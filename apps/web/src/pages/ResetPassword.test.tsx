import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ResetPassword } from "./ResetPassword.js";
import { AUTH_ME_KEY, type CurrentUser } from "../lib/auth.js";

/**
 * Regression coverage for the blank page after a successful reset: the page used to seed the
 * auth cache with this route's partial `{id, email}` response, which made the app render a
 * session whose `entitlement` was undefined and unmount the whole root. The rule these tests
 * pin is that only /auth/me ever supplies the user.
 */

const fullUser: CurrentUser = {
  id: "user-1",
  email: "athlete@run-far.local",
  timezone: "America/New_York",
  role: "user",
  needsTutorial: false,
  approved: true,
  entitlement: { active: true, source: "stripe", status: "active", expiresAt: null },
  emailVerified: true,
  hasPassword: true,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  } as Response;
}

/** Records the order calls arrive in, so a test can assert /auth/me landed before navigation. */
let calls: string[];

function mockFetch(handler: (path: string, init?: RequestInit) => Response) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    calls.push(path);
    return handler(path, init);
  });
}

function renderPage(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/reset-password?token=live-token"]}>
        <Routes>
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/" element={<div>DASHBOARD</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function fillAndSubmit() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/^new password$|^password$/i), "a-fine-password-10");
  await user.type(screen.getByLabelText(/confirm/i), "a-fine-password-10");
  await user.click(screen.getByRole("button", { name: /save password/i }));
}

describe("ResetPassword", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    calls = [];
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the full user from /auth/me before navigating into the app", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((path) => {
        if (path.endsWith("/auth/reset-password/check")) {
          return jsonResponse({ valid: true, email: fullUser.email, hasPassword: true });
        }
        if (path.endsWith("/auth/reset-password")) {
          // The real route answers with this partial shape — never a full user.
          return jsonResponse({ id: fullUser.id, email: fullUser.email });
        }
        if (path.endsWith("/auth/me")) return jsonResponse(fullUser);
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderPage(queryClient);
    await screen.findByLabelText(/confirm/i);
    await fillAndSubmit();

    await screen.findByText("DASHBOARD");

    // The session must be complete before the app renders: /auth/me is fetched, and what
    // lands in the cache is the full user, not the mutation's partial response.
    expect(calls).toContain("/api/auth/me");
    expect(calls.indexOf("/api/auth/me")).toBeGreaterThan(calls.indexOf("/api/auth/reset-password"));
    expect(queryClient.getQueryData(AUTH_ME_KEY)).toEqual(fullUser);
  });

  it("confirms the password was saved when the follow-up /auth/me fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((path) => {
        if (path.endsWith("/auth/reset-password/check")) {
          return jsonResponse({ valid: true, email: fullUser.email, hasPassword: true });
        }
        if (path.endsWith("/auth/reset-password")) {
          return jsonResponse({ id: fullUser.id, email: fullUser.email });
        }
        if (path.endsWith("/auth/me")) {
          return jsonResponse({ error: { message: "boom", code: "SERVER_ERROR" } }, 500);
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderPage(queryClient);
    await screen.findByLabelText(/confirm/i);
    await fillAndSubmit();

    // The password IS changed and the token IS spent, so this must read as success with a way
    // forward — never an error, and never the form still sitting there inviting a retry.
    await screen.findByText("Password updated");
    expect(screen.getByRole("link", { name: /continue/i })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("button", { name: /save password/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the dead-link state and no form when the token is spent", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((path) => {
        if (path.endsWith("/auth/reset-password/check")) return jsonResponse({ valid: false });
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderPage(queryClient);

    await screen.findByText(/expired or has already been used/i);
    expect(screen.queryByLabelText(/confirm/i)).not.toBeInTheDocument();
    await waitFor(() => expect(calls).not.toContain("/api/auth/reset-password"));
  });
});
