import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, invitedEmails } from "../db/schema.js";
import { env } from "../env.js";
import { logger } from "./logger.js";

/**
 * Reconciles the ADMIN_EMAILS allowlist into the users table on every boot.
 *
 * Before this existed, `role` was granted only by data migration
 * (drizzle/0018_handy_maddog.sql), which made admin a one-way door: once the last admin row
 * was deleted or locked out, nothing inside the app could mint a replacement and the
 * backoffice was orphaned for good. Routes now refuse to destroy an admin (see
 * routes/admin.ts, ADMIN_TARGET), and this is the break-glass for a database that's already
 * in that state — including one where the row is gone entirely: the invite is re-seeded so
 * the operator can sign up again, and the next boot promotes the fresh row.
 *
 * Deliberately additive. It grants and un-disables, but never demotes an admin who's absent
 * from the list — dropping the env var on one deploy must not silently strip access.
 */
export async function reconcileAdminEmails(): Promise<void> {
  if (env.adminEmails.size === 0) {
    logger.warn(
      "ADMIN_EMAILS is unset — no admin can be restored from config if the backoffice is locked out",
    );
    return;
  }

  for (const email of env.adminEmails) {
    try {
      // Seed the invite first: a deleted admin has to get back through signup, and
      // isEmailAllowedToSignUp (routes/auth.ts) fails closed in production without this.
      await db.insert(invitedEmails).values({ email }).onConflictDoNothing();

      const [user] = await db
        .select({
          id: users.id,
          role: users.role,
          disabledAt: users.disabledAt,
          approvedAt: users.approvedAt,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(eq(users.email, email));

      if (!user) {
        logger.warn(
          { email },
          "ADMIN_EMAILS entry has no account yet — invite seeded; sign up, then redeploy to be promoted",
        );
        continue;
      }

      const alreadyGood =
        user.role === "admin" && !user.disabledAt && user.approvedAt && user.emailVerifiedAt;
      if (alreadyGood) continue;

      const now = new Date();
      await db
        .update(users)
        .set({
          role: "admin",
          disabledAt: null,
          // Don't overwrite a real approval/verification timestamp — only fill in a missing
          // one, so the backoffice keeps showing when access was actually granted.
          approvedAt: user.approvedAt ?? now,
          emailVerifiedAt: user.emailVerifiedAt ?? now,
        })
        .where(eq(users.id, user.id));

      logger.warn(
        { email, previousRole: user.role, wasDisabled: user.disabledAt != null },
        "admin restored from ADMIN_EMAILS",
      );
    } catch (err) {
      // One bad entry must not stop the others, and must not take the API down: this runs
      // after listen(), so a throw here would kill an otherwise healthy process.
      logger.error({ err, email }, "failed to reconcile ADMIN_EMAILS entry");
    }
  }
}
