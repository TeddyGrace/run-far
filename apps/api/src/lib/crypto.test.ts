import { describe, it, expect, beforeAll } from "vitest";

// crypto.ts reads env.ENCRYPTION_KEY at call time via ../env.js, which validates on import.
// Point it at a throwaway key before importing.
process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

const { encryptSecret, decryptSecret } = await import("./crypto.js");

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext value", () => {
    const plaintext = "whoop-access-token-abc123";
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a).not.toBe(b);
  });

  it("throws when the payload is tampered with", () => {
    const encrypted = encryptSecret("sensitive-value");
    const [iv = "", tag = "", ciphertext = ""] = encrypted.split(":");
    const tamperedByte = Buffer.from(ciphertext, "base64");
    tamperedByte[0] = (tamperedByte[0] ?? 0) ^ 0xff;
    const tampered = `${iv}:${tag}:${tamperedByte.toString("base64")}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws on malformed input", () => {
    expect(() => decryptSecret("not-a-valid-payload")).toThrow();
  });
});
