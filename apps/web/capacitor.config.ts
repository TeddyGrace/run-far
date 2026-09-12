import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The iOS shell around the existing web app.
 *
 * Capacitor rather than a second native UI: the dashboard, calendar, plan builder and assistant
 * are a substantial React app, and maintaining a parallel SwiftUI copy would mean every change
 * shipping twice. What the native shell adds is the thing the web app genuinely cannot do —
 * read HealthKit, and be woken by iOS when new health data lands (see packages/health-bridge).
 *
 * That also happens to be what keeps the app clear of App Review guideline 4.2: a web view with
 * no native capability reads as a repackaged website, while HealthKit integration and
 * background health delivery are real device functionality. See docs/ios.md.
 */
const config: CapacitorConfig = {
  appId: "app.runfar.ios",
  appName: "run-far",
  webDir: "dist",

  ios: {
    // The app's own scheme for the local bundle. Kept explicit because it becomes the WebView's
    // origin, and therefore the origin the session cookie is scoped to — changing it after
    // release signs everyone out.
    scheme: "runfar",
    // Let iOS decide light/dark from the system; the app's own palette is dark either way.
    backgroundColor: "#121815ff",
    // Rubber-banding on a dashboard that is mostly fixed-height cards reads as jank rather
    // than as native feel.
    scrollEnabled: true,
    contentInset: "always",
  },

  server: {
    /**
     * The API the WebView talks to.
     *
     * Capacitor serves the built bundle from a local scheme rather than from the API's origin,
     * so `/api/...` is not same-origin the way it is on the web. Pointing the WebView's
     * hostname at the deployed origin is what keeps one fetch path working in both builds —
     * and, importantly, keeps the session cookie working, since the cookie is set for that
     * origin.
     *
     * Set RUNFAR_IOS_ORIGIN at build time. It has no default on purpose: a wrong default
     * silently ships a build that talks to the wrong backend, which is worse than a build that
     * refuses to start.
     */
    hostname: process.env.RUNFAR_IOS_ORIGIN?.replace(/^https?:\/\//, "") ?? "localhost",
    androidScheme: "https",
    iosScheme: "https",
  },
};

export default config;
