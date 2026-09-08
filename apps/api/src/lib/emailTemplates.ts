import { env } from "../env.js";

function wrap(bodyHtml: string): string {
  return `<div style="font-family:sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;max-width:480px">
    <p style="letter-spacing:0.1em;text-transform:uppercase;font-size:11px;color:#4fb0a6">run-far</p>
    ${bodyHtml}
  </div>`;
}

export function verificationEmail(token: string): { subject: string; html: string; text: string } {
  const url = `${env.WEB_ORIGIN}/verify-email?token=${encodeURIComponent(token)}`;
  return {
    subject: "Verify your run-far email",
    html: wrap(
      `<p>Confirm this email to finish creating your run-far account.</p>
       <p><a href="${url}" style="color:#4fb0a6">Verify email</a></p>
       <p style="color:#666;font-size:13px">This link expires in 24 hours. If you didn't request this, you can ignore it.</p>`,
    ),
    text: `Confirm this email to finish creating your run-far account:\n${url}\n\nThis link expires in 24 hours. If you didn't request this, you can ignore it.`,
  };
}

export function alreadyHasAccountEmail(): { subject: string; html: string; text: string } {
  const loginUrl = `${env.WEB_ORIGIN}/login`;
  const resetUrl = `${env.WEB_ORIGIN}/forgot-password`;
  return {
    subject: "You already have a run-far account",
    html: wrap(
      `<p>Someone tried to sign up with this email, but an account already exists.</p>
       <p>You can <a href="${loginUrl}" style="color:#4fb0a6">sign in</a> (with Google or your
       password), or <a href="${resetUrl}" style="color:#4fb0a6">reset your password</a> if
       you've forgotten it.</p>
       <p style="color:#666;font-size:13px">If this wasn't you, no action is needed.</p>`,
    ),
    text: `Someone tried to sign up with this email, but an account already exists.\n\nSign in: ${loginUrl}\nReset your password: ${resetUrl}\n\nIf this wasn't you, no action is needed.`,
  };
}

/** Sent when someone tries to sign in with a password to an account that has none — i.e. a
 * Google-only account. The login screen can't say this (it would confirm the address exists
 * and how it signs in), but the inbox can: only the real owner reads it, and if they weren't
 * the one typing, it's a heads-up that someone is guessing at their account. Deliberately
 * carries no reset token — it links to /forgot-password so the owner asks for their own
 * link, which keeps a stranger's failed login from invalidating a reset the owner already
 * requested. */
export function passwordLoginOnGoogleAccountEmail(): { subject: string; html: string; text: string } {
  const loginUrl = `${env.WEB_ORIGIN}/login`;
  const resetUrl = `${env.WEB_ORIGIN}/forgot-password`;
  return {
    subject: "Trouble signing in to run-far?",
    html: wrap(
      `<p>Someone just tried to sign in to run-far with a password for this email, but this
       account signs in with Google and doesn't have a password.</p>
       <p>If that was you: <a href="${loginUrl}" style="color:#4fb0a6">Continue with Google</a>
       on the sign-in page. To use a password as well, you can
       <a href="${resetUrl}" style="color:#4fb0a6">set one here</a> — same account either way.</p>
       <p style="color:#666;font-size:13px">If it wasn't you, nothing has changed and no one got
       in. You don't need to do anything.</p>`,
    ),
    text: `Someone just tried to sign in to run-far with a password for this email, but this account signs in with Google and doesn't have a password.\n\nIf that was you, use "Continue with Google": ${loginUrl}\nTo use a password as well, set one here: ${resetUrl}\n\nIf it wasn't you, nothing has changed and no one got in. You don't need to do anything.`,
  };
}

export function passwordResetEmail(token: string): { subject: string; html: string; text: string } {
  const url = `${env.WEB_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`;
  return {
    subject: "Reset your run-far password",
    html: wrap(
      `<p>Click below to choose a new password.</p>
       <p><a href="${url}" style="color:#4fb0a6">Reset password</a></p>
       <p style="color:#666;font-size:13px">This link expires in 1 hour. If you didn't request this, you can ignore it.</p>`,
    ),
    text: `Click below to choose a new password:\n${url}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore it.`,
  };
}

export function inviteEmail(): { subject: string; html: string; text: string } {
  const signupUrl = `${env.WEB_ORIGIN}/signup`;
  return {
    subject: "You're invited to run-far",
    html: wrap(
      `<p>You've been invited to run-far.</p>
       <p><a href="${signupUrl}" style="color:#4fb0a6">Create your account</a> — you're already
       approved, so you'll be in as soon as you sign up. You can use Google or a password.</p>`,
    ),
    text: `You've been invited to run-far.\n\nCreate your account — you're already approved, so you'll be in as soon as you sign up:\n${signupUrl}`,
  };
}

export function accessApprovedEmail(): { subject: string; html: string; text: string } {
  const loginUrl = `${env.WEB_ORIGIN}/login`;
  return {
    subject: "You're in — run-far access approved",
    html: wrap(
      `<p>Your run-far account has been approved.</p>
       <p><a href="${loginUrl}" style="color:#4fb0a6">Sign in</a> to get started.</p>`,
    ),
    text: `Your run-far account has been approved.\n\nSign in: ${loginUrl}`,
  };
}
