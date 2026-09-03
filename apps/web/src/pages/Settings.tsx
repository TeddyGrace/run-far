import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConnectionStatus, UserSettings } from "@run-far/shared";
import { AI_MODEL_OPTIONS } from "@run-far/shared";
import { api, ApiError } from "../lib/api.js";
import { useAuth, useLogout } from "../lib/auth.js";

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

function ModelSelect({
  label,
  description,
  value,
  defaultModel,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  value: string | null | undefined;
  defaultModel: string;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-ink-primary">{label}</label>
      <p className="mb-2 text-xs text-ink-muted">{description}</p>
      <select
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-ink-primary disabled:opacity-50"
      >
        <option value="">Default ({defaultModel})</option>
        {AI_MODEL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function AiModelsCard() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery<UserSettings>({
    queryKey: ["settings"],
    queryFn: () => api.get<UserSettings>("/settings"),
  });

  const updateSettings = useMutation({
    mutationFn: (body: { assistantModel?: string | null; planModel?: string | null }) =>
      api.patch<UserSettings>("/settings", body),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
    },
  });

  const settings = settingsQuery.data;

  return (
    <div className="rounded-xl border border-border bg-surface-1 p-5">
      <h3 className="font-display font-semibold text-ink-primary">AI models</h3>
      <p className="mt-1 text-sm text-ink-secondary">
        Choose which Claude model powers each AI agent. Leave on default unless you have a reason to
        change it.
      </p>
      {settingsQuery.isLoading ? (
        <p className="mt-4 text-sm text-ink-muted">Loading…</p>
      ) : (
        <div className="mt-4 space-y-4">
          <ModelSelect
            label="Assistant"
            description="The chat assistant embedded across the app (recovery, calendar, schedule changes)."
            value={settings?.assistantModel}
            defaultModel={settings?.defaultAssistantModel ?? "server default"}
            disabled={updateSettings.isPending}
            onChange={(assistantModel) => updateSettings.mutate({ assistantModel })}
          />
          <ModelSelect
            label="Plan builder"
            description="The coach that drafts and revises training plans."
            value={settings?.planModel}
            defaultModel={settings?.defaultPlanModel ?? "server default"}
            disabled={updateSettings.isPending}
            onChange={(planModel) => updateSettings.mutate({ planModel })}
          />
        </div>
      )}
      {updateSettings.isError && (
        <p className="mt-3 text-sm text-zone-red">
          {updateSettings.error instanceof ApiError ? updateSettings.error.message : "Failed to save"}
        </p>
      )}
    </div>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function geolocationErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Location permission was denied. Enable location access for this site in your browser's settings, then try again.";
    case err.POSITION_UNAVAILABLE:
      return "Your location couldn't be determined right now. Try again in a moment.";
    case err.TIMEOUT:
      return "Location request timed out. Try again.";
    default:
      return "Couldn't get your location. Try again.";
  }
}

function LocationCard() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const settingsQuery = useQuery<UserSettings>({
    queryKey: ["settings"],
    queryFn: () => api.get<UserSettings>("/settings"),
  });

  const updateLocation = useMutation({
    mutationFn: (body: { locationLat: number; locationLon: number }) =>
      api.patch<UserSettings>("/settings", body),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to save location"),
  });

  function useMyLocation() {
    setError(null);
    if (!("geolocation" in navigator)) {
      setError("Your browser doesn't support location services.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        updateLocation.mutate({ locationLat: position.coords.latitude, locationLon: position.coords.longitude });
      },
      (err) => {
        setLocating(false);
        setError(geolocationErrorMessage(err));
      },
      { timeout: 10_000 },
    );
  }

  const settings = settingsQuery.data;
  const isSet = settings?.locationLat != null && settings?.locationLon != null;
  const busy = locating || updateLocation.isPending;

  return (
    <div className="rounded-xl border border-border bg-surface-1 p-5">
      <h3 className="font-display font-semibold text-ink-primary">Weather</h3>
      <p className="mt-1 text-sm text-ink-secondary">
        Your location powers weather on the calendar and in coaching recommendations (heat, storms,
        rain). It's set once from your browser — the app quietly keeps it current after that if you
        move, so you shouldn't need to touch this again.
      </p>
      {settingsQuery.isLoading ? (
        <p className="mt-4 text-sm text-ink-muted">Loading…</p>
      ) : (
        <div className="mt-4 flex items-center justify-between gap-4">
          <p className="text-sm text-ink-secondary">
            {isSet
              ? `Location set${settings?.locationUpdatedAt ? ` — last updated ${relativeTime(settings.locationUpdatedAt)}` : ""}`
              : "Not set — weather won't show until you set a location."}
          </p>
          <button
            onClick={useMyLocation}
            disabled={busy}
            className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm text-ink-secondary hover:text-ink-primary disabled:opacity-50"
          >
            {busy ? "Locating…" : isSet ? "Update location" : "Use my location"}
          </button>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-zone-red">{error}</p>}
    </div>
  );
}

function AccountCard() {
  const { user } = useAuth();
  const logout = useLogout();
  return (
    <div className="rounded-xl border border-border bg-surface-1 p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-display font-semibold text-ink-primary">Account</h3>
          <p className="mt-1 text-sm text-ink-secondary">Signed in as {user?.email}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            onClick={() => logout()}
            className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm text-ink-secondary hover:text-ink-primary"
          >
            Sign out
          </button>
          {user?.role === "admin" && (
            <a
              href="https://backoffice.run-far.cc"
              className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm text-ink-secondary hover:text-ink-primary"
            >
              Backoffice
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function EmailSignInCard() {
  const { user } = useAuth();
  const [email, setEmail] = useState(user?.email ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (user?.email) setEmail((current) => current || user.email);
  }, [user?.email]);

  const setPasswordMutation = useMutation({
    mutationFn: () =>
      api.post<{ id: string; email: string }>("/auth/set-password", {
        email,
        password,
        currentPassword: user?.hasPassword ? currentPassword : undefined,
      }),
    onSuccess: () => {
      setSuccess(true);
      setCurrentPassword("");
      setPassword("");
      setConfirmPassword("");
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSuccess(false);
    if (password !== confirmPassword) {
      setFormError("Passwords don't match");
      return;
    }
    setPasswordMutation.mutate();
  }

  const mutationError =
    setPasswordMutation.error instanceof ApiError
      ? setPasswordMutation.error.message
      : setPasswordMutation.isError
        ? "Failed to set password"
        : null;

  return (
    <div className="rounded-xl border border-border bg-surface-1 p-5">
      <h3 className="font-display font-semibold text-ink-primary">Email sign-in</h3>
      <p className="mt-1 text-sm text-ink-secondary">
        Set a password on your account so you can sign in with email instead of Google. This links to
        the same account — your data doesn't change.
      </p>
      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        {user?.hasPassword && (
          <div>
            <label htmlFor="settings-current-password" className="mb-1.5 block text-sm text-ink-secondary">
              Current password
            </label>
            <input
              id="settings-current-password"
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-base text-ink-primary sm:text-sm"
            />
          </div>
        )}
        <div>
          <label htmlFor="settings-email" className="mb-1.5 block text-sm text-ink-secondary">
            Email
          </label>
          <input
            id="settings-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-base text-ink-primary sm:text-sm"
          />
        </div>
        <div>
          <label htmlFor="settings-password" className="mb-1.5 block text-sm text-ink-secondary">
            Password
          </label>
          <input
            id="settings-password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-base text-ink-primary sm:text-sm"
          />
        </div>
        <div>
          <label htmlFor="settings-confirm-password" className="mb-1.5 block text-sm text-ink-secondary">
            Confirm password
          </label>
          <input
            id="settings-confirm-password"
            type="password"
            required
            minLength={8}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-base text-ink-primary sm:text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={setPasswordMutation.isPending}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-0 hover:opacity-90 disabled:opacity-50"
        >
          {setPasswordMutation.isPending ? "Saving…" : "Save password"}
        </button>
      </form>
      {formError && <p className="mt-3 text-sm text-zone-red">{formError}</p>}
      {mutationError && <p className="mt-3 text-sm text-zone-red">{mutationError}</p>}
      {success && <p className="mt-3 text-sm text-zone-good">Password saved — you can now sign in with email.</p>}
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
      <AccountCard />
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
      <EmailSignInCard />
      <LocationCard />
      <AiModelsCard />
    </div>
  );
}
