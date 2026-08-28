import { z } from "zod";
import { runTypeSchema } from "./plan.js";

export const chatMessageRoleSchema = z.enum(["user", "assistant"]);
export type ChatMessageRole = z.infer<typeof chatMessageRoleSchema>;

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  role: chatMessageRoleSchema,
  content: z.string(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatSessionSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatSession = z.infer<typeof chatSessionSchema>;

export const chatSessionWithPreviewSchema = chatSessionSchema.extend({
  lastMessagePreview: z.string().nullable(),
});
export type ChatSessionWithPreview = z.infer<typeof chatSessionWithPreviewSchema>;

export const sendChatMessageSchema = z.object({
  content: z.string().min(1).max(8_000),
});
export type SendChatMessageInput = z.infer<typeof sendChatMessageSchema>;

export const renameChatSessionSchema = z.object({
  title: z.string().min(1).max(120),
});
export type RenameChatSessionInput = z.infer<typeof renameChatSessionSchema>;

// --- Schedule-change proposals: a diff the athlete must confirm before it touches the
// calendar. One item per run being created/updated/deleted. ---

export const scheduleChangeItemSchema = z.object({
  op: z.enum(["create", "update", "delete"]),
  runId: z.string().uuid().nullable(),
  summary: z.string().min(1).max(300),
  scheduledAt: z.string().nullable().optional(),
  runType: runTypeSchema.nullable().optional(),
  durationMin: z.number().nullable().optional(),
  distanceM: z.number().nullable().optional(),
  targetPaceSPerKm: z.number().nullable().optional(),
  plannedTss: z.number().nullable().optional(),
  description: z.string().nullable().optional(),
});
export type ScheduleChangeItem = z.infer<typeof scheduleChangeItemSchema>;

export const scheduleChangeProposalSchema = z.object({
  summary: z.string().min(1).max(2000),
  items: z.array(scheduleChangeItemSchema).min(1).max(100),
});
export type ScheduleChangeProposal = z.infer<typeof scheduleChangeProposalSchema>;

export const chatTurnResponseSchema = z.object({
  session: chatSessionSchema,
  assistantMessage: chatMessageSchema,
  proposal: scheduleChangeProposalSchema.nullable(),
  proposalToken: z.string().nullable(),
});
export type ChatTurnResponse = z.infer<typeof chatTurnResponseSchema>;

export const applyScheduleChangesSchema = z.object({
  proposalToken: z.string().min(1),
});
export type ApplyScheduleChangesInput = z.infer<typeof applyScheduleChangesSchema>;

export const applyScheduleChangesResponseSchema = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
});
export type ApplyScheduleChangesResponse = z.infer<typeof applyScheduleChangesResponseSchema>;

// --- Streaming chat events (SSE). The stream endpoint emits one JSON object per SSE frame;
// the client reduces them into the in-flight turn. `tool` reports what data the coach is
// consulting, `text` carries prose deltas, `proposal` stages a confirmable diff, `done`
// closes the turn with the persisted message + (possibly renamed) session title. ---

export const chatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool"), label: z.string() }),
  z.object({ type: z.literal("text"), delta: z.string() }),
  z.object({
    type: z.literal("proposal"),
    proposal: scheduleChangeProposalSchema,
    proposalToken: z.string(),
  }),
  z.object({
    type: z.literal("done"),
    session: chatSessionSchema,
    assistantMessage: chatMessageSchema,
  }),
  z.object({ type: z.literal("error"), message: z.string(), code: z.string().optional() }),
]);
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
