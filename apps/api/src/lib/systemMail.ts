import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { hasGoogleConnection, sendGmail } from "../integrations/google/gmailClient.js";
import { getConnectionMetadata, setConnectionMetadata } from "../integrations/google/oauth.js";
import { logger } from "./logger.js";

/** Thrown when the mail transport itself is unusable (no admin, no Google connection, or a
 * revoked/expired grant) — as opposed to one message failing for some other reason. Callers
 * use this to distinguish "nobody can be emailed right now" from an unexpected error, and
 * degrade gracefully (e.g. still create the account, just skip the email) instead of 500ing. */
export class MailTransportDownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailTransportDownError";
  }
}

/** Detects Google's `invalid_grant` — the admin's Gmail refresh token was revoked or expired.
 * Duck-typed against the gaxios/google-auth-library error shape rather than importing gaxios
 * directly, since it's only a transitive dependency here. */
function isInvalidGrantError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const data = (err as { response?: { data?: { error?: string } } }).response?.data;
  return err.message === "invalid_grant" || data?.error === "invalid_grant";
}

/** Merge-updates the connection's metadata rather than overwriting it — other fields (e.g.
 * `calendarId`, set by calendarClient) live in the same JSON blob and must survive this. */
async function setGoogleConnectionInvalid(userId: string, invalidAt: string | null): Promise<void> {
  const existing = await getConnectionMetadata(userId);
  if ((existing?.invalidAt ?? null) === invalidAt) return; // no-op, skip the write
  await setConnectionMetadata(userId, { ...existing, invalidAt });
}

/** The admin whose Gmail grant sends all transactional email — same lookup `sendSystemMail`
 * uses, exposed so the backoffice can report on the transport's health without duplicating it. */
export async function findSystemMailAdmin(): Promise<{ id: string } | undefined> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .orderBy(users.createdAt)
    .limit(1);
  return admin;
}

/** Sends a transactional email (verification, password reset, etc.) via the admin's
 * connected Gmail account — there's no dedicated transactional-email provider, so the app's
 * own admin inbox is the sender. Throws loudly rather than swallowing the failure: a signup
 * or reset request that silently never sends is a dead end for whoever's waiting on it.
 * Throws `MailTransportDownError` specifically when the transport itself is unusable, so
 * callers can choose to degrade instead of failing the whole request. */
export async function sendSystemMail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const admin = await findSystemMailAdmin();

  if (!admin) {
    logger.error("no admin user found — cannot send system email");
    throw new MailTransportDownError("System email is not configured (no admin user)");
  }
  if (!(await hasGoogleConnection(admin.id))) {
    logger.error({ adminId: admin.id }, "admin has no connected Google account — cannot send system email");
    throw new MailTransportDownError("System email is not configured (admin has no Google connection)");
  }

  try {
    await sendGmail(admin.id, params);
    // A send that succeeds after an earlier invalid_grant means the admin reconnected —
    // clear the stale flag so the backoffice banner (and this same check) stop firing.
    await setGoogleConnectionInvalid(admin.id, null).catch((metaErr) =>
      logger.error({ err: metaErr, adminId: admin.id }, "failed to clear invalid google connection flag"),
    );
  } catch (err) {
    if (isInvalidGrantError(err)) {
      logger.error(
        { adminId: admin.id },
        "admin's Google grant is revoked/expired (invalid_grant) — system email is down until reconnected",
      );
      await setGoogleConnectionInvalid(admin.id, new Date().toISOString()).catch((metaErr) =>
        logger.error({ err: metaErr, adminId: admin.id }, "failed to record invalid google connection"),
      );
      throw new MailTransportDownError("System email is unavailable (admin's Google grant was revoked)");
    }
    throw err;
  }
}
