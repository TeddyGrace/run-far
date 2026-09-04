import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";

const { db } = await import("../db/client.js");
const { users } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("../lib/session.js");
const { inArray, eq } = await import("drizzle-orm");

/**
 * Regression coverage for the AI-cost control that gates the model picker to admins: model
 * choice drives which (potentially far pricier) Anthropic model gets billed per request, so a
 * plain user's assistantModel/planModel in a PATCH must be silently dropped, not honored — see
 * integrations/anthropic/{assistantChat,planChat}.ts, which now only reads the stored override
 * for an admin row.
 */
describe("PATCH /api/settings model override", () => {
  let createdIds: string[];

  afterEach(async () => {
    await db.delete(users).where(inArray(users.id, createdIds));
  });

  async function seedUser(role: "user" | "admin") {
    const stamp = randomUUID();
    const [row] = await db
      .insert(users)
      .values({
        email: `settings-test-${stamp}@run-far.local`,
        emailVerifiedAt: new Date(),
        entitlementSource: "comp",
        entitlementStatus: "active",
        role,
      })
      .returning({ id: users.id });
    if (!row) throw new Error("failed to seed test user");
    createdIds = [row.id];
    return row.id;
  }

  it("drops a plain user's assistantModel/planModel instead of saving them", async () => {
    const userId = await seedUser("user");
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/settings",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { assistantModel: "claude-opus-5", planModel: "claude-opus-5" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ assistantModel: null, planModel: null, canChooseModel: false });

      const [row] = await db.select().from(users).where(eq(users.id, userId));
      expect(row?.assistantModel).toBeNull();
      expect(row?.planModel).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("saves an admin's assistantModel/planModel", async () => {
    const userId = await seedUser("admin");
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/settings",
        cookies: { [SESSION_COOKIE]: app.signCookie(userId) },
        payload: { assistantModel: "claude-opus-5", planModel: "claude-opus-5" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        assistantModel: "claude-opus-5",
        planModel: "claude-opus-5",
        canChooseModel: true,
      });
    } finally {
      await app.close();
    }
  });
});
