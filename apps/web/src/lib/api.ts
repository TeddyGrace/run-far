export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Registered by AuthProvider on mount so this module (plain, outside React) can trigger an
 * immediate refetch of the current user when any request comes back 402 — e.g. a subscription
 * lapsed mid-session, or a comp was revoked. Without this the UI would only notice on the next
 * 30s poll (see lib/auth.tsx's refetchInterval); with it, the paywall shows up right away.
 */
let onPaymentRequired: (() => void) | null = null;
export function setPaymentRequiredHandler(handler: (() => void) | null): void {
  onPaymentRequired = handler;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    if (res.status === 402) onPaymentRequired?.();
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error?.message ?? res.statusText, res.status, body?.error?.code);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * POST a body and consume a Server-Sent Events response, invoking `onEvent` with each parsed
 * JSON frame. Used for streaming assistant turns — EventSource can't POST, so we read the
 * response body ourselves. Resolves when the stream ends; rejects on transport/HTTP errors or
 * if aborted via `signal`.
 */
async function stream<E>(
  path: string,
  body: unknown,
  onEvent: (event: E) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const errBody = await res.json().catch(() => null);
    throw new ApiError(errBody?.error?.message ?? res.statusText, res.status, errBody?.error?.code);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json) continue;
      try {
        onEvent(JSON.parse(json) as E);
      } catch {
        // Ignore malformed frames rather than tearing down the whole stream.
      }
    }
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body != null ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body != null ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "DELETE", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  upload: <T>(path: string, formData: FormData) =>
    request<T>(path, { method: "POST", body: formData, headers: undefined }),
  stream,
};
