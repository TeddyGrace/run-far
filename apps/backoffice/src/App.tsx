import { useEffect, useState } from "react";
import { api, ApiError, type AccessRequest, type AdminUser, type InvitedEmail } from "./api.js";

const WEB_LOGIN_URL = "https://run-far.cc/login";

type Gate = { status: "loading" } | { status: "signed-out" } | { status: "ok" };

export function App() {
  const [gate, setGate] = useState<Gate>({ status: "loading" });

  useEffect(() => {
    api
      .me()
      .then(() => setGate({ status: "ok" }))
      .catch(() => setGate({ status: "signed-out" }));
  }, []);

  if (gate.status === "loading") return null;

  if (gate.status === "signed-out") {
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
      <h1 className="mb-8 font-display text-2xl font-semibold text-ink-primary">Invites &amp; access requests</h1>
      <AccessRequests />
      <div className="mt-10">
        <InvitedEmails />
      </div>
      <div className="mt-10">
        <Accounts />
      </div>
    </div>
  );
}

function Accounts() {
  const [accounts, setAccounts] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => api.listUsers().then(setAccounts).catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
    reload();
  };

  const remove = (u: AdminUser) => {
    const ok = window.confirm(
      `Permanently delete ${u.email}?\n\nThis erases their runs, plans, chats and connected ` +
        `accounts, and removes them from the invite list. This cannot be undone.\n\n` +
        `To block access reversibly, use Disable instead.`,
    );
    if (ok) run(() => api.deleteUser(u.id));
  };

  return (
    <section>
      <h2 className="mb-1 font-display text-sm font-semibold uppercase tracking-wide text-ink-secondary">
        Accounts
      </h2>
      <p className="mb-3 text-xs text-ink-muted">
        Removing an invite above only blocks new signups. Existing accounts keep access until
        disabled or deleted here.
      </p>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {accounts === null ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {accounts.map((u) => (
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
                </p>
                <p className="text-xs text-ink-muted">
                  joined {new Date(u.createdAt).toLocaleDateString()}
                  {u.disabledAt && ` · disabled ${new Date(u.disabledAt).toLocaleDateString()}`}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {u.disabledAt ? (
                  <button
                    onClick={() => run(() => api.enableUser(u.id))}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 hover:opacity-90"
                  >
                    Enable
                  </button>
                ) : (
                  <button
                    onClick={() => run(() => api.disableUser(u.id))}
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary"
                  >
                    Disable
                  </button>
                )}
                <button
                  onClick={() => remove(u)}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-danger"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AccessRequests() {
  const [requests, setRequests] = useState<AccessRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => api.listAccessRequests().then(setRequests).catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);

  const pending = requests?.filter((r) => r.status === "pending") ?? [];

  const approve = async (id: string) => {
    await api.approveAccessRequest(id).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
    reload();
  };
  const dismiss = async (id: string) => {
    await api.dismissAccessRequest(id).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
    reload();
  };

  return (
    <section>
      <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wide text-ink-secondary">
        Access requests
      </h2>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {requests === null ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : pending.length === 0 ? (
        <p className="text-sm text-ink-muted">No pending requests.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {pending.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-ink-primary">{r.email}</p>
                <p className="text-xs text-ink-muted">
                  {r.requestCount} attempt{r.requestCount === 1 ? "" : "s"} · last{" "}
                  {new Date(r.lastRequestedAt).toLocaleString()}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => approve(r.id)}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 hover:opacity-90"
                >
                  Approve
                </button>
                <button
                  onClick={() => dismiss(r.id)}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary"
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InvitedEmails() {
  const [invites, setInvites] = useState<InvitedEmail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reload = () => api.listInvites().then(setInvites).catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.addInvite(email.trim(), note.trim());
      setEmail("");
      setNote("");
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (id: string) => {
    await api.deleteInvite(id).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
    reload();
  };

  return (
    <section>
      <h2 className="mb-1 font-display text-sm font-semibold uppercase tracking-wide text-ink-secondary">
        Invited emails
      </h2>
      <p className="mb-3 text-xs text-ink-muted">
        Who may create a new account. Revoking an existing account happens under Accounts below.
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
          disabled={submitting}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
        >
          Add
        </button>
      </form>

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      {invites === null ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : invites.length === 0 ? (
        <p className="text-sm text-ink-muted">No invited emails yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {invites.map((inv) => (
            <li key={inv.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-ink-primary">{inv.email}</p>
                <p className="text-xs text-ink-muted">
                  {inv.note ? `${inv.note} · ` : ""}invited {new Date(inv.invitedAt).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => remove(inv.id)}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-danger"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
