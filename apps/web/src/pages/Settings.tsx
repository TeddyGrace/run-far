import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConnectionStatus } from "@run-far/shared";
import { api, ApiError } from "../lib/api.js";

function ConnectionCard({
  title,
  description,
  status,
  connectUrl,
  onSyncNow,
  syncing,
  syncError,
  syncLabel = "Sync now",
}: {
  title: string;
  description: string;
  status: ConnectionStatus | undefined;
  connectUrl: string;
  onSyncNow?: () => void;
  syncing?: boolean;
  syncError?: string | null;
  syncLabel?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-1 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display font-semibold text-ink-primary">{title}</h3>
          <p className="mt-1 text-sm text-ink-secondary">{description}</p>
          {status?.connected && status.lastSyncedAt && (
            <p className="mt-2 text-xs text-ink-muted">
              Last synced {new Date(status.lastSyncedAt).toLocaleString()}
            </p>
          )}
        </div>
        <span
          className={
            "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium " +
            (status?.connected ? "bg-zone-good/15 text-zone-good" : "bg-surface-2 text-ink-muted")
          }
        >
          {status?.connected ? "Connected" : "Not connected"}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!status?.connected && (
          <a
            href={connectUrl}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-0 hover:opacity-90"
          >
            Connect
          </a>
        )}
        {status?.connected && onSyncNow && (
          <button
            onClick={onSyncNow}
            disabled={syncing}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-ink-secondary hover:text-ink-primary disabled:opacity-50"
          >
            {syncing ? "Syncing…" : syncLabel}
          </button>
        )}
      </div>
      {syncError && <p className="mt-3 text-sm text-zone-red">{syncError}</p>}
    </div>
  );
}

export function Settings() {
  const queryClient = useQueryClient();

  const whoopStatus = useQuery<ConnectionStatus>({
    queryKey: ["whoop", "status"],
    queryFn: () => api.get<ConnectionStatus>("/whoop/status"),
  });
  const googleStatus = useQuery<ConnectionStatus>({
    queryKey: ["google", "status"],
    queryFn: () => api.get<ConnectionStatus>("/google/status"),
  });

  const syncWhoop = useMutation({
    mutationFn: () => api.post<{ ok: true; lastSyncedAt: string | null }>("/whoop/sync"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["whoop", "status"] });
      void queryClient.invalidateQueries({ queryKey: ["recovery"] });
      void queryClient.invalidateQueries({ queryKey: ["recommendations"] });
    },
  });

  const syncGoogle = useMutation({
    mutationFn: () => api.post("/google/sync"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["google", "status"] });
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="mb-2 font-display text-xl font-semibold text-ink-primary">Settings</h1>
      <ConnectionCard
        title="Whoop"
        description="Recovery, HRV, sleep, and workout data driving today's recommendation. Until Whoop webhooks are hosted live, use Sync now to pull the last 90 days."
        status={whoopStatus.data}
        connectUrl="/api/whoop/oauth/start"
        onSyncNow={() => syncWhoop.mutate()}
        syncing={syncWhoop.isPending}
        syncLabel="Sync now"
        syncError={
          syncWhoop.isError
            ? syncWhoop.error instanceof ApiError
              ? syncWhoop.error.message
              : "Whoop sync failed"
            : null
        }
      />
      <ConnectionCard
        title="Google Calendar"
        description="Connected when you sign in with Google. Two-way sync with a dedicated Running calendar — the app's schedule always wins on conflicts."
        status={googleStatus.data}
        connectUrl="/api/google/oauth/start"
        onSyncNow={() => syncGoogle.mutate()}
        syncing={syncGoogle.isPending}
        syncError={
          syncGoogle.isError
            ? syncGoogle.error instanceof ApiError
              ? syncGoogle.error.message
              : "Google sync failed"
            : null
        }
      />
    </div>
  );
}
