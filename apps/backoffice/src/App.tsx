import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type AdminUser,
  type AppSettings,
  type InvitedEmail,
  type MailStatus,
} from "./api.js";

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
      <h1 className="mb-8 font-display text-2xl font-semibold text-ink-primary">Accounts &amp; access</h1>
      <MailStatusBanner />
      <RecommendationEngine />
      <Accounts />
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
        sending — set it to restore them. Anyone stuck without their verification mail shows as
        unverified below and can be marked verified by hand.
      </p>
    </div>
  );
}

/**
 * The global switch for whether athletes see model-sourced recommendations.
 *
 * Worth being precise about in the copy, because the obvious reading is wrong: this does not
 * start or stop the model. The model source runs on every ingestion event either way and its
 * output is persisted and scored against real accept/dismiss behavior — that record is what a
 * candidate model gets evaluated on. All this switch decides is whether athletes see any of it.
 */
function RecommendationEngine() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery<AppSettings>({
    queryKey: ["admin", "settings"],
    queryFn: api.getSettings,
  });
  const update = useMutation({
    mutationFn: api.updateSettings,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["admin", "settings"] }),
  });

  const on = settings?.modelRenderedDefault ?? false;

  return (
    <section className="mb-10">
      <h2 className="mb-1 font-display text-sm font-semibold uppercase tracking-wide text-ink-secondary">
        Recommendation engine
      </h2>
      <p className="mb-3 text-xs text-ink-muted">
        The rules engine always runs. The model runs and is scored against real accept and dismiss
        rates either way — this only decides whether athletes see its suggestions. Individual
        accounts can override the default below.
      </p>
      {update.error && <p className="mb-3 text-sm text-danger">{errorMessage(update.error)}</p>}
      <div className="flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3">
        <div>
          <p className="text-sm font-medium text-ink-primary">
            Model suggestions
            <span
              className={`ml-2 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${
                on ? "bg-accent/15 text-accent" : "bg-surface-2 text-ink-muted"
              }`}
            >
              {isLoading ? "…" : on ? "shown" : "shadow only"}
            </span>
          </p>
          <p className="text-xs text-ink-muted">
            {on
              ? "Model cards are shown to athletes and arbitrated against rules cards."
              : "Model cards are recorded for scoring but never shown."}
          </p>
        </div>
        <button
          onClick={() => update.mutate({ modelRenderedDefault: !on })}
          disabled={isLoading || update.isPending}
          className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
            on
              ? "border border-border text-ink-secondary hover:text-ink-primary"
              : "bg-accent text-surface-0 hover:opacity-90"
          }`}
        >
          {update.isPending ? "Saving…" : on ? "Switch off" : "Switch on"}
        </button>
      </div>
    </section>
  );
}

/** One cached list behind every account row, so nothing disagrees after a mutation. */
function useUsers() {
  return useQuery<AdminUser[]>({ queryKey: ["admin", "users"], queryFn: api.listUsers });
}

/** Some mutations touch both users and invited_emails (deleting an account clears its
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
        free access
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

/**
 * Three-state per-account control over model-sourced recommendations: inherit the global default,
 * or pin on/off. Inherit is a genuinely distinct state rather than a synonym for off — an account
 * left on inherit follows the global switch when it is flipped, which is what makes a staged
 * rollout possible without revisiting every row.
 */
function ModelRenderingControl({
  user,
  busy,
  onChange,
}: {
  user: AdminUser;
  busy: boolean;
  onChange: (rendered: boolean | null) => void;
}) {
  const options: Array<{ value: boolean | null; label: string; title: string }> = [
    { value: null, label: "Inherit", title: "Follow the global default above" },
    { value: true, label: "On", title: "Always show model suggestions to this account" },
    { value: false, label: "Off", title: "Never show model suggestions to this account" },
  ];

  return (
    <div
      className="flex self-center overflow-hidden rounded-md border border-border"
      title="Whether this athlete sees model-sourced recommendations"
    >
      {options.map((opt) => {
        const selected = user.modelRenderedOverride === opt.value;
        return (
          <button
            key={String(opt.value)}
            onClick={() => onChange(opt.value)}
            disabled={busy || selected}
            title={opt.title}
            className={`px-2 py-1.5 text-[11px] font-medium disabled:opacity-100 ${
              selected
                ? "bg-accent text-surface-0"
                : "text-ink-muted hover:text-ink-primary disabled:opacity-50"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function Accounts() {
  const queryClient = useQueryClient();
  const { data: accounts, isLoading, error } = useUsers();
  const disable = useUserAction(api.disableUser);
  const enable = useUserAction(api.enableUser);
  const comp = useUserAction((id: string) => api.compUser(id));
  const uncomp = useUserAction(api.uncompUser);
  const verifyEmail = useUserAction(api.verifyUserEmail);
  const setModel = useMutation({
    mutationFn: ({ id, rendered }: { id: string; rendered: boolean | null }) =>
      rendered === null ? api.clearUserModelRendering(id) : api.setUserModelRendering(id, rendered),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
  const del = useUserAction(async (id: string) => {
    await api.deleteUser(id);
    return {} as AdminUser;
  });

  const activeMutation = [disable, enable, comp, uncomp, verifyEmail, del].find((m) => m.isPending);
  // setModel is kept out of the list above because its variables are an object, not a bare id.
  const activeId = (activeMutation?.variables as string | undefined) ?? setModel.variables?.id;

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
        Everyone who has signed up. Anyone can create an account; what they get is decided by
        the badge — a subscription, free access, or the paywall.
      </p>
      {error && <p className="mb-3 text-sm text-danger">{errorMessage(error)}</p>}
      {isLoading ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {(accounts ?? []).map((u) => {
            const busy = activeId === u.id;
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
                    {u.disabledAt && (
                      <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-danger">
                        disabled
                      </span>
                    )}
                    {!u.emailVerifiedAt && (
                      <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-danger">
                        unverified
                      </span>
                    )}
                    {u.role !== "admin" && <EntitlementBadge user={u} />}
                  </p>
                  <p className="text-xs text-ink-muted">
                    joined {new Date(u.createdAt).toLocaleDateString()} · {u.signupSource}
                    {u.disabledAt && ` · disabled ${new Date(u.disabledAt).toLocaleDateString()}`}
                    {u.role !== "admin" && u.aiUsageThisMonthMicros > 0 && (
                      <> · AI this month: {formatUsd(u.aiUsageThisMonthMicros)}</>
                    )}
                    {u.compNote && ` · note: ${u.compNote}`}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {/* Only ever reachable while system email is down (see MailStatusBanner) —
                      otherwise the user clicks the link in their own verification mail. */}
                  {!u.emailVerifiedAt && (
                    <button
                      onClick={() => verifyEmail.mutate(u.id)}
                      disabled={busy}
                      title="Mark verified without the emailed link — use when system email is down"
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary disabled:opacity-50"
                    >
                      {verifyEmail.isPending && busy ? "Verifying…" : "Mark verified"}
                    </button>
                  )}
                  {u.role !== "admin" && (
                    <ModelRenderingControl
                      user={u}
                      busy={busy}
                      onChange={(rendered) => setModel.mutate({ id: u.id, rendered })}
                    />
                  )}
                  {/* The admin row is deliberately actionless: the role is only ever granted
                      by data migration, so deleting or locking out the last admin orphans
                      this backoffice for good. The API refuses all of them anyway
                      (ADMIN_TARGET). */}
                  {u.role === "admin" && (
                    <span className="self-center text-xs text-ink-muted">protected account</span>
                  )}
                  {u.role !== "admin" &&
                    (u.entitlementSource === "comp" ? (
                      <button
                        onClick={() => uncomp.mutate(u.id)}
                        disabled={busy}
                        title="Drop this account back to whatever their subscription says — usually the paywall"
                        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary disabled:opacity-50"
                      >
                        {uncomp.isPending && busy ? "Revoking…" : "Revoke free access"}
                      </button>
                    ) : (
                      <button
                        onClick={() => comp.mutate(u.id)}
                        disabled={busy}
                        title="Give this account every paid feature for free, indefinitely, without a subscription"
                        className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
                      >
                        {comp.isPending && busy ? "Granting…" : "Free access"}
                      </button>
                    ))}
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
        Free-access invites
      </h2>
      <p className="mb-3 text-xs text-ink-muted">
        Signup is open to anyone — an invite just means this email skips the paywall. Adding one
        emails an invitation, or grants free access straight away if the account already exists.
        Once it turns into an account it moves to Accounts above and drops off this list.
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
        <p className="text-sm text-ink-muted">No invites waiting on a signup.</p>
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
