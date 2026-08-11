import Anthropic from "@anthropic-ai/sdk";
import { aiPlanDraftSchema, type AiPlanDraft, type PlanChatMessage } from "@run-far/shared";
import { env } from "../../env.js";
import { logger } from "../../lib/logger.js";
import { newDraftToken, saveAiDraft } from "./draftStore.js";
import { computePlanWindow } from "../../plans/planWindow.js";
import { validatePlanDraft } from "../../plans/validate.js";
import { getAthleteContext } from "../../plans/athleteContext.js";

const MAX_TOOL_ITERATIONS = 8;

function systemPrompt(todayIso: string): string {
  return `You are a running coach embedded in run-far, a training calendar app.
Help the athlete design a concrete, date-accurate training plan through conversation.

Today's date (UTC) is ${todayIso}. Never guess the date — call get_current_date if you need it again.

Workflow:
1. Ask clarifying questions when the goal, race/goal date, current fitness, weekly mileage, or available training days are unclear.
2. Use get_athlete_context early to ground the plan in the athlete's recent Whoop mileage and recovery. Don't invent a starting volume if data exists.
3. Use compute_plan_window to get exact start/end dates and the list of training weeks before scheduling anything. All run dates MUST fall inside that window.
4. Draft the plan, then call validate_training_plan. Fix every error it returns and address warnings where reasonable. Only after it passes should you call propose_training_plan.
5. After proposing, give a short plain-language summary and invite edits.

Coaching constraints:
- Progressive overload: avoid raising weekly distance more than ~10-15% week to week unless the athlete insists.
- Include rest/easy days; never schedule back-to-back hard days (tempo/interval/long/race) without recovery between.
- If a race date is given, put a "race" run on that day and taper volume in the final 1-2 weeks.
- Dates must be ISO-8601 datetimes; prefer local morning starts (e.g. 07:00). Distances are meters; paces are seconds per kilometer.
- runType must be one of: easy, tempo, interval, long, recovery, race, rest. Rest days may have null duration/distance.
- Keep plans practical (typically 1-20 weeks). Cap at 200 sessions.`;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_current_date",
    description: "Return today's date (UTC) and weekday. Use this to anchor all scheduling.",
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
      "Present the finished, validated plan for the athlete to preview and confirm. Only call after validate_training_plan returns no errors.",
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
            scheduledAt: { type: "string", description: "ISO datetime" },
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
      };
    }
    case "get_athlete_context": {
      const trailingWeeks =
        typeof input.trailingWeeks === "number" ? Math.min(Math.max(input.trailingWeeks, 4), 26) : 8;
      return getAthleteContext(ctx.userId, trailingWeeks);
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
        // Remember resolved bounds so validate uses the same window even if the model omits them.
        ctx.bounds.startDate = result.window.startDate;
        if (result.window.hasRace) ctx.bounds.raceDate = result.window.endDate;
        return result.window;
      }
      return { error: result.error };
    }
    case "validate_training_plan": {
      const parsed = aiPlanDraftSchema.safeParse(input.plan);
      if (!parsed.success) {
        return { valid: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`), warnings: [] };
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

  const conversation: Anthropic.MessageParam[] = params.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let assistantMessage = "";
  let draft: AiPlanDraft | null = null;
  let draftToken: string | null = null;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 8192,
      system: systemPrompt(todayIso),
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
          // Gate: never surface a plan that fails hard constraints, even if the model skipped validate.
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

    // No tools called this turn: the model is talking to the athlete; we're done.
    if (toolResults.length === 0) break;

    conversation.push({ role: "assistant", content: response.content });
    conversation.push({ role: "user", content: toolResults });

    if (proposedThisTurn && draft) {
      // One more turn already appended will let the model summarize, but to keep latency
      // bounded we persist now and continue only if it hasn't produced prose yet.
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
