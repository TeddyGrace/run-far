import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Separate from vite.config.ts on purpose: the app config carries VitePWA, which wants to
// generate a service worker and manifest on every run — nothing a component test needs.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Pinned to a negative-offset zone so date-bucketing tests exercise the case where the
    // athlete's calendar day and the UTC one disagree — the whole reason lib/localDate exists.
    // A UTC runner would let a `toISOString().slice(0, 10)` regression pass silently.
    env: { TZ: "America/New_York" },
  },
});
