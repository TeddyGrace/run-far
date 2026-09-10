import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssistantChat } from "./AssistantChat.js";

/**
 * The coach panel's open state, thread and size live in localStorage so a reload brings it
 * back as it was. (Tab switches don't remount it — every signed-in route shares one `Layout`;
 * see App.test.tsx.) These tests pin that, plus the drag-to-resize behaviour.
 */

const PREFS_KEY = "runfar.coach.panel";

function renderChat() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AssistantChat />
    </QueryClientProvider>,
  );
}

function readStoredPrefs() {
  return JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}");
}

beforeEach(() => {
  window.localStorage.clear();
  // jsdom reports 1024x768; matchMedia is unimplemented, so stand in for the `sm` breakpoint.
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AssistantChat", () => {
  it("stays closed by default and records the open state when toggled", async () => {
    renderChat();
    expect(screen.queryByRole("dialog", { name: "Coach chat" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open coach chat" }));

    expect(await screen.findByRole("dialog", { name: "Coach chat" })).toBeInTheDocument();
    expect(readStoredPrefs().open).toBe(true);
  });

  it("reopens on the stored thread after a remount, the way a reload causes", () => {
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ open: true, sessionId: "session-7", size: { width: 500, height: 600 } }),
    );

    renderChat();

    const panel = screen.getByRole("dialog", { name: "Coach chat" });
    expect(panel).toHaveStyle({ width: "500px", height: "600px" });
    // The stored thread is what gets fetched, rather than falling back to a new conversation.
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("session-7"))).toBe(true);
  });

  it("grows when the top-left corner is dragged out, and persists the new size", () => {
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ open: true, sessionId: null, size: { width: 432, height: 544 } }),
    );
    renderChat();

    const handle = screen.getByRole("separator", { name: "Resize chat panel" });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 240, clientY: 160 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    const panel = screen.getByRole("dialog", { name: "Coach chat" });
    expect(panel).toHaveStyle({ width: "492px", height: "584px" });
    expect(readStoredPrefs().size).toEqual({ width: 492, height: 584 });
  });

  it("clamps a drag at the minimum size", () => {
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ open: true, sessionId: null, size: { width: 432, height: 544 } }),
    );
    renderChat();

    const handle = screen.getByRole("separator", { name: "Resize chat panel" });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900, clientY: 900 });

    expect(screen.getByRole("dialog", { name: "Coach chat" })).toHaveStyle({
      width: "320px",
      height: "280px",
    });
  });

  it("resizes with the arrow keys for keyboard users", () => {
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ open: true, sessionId: null, size: { width: 432, height: 544 } }),
    );
    renderChat();

    const widthHandle = screen.getByRole("separator", { name: "Resize chat width" });
    fireEvent.keyDown(widthHandle, { key: "ArrowLeft" });

    expect(screen.getByRole("dialog", { name: "Coach chat" })).toHaveStyle({
      width: "456px",
      height: "544px",
    });
  });
});
