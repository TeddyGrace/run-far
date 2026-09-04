import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type AdminUser, type InvitedEmail, type MailStatus } from "./api.js";

const WEB_LOGIN_URL = "https://run-far.cc/login";

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong";
}

export function App() {
  const me = useQuery({ queryKey: ["admin", "me"], queryFn: api.me, retry: false });

  if (me.isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-ink-muted">Loading…</div>;
  }

  if (!me.data) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <p className="mb-2 font-mono text-[11px] tracking-[0.22em] text-accent">run-far backoffice</p>
          <h1 className="mb-3 font-display text-2xl font-semibold text-ink-primary">Admin sign-in required</h1>
          <p className="mb-6 text-sm leading-relaxed text-ink-secondary">
            Sign in with Google at run-far.cc, then reload this page.
          </p>
          <a
            href={WEB_LOGIN_URL}
            className="inline-flex items-center justify-center rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-surface-0 transition-opacity hover:opacity-90"
          >
            Go to run-far.cc/login
          </a>
        </div>
      </div>
    );
  }

  return <Dashboard />;
}

function Dashboard() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <p className="mb-1 font-mono text-[11px] tracking-[0.22em] text-accent">run-far backoffice</p>
      <h1 className="mb-8 font-display text-2xl font-semibold text-ink-primary">Invites &amp; access</h1>
      <MailStatusBanner />
      <NeedsReview />
      <div className="mt-10">
        <Accounts />
      </div>
      <div className="mt-10">
        <Invites />
      </div>
    </div>
  );
}

function MailStatusBanner() {
  const { data: status } = useQuery<MailStatus>({
    queryKey: ["admin", "mail-status"],
    queryFn: api.mailStatus,
  });

  if (!status?.down) return null;

  return (
    <div className="mb-6 rounded-md border border-danger/40 bg-danger/10 px-4 py-3">
      <p className="text-sm font-medium text-danger">System email is down</p>
      <p className="mt-1 text-xs text-ink-secondary">
        RESEND_API_KEY isn't set. Signup, verification, and password-reset emails aren't
        sending — set it to restore them. Affected signups are still visible in Needs review
        below and can be verified manually.
      </p>
    </div>
  );
}

/** Shared by NeedsReview and Accounts so both sections read the same cached list and never
 * disagree after a mutation — see the plan's react-query section. */
function useUsers() {
  return useQuery<AdminUser[]>({ queryKey: ["admin", "users"], queryFn: api.listUsers });
}

/** Every mutation here touches both users and invited_emails (approveExistingUser upserts the
 * invite), so both caches are invalidated together on settle. */
function useUserAction(fn: (id: string) => Promise<AdminUser>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "invites"] });
    },
  });
}

function NeedsReview() {
  const { data: accounts, isLoading, error } = useUsers();
  const approve = useUserAction(api.approveUser);
  const deny = useUserAction(api.denyUser);
  const verifyEmail = useUserAction(api.verifyUserEmail);

  const pending = (accounts ?? []).filter((u) => !u.approvedAt && !u.disabledAt);
  const activeMutation = [approve, deny, verifyEmail].find((m) => m.isPending);
  const activeId = activeMutation?.variables as string | undefined;

  return (
    <section>
      <h2 className="mb-1 font-display text-sm font-semibold uppercase tracking-wide text-ink-secondary">
        Needs review
      </h2>
      <p className="mb-3 text-xs text-ink-muted">
        New signups that aren't on the invite allowlist. Approve to let them in, Deny to block
        the account (it stays visible under Accounts).
      </p>
      {error && <p className="mb-3 text-sm text-danger">{errorMessage(error)}</p>}
      {isLoading ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : pending.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing waiting on review.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {pending.map((u) => {
            const busy = activeId === u.id;
            return (
              <li key={u.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-ink-primary">
                    {u.email}
                    <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-secondary">
                      {u.signupSource}
                    </span>
                    {!u.emailVerifiedAt && (
                      <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-danger">
                        unverified
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-ink-muted">
                    joined {new Date(u.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {!u.emailVerifiedAt && (
                    <button
                      onClick={() => verifyEmail.mutate(u.id)}
                      disabled={busy}
                      title="Mark verified without the emailed link — use when system email is down"
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary disabled:opacity-50"
                    >
                      Mark verified
                    </button>
                  )}
                  <button
                    onClick={() => approve.mutate(u.id)}
                    disabled={busy}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
                  >
                    {approve.isPending && busy ? "Approving…" : "Approve"}
                  </button>
                  <button
                    onClick={() => deny.mutate(u.id)}
                    disabled={busy}
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-danger disabled:opacity-50"
                  >
                    {deny.isPending && busy ? "Denying…" : "Deny"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

const ENTITLEMENT_LABELS: Record<AdminUser["entitlementStatus"], string> = {
  trialing: "Trial",
  active: "Active",
  past_due: "Past due",
  canceled: "Canceled",
  none: "None",
};

function EntitlementBadge({ user }: { user: AdminUser }) {
  if (user.entitlementSource === "comp") {
    return (
      <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-accent">
        comped
      </span>
    );
  }
  if (user.entitlementSource === "stripe" || user.entitlementSource === "apple") {
    return (
      <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-secondary">
        {ENTITLEMENT_LABELS[user.entitlementStatus]}
      </span>
    );
  }
  return (
    <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-muted">
      no subscription
    </span>
  );
}

function Accounts() {
  const { data: accounts, isLoading, error } = useUsers();
  const unapprove = useUserAction(api.unapproveUser);
  const disable = useUserAction(api.disableUser);
  const enable = useUserAction(api.enableUser);
  const comp = useUserAction((id: string) => api.compUser(id));
  const uncomp = useUserAction(api.uncompUser);
  const del = useUserAction(async (id: string) => {
    await api.deleteUser(id);
    return {} as AdminUser;
  });

  const activeMutation = [unapprove, disable, enable, comp, uncomp, del].find((m) => m.isPending);
  const activeId = activeMutation?.variables as string | undefined;

  const remove = (u: AdminUser) => {
    const ok = window.confirm(
      `Permanently delete ${u.email}?\n\nThis erases their runs, plans, chats and connected ` +
        `accounts, and removes them from the invite list. This cannot be undone.\n\n` +
        `To block access reversibly, use Disable instead.`,
    );
    if (ok) del.mutate(u.id);
  };

  return (
    <section>
      <h2 className="mb-1 font-display text-sm font-semibold uppercase tracking-wide text-ink-secondary">
        Accounts
      </h2>
      <p className="mb-3 text-xs text-ink-muted">
        Everyone approved or denied so far. Removing an invite under Invites below only blocks
        new signups — revoke existing access here.
      </p>
      {error && <p className="mb-3 text-sm text-danger">{errorMessage(error)}</p>}
      {isLoading ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {(accounts ?? [])
            .filter((u) => u.approvedAt || u.disabledAt)
            .map((u) => {
              const busy = activeId === u.id;
              const denied = u.disabledAt && !u.approvedAt;
              return (
                <li key={u.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-ink-primary">
                      {u.email}
                      {u.role === "admin" && (
                        <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-accent">
                          admin
                        </span>
                      )}
                      {denied ? (
                        <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-danger">
                          denied
                        </span>
                      ) : (
                        u.disabledAt && (
                          <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-danger">
                            disabled
                          </span>
                        )
                      )}
                      {u.role !== "admin" && <EntitlementBadge user={u} />}
                    </p>
                    <p className="text-xs text-ink-muted">
                      joined {new Date(u.createdAt).toLocaleDateString()} · {u.signupSource}
                      {u.disabledAt && ` · ${denied ? "denied" : "disabled"} ${new Date(u.disabledAt).toLocaleDateString()}`}
                      {u.role !== "admin" && u.aiUsageThisMonthMicros > 0 && (
                        <> · AI this month: {formatUsd(u.aiUsageThisMonthMicros)}</>
                      )}
                      {u.compNote && ` · comp note: ${u.compNote}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {/* The admin row is deliberately actionless: the role is only ever granted
                        by data migration, so deleting or locking out the last admin orphans
                        this backoffice for good. The API refuses all four anyway
                        (ADMIN_TARGET). */}
                    {u.role === "admin" && (
                      <span className="self-center text-xs text-ink-muted">protected account</span>
                    )}
                    {u.role !== "admin" &&
                      (u.entitlementSource === "comp" ? (
                        <button
                          onClick={() => uncomp.mutate(u.id)}
                          disabled={busy}
                          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary disabled:opacity-50"
                        >
                          {uncomp.isPending && busy ? "Un-comping…" : "Un-comp"}
                        </button>
                      ) : (
                        <button
                          onClick={() => comp.mutate(u.id)}
                          disabled={busy}
                          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
                        >
                          {comp.isPending && busy ? "Comping…" : "Comp"}
                        </button>
                      ))}
                    {u.role !== "admin" && u.approvedAt && (
                      <button
                        onClick={() => unapprove.mutate(u.id)}
                        disabled={busy}
                        title="Legacy from the invite-approval flow — clears an invite-granted comp without affecting Stripe or a comp granted from the button above"
                        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary disabled:opacity-50"
                      >
                        {unapprove.isPending && busy ? "Unapproving…" : "Unapprove"}
                      </button>
                    )}
                    {u.role !== "admin" &&
                      (u.disabledAt ? (
                        <button
                          onClick={() => enable.mutate(u.id)}
                          disabled={busy}
                          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
                        >
                          {enable.isPending && busy ? "Enabling…" : "Enable"}
                        </button>
                      ) : (
                        <button
                          onClick={() => disable.mutate(u.id)}
                          disabled={busy}
                          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary disabled:opacity-50"
                        >
                          {disable.isPending && busy ? "Disabling…" : "Disable"}
                        </button>
                      ))}
                    {u.role !== "admin" && (
                      <button
                        onClick={() => remove(u)}
                        disabled={busy}
                        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-danger disabled:opacity-50"
                      >
                        {del.isPending && busy ? "Deleting…" : "Delete"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
        </ul>
      )}
    </section>
  );
}

function Invites() {
  const queryClient = useQueryClient();
  const { data: invites, isLoading, error } = useQuery<InvitedEmail[]>({
    queryKey: ["admin", "invites"],
    queryFn: api.listInvites,
  });
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["admin", "invites"] });
    queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
  };

  const add = useMutation({
    mutationFn: () => api.addInvite(email.trim(), note.trim()),
    onSuccess: () => {
      setEmail("");
      setNote("");
      setFormError(null);
    },
    onError: (e) => setFormError(errorMessage(e)),
    onSettled: invalidateAll,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteInvite(id),
    onSettled: invalidateAll,
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    add.mutate();
  };

  const pending = (invites ?? []).filter((inv) => !inv.hasAccount);

  return (
    <section>
      <h2 className="mb-1 font-display text-sm font-semibold uppercase tracking-wide text-ink-secondary">
        Invites
      </h2>
      <p className="mb-3 text-xs text-ink-muted">
        Who may create a new account. Once an invite turns into an account it moves to Needs
        review or Accounts above and drops off this list.
      </p>

      <form onSubmit={submit} className="mb-4 flex flex-wrap gap-2">
        <input
          type="email"
          required
          placeholder="email@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-w-[14rem] flex-1 rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-ink-primary placeholder:text-ink-muted focus:border-accent"
        />
        <input
          type="text"
          placeholder="note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="min-w-[10rem] flex-1 rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-ink-primary placeholder:text-ink-muted focus:border-accent"
        />
        <button
          type="submit"
          disabled={add.isPending}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
        >
          {add.isPending ? "Adding…" : "Add"}
        </button>
      </form>

      {formError && <p className="mb-3 text-sm text-danger">{formError}</p>}
      {error && <p className="mb-3 text-sm text-danger">{errorMessage(error)}</p>}

      {isLoading ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : pending.length === 0 ? (
        <p className="text-sm text-ink-muted">No pending invites.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {pending.map((inv) => (
            <li key={inv.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-ink-primary">{inv.email}</p>
                <p className="text-xs text-ink-muted">
                  {inv.note ? `${inv.note} · ` : ""}invited {new Date(inv.invitedAt).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => remove.mutate(inv.id)}
                disabled={remove.isPending && remove.variables === inv.id}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-danger disabled:opacity-50"
              >
                {remove.isPending && remove.variables === inv.id ? "Removing…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
