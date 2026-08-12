import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import {
  scheduleChangeProposalSchema,
  type ChatMessage,
  type ScheduleChangeProposal,
} from "@run-far/shared";
import { env } from "../../env.js";
import { db } from "../../db/client.js";
import { recoveryMetrics, sleepRecords, whoopWorkouts, plannedRuns, recommendations } from "../../db/schema.js";
import { getAthleteContext } from "../../plans/athleteContext.js";
import { getActivePlanSnapshot } from "../../plans/activePlan.js";
import { getActivePlanId, visibleRunsSql } from "../../plans/lifecycle.js";
import { offsetStringForZone } from "../../plans/zonedTime.js";
import { sendRecoveryDigestNow } from "../google/recoveryDigest.js";
import { newProposalToken, saveProposal } from "./proposalStore.js";

const MAX_TOOL_ITERATIONS = 8;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function systemPrompt(todayIso: string, timeZone: string): string {
  const offset = offsetStringForZone(timeZone);
  return `You are the run-far assistant, embedded across the whole app (not just plan building).
You can see the athlete's recovery/sleep/workout data (from Whoop), their calendar of planned runs,
their training plans, and their pending coaching recommendations. Use these tools to answer questions
grounded in real data — never guess numbers you can look up.

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

If the athlete asks you to email/send them today's recovery summary or recommendations (e.g. "email me my
recovery", "send me today's digest"), call send_recovery_email. This immediately sends a real email via
their connected Gmail account — unlike schedule changes, it needs no separate confirmation since it has no
effect on their data, but only call it when they've actually asked to be emailed, not speculatively.

runType must be one of: easy, tempo, interval, long, recovery, race, rest. Tool payload fields (distanceM,
targetPaceSPerKm) are metric — that's the storage format, not what the athlete sees.

Units (important): the athlete is US-based and thinks in miles. Every distance, pace, or elevation figure
you write in your own prose — answers, summaries, schedule-change descriptions, anything you say out loud
to them — MUST be miles and minutes-per-mile (e.g. "5 mi easy", "~9:40/mi", "300 ft of climb"), converted
from whatever metric values the tools return (distanceM, targetPaceSPerKm, altitude in meters). Never
surface km, meters, or /km to the athlete, even in passing. Temperatures, if ever relevant, are Fahrenheit.

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
      "Return trailing weekly run mileage, averages, longest run, typical run days/week, a recovery summary, and any active plan.",
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

async function executeTool(name: string, input: Record<string, unknown>, userId: string): Promise<unknown> {
  switch (name) {
    case "get_current_date": {
      const now = new Date();
      return {
        todayIso: isoDate(now),
        weekday: now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
        timeZone: env.ATHLETE_TIMEZONE,
        utcOffset: offsetStringForZone(env.ATHLETE_TIMEZONE, now),
      };
    }
    case "get_athlete_context": {
      const trailingWeeks =
        typeof input.trailingWeeks === "number" ? Math.min(Math.max(input.trailingWeeks, 4), 26) : 8;
      return getAthleteContext(userId, trailingWeeks);
    }
    case "get_recovery_history": {
      const windowDays = Math.min(Math.max(Number(input.days) || 14, 1), 90);
      const startIso = isoDate(new Date(Date.now() - (windowDays - 1) * 86_400_000));
      const endIso = isoDate(new Date());
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
      return db
        .select()
        .from(whoopWorkouts)
        .where(and(...conditions))
        .orderBy(desc(whoopWorkouts.date), desc(whoopWorkouts.createdAt))
        .limit(limit);
    }
    case "get_runs": {
      const from = typeof input.from === "string" ? input.from : isoDate(new Date());
      const fromDate = new Date(`${from}T00:00:00Z`);
      const to =
        typeof input.to === "string" ? input.to : isoDate(new Date(fromDate.getTime() + 14 * 86_400_000));
      const toDate = new Date(`${to}T23:59:59Z`);

      const activePlanId = await getActivePlanId(userId);
      return db
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
    }
    case "get_active_plan": {
      const plan = await getActivePlanSnapshot(userId);
      if (!plan) return { activePlan: null };
      return { activePlan: plan, timeZone: env.ATHLETE_TIMEZONE };
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

export function isAnthropicConfigured(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
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
  const todayIso = isoDate(new Date());

  const conversation: Anthropic.MessageParam[] = params.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let assistantMessage = "";
  let proposal: ScheduleChangeProposal | null = null;
  let proposalToken: string | null = null;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: systemPrompt(todayIso, env.ATHLETE_TIMEZONE),
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
          const parsed = scheduleChangeProposalSchema.safeParse(block.input);
          if (!parsed.success) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              is_error: true,
              content: `Invalid proposal: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            });
            continue;
          }
          const badItem = parsed.data.items.find((it) => {
            if (it.op === "create") return !it.scheduledAt || !it.runType;
            return !it.runId;
          });
          if (badItem) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              is_error: true,
              content:
                "Invalid proposal: create items need scheduledAt+runType; update/delete items need runId.",
            });
            continue;
          }
          proposal = parsed.data;
          proposalToken = newProposalToken();
          await saveProposal(proposalToken, proposal, { userId: params.userId, createdAt: new Date().toISOString() });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Staged ${parsed.data.items.length} change(s) for the athlete to confirm.`,
          });
        } else {
          const output = await executeTool(block.name, (block.input as Record<string, unknown>) ?? {}, params.userId);
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
