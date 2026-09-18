import { useEffect, useState } from "react";
import clsx from "clsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HealthProvider, UserSettings } from "@run-far/shared";
import { HEALTH_PROVIDER_LABELS } from "@run-far/shared";
import type { HealthBridgeStatus, HealthBridgeSyncResult } from "@run-far/health-bridge";

import { api, ApiError } from "../lib/api.js";
import { Button, FieldError, RowDescription } from "./ui/index.js";
import {
  connectAppleHealth,
  disconnectAppleHealth,
  getAppleHealthStatus,
  isNativeIos,
  syncAppleHealth,
} from "../lib/appleHealth.js";

/**
 * Which wearable the engine reads.
 *
 * Just the choice now — the Apple Health connection it used to sit beside lives in
 * AppleHealthCard below. They looked like one decision when they shared a card, and they
 * aren't: you can have HealthKit wired up perfectly and still be reading Whoop.
 */
export function HealthSourceCard() {
  const queryClient = useQueryClient();

  const settings = useQuery<UserSettings>({
    queryKey: ["settings"],
    queryFn: () => api.get<UserSettings>("/settings"),
  });

  const setProvider = useMutation({
    mutationFn: (provider: HealthProvider) =>
      api.patch<UserSettings>("/settings", { activeHealthProvider: provider }),
    onSuccess: () => {
      // Switching provider changes every input the engine reads, so nothing already on screen
      // was computed from the athlete's now-active data.
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["recovery"] });
      void queryClient.invalidateQueries({ queryKey: ["recommendations"] });
      void queryClient.invalidateQueries({ queryKey: ["adherence"] });
      void queryClient.invalidateQueries({ queryKey: ["activities"] });
    },
  });

  const active = settings.data?.activeHealthProvider ?? "whoop";
  const availability = settings.data?.healthProviderAvailability;

  return (
    <div>
      <RowDescription>
        Which wearable drives your recovery score, sleep, and workouts. Only one at a time — a
        Whoop HRV reading (RMSSD) and an Apple Watch one (SDNN) are different measurements, so
        mixing them would make your baselines meaningless.
      </RowDescription>

      <div className="mt-4 space-y-2">
        {(["whoop", "apple_health"] as const).map((provider) => {
          const hasData =
            provider === "whoop" ? availability?.whoop : availability?.appleHealth;
          const isActive = active === provider;
          return (
            <label
              key={provider}
              className={clsx(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3",
                isActive ? "border-accent bg-surface-2" : "border-border",
              )}
            >
              <input
                type="radio"
                name="health-provider"
                className="mt-1"
                checked={isActive}
                disabled={setProvider.isPending}
                onChange={() => setProvider.mutate(provider)}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink-primary">
                  {HEALTH_PROVIDER_LABELS[provider]}
                </span>
                <span className="block text-xs text-ink-muted">
                  {provider === "whoop"
                    ? "Whoop's own recovery score, strain, and sleep."
                    : "Apple Watch HRV, resting heart rate, sleep, and workouts — run-far computes the recovery score."}
                </span>
                {/* Said before switching, not discovered afterwards: an empty dashboard with no
                    explanation is the worst version of this. */}
                {hasData === false && (
                  <span className="mt-1 block text-xs text-zone-yellow">
                    No data stored yet — switching now would leave your dashboard empty until this
                    source syncs.
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>

      <FieldError>
        {setProvider.isError
          ? setProvider.error instanceof ApiError
            ? setProvider.error.message
            : "Couldn't change the data source."
          : null}
      </FieldError>
    </div>
  );
}

/**
 * The Apple Health connection.
 *
 * Its own row rather than a divided-off half of the picker above: choosing which source the
 * engine reads and wiring up HealthKit are two different jobs, and the old single card made it
 * easy to think connecting was the same as selecting. The one thing that card said well —
 * data can sync perfectly while the dashboard ignores it, because Whoop is still selected —
 * survives in AppleHealthSyncSummary below.
 */
export function AppleHealthCard() {
  const queryClient = useQueryClient();

  const settings = useQuery<UserSettings>({
    queryKey: ["settings"],
    queryFn: () => api.get<UserSettings>("/settings"),
  });

  const [bridgeStatus, setBridgeStatus] = useState<HealthBridgeStatus | null>(null);
  const [syncResult, setSyncResult] = useState<HealthBridgeSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const native = isNativeIos();

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    void getAppleHealthStatus().then((status) => {
      if (!cancelled) setBridgeStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, [native]);

  const connect = useMutation({
    mutationFn: connectAppleHealth,
    onSuccess: async (result) => {
      setError(result.available ? null : (result.reason ?? "Apple Health isn't available here."));
      setSyncResult(result.sync ?? null);
      setBridgeStatus(await getAppleHealthStatus());
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["recovery"] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : "Couldn't connect Apple Health."),
  });

  const sync = useMutation({
    mutationFn: () => syncAppleHealth(false),
    onSuccess: async (result) => {
      setSyncResult(result);
      setError(result.error ?? null);
      setBridgeStatus(await getAppleHealthStatus());
      void queryClient.invalidateQueries({ queryKey: ["recovery"] });
      void queryClient.invalidateQueries({ queryKey: ["recommendations"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Sync failed."),
  });

  const disconnect = useMutation({
    mutationFn: disconnectAppleHealth,
    onSuccess: async () => {
      setSyncResult(null);
      setError(null);
      setBridgeStatus(await getAppleHealthStatus());
    },
  });

  const active = settings.data?.activeHealthProvider ?? "whoop";

  return (
    <div>
      {!native ? (
        // The honest answer rather than a button that can't work: HealthKit is only readable
        // by an app running on the device.
        <RowDescription>
          Apple Health can only be read by the run-far iOS app on an iPhone — there's no way to
          reach it from a browser. Install the app and connect it there; the data lands in this
          same account.
        </RowDescription>
      ) : !bridgeStatus?.available ? (
        <RowDescription>
          This device doesn't have an Apple Health store (HealthKit needs an iPhone).
        </RowDescription>
      ) : (
        <>
          <RowDescription>
            {bridgeStatus.configured
              ? "Connected. run-far reads new sleep and workouts in the background, so your recovery score is ready before you open the app."
              : "Connect to let run-far read your sleep, HRV, resting heart rate, and workouts."}
          </RowDescription>
          {bridgeStatus.configured && bridgeStatus.lastSyncedAt && (
            <p className="mt-2 text-xs text-ink-muted">
              Last synced {new Date(bridgeStatus.lastSyncedAt).toLocaleString()}
            </p>
          )}
          {bridgeStatus.lastError && (
            <p className="mt-2 text-xs text-zone-yellow">Last sync problem: {bridgeStatus.lastError}</p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {!bridgeStatus.configured ? (
              <Button
                variant="primary"
                disabled={connect.isPending}
                onClick={() => connect.mutate()}
              >
                {connect.isPending ? "Connecting…" : "Connect Apple Health"}
              </Button>
            ) : (
              <>
                <Button disabled={sync.isPending} onClick={() => sync.mutate()}>
                  {sync.isPending ? "Syncing…" : "Sync now"}
                </Button>
                <Button
                  variant="danger"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                >
                  Disconnect
                </Button>
              </>
            )}
          </div>

          <AppleHealthSyncSummary result={syncResult} activeProvider={active} />
          <FieldError>{error}</FieldError>
        </>
      )}
    </div>
  );
}

/**
 * What a sync actually achieved.
 *
 * Worth its own component because "synced" on its own is misleading in two situations that are
 * both normal: the data landed but isn't being read (Whoop still selected), and the data landed
 * but can't be scored yet (not enough baseline). Both look like nothing happened.
 */
function AppleHealthSyncSummary({
  result,
  activeProvider,
}: {
  result: HealthBridgeSyncResult | null;
  activeProvider: HealthProvider;
}) {
  if (!result) return null;

  const { read, ingested } = result;
  if (!ingested) {
    return (
      <p className="mt-3 text-xs text-ink-muted">
        Read {read.sleepSessions} night{read.sleepSessions === 1 ? "" : "s"} and {read.workouts}{" "}
        workout{read.workouts === 1 ? "" : "s"} from Apple Health.
        {/* Zero of everything after granting permission almost always means the permission
            sheet was declined — iOS won't tell us directly, so this is the one honest hint. */}
        {read.sleepSessions === 0 && read.workouts === 0 && (
          <>
            {" "}
            Nothing came back — if you declined any of the Health permissions, you can grant them
            in iOS Settings → Health → Data Access &amp; Devices → run-far.
          </>
        )}
      </p>
    );
  }

  const baselineShort = ingested.baselineDays < ingested.baselineDaysRequired;
  const daysToGo = ingested.baselineDaysRequired - ingested.baselineDays;

  return (
    <div className="mt-3 space-y-1 text-xs text-ink-muted">
      <p>
        Synced {ingested.sleepSessions} night{ingested.sleepSessions === 1 ? "" : "s"} and{" "}
        {ingested.workouts} workout{ingested.workouts === 1 ? "" : "s"}.
      </p>
      {activeProvider !== "apple_health" && (
        <p className="text-zone-yellow">
          Stored, but not being used yet — your data source above is still{" "}
          {HEALTH_PROVIDER_LABELS[activeProvider]}. Switch to Apple Health to use it.
        </p>
      )}
      {baselineShort && (
        <p>
          Still collecting your baseline: {daysToGo} more night{daysToGo === 1 ? "" : "s"} before
          run-far can score your recovery. A score built on less history than that swings on
          ordinary night-to-night variation, so it stays blank rather than guessing.
        </p>
      )}
    </div>
  );
}
