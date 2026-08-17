export type InvitedEmail = {
  id: string;
  email: string;
  note: string | null;
  invitedBy: string | null;
  invitedAt: string;
};

export type AccessRequest = {
  id: string;
  email: string;
  firstRequestedAt: string;
  lastRequestedAt: string;
  requestCount: number;
  status: "pending" | "invited" | "dismissed";
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
  listInvites: () => request<InvitedEmail[]>("/api/admin/invites"),
  addInvite: (email: string, note?: string) =>
    request<InvitedEmail>("/api/admin/invites", {
      method: "POST",
      body: JSON.stringify({ email, note: note || undefined }),
    }),
  deleteInvite: (id: string) => request<void>(`/api/admin/invites/${id}`, { method: "DELETE" }),
  listAccessRequests: () => request<AccessRequest[]>("/api/admin/access-requests"),
  approveAccessRequest: (id: string) =>
    request<AccessRequest>(`/api/admin/access-requests/${id}/approve`, { method: "POST" }),
  dismissAccessRequest: (id: string) =>
    request<AccessRequest>(`/api/admin/access-requests/${id}`, { method: "DELETE" }),
};

export { ApiError };
