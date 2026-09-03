import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useLocation } from "react-router-dom";
import { api } from "./api.js";
import { PendingApproval } from "../pages/PendingApproval.js";

export interface CurrentUser {
  id: string;
  email: string;
  timezone: string | null;
  needsTutorial: boolean;
  approved: boolean;
  emailVerified: boolean;
  hasPassword: boolean;
}

interface AuthContextValue {
  user: CurrentUser | null;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery<CurrentUser>({
    queryKey: ["auth", "me"],
    queryFn: () => api.get<CurrentUser>("/auth/me"),
    retry: false,
    // A pending athlete's PendingApproval screen has no other way to learn they've been
    // approved — poll gently so it lands within half a minute without a manual reload.
    refetchInterval: (query) => (query.state.data && !query.state.data.approved ? 30_000 : false),
  });

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
    queryClient.setQueryData(["auth", "me"], null);
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
  if (!user.approved) {
    return <PendingApproval />;
  }
  return <>{children}</>;
}
