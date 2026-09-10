import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The dashboard used to sit in a `Layout` of its own, so switching between it and any other
 * tab unmounted one `Layout` and mounted another — which tore down and rebuilt the coach
 * panel, closing and reopening it in front of the athlete. These tests pin that every
 * signed-in route now renders through a single, reused `Layout`.
 */

let mountCount = 0;

vi.mock("./components/AssistantChat.js", async () => {
  const { useEffect } = await import("react");
  return {
    AssistantChat: () => {
      // Mounts, not renders: re-rendering on navigation is fine, remounting is the bug.
      useEffect(() => {
        mountCount += 1;
      }, []);
      return <div data-testid="coach-panel" />;
    },
  };
});

vi.mock("./pages/Dashboard.js", () => ({ Dashboard: () => <div>DASHBOARD</div> }));
vi.mock("./pages/Calendar.js", () => ({ Calendar: () => <div>CALENDAR</div> }));
vi.mock("./pages/Build.js", () => ({ Build: () => <div>BUILD</div> }));
vi.mock("./pages/Settings.js", () => ({ Settings: () => <div>SETTINGS</div> }));
vi.mock("./pages/Home.js", () => ({ Home: () => <div>LANDING</div> }));

const currentUser = {
  id: "u1",
  email: "athlete@example.com",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  role: "user",
  needsTutorial: false,
  approved: true,
  entitlement: { active: true, source: "stripe", status: "active", expiresAt: null },
  emailVerified: true,
  hasPassword: true,
};

let signedIn = true;

vi.mock("./lib/api.js", () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    setPaymentRequiredHandler: () => {},
    api: {
      get: async (path: string) => {
        if (path === "/auth/me") {
          if (!signedIn) throw new ApiError(401, "Unauthorized");
          return currentUser;
        }
        if (path === "/settings") return { locationLat: null, locationLon: null };
        return {};
      },
      post: async () => ({}),
      patch: async () => ({}),
      delete: async () => ({}),
      upload: async () => ({}),
      stream: async () => {},
    },
  };
});

// Imported after the mocks so App picks them up.
const { App } = await import("./App.js");

function renderApp(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mountCount = 0;
  signedIn = true;
});

describe("App routing", () => {
  it("keeps the coach panel mounted when moving between the dashboard and the other tabs", async () => {
    renderApp("/");
    expect(await screen.findByText("DASHBOARD")).toBeInTheDocument();
    expect(mountCount).toBe(1);

    await userEvent.click(screen.getByRole("link", { name: "Build" }));
    expect(await screen.findByText("BUILD")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Calendar" }));
    expect(await screen.findByText("CALENDAR")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    expect(await screen.findByText("DASHBOARD")).toBeInTheDocument();

    expect(screen.getByTestId("coach-panel")).toBeInTheDocument();
    expect(mountCount).toBe(1);
  });

  it("still shows the landing page at / for a signed-out visitor", async () => {
    signedIn = false;
    renderApp("/");
    expect(await screen.findByText("LANDING")).toBeInTheDocument();
    expect(screen.queryByTestId("coach-panel")).toBeNull();
  });
});
