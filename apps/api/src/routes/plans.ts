import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { commitImportSchema } from "@run-far/shared";
import { requireUserId } from "../lib/session.js";
import { parseTrainingPeaksCsv } from "../integrations/trainingpeaks/parser.js";
import { newUploadToken, saveUpload, loadUpload } from "../integrations/trainingpeaks/uploadStore.js";
import { pushPlannedRunToGoogle } from "../integrations/google/push.js";
import { db } from "../db/client.js";
import { trainingPlans, plannedRuns } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import type { RunType } from "@run-far/shared";

export async function planRoutes(app: FastifyInstance) {
  // Multipart upload -> parse -> preview. Nothing is written to planned_runs yet.
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

  // Commits a previously previewed upload. Re-parses from the saved file (not the client's
  // preview payload) so the server is the single source of truth for what actually gets written.
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
        rawFile: upload.csvContent.length < 200_000 ? upload.csvContent : null,
      })
      .returning();
    if (!plan) throw new Error("failed to create training plan");

    let inserted = 0;
    let updated = 0;
    for (const row of importable) {
      if (!row.scheduledAt || !row.runType) continue;
      const scheduledAt = new Date(row.scheduledAt);

      // Reconcile against a prior import of the same plan: match on (plan, time, type)
      // rather than blind-inserting, so re-uploading the same file doesn't duplicate rows.
      const [existing] = await db
        .select({ id: plannedRuns.id })
        .from(plannedRuns)
        .where(
          and(
            eq(plannedRuns.userId, userId),
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

      let runId: string;
      if (existing) {
        await db
          .update(plannedRuns)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(plannedRuns.id, existing.id));
        runId = existing.id;
        updated++;
      } else {
        const [created] = await db.insert(plannedRuns).values(values).returning({ id: plannedRuns.id });
        runId = created!.id;
        inserted++;
      }
      // Bulk imports can be dozens of rows; push to Google in the background so the
      // commit response doesn't wait on one Calendar API call per row.
      pushPlannedRunToGoogle(runId, userId).catch((err) =>
        logger.error({ err, runId }, "failed to push imported run to google"),
      );
    }

    logger.info({ userId, planId: plan.id, inserted, updated, skipped }, "training plan import committed");

    return {
      planId: plan.id,
      inserted,
      updated,
      skipped,
    };
  });
}
