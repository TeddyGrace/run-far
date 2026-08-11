import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WHOOP_CLIENT_ID ??= "test-client-id";
process.env.WHOOP_CLIENT_SECRET ??= "test-client-secret";

const { db } = await import("../../db/client.js");
const { users, oauthConnections } = await import("../../db/schema.js");
const { encryptSecret } = await import("../../lib/crypto.js");
const { whoopGet } = await import("./client.js");
const { eq } = await import("drizzle-orm");

let userId: string;
let tokenRequestCount = 0;

beforeEach(async () => {
  tokenRequestCount = 0;
  const [user] = await db
    .insert(users)
    .values({ email: `client-test-${randomUUID()}@run-far.local`, passwordHash: "x" })
    .returning({ id: users.id });
  userId = user!.id;

  await db.insert(oauthConnections).values({
    userId,
    provider: "whoop",
    accessTokenEnc: encryptSecret("stale-access-token"),
    refreshTokenEnc: encryptSecret("original-refresh-token"),
    // Already expired, so the first request must refresh before it can call the API.
    expiresAt: new Date(Date.now() - 1000),
    scopes: ["offline"],
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/oauth/oauth2/token")) {
        tokenRequestCount++;
        // A slow refresh response widens the window for a second concurrent call to race in.
        await new Promise((r) => setTimeout(r, 20));
        return new Response(
          JSON.stringify({
            access_token: `fresh-access-token-${tokenRequestCount}`,
            refresh_token: `rotated-refresh-token-${tokenRequestCount}`,
            expires_in: 3600,
            scope: "offline",
            token_type: "Bearer",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
});

afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
  vi.unstubAllGlobals();
});

describe("whoopGet refresh concurrency", () => {
  it("refreshes exactly once when two requests race against an expired token", async () => {
    await Promise.all([whoopGet(userId, "/v2/user/profile/basic"), whoopGet(userId, "/v2/user/profile/basic")]);
    expect(tokenRequestCount).toBe(1);

    const [conn] = await db.select().from(oauthConnections).where(eq(oauthConnections.userId, userId));
    expect(conn?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
