import { MailTransportDownError, sendMail } from "./mailer.js";

export { MailTransportDownError };

/** Sends a transactional email (verification, password reset, etc.) via Resend. Thin
 * pass-through kept as its own export so callers (routes/auth.ts, routes/admin.ts) don't
 * need to know about the underlying transport. */
export async function sendSystemMail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  await sendMail(params);
}
