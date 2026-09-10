import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Calendar } from "./Calendar.js";

/**
 * The calendar's columns are the athlete's *local* calendar days. Tests run in
 * America/New_York (see vitest.config.ts), so at 9pm the UTC date is already tomorrow —
 * the case that used to mark the wrong column "Today" and file an evening run under the
 * next day.
 */

// 9:00pm Wednesday 9 September 2026 in New York; 01:00 Thursday 10 September in UTC.
const NINE_PM_WEDNESDAY = new Date("2026-09-10T01:00:00Z");

const NINE_PM_RUN = {
  id: "run-evening",
  userId: "u1",
  planId: null,
  runType: "easy",
  scheduledAt: "2026-09-10T01:00:00.000Z", // 9pm Wed local
  durationMin: 45,
  distanceM: null,
  description: null,
  origin: "manual",
  gcalEventId: null,
  gcalEtag: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

let requestedUrls: string[] = [];

function mockApi(runs: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requestedUrls.push(url);
      const body = url.includes("/weather/forecast")
        ? { configured: true, forecasts: [] }
        : runs;
      return { ok: true, status: 200, json: async () => body };
    }),
  );
}

function renderCalendar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Calendar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The column whose header carries a given day-of-month. */
function column(dayOfMonth: number): HTMLElement {
  const heading = screen.getAllByText(String(dayOfMonth)).find((el) => el.tagName === "SPAN");
  if (!heading) throw new Error(`no column for day ${dayOfMonth}`);
  return heading.closest("div.flex.min-h-\\[260px\\]") as HTMLElement;
}

beforeEach(() => {
  requestedUrls = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NINE_PM_WEDNESDAY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Calendar", () => {
  it("marks the athlete's local day as Today, not the UTC one", async () => {
    mockApi([]);
    renderCalendar();

    // Wednesday the 9th, even though it is already the 10th in UTC.
    expect(within(column(9)).getByText("Today")).toBeInTheDocument();
    expect(within(column(10)).queryByText("Today")).toBeNull();
    expect(within(column(9)).getByText("Wed")).toBeInTheDocument();
  });

  it("shows the week Monday-to-Sunday around the local day", async () => {
    mockApi([]);
    renderCalendar();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "September 7 – September 13",
    );
  });

  it("files a 9pm run under the evening it is run, not the next UTC day", async () => {
    mockApi([NINE_PM_RUN]);
    renderCalendar();

    await waitFor(() => expect(within(column(9)).getByText("easy")).toBeInTheDocument());
    expect(within(column(10)).queryByText("easy")).toBeNull();
    // And the card's own clock agrees with the column it sits in.
    expect(within(column(9)).getByText("9:00 PM")).toBeInTheDocument();
  });

  it("asks the API for the local week's window", async () => {
    mockApi([]);
    renderCalendar();

    await waitFor(() => expect(requestedUrls.some((u) => u.includes("/runs"))).toBe(true));
    const runsUrl = requestedUrls.find((u) => u.includes("/runs"))!;
    // Local midnight Monday Sep 7 (EDT, UTC-4) through the last millisecond of Sunday Sep 13.
    expect(runsUrl).toContain("from=2026-09-07T04:00:00.000Z");
    expect(runsUrl).toContain("to=2026-09-14T03:59:59.999Z");

    const weatherUrl = requestedUrls.find((u) => u.includes("/weather/forecast"))!;
    expect(weatherUrl).toContain("from=2026-09-07");
    expect(weatherUrl).toContain("to=2026-09-13");
  });
});
