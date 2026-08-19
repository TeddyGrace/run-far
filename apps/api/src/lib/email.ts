/** Canonical form for every stored/compared email in the system — trim + lowercase.
 * Google's ID token email and the password-login email must both go through this or an
 * account created via one path (e.g. "Foo@Gmail.com") won't match the other
 * ("foo@gmail.com") and the two never merge. Does not fold gmail dot/plus aliases — those
 * are distinct mailboxes as far as this app is concerned. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
