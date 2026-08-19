import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";

const LEGACY_KEY_LENGTH = 64;

/** Tuned so a hash takes roughly 100-250ms on the Railway instance. */
const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

/** Hashes a password with argon2id. The encoded string argon2 returns carries its own
 * params and a leading "$", which is how verifyPassword tells it apart from a legacy
 * "salt:hash" scrypt string below. */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTS);
}

function verifyLegacyScrypt(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, LEGACY_KEY_LENGTH);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** True if `stored` was produced by the old hashPassword (pre-argon2). */
export function isLegacyHash(stored: string): boolean {
  return !stored.startsWith("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (isLegacyHash(stored)) return verifyLegacyScrypt(password, stored);
  return argon2.verify(stored, password);
}

// A real argon2id hash of a random value, computed once (lazily) so the dummy verify below
// pays the same cost as a real one without blocking module load on a ~200ms hash.
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = argon2.hash(randomBytes(32).toString("hex"), ARGON2_OPTS);
  return dummyHash;
}

/** Constant-time-ish dummy verify for a login attempt against an email that doesn't exist,
 * so responding "invalid credentials" takes about as long whether or not the account is
 * real — avoids a timing side-channel for account enumeration. */
export async function verifyAgainstDummyHash(password: string): Promise<void> {
  const digest = await getDummyHash();
  await argon2.verify(digest, password).catch(() => undefined);
}
