import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WHOOP_WEBHOOK_SECRET = "test-whoop-webhook-secret";

const { verifySignature } = await import("./webhooks.js");

function sign(timestamp: string, body: string, secret: string): string {
  return createHmac("sha256", secret).update(timestamp + body).digest("base64");
}

describe("verifySignature", () => {
  const secret = process.env.WHOOP_WEBHOOK_SECRET!;
  const body = JSON.stringify({
    user_id: 123,
    id: "550e8400-e29b-41d4-a716-446655440000",
    type: "sleep.updated",
    trace_id: "trace-1",
  });
  const timestamp = String(Date.now());

  it("accepts a correctly signed payload", () => {
    const signature = sign(timestamp, body, secret);
    expect(verifySignature(body, timestamp, signature)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signature = sign(timestamp, body, secret);
    const tamperedBody = body.replace("sleep.updated", "sleep.deleted");
    expect(verifySignature(tamperedBody, timestamp, signature)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const wrongSignature = sign(timestamp, body, "wrong-secret");
    expect(verifySignature(body, timestamp, wrongSignature)).toBe(false);
  });

  it("rejects a garbage signature without throwing", () => {
    expect(verifySignature(body, timestamp, "not-base64-!!!")).toBe(false);
  });
});
