import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import {
  applyScheduleChangesSchema,
  renameChatSessionSchema,
  sendChatMessageSchema,
  type ChatMessage,
} from "@run-far/shared";
import { requireUserId } from "../lib/session.js";
import { db } from "../db/client.js";
import { chatSessions, chatMessages } from "../db/schema.js";
import {
  isAnthropicConfigured,
  runAssistantChatTurn,
  runAssistantChatTurnStream,
} from "../integrations/anthropic/assistantChat.js";
import { loadProposal, deleteProposal } from "../integrations/anthropic/proposalStore.js";
import { applyScheduleChanges } from "../assistant/scheduleChanges.js";
import { logger } from "../lib/logger.js";

const MAX_HISTORY_MESSAGES = 40;

function toChatMessage(row: typeof chatMessages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

function titleFromFirstMessage(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed || "New chat";
}

export async function assistantRoutes(app: FastifyInstance) {
  app.get("/api/assistant/sessions", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const sessions = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.userId, userId))
      .orderBy(desc(chatSessions.updatedAt));

    const items = await Promise.all(
      sessions.map(async (s) => {
        const [last] = await db
          .select({ content: chatMessages.content })
          .from(chatMessages)
          .where(eq(chatMessages.sessionId, s.id))
          .orderBy(desc(chatMessages.createdAt))
          .limit(1);
        return {
          id: s.id,
          title: s.title,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          lastMessagePreview: last?.content.slice(0, 120) ?? null,
        };
      }),
    );

    return { items };
  });

  app.post("/api/assistant/sessions", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const [session] = await db.insert(chatSessions).values({ userId }).returning();
    if (!session) throw new Error("failed to create chat session");
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    };
  });

  app.get("/api/assistant/sessions/:id/messages", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };

    const [session] = await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId)));
    if (!session) {
      reply.status(404).send({ error: { message: "Chat not found", code: "NOT_FOUND" } });
      return;
    }

    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, id))
      .orderBy(chatMessages.createdAt);

    return {
      session: {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      },
      messages: rows.map(toChatMessage),
    };
  });

  app.patch("/api/assistant/sessions/:id", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    const body = renameChatSessionSchema.parse(request.body);

    const [existing] = await db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId)));
    if (!existing) {
      reply.status(404).send({ error: { message: "Chat not found", code: "NOT_FOUND" } });
      return;
    }

    await db
      .update(chatSessions)
      .set({ title: body.title, updatedAt: new Date() })
      .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId)));
    return { ok: true };
  });

  app.delete("/api/assistant/sessions/:id", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };

    const [existing] = await db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId)));
    if (!existing) {
      reply.status(404).send({ error: { message: "Chat not found", code: "NOT_FOUND" } });
      return;
    }

    await db.delete(chatSessions).where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId)));
    return { ok: true };
  });

  app.post("/api/assistant/sessions/:id/chat", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };

    if (!isAnthropicConfigured()) {
      reply.status(503).send({
        error: { message: "Anthropic is not configured. Set ANTHROPIC_API_KEY in .env.", code: "AI_NOT_CONFIGURED" },
      });
      return;
    }

    const [session] = await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId)));
    if (!session) {
      reply.status(404).send({ error: { message: "Chat not found", code: "NOT_FOUND" } });
      return;
    }

    const body = sendChatMessageSchema.parse(request.body);

    const priorRows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, id))
      .orderBy(desc(chatMessages.createdAt))
      .limit(MAX_HISTORY_MESSAGES);
    const priorMessages = priorRows.reverse().map(toChatMessage);

    const isFirstMessage = priorMessages.length === 0;

    const [userMsg] = await db
      .insert(chatMessages)
      .values({ sessionId: id, role: "user", content: body.content })
      .returning();
    if (!userMsg) throw new Error("failed to save user message");

    const conversation: ChatMessage[] = [...priorMessages, toChatMessage(userMsg)];

    let turn: Awaited<ReturnType<typeof runAssistantChatTurn>>;
    try {
      turn = await runAssistantChatTurn({ userId, messages: conversation });
    } catch (err) {
      logger.error({ err, userId, sessionId: id }, "assistant chat failed");
      reply.status(502).send({ error: { message: err instanceof Error ? err.message : "AI chat failed", code: "AI_CHAT_FAILED" } });
      return;
    }

    const [assistantMsg] = await db
      .insert(chatMessages)
      .values({ sessionId: id, role: "assistant", content: turn.assistantMessage })
      .returning();
    if (!assistantMsg) throw new Error("failed to save assistant message");

    const newTitle = isFirstMessage ? titleFromFirstMessage(body.content) : session.title;
    await db
      .update(chatSessions)
      .set({ title: newTitle, updatedAt: new Date() })
      .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId)));

    return {
      session: {
        id: session.id,
        title: newTitle,
        createdAt: session.createdAt.toISOString(),
        updatedAt: new Date().toISOString(),
      },
      assistantMessage: toChatMessage(assistantMsg),
      proposal: turn.proposal,
      proposalToken: turn.proposalToken,
    };
  });

  app.post("/api/assistant/sessions/:id/chat/stream", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };

    if (!isAnthropicConfigured()) {
      reply.status(503).send({
        error: { message: "Anthropic is not configured. Set ANTHROPIC_API_KEY in .env.", code: "AI_NOT_CONFIGURED" },
      });
      return;
    }

    const [session] = await db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId)));
    if (!session) {
      reply.status(404).send({ error: { message: "Chat not found", code: "NOT_FOUND" } });
      return;
    }

    const body = sendChatMessageSchema.parse(request.body);

    const priorRows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, id))
      .orderBy(desc(chatMessages.createdAt))
      .limit(MAX_HISTORY_MESSAGES);
    const priorMessages = priorRows.reverse().map(toChatMessage);
    const isFirstMessage = priorMessages.length === 0;

    const [userMsg] = await db
      .insert(chatMessages)
      .values({ sessionId: id, role: "user", content: body.content })
      .returning();
    if (!userMsg) throw new Error("failed to save user message");

    const conversation: ChatMessage[] = [...priorMessages, toChatMessage(userMsg)];

    // Take over the socket for Server-Sent Events. Each frame is one JSON object matching
    // chatStreamEventSchema in @run-far/shared.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: unknown) => raw.write(`data: ${JSON.stringify(event)}\n\n`);

    try {
      const turn = await runAssistantChatTurnStream({
        userId,
        messages: conversation,
        onEvent: (event) => send(event),
      });

      const [assistantMsg] = await db
        .insert(chatMessages)
        .values({ sessionId: id, role: "assistant", content: turn.assistantMessage })
        .returning();
      if (!assistantMsg) throw new Error("failed to save assistant message");

      const newTitle = isFirstMessage ? titleFromFirstMessage(body.content) : session.title;
      const updatedAt = new Date();
      await db
        .update(chatSessions)
        .set({ title: newTitle, updatedAt })
        .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, userId)));

      send({
        type: "done",
        session: {
          id: session.id,
          title: newTitle,
          createdAt: session.createdAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
        },
        assistantMessage: toChatMessage(assistantMsg),
      });
    } catch (err) {
      logger.error({ err, userId, sessionId: id }, "assistant chat stream failed");
      send({
        type: "error",
        message: err instanceof Error ? err.message : "AI chat failed",
        code: "AI_CHAT_FAILED",
      });
    } finally {
      raw.end();
    }
  });

  app.post("/api/assistant/apply", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const body = applyScheduleChangesSchema.parse(request.body);
    const stored = await loadProposal(body.proposalToken);
    if (!stored || stored.meta.userId !== userId) {
      reply.status(404).send({ error: { message: "Proposal not found or expired", code: "PROPOSAL_NOT_FOUND" } });
      return;
    }

    const result = await applyScheduleChanges(userId, stored.proposal);
    await deleteProposal(body.proposalToken);

    logger.info({ userId, ...result }, "assistant schedule changes applied");
    return result;
  });
}
