import type { AppleHealthIngestResult } from "@run-far/shared";

/**
 * The bridge between run-far's web UI and HealthKit.
 *
 * The division of labour is the important part of this interface, and it is not the obvious
 * one. The native side owns *everything* about reading HealthKit and pushing it: permissions,
 * queries, the read window, payload assembly, and the HTTP call to the API. The web side
 * only configures it, triggers a foreground sync, and reads status.
 *
 * That looks like a lot to put in Swift when there is a perfectly good TypeScript app right
 * there. The reason is background delivery. HealthKit can wake the app when new data lands —
 * which is what makes this morning's recovery already be on the dashboard rather than
 * appearing when the athlete next opens the app — and that wake runs native code with no
 * WebView alive at all. If the payload assembly and the push lived in TypeScript, the
 * background path would need a second implementation of both, and the two would drift. So
 * there is one implementation, in Swift, and the foreground path calls the same code.
 *
 * The corollary is the device token (see `configure`): native code cannot read the WebView's
 * cookie jar, so it needs its own credential.
 */
export interface HealthBridgePlugin {
  /**
   * Whether this build can talk to HealthKit at all.
   *
   * False on web and on iPad (HealthKit is iPhone/Watch only), which the UI needs in order to
   * show something other than a connect button that cannot work. Checked rather than inferred
   * from the platform, because "is this a Capacitor native build" and "does HealthKit exist
   * here" are different questions.
   */
  isAvailable(): Promise<{ available: boolean; reason?: string }>;

  /**
   * Ask iOS for read permission over the types run-far uses.
   *
   * Resolves once the athlete dismisses Apple's sheet — which tells you nothing about what they
   * granted. iOS deliberately does not report read-permission status, to avoid leaking that
   * someone declined to share a health condition; `authorizationRequested` only means the sheet
   * was shown. The honest way to find out is to sync and see what comes back, which is why
   * `sync` reports per-type sample counts.
   */
  requestAuthorization(): Promise<{ authorizationRequested: boolean }>;

  /**
   * Hand the native side what it needs to push on its own: where the API is, and a device
   * token to authenticate with.
   *
   * Called from the WebView after `POST /api/apple-health/devices`, which is authenticated by
   * the ordinary session cookie. The token is stored in the iOS Keychain, so it survives app
   * restarts and is available to a background wake.
   */
  configure(options: {
    apiBaseUrl: string;
    deviceToken: string;
    /** IANA zone, sent with each batch for diagnostics. Dates are bucketed server-side in the
     * athlete's *configured* zone, so this is not authoritative. */
    timeZone?: string;
  }): Promise<void>;

  /**
   * Read anything new since the last sync and push it.
   *
   * "New" means a rolling recent window, not strictly-unseen samples: Apple revises sleep
   * stages and backfills workout distances after the fact, and re-reading is how those
   * revisions are ever seen (the server's upserts make re-sending free). `full` widens that
   * window to the whole 90-day backfill — used for the first sync after connecting, and as the
   * repair path when something looks wrong.
   *
   * The result is the API's own ingest result, so the UI can say "collecting baseline, 9 days
   * to go" rather than just "synced".
   */
  sync(options?: { full?: boolean }): Promise<HealthBridgeSyncResult>;

  /** Turn HealthKit background delivery on or off. On is the point of the app; off exists so
   * an athlete who switches back to Whoop stops their phone doing pointless work. */
  setBackgroundDelivery(options: { enabled: boolean }): Promise<void>;

  /** What the native side thinks the current state is, for the Settings screen. */
  getStatus(): Promise<HealthBridgeStatus>;

  /** Forget the device token and stop background delivery. Called when the athlete
   * disconnects, or after the server rejects the token — which it does permanently once the
   * registration is revoked, so continuing to retry would be pointless. */
  reset(): Promise<void>;
}

export interface HealthBridgeSyncResult {
  /** What was read from HealthKit, before the server saw it. Distinguishing "nothing to sync"
   * from "permission was silently declined" is only possible from these. */
  read: {
    sleepSessions: number;
    workouts: number;
    /** True when the whole lookback window was re-read rather than only what is new. */
    full: boolean;
  };
  /** The API's response, absent when the push itself failed (the batch is kept for retry). */
  ingested?: AppleHealthIngestResult & { activeProvider: string; storedButNotActive: boolean };
  /** Present when the push failed — a message worth showing, not a stack trace. */
  error?: string;
}

export interface HealthBridgeStatus {
  available: boolean;
  /** Whether a device token is in the Keychain. Not the same as "working" — the token may have
   * been revoked server-side, which is only discovered on the next push. */
  configured: boolean;
  backgroundDeliveryEnabled: boolean;
  /** Last successful push, ISO 8601, or null. */
  lastSyncedAt: string | null;
  /** Last push failure, so the UI can surface a stuck sync instead of looking idle. */
  lastError: string | null;
}
