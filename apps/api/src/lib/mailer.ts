import { Resend } from "resend";
import { env } from "../env.js";
import { logger } from "./logger.js";

/** Thrown when the mail transport itself is unusable (no API key configured, or Resend
 * rejects the request for a config reason like an invalid key or unverified sending domain)
 * — as opposed to one message failing for some other reason. Callers use this to distinguish
 * "nobody can be emailed right now" from an unexpected error, and degrade gracefully (e.g.
 * still create the account, just skip the email) instead of 500ing. */
export class MailTransportDownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailTransportDownError";
  }
}

let resendClient: Resend | undefined;
function getResendClient(): Resend {
  resendClient ??= new Resend(env.RESEND_API_KEY);
  return resendClient;
}

/** Sends a transactional email (auth mail, the recovery digest, etc.) via Resend, from
 * `MAIL_FROM`. In development with no `RESEND_API_KEY` configured, logs the message instead
 * of sending — lets signup/reset flows (which embed a URL in `text`) be exercised locally
 * with no account and no network. Throws loudly rather than swallowing the failure: a signup
 * or reset request that silently never sends is a dead end for whoever's waiting on it.
 * Throws `MailTransportDownError` specifically when the transport itself is unusable, so
 * callers can choose to degrade instead of failing the whole request. */
export async function sendMail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  if (!env.RESEND_API_KEY) {
    if (env.NODE_ENV === "production") {
      logger.error("RESEND_API_KEY is not configured — cannot send email");
      throw new MailTransportDownError("Email is not configured (no RESEND_API_KEY)");
    }
    logger.info(
      { to: params.to, subject: params.subject, text: params.text },
      "RESEND_API_KEY not set — logging email instead of sending",
    );
    return;
  }

  const { error } = await getResendClient().emails.send({
    from: env.MAIL_FROM,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    ...(env.MAIL_REPLY_TO ? { replyTo: env.MAIL_REPLY_TO } : {}),
  });

  if (error) {
    // Resend's SDK resolves with { error } rather than rejecting on API failures, so this
    // check is load-bearing — an unchecked error here would silently drop the email exactly
    // like the outage this transport replaced.
    const isConfigError =
      error.statusCode === 401 || error.statusCode === 403 || error.name === "validation_error";
    logger.error({ err: error, to: params.to }, "failed to send email via Resend");
    if (isConfigError) {
      throw new MailTransportDownError(`Email transport is unavailable (${error.name})`);
    }
    throw new Error(`Resend send failed: ${error.message}`);
  }
}
