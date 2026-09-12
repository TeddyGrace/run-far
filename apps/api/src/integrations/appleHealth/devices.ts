import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "../../db/client.js";
import { healthIngestDevices } from "../../db/schema.js";

/**
 * Device registrations for Apple Health push.
 *
 * See the healthIngestDevices schema comment for why a bearer token exists at all when
 * everything else uses the session cookie: HealthKit background delivery wakes native code
 * with no WebView, and native code cannot read the WebView's cookies.
 */

/** Registration cap per athlete. Not a security boundary — a legitimate athlete has one or two
 * devices, and an unbounded list would let a loop in the app mint thousands of live
 * credentials, each one a thing that has to be revoked later. */
const MAX_ACTIVE_DEVICES = 8;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface RegisteredDevice {
  id: string;
  /** The raw token. Returned exactly once, at registration — only its hash is persisted, so it
   * cannot be recovered or re-shown. The app must store it in the Keychain immediately. */
  token: string;
}

/**
 * Register a device and issue its push token.
 *
 * Called from inside the WebView, so it is authenticated by the ordinary session cookie: the
 * athlete is signed in, taps "Connect Apple Health", and the token this returns is handed
 * straight to the native side to keep. That is the whole trust chain — a token is only ever
 * issued to an already-authenticated session on the athlete's own device.
 */
export async function registerDevice(userId: string, label: string | null): Promise<RegisteredDevice> {
  const active = await listDevices(userId);
  if (active.length >= MAX_ACTIVE_DEVICES) {
    // Revoke the least recently used rather than refusing: an athlete who has reinstalled the
    // app eight times should not be locked out of syncing on the ninth, and the stale
    // registrations are exactly the ones with nothing behind them.
    const oldest = active[active.length - 1]!;
    await revokeDevice(userId, oldest.id);
  }

  const token = randomBytes(32).toString("base64url");
  const [row] = await db
    .insert(healthIngestDevices)
    .values({ userId, label, tokenHash: hashToken(token) })
    .returning({ id: healthIngestDevices.id });

  return { id: row!.id, token };
}

/**
 * Resolve a bearer token to the athlete it pushes for, or null.
 *
 * The lookup is by hash, so the stored value is useless for authenticating. The constant-time
 * compare that follows is belt-and-braces on top of that: the hash is already the index key, so
 * this is not the primary defence, but a plain `===` on a credential is the kind of thing that
 * gets copied into code where it does matter.
 */
export async function resolveDeviceToken(token: string): Promise<{ userId: string; deviceId: string } | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const [row] = await db
    .select({
      id: healthIngestDevices.id,
      userId: healthIngestDevices.userId,
      tokenHash: healthIngestDevices.tokenHash,
      revokedAt: healthIngestDevices.revokedAt,
    })
    .from(healthIngestDevices)
    .where(eq(healthIngestDevices.tokenHash, tokenHash));

  if (!row || row.revokedAt) return null;

  const a = Buffer.from(row.tokenHash);
  const b = Buffer.from(tokenHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return { userId: row.userId, deviceId: row.id };
}

/** Stamp a successful push. Best-effort bookkeeping for the Settings list — a failure here must
 * never fail an ingest that already succeeded. */
export async function touchDevice(deviceId: string): Promise<void> {
  await db
    .update(healthIngestDevices)
    .set({ lastSeenAt: new Date() })
    .where(eq(healthIngestDevices.id, deviceId));
}

export async function listDevices(userId: string) {
  return db
    .select({
      id: healthIngestDevices.id,
      label: healthIngestDevices.label,
      createdAt: healthIngestDevices.createdAt,
      lastSeenAt: healthIngestDevices.lastSeenAt,
    })
    .from(healthIngestDevices)
    .where(and(eq(healthIngestDevices.userId, userId), isNull(healthIngestDevices.revokedAt)))
    // Most recently active first; a never-used registration sorts last, which is also the order
    // the eviction above wants.
    .orderBy(desc(healthIngestDevices.lastSeenAt), desc(healthIngestDevices.createdAt));
}

/** Revoke by id, scoped to the owner so one athlete can't revoke another's device. Idempotent:
 * revoking an already-revoked or unknown device reports false rather than failing. */
export async function revokeDevice(userId: string, deviceId: string): Promise<boolean> {
  const rows = await db
    .update(healthIngestDevices)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(healthIngestDevices.id, deviceId),
        eq(healthIngestDevices.userId, userId),
        isNull(healthIngestDevices.revokedAt),
      ),
    )
    .returning({ id: healthIngestDevices.id });
  return rows.length > 0;
}
