import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    return { status: "ok", uptimeSec: process.uptime() };
  });

  app.get("/health/db", async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: "ok" };
    } catch (err) {
      reply.status(503);
      return { status: "unreachable", error: (err as Error).message };
    }
  });
}
