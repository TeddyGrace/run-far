import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Navigate, useLocation } from "react-router-dom";
import { api, setPaymentRequiredHandler } from "./api.js";
import { Subscribe } from "../pages/Subscribe.js";

export interface Entitlement {
  active: boolean;
  source: "comp" | "stripe" | "apple" | null;
  status: "trialing" | "active" | "past_due" | "canceled" | "none";
  expiresAt: string | null;
}

export interface CurrentUser {
  id: string;
  email: string;
  timezone: string | null;
  role: "admin" | "user";
  needsTutorial: boolean;
  /** @deprecated use entitlement.active */
  approved: boolean;
  entitlement: Entitlement;
  emailVerified: boolean;
  hasPassword: boolean;
}

/**
 * The one cache entry holding the signed-in athlete. Invariant: **only `/auth/me` writes a
 * user object here.** Every auth mutation route (`/auth/login`, `/auth/verify-email`,
 * `/auth/reset-password`, `/auth/set-password`) answers with a deliberately partial user —
 * seeding one of those makes the app render as though the session were fully loaded, with
 * `entitlement` undefined, which is a blank page rather than an error. Refresh through
 * `refreshCurrentUser` instead of writing here by hand.
 */
export const AUTH_ME_KEY = ["auth", "me"] as const;

export const currentUserQueryOptions = {
  queryKey: AUTH_ME_KEY,
  queryFn: () => api.get<CurrentUser>("/auth/me"),
  retry: false,
};

/**
 * Loads the full user into the cache and hands it back, for the moment after a mutation that
 * changes who the session is. Prefer this over `invalidateQueries`, which resolves even when
 * the refetch failed — a caller awaiting it can't tell a warm cache from a 500, and would
 * navigate into the app on either. This throws instead, so the caller can decide.
 */
export function refreshCurrentUser(queryClient: QueryClient): Promise<CurrentUser> {
  return queryClient.fetchQuery(currentUserQueryOptions);
}

/** The single answer to "does this user have access". Tolerates a half-loaded user rather
 * than throwing on `entitlement` — see the invariant on AUTH_ME_KEY. */
export function isEntitled(user: CurrentUser | null | undefined): boolean {
  return user?.entitlement?.active === true;
}

interface AuthContextValue {
  user: CurrentUser | null;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<CurrentUser>({
    ...currentUserQueryOptions,
    // An unentitled athlete's paywall has no other way to learn a Checkout/webhook or a
    // backoffice comp landed — poll gently so it clears within half a minute without a
    // manual reload. setPaymentRequiredHandler below covers the opposite direction (access
    // lapsing mid-session) immediately rather than waiting on this poll.
    refetchInterval: (query) => (query.state.data && !isEntitled(query.state.data) ? 30_000 : false),
  });

  // Any 402 from any API call (see lib/api.ts) means the session's entitlement just lapsed —
  // refetch immediately so the paywall replaces the current screen right away instead of on
  // the next 30s poll.
  useEffect(() => {
    setPaymentRequiredHandler(() => {
      void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    });
    return () => setPaymentRequiredHandler(null);
  }, [queryClient]);

  // Captures the browser's IANA zone on first login and whenever it drifts (e.g. travel) —
  // the only source for this, since the server has no other way to know it. Fires at most
  // once per user id per page load, not on every render.
  const syncedForUserId = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    if (syncedForUserId.current === data.id) return;
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (data.timezone === browserTz) {
      syncedForUserId.current = data.id;
      return;
    }
    syncedForUserId.current = data.id;
    api.patch("/settings", { timezone: browserTz }).catch(() => {
      // Best-effort — a failed capture just means the athlete's date bucketing falls back to
      // the server default until the next successful login.
    });
  }, [data]);

  return <AuthContext.Provider value={{ user: data ?? null, isLoading }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function useLogout() {
  const queryClient = useQueryClient();
  return async () => {
    await api.post("/auth/logout");
    queryClient.setQueryData(AUTH_ME_KEY, null);
  };
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-ink-muted">Loading…</div>;
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (!isEntitled(user)) {
    return <Subscribe />;
  }
  return <>{children}</>;
}
