import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";

const { db } = await import("../db/client.js");
const { users, appSettings } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("../lib/session.js");
const { isModelRenderedFor, APP_SETTINGS_ID } = await import("../lib/modelRendering.js");
const { eq, inArray } = await import("drizzle-orm");

let adminId: string;
let athleteId: string;

beforeEach(async () => {
  const stamp = randomUUID();
  const rows = await db
    .insert(users)
    .values([
      { email: `settings-admin-${stamp}@run-far.local`, role: "admin" as const },
      {
        email: `settings-athlete-${stamp}@run-far.local`,
        // Comped so the entitlement guard passes and it is the *admin* guard that rejects the
        // request below — otherwise the assertion would pass on a 402 and prove nothing.
        entitlementSource: "comp" as const,
        entitlementStatus: "active" as const,
      },
    ])
    .returning({ id: users.id });
  adminId = rows[0]!.id;
  athleteId = rows[1]!.id;
});

afterEach(async () => {
  await db.delete(users).where(inArray(users.id, [adminId, athleteId]));
  // Leave the singleton as the migration seeded it, so suites don't leak state into each other.
  await db
    .update(appSettings)
    .set({ modelRenderedDefault: false, updatedBy: null })
    .where(eq(appSettings.id, APP_SETTINGS_ID));
});

async function asAdmin(
  app: Awaited<ReturnType<typeof buildServer>>,
  method: "GET" | "PATCH" | "POST" | "DELETE",
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    payload: payload as never,
    cookies: { [SESSION_COOKIE]: app.signCookie(adminId) },
  });
}

describe("recommendation engine settings", () => {
  it("requires an admin session", async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/settings",
        cookies: { [SESSION_COOKIE]: app.signCookie(athleteId) },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("flips the global default and takes effect for accounts on inherit", async () => {
    const app = await buildServer();
    try {
      expect(await isModelRenderedFor(athleteId)).toBe(false);

      const res = await asAdmin(app, "PATCH", "/api/admin/settings", {
        modelRenderedDefault: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().modelRenderedDefault).toBe(true);

      expect(await isModelRenderedFor(athleteId)).toBe(true);

      // Attribution, same pattern as compedBy on a comp grant.
      const [row] = await db
        .select({ updatedBy: appSettings.updatedBy })
        .from(appSettings)
        .where(eq(appSettings.id, APP_SETTINGS_ID));
      expect(row?.updatedBy).toBe(adminId);
    } finally {
      await app.close();
    }
  });

  it("lets a per-account override win over the global default, in both directions", async () => {
    const app = await buildServer();
    try {
      await asAdmin(app, "PATCH", "/api/admin/settings", { modelRenderedDefault: true });

      await asAdmin(app, "POST", `/api/admin/users/${athleteId}/model-rendering`, {
        rendered: false,
      });
      expect(await isModelRenderedFor(athleteId)).toBe(false);

      await asAdmin(app, "PATCH", "/api/admin/settings", { modelRenderedDefault: false });
      await asAdmin(app, "POST", `/api/admin/users/${athleteId}/model-rendering`, {
        rendered: true,
      });
      expect(await isModelRenderedFor(athleteId)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns an account to the global default when the override is cleared", async () => {
    const app = await buildServer();
    try {
      await asAdmin(app, "POST", `/api/admin/users/${athleteId}/model-rendering`, {
        rendered: true,
      });
      await asAdmin(app, "PATCH", "/api/admin/settings", { modelRenderedDefault: false });
      expect(await isModelRenderedFor(athleteId)).toBe(true);

      const res = await asAdmin(app, "DELETE", `/api/admin/users/${athleteId}/model-rendering`);
      expect(res.statusCode).toBe(200);
      expect(res.json().modelRenderedOverride).toBeNull();
      expect(await isModelRenderedFor(athleteId)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("404s on an unknown account", async () => {
    const app = await buildServer();
    try {
      const res = await asAdmin(app, "DELETE", `/api/admin/users/${randomUUID()}/model-rendering`);
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
