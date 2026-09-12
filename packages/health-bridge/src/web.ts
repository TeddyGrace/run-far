import { WebPlugin } from "@capacitor/core";

import type {
  HealthBridgePlugin,
  HealthBridgeStatus,
  HealthBridgeSyncResult,
} from "./definitions.js";

/**
 * Browser implementation: HealthKit does not exist here, and there is no partial version of it
 * that would.
 *
 * Every method resolves rather than rejecting, reporting unavailability through the same shape
 * the native side uses. That is deliberate — the web app is the primary way run-far is used,
 * and a Settings screen that threw on mount in a browser to serve the iOS build would be the
 * wrong trade entirely.
 */
export class HealthBridgeWeb extends WebPlugin implements HealthBridgePlugin {
  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    return {
      available: false,
      reason: "Apple Health is only readable from the run-far iOS app on an iPhone.",
    };
  }

  async requestAuthorization(): Promise<{ authorizationRequested: boolean }> {
    return { authorizationRequested: false };
  }

  async configure(): Promise<void> {
    // Nothing to configure: there is no native side here to hand a token to.
  }

  async sync(): Promise<HealthBridgeSyncResult> {
    return {
      read: { sleepSessions: 0, workouts: 0, full: false },
      error: "Apple Health is not available in a browser.",
    };
  }

  async setBackgroundDelivery(): Promise<void> {
    // No-op: nothing to deliver in the background.
  }

  async getStatus(): Promise<HealthBridgeStatus> {
    return {
      available: false,
      configured: false,
      backgroundDeliveryEnabled: false,
      lastSyncedAt: null,
      lastError: null,
    };
  }

  async reset(): Promise<void> {
    // No-op.
  }
}
