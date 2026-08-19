import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { hasGoogleConnection, sendGmail } from "../integrations/google/gmailClient.js";
import { logger } from "./logger.js";

/** Sends a transactional email (verification, password reset, etc.) via the admin's
 * connected Gmail account — there's no dedicated transactional-email provider, so the app's
 * own admin inbox is the sender. Throws loudly rather than swallowing the failure: a signup
 * or reset request that silently never sends is a dead end for whoever's waiting on it. */
export async function sendSystemMail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .orderBy(users.createdAt)
    .limit(1);

  if (!admin) {
    logger.error("no admin user found — cannot send system email");
    throw new Error("System email is not configured (no admin user)");
  }
  if (!(await hasGoogleConnection(admin.id))) {
    logger.error({ adminId: admin.id }, "admin has no connected Google account — cannot send system email");
    throw new Error("System email is not configured (admin has no Google connection)");
  }

  await sendGmail(admin.id, params);
}
