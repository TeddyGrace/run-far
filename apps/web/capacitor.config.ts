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
function requireOrigin(): string {
  const origin = process.env.RUNFAR_IOS_ORIGIN;
  if (!origin) {
    throw new Error(
      "RUNFAR_IOS_ORIGIN is required — set it to the origin the app should load and call, " +
        "e.g. RUNFAR_IOS_ORIGIN=https://your-app.up.railway.app. See docs/ios.md.",
    );
  }
  return origin.replace(/\/$/, "");
}

const config: CapacitorConfig = {
  appId: "app.runfar.ios",
  appName: "run-far",
  webDir: "dist",

  ios: {
    // Scheme for the local bundle. Unused while `server.url` is set (the WebView's origin is
    // the remote one then), but kept explicit so it is already decided if the app ever moves to
    // a bundled build — at which point it becomes the origin the session cookie is scoped to,
    // and changing it after release would sign everyone out.
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
     * Load the deployed web app in the WebView, rather than bundling it.
     *
     * This is the decision that makes the session cookie work, and it took a wrong turn first:
     * the obvious-looking `server.hostname` does *not* point the app at a backend. It only
     * renames the origin Capacitor serves its own local bundle from, and Capacitor intercepts
     * that origin — so every `/api/...` fetch would have been answered by the local bundle
     * server and never reached the network at all.
     *
     * With `server.url`, the WebView's origin *is* the deployed origin. `/api/...` is then
     * same-origin exactly as it is in Safari, so the existing signed session cookie works with
     * no CORS entry and no SameSite=None relaxation — the app authenticates the same way the
     * website does, because it is the website, wrapped. The native HealthKit plugin is
     * unaffected by where the web content comes from.
     *
     * The cost, stated plainly: the app needs a network connection to start, and there is no
     * offline shell. That is the right trade for validating Apple Health on a real phone, and
     * it is worth revisiting before App Store release — see docs/ios.md, which describes the
     * local-bundle alternative and what it would cost (an absolute API base URL, a CORS entry
     * for the capacitor origin, and SameSite=None cookies).
     *
     * RUNFAR_IOS_ORIGIN is required and has no default: a default would silently ship a build
     * pointed at the wrong backend, which is worse than one that refuses to build. Use an https
     * origin — pointing this at a plain-http dev server on a LAN address additionally needs an
     * App Transport Security exception in Info.plist, which is a foot-gun to leave lying around
     * in a project that will later be submitted.
     */
    url: requireOrigin(),
  },
};

export default config;
