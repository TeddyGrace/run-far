import { randomBytes, createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { authTokens } from "../db/schema.js";

const EXPIRY_MS: Record<"email_verification" | "password_reset", number> = {
  email_verification: 24 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Issues a fresh single-use token for the given user + purpose, invalidating any prior
 * unused tokens of the same purpose first so an old emailed link stops working once a new
 * one is requested. Returns the raw token — callers must email it immediately; only its
 * hash is persisted. */
export async function issueAuthToken(
  userId: string,
  purpose: "email_verification" | "password_reset",
): Promise<string> {
  await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt)));

  const token = randomBytes(32).toString("base64url");
  await db.insert(authTokens).values({
    userId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + EXPIRY_MS[purpose]),
  });
  return token;
}

/** Verifies and consumes a token. Returns the userId on success, or null if the token is
 * unknown, already used, or expired. */
export async function consumeAuthToken(
  token: string,
  purpose: "email_verification" | "password_reset",
): Promise<string | null> {
  const tokenHash = hashToken(token);
  const [row] = await db.select().from(authTokens).where(eq(authTokens.tokenHash, tokenHash));
  if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt < new Date()) return null;

  await db.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, row.id));
  return row.userId;
}
