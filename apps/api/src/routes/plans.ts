import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, ne, sql } from "drizzle-orm";
import {
  aiPlanDraftSchema,
  commitAiPlanSchema,
  commitImportSchema,
  planAiChatRequestSchema,
  type RunType,
} from "@run-far/shared";
import { requireUserId } from "../lib/session.js";
import { parseTrainingPeaksCsv } from "../integrations/trainingpeaks/parser.js";
import { newUploadToken, saveUpload, loadUpload } from "../integrations/trainingpeaks/uploadStore.js";
import { db } from "../db/client.js";
import { trainingPlans, plannedRuns } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { activatePlan, archivePlan, resyncPlanToGoogle, unarchivePlan } from "../plans/lifecycle.js";
import { isAnthropicConfigured, runPlanChatTurn } from "../integrations/anthropic/planChat.js";
import { loadAiDraft } from "../integrations/anthropic/draftStore.js";

export async function planRoutes(app: FastifyInstance) {
  app.get("/api/plans", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { includeArchived } = request.query as { includeArchived?: string };
    const showArchived = includeArchived === "1" || includeArchived === "true";

    const conditions = [eq(trainingPlans.userId, userId)];
    if (!showArchived) conditions.push(ne(trainingPlans.status, "archived"));

    const rows = await db
      .select({
        id: trainingPlans.id,
        name: trainingPlans.name,
        source: trainingPlans.source,
        status: trainingPlans.status,
        brief: trainingPlans.brief,
        importedAt: trainingPlans.importedAt,
        archivedAt: trainingPlans.archivedAt,
        runCount: count(plannedRuns.id),
      })
      .from(trainingPlans)
      .leftJoin(plannedRuns, eq(plannedRuns.planId, trainingPlans.id))
      .where(and(...conditions))
      .groupBy(trainingPlans.id)
      .orderBy(
        sql`CASE ${trainingPlans.status}
          WHEN 'active' THEN 0
          WHEN 'inactive' THEN 1
          ELSE 2 END`,
        desc(trainingPlans.importedAt),
      );

    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        source: r.source,
        status: r.status,
        brief: r.brief,
        importedAt: r.importedAt.toISOString(),
        archivedAt: r.archivedAt?.toISOString() ?? null,
        runCount: Number(r.runCount),
      })),
    };
  });

  app.post("/api/plans/:id/activate", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    try {
      await activatePlan(userId, id);
    } catch (err) {
      const code = err instanceof Error ? err.message : "UNKNOWN";
      if (code === "PLAN_NOT_FOUND") {
        reply.status(404).send({ error: { message: "Plan not found", code } });
        return;
      }
      if (code === "PLAN_ARCHIVED") {
        reply.status(400).send({ error: { message: "Unarchive the plan before activating", code } });
        return;
      }
      throw err;
    }
    return { ok: true, planId: id };
  });

  app.post("/api/plans/:id/archive", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    try {
      await archivePlan(userId, id);
    } catch (err) {
      const code = err instanceof Error ? err.message : "UNKNOWN";
      if (code === "PLAN_NOT_FOUND") {
        reply.status(404).send({ error: { message: "Plan not found", code } });
        return;
      }
      throw err;
    }
    return { ok: true, planId: id };
  });

  app.post("/api/plans/:id/resync-google", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    try {
      const result = await resyncPlanToGoogle(userId, id);
      return { ok: true, planId: id, ...result };
    } catch (err) {
      const code = err instanceof Error ? err.message : "UNKNOWN";
      if (code === "PLAN_NOT_FOUND") {
        reply.status(404).send({ error: { message: "Plan not found", code } });
        return;
      }
      if (code === "GOOGLE_NOT_CONNECTED") {
        reply
          .status(400)
          .send({ error: { message: "Connect Google Calendar in Settings first", code } });
        return;
      }
      if (code === "GOOGLE_NEEDS_REAUTH") {
        reply
          .status(400)
          .send({ error: { message: "Google Calendar access expired — reconnect it in Settings", code } });
        return;
      }
      throw err;
    }
  });

  app.post("/api/plans/:id/unarchive", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    try {
      await unarchivePlan(userId, id);
    } catch (err) {
      const code = err instanceof Error ? err.message : "UNKNOWN";
      if (code === "PLAN_NOT_FOUND") {
        reply.status(404).send({ error: { message: "Plan not found", code } });
        return;
      }
      throw err;
    }
    return { ok: true, planId: id };
  });

  app.post("/api/plans/ai/chat", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    if (!isAnthropicConfigured()) {
      reply.status(503).send({
        error: {
          message: "Anthropic is not configured. Set ANTHROPIC_API_KEY in .env.",
          code: "AI_NOT_CONFIGURED",
        },
      });
      return;
    }

    const body = planAiChatRequestSchema.parse(request.body);
    try {
      return await runPlanChatTurn({ userId, messages: body.messages });
    } catch (err) {
      logger.error({ err, userId }, "plan AI chat failed");
      reply.status(502).send({
        error: {
          message: err instanceof Error ? err.message : "AI chat failed",
          code: "AI_CHAT_FAILED",
        },
      });
    }
  });

  app.post("/api/plans/ai/commit", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const body = commitAiPlanSchema.parse(request.body);
    const stored = await loadAiDraft(body.draftToken);
    if (!stored || stored.meta.userId !== userId) {
      reply.status(404).send({ error: { message: "Draft not found or expired", code: "DRAFT_NOT_FOUND" } });
      return;
    }

    const draft = aiPlanDraftSchema.parse(stored.draft);
    const planName = body.planName?.trim() || draft.name;

    const [plan] = await db
      .insert(trainingPlans)
      .values({
        userId,
        name: planName,
        source: "ai_generated",
        status: "inactive",
        brief: stored.meta.brief,
      })
      .returning();
    if (!plan) throw new Error("failed to create AI training plan");

    let inserted = 0;
    for (const row of draft.runs) {
      await db.insert(plannedRuns).values({
        userId,
        planId: plan.id,
        scheduledAt: new Date(row.scheduledAt),
        durationMin: row.durationMin ?? null,
        distanceM: row.distanceM ?? null,
        runType: row.runType as RunType,
        targetPaceSPerKm: row.targetPaceSPerKm ?? null,
        plannedTss: row.plannedTss ?? null,
        description: row.description ?? null,
        structure: null,
        status: "planned",
        origin: "ai_generated",
      });
      inserted++;
    }

    await activatePlan(userId, plan.id);

    logger.info({ userId, planId: plan.id, inserted }, "AI training plan committed");

    return { planId: plan.id, inserted, updated: 0, skipped: 0 };
  });

  app.post("/api/plans/import/preview", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const parts = request.parts();
    let csvContent: string | null = null;
    let originalFilename = "upload.csv";
    let planStartDate: string | undefined;

    for await (const part of parts) {
      if (part.type === "file" && part.fieldname === "file") {
        originalFilename = part.filename;
        csvContent = (await part.toBuffer()).toString("utf8");
      } else if (part.type === "field" && part.fieldname === "planStartDate") {
        planStartDate = part.value as string;
      }
    }

    if (!csvContent) {
      reply.status(400).send({ error: { message: "No file uploaded", code: "MISSING_FILE" } });
      return;
    }

    const { rows, headerWarnings } = parseTrainingPeaksCsv(csvContent, planStartDate);
    const token = newUploadToken();
    await saveUpload(token, csvContent, {
      userId,
      originalFilename,
      planStartDate,
      createdAt: new Date().toISOString(),
    });

    return {
      uploadToken: token,
      planName: originalFilename.replace(/\.csv$/i, ""),
      rows,
      headerWarnings,
    };
  });

  app.post("/api/plans/import/commit", async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;

    const body = commitImportSchema.parse(request.body);
    const upload = await loadUpload(body.uploadToken);
    if (!upload || upload.meta.userId !== userId) {
      reply.status(404).send({ error: { message: "Upload not found or expired", code: "UPLOAD_NOT_FOUND" } });
      return;
    }

    const { rows } = parseTrainingPeaksCsv(upload.csvContent, upload.meta.planStartDate);
    const included = body.includeRowIndexes
      ? rows.filter((r) => body.includeRowIndexes!.includes(r.rowIndex))
      : rows;
    const importable = included.filter((r) => r.scheduledAt != null);
    const skipped = included.length - importable.length;

    const [plan] = await db
      .insert(trainingPlans)
      .values({
        userId,
        name: body.planName,
        source: "trainingpeaks_csv",
        status: "inactive",
        rawFile: upload.csvContent.length < 200_000 ? upload.csvContent : null,
      })
      .returning();
    if (!plan) throw new Error("failed to create training plan");

    let inserted = 0;
    let updated = 0;
    for (const row of importable) {
      if (!row.scheduledAt || !row.runType) continue;
      const scheduledAt = new Date(row.scheduledAt);

      const [existing] = await db
        .select({ id: plannedRuns.id })
        .from(plannedRuns)
        .where(
          and(
            eq(plannedRuns.userId, userId),
            eq(plannedRuns.planId, plan.id),
            eq(plannedRuns.scheduledAt, scheduledAt),
            eq(plannedRuns.runType, row.runType as RunType),
          ),
        );

      const values = {
        userId,
        planId: plan.id,
        scheduledAt,
        durationMin: row.durationMin,
        distanceM: row.distanceM,
        runType: row.runType as RunType,
        targetPaceSPerKm: row.targetPaceSPerKm,
        plannedTss: row.plannedTss,
        description: row.description,
        structure: null,
        status: "planned" as const,
        origin: "imported" as const,
      };

      if (existing) {
        await db
          .update(plannedRuns)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(plannedRuns.id, existing.id));
        updated++;
      } else {
        await db.insert(plannedRuns).values(values);
        inserted++;
      }
    }

    await activatePlan(userId, plan.id);

    logger.info({ userId, planId: plan.id, inserted, updated, skipped }, "training plan import committed");

    return {
      planId: plan.id,
      inserted,
      updated,
      skipped,
    };
  });
}
