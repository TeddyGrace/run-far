import { and, eq } from "drizzle-orm";
import type { RunType, ScheduleChangeProposal } from "@run-far/shared";
import { db } from "../db/client.js";
import { plannedRuns } from "../db/schema.js";
import { pushPlannedRunToGoogle, deletePlannedRunFromGoogle } from "../integrations/google/push.js";
import { logger } from "../lib/logger.js";

export interface ApplyResult {
  created: number;
  updated: number;
  deleted: number;
}

/**
 * Executes a confirmed schedule-change proposal against planned_runs, scoped to `userId`.
 * Items are not re-validated against coaching constraints here — the athlete already saw
 * and confirmed the human-readable summary; this just performs the writes.
 */
export async function applyScheduleChanges(
  userId: string,
  proposal: ScheduleChangeProposal,
): Promise<ApplyResult> {
  const result: ApplyResult = { created: 0, updated: 0, deleted: 0 };

  for (const item of proposal.items) {
    if (item.op === "create") {
      if (!item.scheduledAt || !item.runType) continue;
      const [run] = await db
        .insert(plannedRuns)
        .values({
          userId,
          planId: null,
          scheduledAt: new Date(item.scheduledAt),
          durationMin: item.durationMin ?? null,
          distanceM: item.distanceM ?? null,
          runType: item.runType as RunType,
          targetPaceSPerKm: item.targetPaceSPerKm ?? null,
          plannedTss: item.plannedTss ?? null,
          description: item.description ?? null,
          structure: null,
          status: "planned",
          origin: "ai_generated",
        })
        .returning();
      if (run) {
        result.created++;
        pushPlannedRunToGoogle(run.id, userId).catch((err) =>
          logger.error({ err, runId: run.id }, "assistant: failed to push created run to google"),
        );
      }
      continue;
    }

    if (item.op === "update") {
      if (!item.runId) continue;
      const [existing] = await db
        .select({ id: plannedRuns.id })
        .from(plannedRuns)
        .where(and(eq(plannedRuns.id, item.runId), eq(plannedRuns.userId, userId)));
      if (!existing) continue;

      const values: Partial<typeof plannedRuns.$inferInsert> = { updatedAt: new Date() };
      if (item.scheduledAt !== undefined && item.scheduledAt !== null) values.scheduledAt = new Date(item.scheduledAt);
      if (item.runType !== undefined && item.runType !== null) values.runType = item.runType as RunType;
      if (item.durationMin !== undefined) values.durationMin = item.durationMin;
      if (item.distanceM !== undefined) values.distanceM = item.distanceM;
      if (item.targetPaceSPerKm !== undefined) values.targetPaceSPerKm = item.targetPaceSPerKm;
      if (item.plannedTss !== undefined) values.plannedTss = item.plannedTss;
      if (item.description !== undefined) values.description = item.description;

      await db.update(plannedRuns).set(values).where(eq(plannedRuns.id, item.runId));
      result.updated++;
      pushPlannedRunToGoogle(item.runId, userId).catch((err) =>
        logger.error({ err, runId: item.runId }, "assistant: failed to push updated run to google"),
      );
      continue;
    }

    if (item.op === "delete") {
      if (!item.runId) continue;
      const [existing] = await db
        .select({ id: plannedRuns.id, gcalEventId: plannedRuns.gcalEventId })
        .from(plannedRuns)
        .where(and(eq(plannedRuns.id, item.runId), eq(plannedRuns.userId, userId)));
      if (!existing) continue;

      await db.delete(plannedRuns).where(eq(plannedRuns.id, item.runId));
      result.deleted++;
      deletePlannedRunFromGoogle(existing.gcalEventId, userId).catch((err) =>
        logger.error({ err, runId: item.runId }, "assistant: failed to delete run from google"),
      );
    }
  }

  return result;
}
