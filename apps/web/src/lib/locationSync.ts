import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserSettings } from "@run-far/shared";
import { api } from "./api.js";

// Below this, treat it as GPS/wifi-positioning jitter around the same spot, not a move —
// keeps this from silently rewriting locationUpdatedAt (and re-fetching weather) every session.
const MOVE_THRESHOLD_KM = 8;

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Silently keeps the athlete's stored location current once they've opted in (via the
 * "Use my location" button in Settings) — no new permission prompt, no UI, no user action
 * required after that first grant. Runs once per app load: if the browser already has
 * geolocation permission granted and the current fix differs meaningfully from what's
 * stored, PATCHes the new coordinates. Does nothing (and never prompts) for an athlete who
 * hasn't set a location yet — that first grant only ever happens via the explicit button. */
export function useAutoUpdateLocation() {
  const queryClient = useQueryClient();
  const attempted = useRef(false);

  const settingsQuery = useQuery<UserSettings>({
    queryKey: ["settings"],
    queryFn: () => api.get<UserSettings>("/settings"),
  });

  const updateLocation = useMutation({
    mutationFn: (body: { locationLat: number; locationLon: number }) =>
      api.patch<UserSettings>("/settings", body),
    onSuccess: (data) => queryClient.setQueryData(["settings"], data),
  });

  useEffect(() => {
    if (attempted.current) return;
    if (!settingsQuery.data) return;
    const { locationLat, locationLon } = settingsQuery.data;
    if (locationLat == null || locationLon == null) return; // never seed automatically
    if (!("geolocation" in navigator)) return;
    attempted.current = true;
    const stored = { lat: locationLat, lon: locationLon };

    async function refresh() {
      if (navigator.permissions?.query) {
        try {
          const status = await navigator.permissions.query({ name: "geolocation" as PermissionName });
          if (status.state !== "granted") return; // don't risk a re-prompt
        } catch {
          // Permissions API not fully supported (e.g. Safari) — fall through and try silently.
        }
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const next = { lat: position.coords.latitude, lon: position.coords.longitude };
          if (haversineKm(stored, next) >= MOVE_THRESHOLD_KM) {
            updateLocation.mutate({ locationLat: next.lat, locationLon: next.lon });
          }
        },
        () => {
          // Silent: permission revoked, no fix available, etc. The Settings button remains
          // the way to fix this — this background path never surfaces an error.
        },
        { maximumAge: 30 * 60_000, timeout: 10_000 },
      );
    }

    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsQuery.data]);
}
