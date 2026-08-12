import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { aiPlanDraftSchema, type AiPlanDraft, type PlanChatMessage } from "@run-far/shared";
import { env } from "../../env.js";
import { db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { newDraftToken, saveAiDraft } from "./draftStore.js";
import { computePlanWindow } from "../../plans/planWindow.js";
import { validatePlanDraft } from "../../plans/validate.js";
import { getAthleteContext } from "../../plans/athleteContext.js";
import { getActivePlanSnapshot } from "../../plans/activePlan.js";
import { offsetStringForZone, shiftRunsToLocalTime } from "../../plans/zonedTime.js";
import { withImperialRunFields } from "../../lib/units.js";

const MAX_TOOL_ITERATIONS = 8;

function systemPrompt(todayIso: string, timeZone: string): string {
  const offset = offsetStringForZone(timeZone);
  return `You are a running coach embedded in run-far, a training calendar app.
Help the athlete design a concrete, date-accurate training plan through conversation.
You can also revise their *existing* active plan (e.g. change start times, tweak volume) when they ask.

Today's date (UTC) is ${todayIso}. Athlete timezone is ${timeZone} (current offset ${offset}).
Never guess the date — call get_current_date if you need it again.

Workflow (new plan):
1. Ask clarifying questions when the goal, race/goal date, current fitness, weekly mileage, or available training days are unclear.
2. Before drafting, explicitly ask for the athlete's preferred local training time (specific time or morning/afternoon/evening) unless they already provided it. Confirm their timezone if it differs from ${timeZone}. This is a required planning input, not an optional detail.
3. Use get_athlete_context early to ground the plan in the athlete's recent Whoop mileage and recovery. Don't invent a starting volume if data exists.
4. Use compute_plan_window to get exact start/end dates and the list of training weeks before scheduling anything. All run dates MUST fall inside that window.
5. Draft dates and workouts, then call shift_run_times to apply the chosen local start time deterministically to every run. If the athlete gives different times for different session types or days, group the runs and call shift_run_times once per group.
6. Call validate_training_plan. Fix every error it returns and address warnings where reasonable. Only after it passes should you call propose_training_plan.
7. Put the chosen local training time and timezone in the plan summary, then give a short plain-language summary and invite edits.

Workflow (revise existing plan — including "move everything to the afternoon"):
1. Call get_active_plan to load the current active plan's runs.
2. For time-of-day changes, call shift_run_times with the active plan's runs and the athlete's preferred local HH:MM (do NOT rewrite ISO timestamps by hand).
3. Keep name/summary sensible (e.g. note the schedule change). Call validate_training_plan, then propose_training_plan.
4. Confirming replaces the active plan with the revised one (previous plan becomes inactive).

Scheduling / timezone (critical — wrong times show up as 3am on the calendar):
- scheduledAt must be full ISO-8601 datetimes that encode the athlete's *local wall clock* correctly.
- Prefer writing times with an explicit offset for ${timeZone} (e.g. 2026-08-12T16:30:00${offset}), or use shift_run_times after drafting dates.
- NEVER use bare UTC Z for a local morning like 07:00 — 2026-08-12T07:00:00Z displays as ~3am in US Eastern.
- Do not silently choose a default during planning. Ask once for the preferred time of day if it has not been supplied. If the athlete declines to choose, use 16:30 local and state that choice.
- Morning plans: 07:00 local. "Before sunset" depends on date and location; ask for a specific local time or location. If they do not provide one, use 16:30 local and clearly say so.

Coaching constraints:
- Progressive overload: avoid raising weekly distance more than ~10-15% week to week unless the athlete insists.
- Include rest/easy days; never schedule back-to-back hard days (tempo/interval/long/race) without recovery between.
- If a race date is given, put a "race" run on that day and taper volume in the final 1-2 weeks.
- runType must be one of: easy, tempo, interval, long, recovery, race, rest. Rest days may have null duration/distance.
- Keep plans practical (typically 1-20 weeks). Cap at 200 sessions.

Units (important): tool payload fields (distanceM, targetPaceSPerKm) are metric — that's the storage format, not what the athlete sees. The athlete is US-based and thinks in miles. Every distance or pace you write in your own prose — summaries, questions, confirmations, anything you say out loud to them — MUST be miles and minutes-per-mile (e.g. "5 mi easy" and "~9:40/mi"). Do NOT convert these yourself: get_active_plan already includes distanceMiles/paceMinPerMile fields alongside the raw metric ones — quote those in prose. Never surface km, meters, or /km to the athlete, even in passing.`;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_current_date",
    description:
      "Return today's date (UTC), weekday, and the athlete's timezone/offset. Use this to anchor all scheduling.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_athlete_context",
    description:
      "Return the athlete's recent training context: trailing weekly run mileage (miles), averages, longest run, typical run days per week, a recovery summary, and any active plan. Use to ground starting volume and progression.",
    input_schema: {
      type: "object",
      properties: {
        trailingWeeks: { type: "number", description: "How many weeks back to summarize (default 8)." },
      },
    },
  },
  {
    name: "get_active_plan",
    description:
      "Load the athlete's currently active training plan with every scheduled run. Use when they ask to revise, reschedule, or retimed an existing plan (e.g. move all runs to the afternoon).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "shift_run_times",
    description:
      "Deterministically rewrite every run's scheduledAt to the same calendar day in the athlete's timezone at localTime (HH:MM). Prefer this over hand-editing ISO strings when changing time of day. Returns the updated runs array ready for validate/propose.",
    input_schema: {
      type: "object",
      properties: {
        runs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              scheduledAt: { type: "string" },
              runType: { type: "string" },
              durationMin: { type: ["number", "null"] },
              distanceM: { type: ["number", "null"] },
              targetPaceSPerKm: { type: ["number", "null"] },
              plannedTss: { type: ["number", "null"] },
              description: { type: ["string", "null"] },
            },
            required: ["scheduledAt", "runType"],
          },
        },
        localTime: {
          type: "string",
          description: '24h local wall-clock HH:MM, e.g. "16:30" for 4:30pm.',
        },
        timeZone: {
          type: "string",
          description: "IANA timezone override; defaults to the athlete timezone.",
        },
      },
      required: ["runs", "localTime"],
    },
  },
  {
    name: "compute_plan_window",
    description:
      "Compute exact plan dates from intent. Given an optional startDate/preferStart and an optional raceDate/goalDate, returns startDate, endDate, total days, complete weeks, and the Monday-Sunday training weeks. Call before scheduling runs so dates are never miscounted.",
    input_schema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "YYYY-MM-DD; explicit start day if the athlete gave one." },
        raceDate: { type: "string", description: "YYYY-MM-DD; race day (hard end bound)." },
        goalDate: { type: "string", description: "YYYY-MM-DD; non-race goal end if no race." },
        preferStart: {
          type: "string",
          enum: ["today", "tomorrow", "next_monday"],
          description: "Used only when startDate is omitted. Default tomorrow.",
        },
      },
    },
  },
  {
    name: "validate_training_plan",
    description:
      "Check a draft plan against hard constraints (dates within window, race-day present, weekly mileage ramp, rest after hard days, taper). Returns errors (must fix) and warnings. Always call this before propose_training_plan.",
    input_schema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "YYYY-MM-DD earliest allowed run." },
        raceDate: { type: "string", description: "YYYY-MM-DD latest allowed run / race day." },
        availableWeekdays: {
          type: "array",
          items: { type: "number" },
          description: "0=Sun..6=Sat; weekdays the athlete can train, if stated.",
        },
        plan: planSchemaForTool(),
      },
      required: ["plan"],
    },
  },
  {
    name: "propose_training_plan",
    description:
      "Present the finished, validated plan for the athlete to preview and confirm. Only call after validate_training_plan returns no errors. Also use this after revising an existing plan's times.",
    input_schema: planSchemaForTool(),
  },
];

function planSchemaForTool(): Anthropic.Tool.InputSchema {
  return {
    type: "object",
    properties: {
      name: { type: "string", description: "Short plan title" },
      summary: { type: "string", description: "1-3 sentence coach summary" },
      runs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            scheduledAt: {
              type: "string",
              description:
                "ISO datetime with correct local offset (not bare UTC Z for wall-clock times). Prefer shift_run_times.",
            },
            runType: {
              type: "string",
              enum: ["easy", "tempo", "interval", "long", "recovery", "race", "rest"],
            },
            durationMin: { type: ["number", "null"] },
            distanceM: { type: ["number", "null"] },
            targetPaceSPerKm: { type: ["number", "null"] },
            plannedTss: { type: ["number", "null"] },
            description: { type: ["string", "null"] },
          },
          required: ["scheduledAt", "runType"],
        },
      },
    },
    required: ["name", "runs"],
  };
}

export function isAnthropicConfigured(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

interface ToolBounds {
  startDate?: string;
  raceDate?: string;
  goalDate?: string;
  availableWeekdays?: number[];
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { userId: string; bounds: ToolBounds },
): Promise<unknown> {
  switch (name) {
    case "get_current_date": {
      const now = new Date();
      return {
        todayIso: now.toISOString().slice(0, 10),
        weekday: now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
        timeZone: env.ATHLETE_TIMEZONE,
        utcOffset: offsetStringForZone(env.ATHLETE_TIMEZONE, now),
      };
    }
    case "get_athlete_context": {
      const trailingWeeks =
        typeof input.trailingWeeks === "number" ? Math.min(Math.max(input.trailingWeeks, 4), 26) : 8;
      return getAthleteContext(ctx.userId, trailingWeeks);
    }
    case "get_active_plan": {
      const plan = await getActivePlanSnapshot(ctx.userId);
      if (!plan) return { activePlan: null, message: "No active plan — build a new one instead." };
      return {
        activePlan: { ...plan, runs: plan.runs.map(withImperialRunFields) },
        timeZone: env.ATHLETE_TIMEZONE,
        hint: 'To change time of day, pass activePlan.runs to shift_run_times with localTime like "16:30". Use distanceMiles/paceMinPerMile (not distanceM/targetPaceSPerKm) when describing runs to the athlete.',
      };
    }
    case "shift_run_times": {
      const runs = input.runs;
      const localTime = input.localTime;
      if (!Array.isArray(runs) || typeof localTime !== "string") {
        return { error: "runs (array) and localTime (HH:MM string) are required" };
      }
      const timeZone =
        typeof input.timeZone === "string" && input.timeZone.trim()
          ? input.timeZone.trim()
          : env.ATHLETE_TIMEZONE;
      try {
        const shifted = shiftRunsToLocalTime(
          runs as Array<{ scheduledAt: string; runType: string } & Record<string, unknown>>,
          localTime,
          timeZone,
        );
        return {
          localTime,
          timeZone,
          runCount: shifted.length,
          runs: shifted,
          sample: shifted.slice(0, 3).map((r) => r.scheduledAt),
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    case "compute_plan_window": {
      if (typeof input.startDate === "string") ctx.bounds.startDate = input.startDate;
      if (typeof input.raceDate === "string") ctx.bounds.raceDate = input.raceDate;
      if (typeof input.goalDate === "string") ctx.bounds.goalDate = input.goalDate;
      const result = computePlanWindow({
        today: new Date(),
        startDate: input.startDate as string | undefined,
        raceDate: input.raceDate as string | undefined,
        goalDate: input.goalDate as string | undefined,
        preferStart: input.preferStart as "today" | "tomorrow" | "next_monday" | undefined,
      });
      if (result.ok) {
        ctx.bounds.startDate = result.window.startDate;
        if (result.window.hasRace) ctx.bounds.raceDate = result.window.endDate;
        return result.window;
      }
      return { error: result.error };
    }
    case "validate_training_plan": {
      const parsed = aiPlanDraftSchema.safeParse(input.plan);
      if (!parsed.success) {
        return {
          valid: false,
          errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          warnings: [],
        };
      }
      if (Array.isArray(input.availableWeekdays)) {
        ctx.bounds.availableWeekdays = (input.availableWeekdays as unknown[]).filter(
          (n): n is number => typeof n === "number",
        );
      }
      return validatePlanDraft({
        draft: parsed.data,
        today: new Date(),
        startDate: (input.startDate as string | undefined) ?? ctx.bounds.startDate,
        raceDate: (input.raceDate as string | undefined) ?? ctx.bounds.raceDate,
        availableWeekdays: ctx.bounds.availableWeekdays,
      });
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

export async function runPlanChatTurn(params: {
  userId: string;
  messages: PlanChatMessage[];
}): Promise<{
  assistantMessage: string;
  draftToken: string | null;
  draft: AiPlanDraft | null;
}> {
  if (!isAnthropicConfigured()) {
    throw new Error("AI_NOT_CONFIGURED");
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const todayIso = new Date().toISOString().slice(0, 10);
  const bounds: ToolBounds = {};

  const [user] = await db
    .select({ planModel: users.planModel })
    .from(users)
    .where(eq(users.id, params.userId));
  const model = user?.planModel || env.ANTHROPIC_MODEL;

  const conversation: Anthropic.MessageParam[] = params.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let assistantMessage = "";
  let draft: AiPlanDraft | null = null;
  let draftToken: string | null = null;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      system: systemPrompt(todayIso, env.ATHLETE_TIMEZONE),
      tools: TOOLS,
      messages: conversation,
    });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let turnText = "";
    let proposedThisTurn = false;

    for (const block of response.content) {
      if (block.type === "text") {
        turnText += (turnText ? "\n\n" : "") + block.text;
      } else if (block.type === "tool_use") {
        if (block.name === "propose_training_plan") {
          const parsed = aiPlanDraftSchema.safeParse(block.input);
          if (!parsed.success) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              is_error: true,
              content: `Invalid plan: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            });
            continue;
          }
          const check = validatePlanDraft({
            draft: parsed.data,
            today: new Date(),
            startDate: bounds.startDate,
            raceDate: bounds.raceDate,
            availableWeekdays: bounds.availableWeekdays,
          });
          if (!check.valid) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              is_error: true,
              content: `Plan rejected by validator. Fix these errors then re-propose: ${check.errors.join("; ")}`,
            });
            continue;
          }
          draft = parsed.data;
          proposedThisTurn = true;
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Accepted. ${check.warnings.length ? `Warnings: ${check.warnings.join("; ")}` : "No warnings."}`,
          });
        } else {
          const output = await executeTool(
            block.name,
            (block.input as Record<string, unknown>) ?? {},
            { userId: params.userId, bounds },
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(output),
          });
        }
      }
    }

    if (turnText) assistantMessage = turnText;

    if (toolResults.length === 0) break;

    conversation.push({ role: "assistant", content: response.content });
    conversation.push({ role: "user", content: toolResults });

    if (proposedThisTurn && draft) {
      draftToken = newDraftToken();
      const brief = params.messages.find((m) => m.role === "user")?.content.slice(0, 500) ?? null;
      await saveAiDraft(draftToken, draft, {
        userId: params.userId,
        brief,
        createdAt: new Date().toISOString(),
      });
    }
  }

  if (draft && !assistantMessage) {
    assistantMessage =
      draft.summary ??
      `Here's a draft plan (“${draft.name}”) with ${draft.runs.length} sessions. Preview it below, or tell me what to change.`;
  }
  if (!assistantMessage) {
    assistantMessage = "Tell me more about your goal, timeline, and how many days you can train.";
  }

  return { assistantMessage, draftToken, draft };
}
