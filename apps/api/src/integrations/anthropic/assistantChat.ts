import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import {
  scheduleChangeProposalSchema,
  type ChatMessage,
  type ScheduleChangeProposal,
} from "@run-far/shared";
import { env } from "../../env.js";
import { logger } from "../../lib/logger.js";
import { db } from "../../db/client.js";
import { recoveryMetrics, sleepRecords, whoopWorkouts, plannedRuns, recommendations, users } from "../../db/schema.js";
import { getAthleteContext } from "../../plans/athleteContext.js";
import { getActivePlanSnapshot } from "../../plans/activePlan.js";
import { getActivePlanId, visibleRunsSql } from "../../plans/lifecycle.js";
import { offsetStringForZone, dateYmdInZone } from "../../lib/zonedTime.js";
import { formatFeet, formatMiles, withImperialRunFields } from "../../lib/units.js";
import { sendRecoveryDigestNow } from "../../email/recoveryDigest.js";
import { hasGoogleConnection } from "../google/push.js";
import { listPrimaryEvents } from "../google/calendarClient.js";
import { getForecastForRange } from "../weather/weatherClient.js";
import { getAthleteLocation } from "../../lib/athleteLocation.js";
import { getAthleteTimezone } from "../../lib/athleteTimezone.js";
import { newProposalToken, saveProposal } from "./proposalStore.js";

const MAX_TOOL_ITERATIONS = 8;

// recoveryMetrics/sleepRecords/whoopWorkouts store the athlete-local date (see
// integrations/whoop/sync.ts), so window bounds must be computed the same way — a UTC slice
// here would drift the window off by a day for evening activity, same as the bug fixed there.
function isoDate(d: Date, tz: string): string {
  return dateYmdInZone(d, tz);
}

function systemPrompt(todayIso: string, timeZone: string): string {
  const offset = offsetStringForZone(timeZone);
  return `You are the run-far assistant, embedded across the whole app (not just plan building).
You can see the athlete's recovery/sleep/workout data (from Whoop), their calendar of planned runs,
their training plans, and their pending coaching recommendations. Use these tools to answer questions
grounded in real data — never guess numbers you can look up.

Sleep debt (from Whoop) is already a rolling, cumulative-per-night figure — each day's value already
reflects debt carried forward from prior nights. Only today's (or a single day's) sleepDebtMin value is
meaningful as "current" sleep debt — get_athlete_context's recovery.sleepDebtMinToday is the right field
for that. Never sum sleepDebtMin across multiple days from get_recovery_history to build a "weekly total"
— that would massively over-count. The per-day history from get_recovery_history is still useful for trend
questions (e.g. "how has my sleep debt changed this month"), just never for summing.

Today's date (UTC) is ${todayIso}. Athlete timezone is ${timeZone} (current offset ${offset}).

You can also help reconfigure the athlete's week or calendar (move runs, add/remove sessions, rest days,
etc). You must NEVER write to the calendar directly. Instead:
1. Gather the context you need (get_runs, get_active_plan, get_athlete_context, get_recovery_history as relevant).
2. Call propose_schedule_changes with the exact set of create/update/delete operations. Each item needs a
   short human-readable summary (e.g. "Tue Aug 18 — move easy run to 6:30am") and, for create/update,
   the relevant fields. scheduledAt must be a full ISO-8601 datetime with the correct local offset for
   ${timeZone} (e.g. 2026-08-18T06:30:00${offset}) — never bare UTC "Z" for a wall-clock local time.
3. After calling propose_schedule_changes, tell the athlete in plain language what you're proposing and
   that they need to confirm it before it touches their calendar. Do not claim the change is already made.

Only call propose_schedule_changes once you have enough information (don't guess dates/times you were not
given and that aren't already on the calendar). Ask clarifying questions first if the request is ambiguous
(e.g. "reconfigure my week" with no detail — ask what's driving it: fatigue, a scheduling conflict, wanting
more/less volume, etc, and confirm which days are in play).

Whenever the athlete asks you to review, look at, or optimize their week's schedule, call get_runs AND
get_calendar_events for the same date range before saying anything substantive. get_calendar_events returns
the athlete's real personal commitments (event titles + times) from their Google Calendar — call out any
specific runs that overlap one by name (e.g. "your Thursday tempo run overlaps Dentist, 3-4pm"), and never
propose a scheduledAt in propose_schedule_changes that overlaps one of those events. If Google isn't
connected, get_calendar_events tells you so — mention that you can't check for calendar conflicts rather
than silently skipping the check.

Weather (get_weather) works the same way: if the athlete's location isn't set, the tool tells you so and
gives you the exact instruction to relay — pass it along in plain language (Settings → Weather → "Use my
location") rather than just saying weather is unavailable.

If the athlete asks you to email/send them today's recovery summary or recommendations (e.g. "email me my
recovery", "send me today's digest"), call send_recovery_email. This immediately sends a real email via
their connected Gmail account — unlike schedule changes, it needs no separate confirmation since it has no
effect on their data, but only call it when they've actually asked to be emailed, not speculatively.

runType must be one of: easy, tempo, interval, long, recovery, race, rest. Tool payload fields (distanceM,
targetPaceSPerKm) are metric — that's the storage format, not what the athlete sees.

Units (important): the athlete is US-based and thinks in miles. Every distance, pace, or elevation figure
you write in your own prose — answers, summaries, schedule-change descriptions, anything you say out loud
to them — MUST be miles and minutes-per-mile (e.g. "5 mi easy", "~9:40/mi", "300 ft of climb"). Do NOT do
this conversion yourself: get_runs, get_active_plan, and get_recent_activities already include
distanceMiles/paceMinPerMile/altitudeGainFeet fields alongside the raw metric ones — always quote those
pre-computed fields in your prose. The raw metric fields (distanceM, targetPaceSPerKm) exist only because
tool-call payloads (propose_schedule_changes, shift_run_times) require metric — use them there, never in
text. Never surface km, meters, or /km to the athlete, even in passing. Temperatures, if relevant, are
Fahrenheit.

Keep answers concise and coach-like.`;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_current_date",
    description: "Return today's date (UTC), weekday, and the athlete's timezone/offset.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_athlete_context",
    description:
      "Return trailing weekly run mileage, averages, longest run, typical run days/week, a recovery summary (including today's rolling sleep debt), and any active plan.",
    input_schema: {
      type: "object",
      properties: {
        trailingWeeks: { type: "number", description: "How many weeks back to summarize (default 8)." },
      },
    },
  },
  {
    name: "get_recovery_history",
    description:
      "Return daily recovery score, HRV, resting HR, sleep, and strain for the last N days (default 14, max 90).",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Number of trailing days, max 90." },
      },
    },
  },
  {
    name: "get_recent_activities",
    description: "Return the athlete's most recent Whoop workouts (any sport), newest first.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max rows, default 10, max 50." },
        sport: { type: "string", description: "Optional sport filter, e.g. running." },
      },
    },
  },
  {
    name: "get_runs",
    description:
      "Return planned runs (calendar entries) in a date range. Defaults to the next 14 days if no range given. Use this before proposing changes so you know current runIds.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD, inclusive. Defaults to today." },
        to: { type: "string", description: "YYYY-MM-DD, inclusive. Defaults to 14 days from `from`." },
      },
    },
  },
  {
    name: "get_calendar_events",
    description:
      "Return the athlete's personal Google Calendar events (not runs) in a date range — their real " +
      "commitments, with titles and times. Defaults to the next 14 days if no range given. Call this " +
      "alongside get_runs whenever reviewing or optimizing the week, so you can flag and avoid conflicts.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD, inclusive. Defaults to today." },
        to: { type: "string", description: "YYYY-MM-DD, inclusive. Defaults to 14 days from `from`." },
      },
    },
  },
  {
    name: "get_weather",
    description:
      "Return the NWS weather forecast for the athlete's location over a date range, one entry per day. " +
      "Each day includes daily high/low temps, conditions, precip chance, wind, and any active NWS alerts, " +
      "plus hour-by-hour data (`hourly`) and three derived intra-day summaries (`segments`: morning ~6-11am, " +
      "midday ~11am-4pm, evening ~4-9pm local), each with its own temp, precip chance, and conditions — use " +
      "these to advise on run timing within a day (e.g. 'run before the evening storm' or 'morning is cooler " +
      "and drier than midday'). Defaults to today through 7 days out if no range given. Calls NWS live for " +
      "freshness. If the athlete's location isn't configured, says so.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD, inclusive. Defaults to today." },
        to: { type: "string", description: "YYYY-MM-DD, inclusive. Defaults to 7 days from `from`." },
      },
    },
  },
  {
    name: "get_active_plan",
    description: "Load the athlete's currently active training plan with every scheduled run.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_recommendations",
    description: "Return pending coaching recommendations (e.g. flagged overreach, sleep debt, calendar conflicts).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_recovery_email",
    description:
      "Immediately email the athlete today's recovery stats + pending recommendations via their connected Gmail account. Use only when they explicitly ask to be emailed/sent a summary.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "propose_schedule_changes",
    description:
      "Stage a set of calendar changes for the athlete to review and confirm. Never applied automatically.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "1-3 sentence plain-language summary of the overall change." },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["create", "update", "delete"] },
              runId: {
                type: ["string", "null"],
                description: "Required for update/delete; null for create.",
              },
              summary: { type: "string", description: "One-line human-readable description of this change." },
              scheduledAt: { type: ["string", "null"] },
              runType: {
                type: ["string", "null"],
                enum: ["easy", "tempo", "interval", "long", "recovery", "race", "rest", null],
              },
              durationMin: { type: ["number", "null"] },
              distanceM: { type: ["number", "null"] },
              targetPaceSPerKm: { type: ["number", "null"] },
              plannedTss: { type: ["number", "null"] },
              description: { type: ["string", "null"] },
            },
            required: ["op", "summary"],
          },
        },
      },
      required: ["summary", "items"],
    },
  },
];

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  userId: string,
  tz: string,
): Promise<unknown> {
  switch (name) {
    case "get_current_date": {
      const now = new Date();
      return {
        todayIso: isoDate(now, tz),
        weekday: now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
        timeZone: tz,
        utcOffset: offsetStringForZone(tz, now),
      };
    }
    case "get_athlete_context": {
      const trailingWeeks =
        typeof input.trailingWeeks === "number" ? Math.min(Math.max(input.trailingWeeks, 4), 26) : 8;
      return getAthleteContext(userId, trailingWeeks);
    }
    case "get_recovery_history": {
      const windowDays = Math.min(Math.max(Number(input.days) || 14, 1), 90);
      const startIso = isoDate(new Date(Date.now() - (windowDays - 1) * 86_400_000), tz);
      const endIso = isoDate(new Date(), tz);
      const [recoveryRows, sleepRows, workoutRows] = await Promise.all([
        db
          .select()
          .from(recoveryMetrics)
          .where(and(eq(recoveryMetrics.userId, userId), gte(recoveryMetrics.date, startIso), lte(recoveryMetrics.date, endIso)))
          .orderBy(desc(recoveryMetrics.date)),
        db
          .select()
          .from(sleepRecords)
          .where(and(eq(sleepRecords.userId, userId), gte(sleepRecords.date, startIso), lte(sleepRecords.date, endIso)))
          .orderBy(desc(sleepRecords.date)),
        db
          .select({ date: whoopWorkouts.date, strain: whoopWorkouts.strain, sport: whoopWorkouts.sport })
          .from(whoopWorkouts)
          .where(and(eq(whoopWorkouts.userId, userId), gte(whoopWorkouts.date, startIso), lte(whoopWorkouts.date, endIso)))
          .orderBy(desc(whoopWorkouts.date)),
      ]);
      return { startIso, endIso, recovery: recoveryRows, sleep: sleepRows, workouts: workoutRows };
    }
    case "get_recent_activities": {
      const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 50);
      const conditions = [eq(whoopWorkouts.userId, userId)];
      if (typeof input.sport === "string" && input.sport.trim()) {
        conditions.push(eq(whoopWorkouts.sport, input.sport.trim()));
      }
      const rows = await db
        .select()
        .from(whoopWorkouts)
        .where(and(...conditions))
        .orderBy(desc(whoopWorkouts.date), desc(whoopWorkouts.createdAt))
        .limit(limit);
      return rows.map((r) => ({
        ...r,
        distanceMiles: formatMiles(r.distanceM),
        altitudeGainFeet: formatFeet(r.altitudeGainM),
      }));
    }
    case "get_runs": {
      const from = typeof input.from === "string" ? input.from : isoDate(new Date(), tz);
      const fromDate = new Date(`${from}T00:00:00Z`);
      const to =
        typeof input.to === "string" ? input.to : isoDate(new Date(fromDate.getTime() + 14 * 86_400_000), tz);
      const toDate = new Date(`${to}T23:59:59Z`);

      const activePlanId = await getActivePlanId(userId);
      const rows = await db
        .select()
        .from(plannedRuns)
        .where(
          and(
            visibleRunsSql(userId, activePlanId),
            gte(plannedRuns.scheduledAt, fromDate),
            lte(plannedRuns.scheduledAt, toDate),
          ),
        )
        .orderBy(plannedRuns.scheduledAt);
      return rows.map(withImperialRunFields);
    }
    case "get_calendar_events": {
      if (!(await hasGoogleConnection(userId))) {
        return { connected: false, events: [] };
      }
      const from = typeof input.from === "string" ? input.from : isoDate(new Date(), tz);
      const fromDate = new Date(`${from}T00:00:00Z`);
      const to =
        typeof input.to === "string" ? input.to : isoDate(new Date(fromDate.getTime() + 14 * 86_400_000), tz);
      const toDate = new Date(`${to}T23:59:59Z`);
      const events = await listPrimaryEvents(userId, fromDate.toISOString(), toDate.toISOString());
      return { connected: true, events };
    }
    case "get_weather": {
      const location = await getAthleteLocation(userId);
      if (!location) {
        return {
          configured: false,
          message:
            "The athlete's location isn't set, so weather can't be fetched. Tell them to go to " +
            "Settings and click \"Use my location\" under Weather to enable it.",
        };
      }
      const from = typeof input.from === "string" ? input.from : isoDate(new Date(), tz);
      const to =
        typeof input.to === "string"
          ? input.to
          : isoDate(new Date(new Date(`${from}T00:00:00Z`).getTime() + 7 * 86_400_000), tz);
      const forecasts = await getForecastForRange(location.lat, location.lon, tz, from, to);
      return { configured: true, forecasts };
    }
    case "get_active_plan": {
      const plan = await getActivePlanSnapshot(userId);
      if (!plan) return { activePlan: null };
      return {
        activePlan: { ...plan, runs: plan.runs.map(withImperialRunFields) },
        timeZone: tz,
      };
    }
    case "get_recommendations": {
      return db
        .select()
        .from(recommendations)
        .where(and(eq(recommendations.userId, userId), eq(recommendations.status, "pending")))
        .orderBy(desc(recommendations.createdAt));
    }
    case "send_recovery_email": {
      return sendRecoveryDigestNow(userId);
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

// Run a data tool and always return a tool_result the model can act on. A single tool failing
// (an expired Google token, a weather outage, a DB hiccup) must never abort the whole turn —
// the model gets an is_error result and can tell the athlete that source is unavailable and
// still answer with what it does have.
async function executeToolSafely(
  name: string,
  input: Record<string, unknown>,
  userId: string,
  tz: string,
  toolUseId: string,
): Promise<Anthropic.ToolResultBlockParam> {
  try {
    const output = await executeTool(name, input, userId, tz);
    return { type: "tool_result", tool_use_id: toolUseId, content: JSON.stringify(output) };
  } catch (err) {
    logger.error({ err, tool: name, userId }, "assistant tool failed");
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      is_error: true,
      content: `${name} is temporarily unavailable (${err instanceof Error ? err.message : "unknown error"}). Tell the athlete you couldn't reach that data source right now, then answer with whatever else you have.`,
    };
  }
}

export function isAnthropicConfigured(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

// Human-readable labels for the live "coach activity" readout the streaming UI shows while
// the agent consults the athlete's data. Keeps the tool vocabulary out of the athlete's face.
const TOOL_ACTIVITY_LABELS: Record<string, string> = {
  get_current_date: "Checking the date",
  get_athlete_context: "Reviewing your training",
  get_recovery_history: "Reading recovery",
  get_recent_activities: "Reviewing recent runs",
  get_runs: "Reading your week",
  get_calendar_events: "Checking your calendar",
  get_weather: "Pulling the forecast",
  get_active_plan: "Opening your plan",
  get_recommendations: "Checking flags",
  send_recovery_email: "Sending your email",
  propose_schedule_changes: "Drafting changes",
};

// Validate a propose_schedule_changes tool payload. Shared by the streaming and non-streaming
// turns so the confirm-before-write contract stays identical on both paths.
function validateProposalInput(
  input: unknown,
): { ok: true; proposal: ScheduleChangeProposal } | { ok: false; error: string } {
  const parsed = scheduleChangeProposalSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid proposal: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    };
  }
  const badItem = parsed.data.items.find((it) => {
    if (it.op === "create") return !it.scheduledAt || !it.runType;
    return !it.runId;
  });
  if (badItem) {
    return {
      ok: false,
      error: "Invalid proposal: create items need scheduledAt+runType; update/delete items need runId.",
    };
  }
  return { ok: true, proposal: parsed.data };
}

export type AssistantStreamEvent =
  | { type: "tool"; label: string }
  | { type: "text"; delta: string }
  | { type: "proposal"; proposal: ScheduleChangeProposal; proposalToken: string };

/**
 * Streaming twin of runAssistantChatTurn. Runs the same agentic tool loop, but streams the
 * coach's prose token-by-token and reports each tool the coach consults via `onEvent`, so the
 * UI can show a live readout instead of a static "Thinking…". Returns the final aggregate
 * (persisted by the caller) so the confirm-before-write proposal contract is unchanged.
 *
 * Text semantics match the non-streaming turn: only the final tool-free turn's text is the
 * answer. Interim text emitted before a tool call is streamed live for immediacy, but a
 * subsequent `tool` event signals the client to discard it — so what remains on screen equals
 * the persisted message.
 */
export async function runAssistantChatTurnStream(params: {
  userId: string;
  messages: ChatMessage[];
  onEvent: (event: AssistantStreamEvent) => void;
}): Promise<{
  assistantMessage: string;
  proposal: ScheduleChangeProposal | null;
  proposalToken: string | null;
}> {
  if (!isAnthropicConfigured()) {
    throw new Error("AI_NOT_CONFIGURED");
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const tz = await getAthleteTimezone(params.userId);
  const todayIso = isoDate(new Date(), tz);

  const [user] = await db
    .select({ assistantModel: users.assistantModel })
    .from(users)
    .where(eq(users.id, params.userId));
  const model = user?.assistantModel || env.ANTHROPIC_MODEL;

  const conversation: Anthropic.MessageParam[] = params.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let assistantMessage = "";
  let proposal: ScheduleChangeProposal | null = null;
  let proposalToken: string | null = null;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const stream = client.messages.stream({
      model,
      max_tokens: 4096,
      system: systemPrompt(todayIso, tz),
      tools: TOOLS,
      messages: conversation,
    });

    // Stream prose deltas as they arrive.
    stream.on("text", (delta) => {
      if (delta) params.onEvent({ type: "text", delta });
    });
    // Announce each tool the coach starts consulting, the moment it begins.
    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        const label = TOOL_ACTIVITY_LABELS[event.content_block.name] ?? "Working";
        params.onEvent({ type: "tool", label });
      }
    });

    const response = await stream.finalMessage();

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let turnText = "";

    for (const block of response.content) {
      if (block.type === "text") {
        turnText += (turnText ? "\n\n" : "") + block.text;
      } else if (block.type === "tool_use") {
        if (block.name === "propose_schedule_changes") {
          const result = validateProposalInput(block.input);
          if (!result.ok) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              is_error: true,
              content: result.error,
            });
            continue;
          }
          proposal = result.proposal;
          proposalToken = newProposalToken();
          await saveProposal(proposalToken, proposal, {
            userId: params.userId,
            createdAt: new Date().toISOString(),
          });
          params.onEvent({ type: "proposal", proposal, proposalToken });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Staged ${result.proposal.items.length} change(s) for the athlete to confirm.`,
          });
        } else {
          const output = await executeTool(
            block.name,
            (block.input as Record<string, unknown>) ?? {},
            params.userId,
            tz,
          );
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(output) });
        }
      }
    }

    if (turnText) assistantMessage = turnText;
    if (toolResults.length === 0) break;

    conversation.push({ role: "assistant", content: response.content });
    conversation.push({ role: "user", content: toolResults });
  }

  if (!assistantMessage) {
    assistantMessage = proposal
      ? "I've staged those changes — review and confirm below to apply them."
      : "I'm not sure how to respond to that yet.";
  }

  return { assistantMessage, proposal, proposalToken };
}

export async function runAssistantChatTurn(params: {
  userId: string;
  messages: ChatMessage[];
}): Promise<{
  assistantMessage: string;
  proposal: ScheduleChangeProposal | null;
  proposalToken: string | null;
}> {
  if (!isAnthropicConfigured()) {
    throw new Error("AI_NOT_CONFIGURED");
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const tz = await getAthleteTimezone(params.userId);
  const todayIso = isoDate(new Date(), tz);

  const [user] = await db
    .select({ assistantModel: users.assistantModel })
    .from(users)
    .where(eq(users.id, params.userId));
  const model = user?.assistantModel || env.ANTHROPIC_MODEL;

  const conversation: Anthropic.MessageParam[] = params.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let assistantMessage = "";
  let proposal: ScheduleChangeProposal | null = null;
  let proposalToken: string | null = null;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt(todayIso, tz),
      tools: TOOLS,
      messages: conversation,
    });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let turnText = "";

    for (const block of response.content) {
      if (block.type === "text") {
        turnText += (turnText ? "\n\n" : "") + block.text;
      } else if (block.type === "tool_use") {
        if (block.name === "propose_schedule_changes") {
          const result = validateProposalInput(block.input);
          if (!result.ok) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              is_error: true,
              content: result.error,
            });
            continue;
          }
          proposal = result.proposal;
          proposalToken = newProposalToken();
          await saveProposal(proposalToken, proposal, { userId: params.userId, createdAt: new Date().toISOString() });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Staged ${result.proposal.items.length} change(s) for the athlete to confirm.`,
          });
        } else {
          toolResults.push(
            await executeToolSafely(
              block.name,
              (block.input as Record<string, unknown>) ?? {},
              params.userId,
              tz,
              block.id,
            ),
          );
        }
      }
    }

    if (turnText) assistantMessage = turnText;
    if (toolResults.length === 0) break;

    conversation.push({ role: "assistant", content: response.content });
    conversation.push({ role: "user", content: toolResults });
  }

  if (!assistantMessage) {
    assistantMessage = proposal
      ? "I've staged those changes — review and confirm below to apply them."
      : "I'm not sure how to respond to that yet.";
  }

  return { assistantMessage, proposal, proposalToken };
}
