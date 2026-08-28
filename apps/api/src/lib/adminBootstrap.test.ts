import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgres://runfar:runfar@localhost:5432/runfar";
process.env.SESSION_SECRET ??= "test-session-secret-not-for-prod";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.WEB_ORIGIN ??= "http://localhost:5174";

const { db } = await import("../db/client.js");
const { users, invitedEmails } = await import("../db/schema.js");
const { env } = await import("../env.js");
const { reconcileAdminEmails } = await import("./adminBootstrap.js");
const { eq } = await import("drizzle-orm");

/**
 * The break-glass path out of a locked-out backoffice: `role` is granted only by data
 * migration, so before this existed a destroyed or disabled admin was unrecoverable.
 */
describe("reconcileAdminEmails", () => {
  let email: string;

  beforeEach(() => {
    email = `bootstrap-admin-${randomUUID()}@run-far.local`;
    // env.adminEmails is built once at import; point it at this run's throwaway address.
    vi.spyOn(env, "adminEmails", "get").mockReturnValue(new Set([email]));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(users).where(eq(users.email, email));
    await db.delete(invitedEmails).where(eq(invitedEmails.email, email));
  });

  it("promotes, re-approves and un-disables a locked-out account", async () => {
    await db.insert(users).values({
      email,
      role: "user" as const,
      disabledAt: new Date(),
      approvedAt: null,
      emailVerifiedAt: null,
    });

    await reconcileAdminEmails();

    const [restored] = await db.select().from(users).where(eq(users.email, email));
    expect(restored?.role).toBe("admin");
    expect(restored?.disabledAt).toBeNull();
    expect(restored?.approvedAt).not.toBeNull();
    expect(restored?.emailVerifiedAt).not.toBeNull();
  });

  it("seeds an invite when the account row is gone, so the admin can sign up again", async () => {
    await reconcileAdminEmails();

    const [invite] = await db
      .select()
      .from(invitedEmails)
      .where(eq(invitedEmails.email, email));
    expect(invite).toBeDefined();
  });

  it("preserves an existing approval timestamp instead of overwriting it", async () => {
    const approvedAt = new Date("2026-01-15T00:00:00Z");
    await db.insert(users).values({ email, role: "user" as const, approvedAt });

    await reconcileAdminEmails();

    const [restored] = await db.select().from(users).where(eq(users.email, email));
    expect(restored?.approvedAt?.toISOString()).toBe(approvedAt.toISOString());
  });

  it("leaves accounts absent from the list untouched", async () => {
    const bystander = `bystander-${randomUUID()}@run-far.local`;
    await db.insert(users).values({ email: bystander, role: "user" as const });
    try {
      await reconcileAdminEmails();

      const [row] = await db.select().from(users).where(eq(users.email, bystander));
      expect(row?.role).toBe("user");
    } finally {
      await db.delete(users).where(eq(users.email, bystander));
    }
  });
});
