import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConnectionStatus, RuleThresholdSettings, UserSettings } from "@run-far/shared";
import { AI_MODEL_OPTIONS, MIN_PASSWORD_LENGTH } from "@run-far/shared";
import { api, ApiError } from "../lib/api.js";
import { useAuth, useLogout, type Entitlement } from "../lib/auth.js";
import { ThresholdsCard } from "../components/ThresholdsCard.js";
import { AppleHealthCard, HealthSourceCard } from "../components/HealthSourceCard.js";
import { isNativeIos } from "../lib/appleHealth.js";
import {
  Badge,
  Button,
  ButtonLink,
  Field,
  FieldError,
  FieldSuccess,
  RowDescription,
  SettingsActionRow,
  SettingsGroup,
  SettingsRow,
  inputClass,
} from "../components/ui/index.js";

interface BillingStatus {
  entitlement: Entitlement;
  hasStripeCustomer: boolean;
  stripeConfigured: boolean;
  aiUsageThisMonthMicros: number;
  aiMonthlyLimitMicros: number;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * One external connection, as the body of a row.
 *
 * The badge lives in the closed row rather than in here, because "is Whoop connected?" is the
 * question people open this page to answer — having to expand something to find out was the
 * old card stack's worst habit.
 */
function ConnectionBody({
  description,
  status,
  connectUrl,
  onSyncNow,
  syncing,
  syncError,
  syncLabel = "Sync now",
}: {
  description: string;
  status: ConnectionStatus | undefined;
  connectUrl: string;
  onSyncNow?: () => void;
  syncing?: boolean;
  syncError?: string | null;
  syncLabel?: string;
}) {
  return (
    <div>
      <RowDescription>{description}</RowDescription>
      {status?.connected && status.lastSyncedAt && (
        <p className="mt-2 text-xs text-ink-muted">
          Last synced {new Date(status.lastSyncedAt).toLocaleString()}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!status?.connected && (
          <ButtonLink href={connectUrl} variant="primary">
            Connect
          </ButtonLink>
        )}
        {status?.connected && onSyncNow && (
          <Button onClick={onSyncNow} disabled={syncing}>
            {syncing ? "Syncing…" : syncLabel}
          </Button>
        )}
      </div>
      <FieldError>{syncError}</FieldError>
    </div>
  );
}

function connectionState(status: ConnectionStatus | undefined): ReactNode {
  return (
    <Badge tone={status?.connected ? "good" : "muted"}>
      {status?.connected ? "Connected" : "Not connected"}
    </Badge>
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
        className={inputClass}
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

function AiModelsBody({ settings }: { settings: UserSettings | undefined }) {
  const queryClient = useQueryClient();

  const updateSettings = useMutation({
    mutationFn: (body: { assistantModel?: string | null; planModel?: string | null }) =>
      api.patch<UserSettings>("/settings", body),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
    },
  });

  return (
    <div>
      <RowDescription>
        Which Claude model powers each AI agent. Leave these on default unless you have a reason
        to change them.
      </RowDescription>
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
      <FieldError>
        {updateSettings.isError ? errorMessage(updateSettings.error, "Failed to save") : null}
      </FieldError>
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

function LocationBody({ settings }: { settings: UserSettings | undefined }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const updateLocation = useMutation({
    mutationFn: (body: { locationLat: number; locationLon: number }) =>
      api.patch<UserSettings>("/settings", body),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
      setError(null);
    },
    onError: (err) => setError(errorMessage(err, "Failed to save location")),
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

  const isSet = settings?.locationLat != null && settings?.locationLon != null;
  const busy = locating || updateLocation.isPending;

  return (
    <div>
      <RowDescription>
        Your location powers weather on the calendar and in coaching recommendations (heat,
        storms, rain). It's set once from your browser — the app quietly keeps it current after
        that if you move, so you shouldn't need to touch this again.
      </RowDescription>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={useMyLocation} disabled={busy}>
          {busy ? "Locating…" : isSet ? "Update location" : "Use my location"}
        </Button>
      </div>
      <FieldError>{error}</FieldError>
    </div>
  );
}

function locationSummary(settings: UserSettings | undefined): string {
  if (settings?.locationLat == null || settings?.locationLon == null) return "Not set";
  return settings.locationUpdatedAt ? `Set ${relativeTime(settings.locationUpdatedAt)}` : "Set";
}

function AccountBody() {
  const logout = useLogout();
  const { user } = useAuth();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={() => logout()}>Sign out</Button>
      {user?.role === "admin" && (
        <ButtonLink href="https://backoffice.run-far.cc">Backoffice</ButtonLink>
      )}
    </div>
  );
}

const ENTITLEMENT_LABELS: Record<Entitlement["status"], string> = {
  trialing: "Trial",
  active: "Active",
  past_due: "Payment past due",
  canceled: "Canceled",
  none: "No subscription",
};

function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function billingSummary(status: BillingStatus | undefined): string {
  if (!status) return "Loading…";
  if (status.entitlement.source === "comp") return "Comped";
  return ENTITLEMENT_LABELS[status.entitlement.status];
}

function BillingBody({ status }: { status: BillingStatus | undefined }) {
  const openPortal = useMutation({
    mutationFn: () => api.post<{ url: string }>("/billing/portal"),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });

  if (!status) return <p className="text-sm text-ink-muted">Loading…</p>;

  const { entitlement } = status;
  const isComped = entitlement.source === "comp";

  return (
    <div>
      <RowDescription>
        {isComped ? (
          "Comped — full access, no charge."
        ) : (
          <>
            {ENTITLEMENT_LABELS[entitlement.status]}
            {entitlement.expiresAt && (
              <>
                {" — "}
                {entitlement.status === "trialing" ? "ends" : "renews"}{" "}
                {new Date(entitlement.expiresAt).toLocaleDateString()}
              </>
            )}
            .
          </>
        )}
      </RowDescription>
      <p className="mt-2 text-xs text-ink-muted">
        AI usage this month: {formatUsd(status.aiUsageThisMonthMicros)} of{" "}
        {formatUsd(status.aiMonthlyLimitMicros)}
      </p>
      {status.hasStripeCustomer && (
        <div className="mt-3">
          <Button onClick={() => openPortal.mutate()} disabled={openPortal.isPending}>
            {openPortal.isPending ? "Opening…" : "Manage billing"}
          </Button>
        </div>
      )}
      <FieldError>
        {openPortal.isError
          ? errorMessage(openPortal.error, "Couldn't open billing portal")
          : null}
      </FieldError>
    </div>
  );
}

function DeleteAccountBody() {
  const { user } = useAuth();
  const logout = useLogout();
  // The server requires a second proof of identity on DELETE /api/account (see
  // routes/account.ts) — the account password, or for Google-only accounts with no password
  // to re-enter, the athlete's own email address typed out.
  const needsPassword = user?.hasPassword ?? false;
  const [challenge, setChallenge] = useState("");
  const deleteAccount = useMutation({
    mutationFn: () =>
      api.delete("/account", needsPassword ? { password: challenge } : { confirmEmail: challenge }),
    onSuccess: async () => {
      await logout();
      window.location.href = "/";
    },
  });

  return (
    <div>
      <RowDescription>
        This permanently deletes your data and cancels any subscription. It can&rsquo;t be undone.
      </RowDescription>
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          deleteAccount.mutate();
        }}
      >
        <label htmlFor="settings-delete-challenge" className="w-full text-sm text-ink-secondary">
          {needsPassword
            ? "Enter your password to confirm."
            : `Type ${user?.email ?? "your email"} to confirm.`}
        </label>
        <input
          id="settings-delete-challenge"
          type={needsPassword ? "password" : "email"}
          autoComplete={needsPassword ? "current-password" : "off"}
          value={challenge}
          onChange={(e) => setChallenge(e.target.value)}
          placeholder={needsPassword ? "Your password" : "Your email address"}
          className={`${inputClass} min-w-0 flex-1`}
        />
        <Button
          type="submit"
          variant="dangerSolid"
          disabled={deleteAccount.isPending || challenge.trim() === ""}
        >
          {deleteAccount.isPending ? "Deleting…" : "Delete account"}
        </Button>
      </form>
      <FieldError>
        {deleteAccount.isError
          ? errorMessage(deleteAccount.error, "Couldn't delete account")
          : null}
      </FieldError>
    </div>
  );
}

// A Google-only account has no password to re-enter, so this row is really two different
// jobs wearing one title: "add a password so email sign-in works at all" and "change the
// password you already have". Splitting on hasPassword keeps each one to the fields it
// actually needs. The account email is shown, never edited — changing an address needs its
// own verified flow, and quietly rewriting it inside a password form would also break the
// Google link.
function PasswordBody() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const hasPassword = user?.hasPassword ?? false;
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const setPasswordMutation = useMutation({
    mutationFn: () =>
      api.post<{ id: string; email: string }>("/auth/set-password", {
        email: user?.email,
        password,
        currentPassword: hasPassword ? currentPassword : undefined,
      }),
    onSuccess: () => {
      setSuccess(true);
      setCurrentPassword("");
      setPassword("");
      setConfirmPassword("");
      // Flips the row into change-password mode without a reload.
      void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSuccess(false);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFormError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
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
        ? "Something went wrong — try again"
        : null;

  return (
    <div>
      <RowDescription>
        {hasPassword ? (
          <>
            You can sign in with <span className="text-ink-primary">{user?.email}</span> and a
            password. Change it here.
          </>
        ) : (
          <>
            You signed in with Google. Add a password to also sign in with{" "}
            <span className="text-ink-primary">{user?.email}</span> — same account, same data, and
            Google keeps working.
          </>
        )}
      </RowDescription>
      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        {hasPassword && (
          <Field
            id="settings-current-password"
            label="Current password"
            type="password"
            required
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            below={
              <a
                href="/forgot-password"
                className="mt-1.5 inline-block text-xs text-ink-secondary underline-offset-4 hover:underline"
              >
                Forgot your password?
              </a>
            }
          />
        )}
        {/* Hidden but present so password managers file the new credential under this account. */}
        <input type="email" name="email" autoComplete="username" value={user?.email ?? ""} readOnly hidden />
        <Field
          id="settings-password"
          label={hasPassword ? "New password" : "Password"}
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          help={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        />
        <Field
          id="settings-confirm-password"
          label={`Confirm ${hasPassword ? "new " : ""}password`}
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
        <Button type="submit" variant="primary" disabled={setPasswordMutation.isPending}>
          {setPasswordMutation.isPending
            ? "Saving…"
            : hasPassword
              ? "Change password"
              : "Add password"}
        </Button>
      </form>
      <FieldError>{formError ?? mutationError}</FieldError>
      <FieldSuccess>
        {success
          ? hasPassword
            ? "Password updated."
            : `Password added — you can now sign in with ${user?.email}.`
          : null}
      </FieldSuccess>
    </div>
  );
}

function appleHealthSummary(): string | undefined {
  // On an iPhone the row itself carries the connect/sync state; in a browser there is nothing
  // to connect, and a row with a blank right edge just looked broken next to its neighbours.
  return isNativeIos() ? undefined : "iPhone app only";
}

function thresholdSummary(data: RuleThresholdSettings | undefined): string {
  if (!data) return "";
  const changed = Object.values(data.overrides).filter((v) => v != null).length;
  if (changed === 0) return "All default";
  return `${changed} changed`;
}

export function Settings() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // These four queries are read here so the closed rows can state what they're set to. Each
  // shares a key with the component that owns the mutations, so react-query serves one
  // request and both stay in step.
  const settings = useQuery<UserSettings>({
    queryKey: ["settings"],
    queryFn: () => api.get<UserSettings>("/settings"),
  });
  const thresholds = useQuery<RuleThresholdSettings>({
    queryKey: ["settings", "thresholds"],
    queryFn: () => api.get<RuleThresholdSettings>("/settings/thresholds"),
  });
  const billing = useQuery<BillingStatus>({
    queryKey: ["billing", "status"],
    queryFn: () => api.get<BillingStatus>("/billing/status"),
  });
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

  const activeProvider = settings.data?.activeHealthProvider ?? "whoop";
  // The server also refuses a non-admin's PATCH of these fields — this just keeps the picker
  // itself from rendering for an account that could never use it.
  const canChooseModel = settings.data?.canChooseModel ?? false;

  return (
    <div className="max-w-2xl space-y-8">
      <header>
        <h1 className="font-display text-xl font-semibold text-ink-primary">Settings</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Your account, the data run-far reads, and how it coaches you.
        </p>
      </header>

      <SettingsGroup title="Account">
        <SettingsRow label="Account" summary={user?.email}>
          <AccountBody />
        </SettingsRow>
        <SettingsRow
          label={user?.hasPassword ? "Password" : "Email sign-in"}
          summary={user?.hasPassword ? "Set" : "Not set"}
        >
          <PasswordBody />
        </SettingsRow>
        <SettingsRow label="Billing" summary={billingSummary(billing.data)}>
          <BillingBody status={billing.data} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Data sources">
        <SettingsRow
          label="Recovery source"
          summary={activeProvider === "apple_health" ? "Apple Health" : "Whoop"}
        >
          <HealthSourceCard />
        </SettingsRow>
        <SettingsRow label="Whoop" status={connectionState(whoopStatus.data)}>
          <ConnectionBody
            description="Recovery, HRV, sleep, and workout data driving today's recommendation. Until Whoop webhooks are hosted live, use Sync now to pull the last 90 days."
            status={whoopStatus.data}
            connectUrl="/api/whoop/oauth/start"
            onSyncNow={() => syncWhoop.mutate()}
            syncing={syncWhoop.isPending}
            syncError={syncWhoop.isError ? errorMessage(syncWhoop.error, "Whoop sync failed") : null}
          />
        </SettingsRow>
        <SettingsRow label="Apple Health" summary={appleHealthSummary()}>
          <AppleHealthCard />
        </SettingsRow>
        <SettingsRow label="Google Calendar" status={connectionState(googleStatus.data)}>
          <ConnectionBody
            description="Connected when you sign in with Google. Two-way sync with a dedicated Running calendar — the app's schedule always wins on conflicts."
            status={googleStatus.data}
            connectUrl="/api/google/oauth/start"
            onSyncNow={() => syncGoogle.mutate()}
            syncing={syncGoogle.isPending}
            syncError={
              syncGoogle.isError ? errorMessage(syncGoogle.error, "Google sync failed") : null
            }
          />
        </SettingsRow>
        <SettingsRow label="Weather" summary={locationSummary(settings.data)}>
          <LocationBody settings={settings.data} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Coaching">
        <SettingsRow label="Thresholds" summary={thresholdSummary(thresholds.data)}>
          <ThresholdsCard />
        </SettingsRow>
        {canChooseModel && (
          <SettingsRow
            label="AI model"
            summary={
              settings.data?.assistantModel || settings.data?.planModel ? "Custom" : "Default"
            }
          >
            <AiModelsBody settings={settings.data} />
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsGroup title="Danger zone" tone="danger">
        <SettingsActionRow
          label="Export my data"
          description="Every run, recovery reading, and setting, as JSON."
        >
          <ButtonLink href="/api/account/export">Export</ButtonLink>
        </SettingsActionRow>
        <SettingsRow label="Delete my account">
          <DeleteAccountBody />
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
