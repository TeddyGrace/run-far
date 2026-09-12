import { registerPlugin } from "@capacitor/core";

import type { HealthBridgePlugin } from "./definitions.js";

/**
 * `web` is the fallback Capacitor uses when the app is running in a browser rather than in the
 * native shell — which is most of the time, since run-far is a web app first. It is a real
 * implementation that reports "unavailable", not a stub that throws: the Settings screen calls
 * isAvailable() unconditionally, and every path through the UI has to work in a browser.
 */
export const HealthBridge = registerPlugin<HealthBridgePlugin>("HealthBridge", {
  web: () => import("./web.js").then((m) => new m.HealthBridgeWeb()),
});

export * from "./definitions.js";
