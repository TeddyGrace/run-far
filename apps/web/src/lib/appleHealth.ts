import { Capacitor } from "@capacitor/core";
import { HealthBridge, type HealthBridgeStatus, type HealthBridgeSyncResult } from "@run-far/health-bridge";

import { api } from "./api.js";

/**
 * The web app's side of the Apple Health connection.
 *
 * Everything here is a no-op in a browser — `HealthBridge`'s web implementation reports
 * unavailability rather than throwing — so the Settings screen can call these unconditionally.
 * That matters because run-far is a web app first: the iOS build is an additional way to use it,
 * not the main one, and the UI must not degrade in a browser to serve it.
 */

/** True in the native iOS shell. Not the same as "HealthKit is available" — ask the plugin for
 * that, since an iPad is a native build with no Health store. */
export function isNativeIos(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

export async function getAppleHealthStatus(): Promise<HealthBridgeStatus> {
  return HealthBridge.getStatus();
}

export interface ConnectResult {
  /** False when the device can't do this at all (a browser, or an iPad) — with `reason` set. */
  available: boolean;
  reason?: string;
  /** The first sync's result, when one ran. */
  sync?: HealthBridgeSyncResult;
}

/**
 * Connect Apple Health: permission, then a device registration, then a full backfill.
 *
 * The order is load-bearing. Permission first, because there is no point registering a device
 * that will have nothing to send. Registration second, from *here* rather than from Swift,
 * because this request is authenticated by the ordinary session cookie — the athlete is signed
 * in, in the WebView, and handing the resulting token to the native side is the entire trust
 * chain by which a background wake can later push as them.
 *
 * Then a full sync rather than an incremental one: it backfills 90 days, matching the Whoop
 * backfill, which is what gives the derived recovery score a baseline to work from. Without it
 * the athlete connects successfully and then sees no score for two weeks, with nothing
 * explaining why.
 */
export async function connectAppleHealth(): Promise<ConnectResult> {
  const { available, reason } = await HealthBridge.isAvailable();
  if (!available) return { available: false, reason };

  await HealthBridge.requestAuthorization();

  const { token } = await api.post<{ id: string; token: string }>("/apple-health/devices", {
    label: deviceLabel(),
  });

  await HealthBridge.configure({
    // The WebView's own origin, which is also the origin the session cookie is scoped to (see
    // capacitor.config.ts) — so the native side and the web side talk to the same backend
    // without a second source of truth for where that is.
    apiBaseUrl: window.location.origin,
    deviceToken: token,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  // Background delivery is the reason the iOS app exists: without it, Apple Health data only
  // reaches run-far when the athlete opens the app, which means the morning's recommendation is
  // computed from yesterday.
  await HealthBridge.setBackgroundDelivery({ enabled: true });

  const sync = await HealthBridge.sync({ full: true });
  return { available: true, sync };
}

export async function syncAppleHealth(full = false): Promise<HealthBridgeSyncResult> {
  return HealthBridge.sync({ full });
}

/**
 * Disconnect: revoke the registration server-side, then clear the device.
 *
 * Server first. If the local reset came first and the revoke then failed, the athlete would be
 * left with a live credential they can no longer see or revoke from this device — the opposite
 * of what they asked for.
 */
export async function disconnectAppleHealth(): Promise<void> {
  const devices = await api.get<Array<{ id: string }>>("/apple-health/devices");
  await Promise.all(
    devices.map((d) =>
      api.delete(`/apple-health/devices/${d.id}`).catch(() => {
        /* Revoking one of several registrations failing shouldn't abandon the rest. */
      }),
    ),
  );
  await HealthBridge.reset();
}

function deviceLabel(): string {
  // Shown in Settings so a revoke targets the right device. Best-effort: the UA string is all
  // the WebView will tell us, and it is cosmetic.
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  return "iOS device";
}
