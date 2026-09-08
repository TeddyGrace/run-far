export type InvitedEmail = {
  id: string;
  email: string;
  note: string | null;
  invitedBy: string | null;
  invitedAt: string;
  hasAccount: boolean;
};

export type AdminUser = {
  id: string;
  email: string;
  role: "user" | "admin";
  disabledAt: string | null;
  emailVerifiedAt: string | null;
  signupSource: "google" | "password";
  createdAt: string;
  entitlementSource: "comp" | "stripe" | "apple" | null;
  entitlementStatus: "trialing" | "active" | "past_due" | "canceled" | "none";
  entitlementExpiresAt: string | null;
  compedAt: string | null;
  compNote: string | null;
  /** Per-account override for whether model-sourced recommendations are rendered.
   * Null means inherit AppSettings.modelRenderedDefault. */
  modelRenderedOverride: boolean | null;
  aiUsageThisMonthMicros: number;
};

export type AppSettings = {
  /** Default for whether athletes see model-sourced recommendations. The model still runs and is
   * still scored in shadow when this is false — it gates rendering only. */
  modelRenderedDefault: boolean;
  updatedAt: string;
};

export type MailStatus = {
  down: boolean;
  reason: "not_configured" | null;
  invalidAt: string | null;
};

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error?.message ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  me: () => request<{ isAdmin: true }>("/api/admin/me"),
  mailStatus: () => request<MailStatus>("/api/admin/mail-status"),
  listInvites: () => request<InvitedEmail[]>("/api/admin/invites"),
  addInvite: (email: string, note?: string) =>
    request<InvitedEmail>("/api/admin/invites", {
      method: "POST",
      body: JSON.stringify({ email, note: note || undefined }),
    }),
  deleteInvite: (id: string) => request<void>(`/api/admin/invites/${id}`, { method: "DELETE" }),
  listUsers: () => request<AdminUser[]>("/api/admin/users"),
  disableUser: (id: string) =>
    request<AdminUser>(`/api/admin/users/${id}/disable`, { method: "POST" }),
  enableUser: (id: string) =>
    request<AdminUser>(`/api/admin/users/${id}/enable`, { method: "POST" }),
  verifyUserEmail: (id: string) =>
    request<AdminUser>(`/api/admin/users/${id}/verify-email`, { method: "POST" }),
  deleteUser: (id: string) => request<void>(`/api/admin/users/${id}`, { method: "DELETE" }),
  /** "Free access" in the UI — grants the comp entitlement that outranks Stripe entirely. */
  compUser: (id: string, note?: string) =>
    request<AdminUser>(`/api/admin/users/${id}/comp`, {
      method: "POST",
      body: JSON.stringify({ note: note || undefined }),
    }),
  uncompUser: (id: string) =>
    request<AdminUser>(`/api/admin/users/${id}/comp`, { method: "DELETE" }),
  getSettings: () => request<AppSettings>("/api/admin/settings"),
  updateSettings: (patch: { modelRenderedDefault: boolean }) =>
    request<AppSettings>("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  /** Pins one account on or off regardless of the global default. */
  setUserModelRendering: (id: string, rendered: boolean) =>
    request<AdminUser>(`/api/admin/users/${id}/model-rendering`, {
      method: "POST",
      body: JSON.stringify({ rendered }),
    }),
  /** Returns the account to the global default. */
  clearUserModelRendering: (id: string) =>
    request<AdminUser>(`/api/admin/users/${id}/model-rendering`, { method: "DELETE" }),
};

export { ApiError };
