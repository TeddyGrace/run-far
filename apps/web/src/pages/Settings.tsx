import { useQuery, useMutation } from "@tanstack/react-query";
import type { ConnectionStatus } from "@run-far/shared";
import { api } from "../lib/api.js";

function ConnectionCard({
  title,
  description,
  status,
  connectUrl,
  onSyncNow,
  syncing,
}: {
  title: string;
  description: string;
  status: ConnectionStatus | undefined;
  connectUrl: string;
  onSyncNow?: () => void;
  syncing?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-1 p-5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-display font-semibold text-ink-primary">{title}</h3>
          <p className="mt-1 text-sm text-ink-secondary">{description}</p>
        </div>
        <span
          className={
            "rounded-full px-2.5 py-1 text-xs font-medium " +
            (status?.connected ? "bg-zone-good/15 text-zone-good" : "bg-surface-2 text-ink-muted")
          }
        >
          {status?.connected ? "Connected" : "Not connected"}
        </span>
      </div>
      <div className="mt-4 flex gap-2">
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
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        )}
      </div>
    </div>
  );
}

export function Settings() {
  const whoopStatus = useQuery<ConnectionStatus>({
    queryKey: ["whoop", "status"],
    queryFn: () => api.get<ConnectionStatus>("/whoop/status"),
  });
  const googleStatus = useQuery<ConnectionStatus>({
    queryKey: ["google", "status"],
    queryFn: () => api.get<ConnectionStatus>("/google/status"),
  });

  const syncGoogle = useMutation({
    mutationFn: () => api.post("/google/sync"),
  });

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="mb-2 font-display text-xl font-semibold text-ink-primary">Settings</h1>
      <ConnectionCard
        title="Whoop"
        description="Recovery, HRV, sleep, and workout data driving today's recommendation."
        status={whoopStatus.data}
        connectUrl="/api/whoop/oauth/start"
      />
      <ConnectionCard
        title="Google Calendar"
        description="Two-way sync with a dedicated Running calendar. The app's schedule always wins on conflicts."
        status={googleStatus.data}
        connectUrl="/api/google/oauth/start"
        onSyncNow={() => syncGoogle.mutate()}
        syncing={syncGoogle.isPending}
      />
    </div>
  );
}
