import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";

const { db } = await import("../db/client.js");
const { users } = await import("../db/schema.js");
const { buildServer } = await import("../server.js");
const { SESSION_COOKIE } = await import("../lib/session.js");
const { inArray } = await import("drizzle-orm");

const ROUTE = {
  name: "Park loop",
  source: "manual",
  distanceM: 4828,
  waypoints: [
    [40.78, -73.96],
    [40.79, -73.95],
    [40.78, -73.96],
  ],
  geometry: [
    [40.78, -73.96],
    [40.785, -73.955],
    [40.79, -73.95],
    [40.78, -73.96],
  ],
};

describe("saved routes", () => {
  const ids: string[] = [];
  let app: Awaited<ReturnType<typeof buildServer>>;

  async function seedUser() {
    const [row] = await db
      .insert(users)
      .values({
        email: `routes-test-${randomUUID()}@run-far.local`,
        emailVerifiedAt: new Date(),
        entitlementSource: "comp",
        entitlementStatus: "active",
      })
      .returning({ id: users.id });
    ids.push(row!.id);
    return row!.id;
  }

  beforeAll(async () => {
    app = await buildServer();
  });
  afterAll(async () => {
    await app.close();
    if (ids.length) await db.delete(users).where(inArray(users.id, ids));
  });

  it("saves, lists and deletes a route, scoped to its owner", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const as = (id: string) => ({ [SESSION_COOKIE]: app.signCookie(id) });

    const created = await app.inject({ method: "POST", url: "/api/routes", cookies: as(owner), payload: ROUTE });
    expect(created.statusCode).toBe(201);
    const saved = created.json();
    expect(saved).toMatchObject({ name: "Park loop", source: "manual", distanceM: 4828, notes: null });
    expect(saved.geometry).toHaveLength(4);

    const mine = await app.inject({ method: "GET", url: "/api/routes", cookies: as(owner) });
    expect(mine.json().items.map((r: { id: string }) => r.id)).toEqual([saved.id]);

    const theirs = await app.inject({ method: "GET", url: "/api/routes", cookies: as(other) });
    expect(theirs.json().items).toEqual([]);

    // Another athlete can't delete it, and a malformed id is a 404, not a database error.
    expect((await app.inject({ method: "DELETE", url: `/api/routes/${saved.id}`, cookies: as(other) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/routes/not-a-uuid", cookies: as(owner) })).statusCode).toBe(404);

    expect((await app.inject({ method: "DELETE", url: `/api/routes/${saved.id}`, cookies: as(owner) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/routes", cookies: as(owner) })).json().items).toEqual([]);
  });

  it("rejects a route with out-of-range coordinates", async () => {
    const owner = await seedUser();
    const res = await app.inject({
      method: "POST",
      url: "/api/routes",
      cookies: { [SESSION_COOKIE]: app.signCookie(owner) },
      payload: { ...ROUTE, waypoints: [[95, 0], [0, 0]] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/routes" })).statusCode).toBe(401);
  });
});
