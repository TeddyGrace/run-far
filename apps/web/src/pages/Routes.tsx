import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import type {
  GenerateRouteResult,
  LatLon,
  PlannedRoute,
  RouteElevation,
  RouteMapConfig,
  RoutePlanStreamEvent,
  RouteSource,
  SavedRoute,
  UserSettings,
} from "@run-far/shared";
import { api, ApiError } from "../lib/api.js";
import { formatMiles } from "../lib/units.js";
import { FEET_PER_METER, SegmentCache, legsOf, mapLimit, stitch } from "../lib/routeSegments.js";
import { RouteMap } from "../components/RouteMap.js";
import { Button, FieldError, inputClass } from "../components/ui/index.js";

type Mode = "draw" | "ai";

const AI_EXAMPLES = [
  "5 mile loop",
  "3 easy miles through a park",
  "6 mile out-and-back along the water",
  "Flat 10K",
];

// The elevation service samples ~100 points anyway; no need to upload thousands.
const MAX_ELEVATION_POINTS = 2_000;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** One-shot browser geolocation as a promise. */
function locate(): Promise<LatLon> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("This browser can't share its location."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.latitude, pos.coords.longitude]),
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? "Location permission is off. Allow it in your browser, or tap the map to set a start."
              : "Couldn't get your location. Tap the map to set a start instead.",
          ),
        ),
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 15_000 },
    );
  });
}

function thin(points: LatLon[], max: number): LatLon[] {
  if (points.length <= max) return points;
  const stride = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * stride)]!);
}

function formatClimb(m: number): string {
  return `${Math.round(m * FEET_PER_METER).toLocaleString()} ft`;
}

export function Routes() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>("draw");
  const [here, setHere] = useState<LatLon | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  const [waypoints, setWaypoints] = useState<LatLon[]>([]);
  const [route, setRoute] = useState<PlannedRoute | null>(null);
  const [source, setSource] = useState<RouteSource>("manual");
  const [snapping, setSnapping] = useState(false);
  const [elevationLoading, setElevationLoading] = useState(false);
  const [snapError, setSnapError] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const segments = useRef(new SegmentCache());
  // Set when waypoints arrive with their geometry already known (an AI route, a saved route),
  // so the snap effect doesn't immediately re-route what the server just routed.
  const preSnapped = useRef<LatLon[] | null>(null);

  const [prompt, setPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiProgress, setAiProgress] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const aiAbort = useRef<AbortController | null>(null);

  const [name, setName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const configQuery = useQuery({
    queryKey: ["routes", "config"],
    queryFn: () => api.get<RouteMapConfig>("/routes/config"),
    staleTime: Infinity,
  });
  const elevationEnabled = configQuery.data?.elevationEnabled ?? false;

  const settingsQuery = useQuery<UserSettings>({
    queryKey: ["settings"],
    queryFn: () => api.get<UserSettings>("/settings"),
  });
  const storedLocation: LatLon | null =
    settingsQuery.data?.locationLat != null && settingsQuery.data?.locationLon != null
      ? [settingsQuery.data.locationLat, settingsQuery.data.locationLon]
      : null;

  const savedQuery = useQuery({
    queryKey: ["routes", "saved"],
    queryFn: () => api.get<{ items: SavedRoute[] }>("/routes"),
  });

  const findMe = useCallback(async () => {
    setLocating(true);
    setLocateError(null);
    try {
      setHere(await locate());
    } catch (err) {
      setLocateError(err instanceof Error ? err.message : "Couldn't get your location.");
    } finally {
      setLocating(false);
    }
  }, []);

  // Ask for a fix on arrival — this page is the one place location is the whole point, and the
  // browser only prompts once; after a denial this fails quietly into the tap-to-start path.
  useEffect(() => {
    void findMe();
  }, [findMe]);

  // Abandon an in-flight AI request if the athlete leaves the page.
  useEffect(() => () => aiAbort.current?.abort(), []);

  // Snap the drawn waypoints to real paths, one leg at a time so an edit only routes the legs
  // it changed, then look up climb once for the whole route. Debounced so a burst of taps
  // routes once.
  useEffect(() => {
    if (preSnapped.current === waypoints) return;
    if (waypoints.length < 2) {
      setRoute(null);
      setSnapError(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSnapping(true);
      try {
        const legs = await mapLimit(legsOf(waypoints), 4, async ([a, b]) => {
          const hit = segments.current.get(a, b);
          if (hit) return hit;
          const snapped = await api.post<PlannedRoute>("/routes/snap", { waypoints: [a, b], elevation: false });
          const seg = { geometry: snapped.geometry, distanceM: snapped.distanceM };
          segments.current.set(a, b, seg);
          return seg;
        });
        if (cancelled) return;
        const joined = stitch(legs);
        setRoute({ waypoints, ...joined, elevationGainM: null, elevationLossM: null });
        setSnapError(null);
        setSnapping(false);

        if (!elevationEnabled) return;
        setElevationLoading(true);
        try {
          const e = await api.post<RouteElevation>("/routes/elevation", {
            geometry: thin(joined.geometry, MAX_ELEVATION_POINTS),
          });
          if (!cancelled) setRoute((r) => (r && r.waypoints === waypoints ? { ...r, ...e } : r));
        } catch {
          // Climb stays unknown; the route itself is fine.
        } finally {
          if (!cancelled) setElevationLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setSnapError(errorMessage(err, "Couldn't snap the route to paths."));
          setSnapping(false);
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setElevationLoading(false);
    };
  }, [waypoints, elevationEnabled]);

  const editWaypoints = (next: LatLon[], from: RouteSource = "manual") => {
    setSource(from);
    setSavedNotice(null);
    setWaypoints(next);
  };

  const handleMapClick = (p: LatLon) => {
    if (aiBusy) return;
    if (mode === "ai") {
      // In AI mode a tap moves the start point, which throws away a planned route — so ask
      // first rather than lose it to a stray tap while panning.
      if (route && waypoints.length > 1 && !window.confirm("Start a new route from here? This clears the current route.")) {
        return;
      }
      setAiMessage(null);
      editWaypoints([p]);
      setRoute(null);
      return;
    }
    setAiMessage(null);
    if (waypoints.length === 0) {
      editWaypoints(here ? [here, p] : [p]);
      return;
    }
    const last = waypoints.length - 1;
    // Adding to a closed loop extends it rather than breaking it open.
    if (isClosed(waypoints)) editWaypoints([...waypoints.slice(0, last), p, waypoints[last]!]);
    else editWaypoints([...waypoints, p]);
  };

  const handleWaypointMove = (index: number, p: LatLon) => {
    setSavedNotice(null);
    setSource("manual");
    setWaypoints((prev) => prev.map((w, i) => (i === index ? p : w)));
  };

  const closed = isClosed(waypoints);
  const startPoint = waypoints[0] ?? here;

  const applyAiResult = (res: GenerateRouteResult) => {
    setAiMessage(res.message);
    if (!res.route) return;
    preSnapped.current = res.route.waypoints;
    setWaypoints(res.route.waypoints);
    setRoute(res.route);
    setSource("ai");
    setName(res.route.name);
    setSnapError(null);
    setSavedNotice(null);
    setFitKey((k) => k + 1);
  };

  const generate = async () => {
    if (!startPoint || !prompt.trim()) return;
    aiAbort.current?.abort();
    const controller = new AbortController();
    aiAbort.current = controller;
    setAiBusy(true);
    setAiError(null);
    setAiMessage(null);
    setAiProgress("Starting…");
    let finished = false;
    try {
      await api.stream<RoutePlanStreamEvent>(
        "/routes/generate/stream",
        { start: startPoint, prompt: prompt.trim() },
        (event) => {
          if (event.type === "progress") setAiProgress(event.message);
          else if (event.type === "done") {
            finished = true;
            applyAiResult(event.result);
          } else {
            finished = true;
            setAiError(event.message);
          }
        },
        controller.signal,
      );
      if (!finished) setAiError("The connection dropped before the route was ready. Try again.");
    } catch (err) {
      if (!controller.signal.aborted) setAiError(errorMessage(err, "Couldn't plan a route."));
    } finally {
      if (aiAbort.current === controller) {
        setAiBusy(false);
        setAiProgress(null);
      }
    }
  };

  const cancelAi = () => {
    aiAbort.current?.abort();
    setAiBusy(false);
    setAiProgress(null);
  };

  const save = useMutation({
    mutationFn: () =>
      api.post<SavedRoute>("/routes", {
        name: name.trim() || defaultName(route),
        source,
        waypoints: route!.waypoints,
        geometry: route!.geometry,
        distanceM: route!.distanceM,
        elevationGainM: route!.elevationGainM,
        elevationLossM: route!.elevationLossM,
      }),
    onSuccess: (saved) => {
      setSaveError(null);
      setSavedNotice(`Saved “${saved.name}”.`);
      void qc.invalidateQueries({ queryKey: ["routes", "saved"] });
    },
    onError: (err) => setSaveError(errorMessage(err, "Couldn't save the route.")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/routes/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["routes", "saved"] }),
  });

  const showSaved = (r: SavedRoute) => {
    preSnapped.current = r.waypoints;
    setWaypoints(r.waypoints);
    setRoute({
      waypoints: r.waypoints,
      geometry: r.geometry,
      distanceM: r.distanceM,
      elevationGainM: r.elevationGainM,
      elevationLossM: r.elevationLossM,
    });
    setSource(r.source);
    setName(r.name);
    setAiMessage(null);
    setSnapError(null);
    setSavedNotice(null);
    setMode("draw");
    setFitKey((k) => k + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const clear = () => {
    editWaypoints([]);
    setRoute(null);
    setAiMessage(null);
    setName("");
  };

  const routeIsCurrent = route != null && route.waypoints === waypoints;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Routes</h1>
        <p className="text-sm text-ink-secondary">
          Plot a run from where you are, or describe the run you want and let the AI map it.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-border p-0.5" role="tablist" aria-label="Planning mode">
          {(["draw", "ai"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={clsx(
                "rounded px-3 py-1 text-sm font-medium transition-colors",
                mode === m ? "bg-surface-2 text-ink-primary" : "text-ink-secondary hover:text-ink-primary",
              )}
            >
              {m === "draw" ? "Draw it" : "Ask AI"}
            </button>
          ))}
        </div>
        <Button onClick={() => void findMe()} disabled={locating}>
          {locating ? "Locating…" : here ? "Re-center on me" : "Use my location"}
        </Button>
        {here && (
          <Button
            disabled={aiBusy}
            onClick={() => {
              if (route && !window.confirm("Start a new route from your location? This clears the current route.")) return;
              editWaypoints([here]);
              setRoute(null);
              setAiMessage(null);
            }}
          >
            Start here
          </Button>
        )}
      </div>
      {locateError && <p className="text-sm text-zone-yellow">{locateError}</p>}

      {mode === "ai" && (
        <section className="space-y-3 rounded-lg border border-border bg-surface-1 p-4">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void generate();
            }}
          >
            <label htmlFor="route-prompt" className="block text-sm font-medium text-ink-primary">
              What kind of run?
            </label>
            <textarea
              id="route-prompt"
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. a 5 mile loop that goes past some water"
              className={clsx(inputClass, "w-full resize-y")}
              maxLength={1000}
              disabled={aiBusy}
            />
            <div className="flex flex-wrap gap-2">
              {AI_EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  disabled={aiBusy}
                  onClick={() => setPrompt(ex)}
                  className="rounded-full border border-border px-3 py-1 text-xs text-ink-secondary hover:border-ink-muted hover:text-ink-primary disabled:opacity-50"
                >
                  {ex}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {aiBusy ? (
                <Button onClick={cancelAi}>Cancel</Button>
              ) : (
                <Button type="submit" variant="primary" disabled={!startPoint || !prompt.trim()}>
                  Map it
                </Button>
              )}
              <span className="text-xs text-ink-muted">
                {startPoint
                  ? waypoints[0]
                    ? "Starting from the S point on the map. Tap the map to move it."
                    : "Starting from your current location. Tap the map to start somewhere else."
                  : "Tap the map to set a start point."}
              </span>
            </div>
          </form>
          {aiBusy && aiProgress && (
            <p className="flex items-center gap-2 text-sm text-ink-secondary" role="status" aria-live="polite">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
              {aiProgress}
            </p>
          )}
          <FieldError>{aiError}</FieldError>
          {aiMessage && !aiBusy && <p className="text-sm text-ink-primary">{aiMessage}</p>}
        </section>
      )}

      <div className="space-y-2">
        <RouteMap
          tileUrl={configQuery.data?.tileUrl}
          tileAttribution={configQuery.data?.tileAttribution}
          center={here ?? storedLocation}
          here={here}
          waypoints={waypoints}
          geometry={route?.geometry ?? []}
          onMapClick={handleMapClick}
          onWaypointMove={mode === "draw" && !aiBusy ? handleWaypointMove : undefined}
          fitKey={fitKey}
        />
        <p className="text-xs text-ink-muted">
          Keyboard: focus the map, use the arrow keys to pan and +/− to zoom, and press Enter to add a point at the
          crosshair.
        </p>
      </div>

      <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-border bg-surface-1 p-4">
        <div className="flex gap-6" aria-live="polite">
          <div className="min-w-[6.5rem]">
            <div className="text-xs uppercase tracking-wide text-ink-muted">Distance</div>
            <div className="font-mono text-2xl text-ink-primary">
              {route ? formatMiles(route.distanceM) : "—"}
              {snapping && <span className="ml-2 text-xs text-ink-muted">routing…</span>}
            </div>
          </div>
          <div className="min-w-[5.5rem]">
            <div className="text-xs uppercase tracking-wide text-ink-muted">Climb</div>
            <div
              className="font-mono text-2xl text-ink-primary"
              title={elevationEnabled ? undefined : "Elevation isn't available on this server."}
            >
              {!route ? (
                "—"
              ) : routeIsCurrent && elevationLoading ? (
                <span className="text-base text-ink-muted">…</span>
              ) : route.elevationGainM != null ? (
                formatClimb(route.elevationGainM)
              ) : (
                <span className="text-base text-ink-muted">n/a</span>
              )}
            </div>
          </div>
        </div>
        {mode === "draw" && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => editWaypoints(waypoints.slice(0, -1))} disabled={waypoints.length === 0}>
              Undo
            </Button>
            <Button onClick={() => editWaypoints([...waypoints, waypoints[0]!])} disabled={waypoints.length < 2 || closed}>
              Close loop
            </Button>
            <Button
              onClick={() => editWaypoints([...waypoints, ...waypoints.slice(0, -1).reverse()])}
              disabled={waypoints.length < 2 || closed}
            >
              Out &amp; back
            </Button>
            <Button onClick={clear} disabled={waypoints.length === 0}>
              Clear
            </Button>
          </div>
        )}
        {route && (
          <form
            className="flex w-full flex-wrap items-center gap-2 lg:ml-auto lg:w-auto"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <input
              aria-label="Route name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultName(route)}
              maxLength={120}
              className={clsx(inputClass, "min-w-0 flex-1 lg:w-48")}
            />
            <Button type="submit" variant="primary" disabled={save.isPending || snapping || !routeIsCurrent}>
              {save.isPending ? "Saving…" : "Save route"}
            </Button>
          </form>
        )}
        {mode === "draw" && waypoints.length === 0 && (
          <p className="w-full text-sm text-ink-secondary">
            Tap the map to add points{here ? " — your route starts from your current location" : ""}. Points snap to
            streets and trails; drag a point to adjust it.
          </p>
        )}
        {snapError && <p className="w-full text-sm text-zone-red">{snapError}</p>}
        {saveError && <p className="w-full text-sm text-zone-red">{saveError}</p>}
        {savedNotice && <p className="w-full text-sm text-zone-good">{savedNotice}</p>}
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold">Saved routes</h2>
        {savedQuery.isLoading ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : savedQuery.data?.items.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {savedQuery.data.items.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                <button type="button" onClick={() => showSaved(r)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm font-medium text-ink-primary">{r.name}</div>
                  <div className="text-xs text-ink-muted">
                    {formatMiles(r.distanceM)}
                    {r.elevationGainM != null && ` · ${formatClimb(r.elevationGainM)} climb`} ·{" "}
                    {r.source === "ai" ? "AI planned" : "Drawn"} · {new Date(r.createdAt).toLocaleDateString()}
                  </div>
                </button>
                <Button onClick={() => showSaved(r)}>Show</Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (window.confirm(`Delete “${r.name}”?`)) remove.mutate(r.id);
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">No saved routes yet.</p>
        )}
      </section>

      <p className="text-xs text-ink-muted">
        Routes follow OpenStreetMap paths and don&apos;t account for traffic, lighting or closures. Climb is estimated
        from terrain data. Check the route before you run it.
      </p>
    </div>
  );
}

function isClosed(points: LatLon[]): boolean {
  if (points.length < 2) return false;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  return a[0] === b[0] && a[1] === b[1];
}

function defaultName(route: PlannedRoute | null): string {
  return route ? `${formatMiles(route.distanceM, 1)} run` : "My run";
}
