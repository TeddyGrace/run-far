import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import type {
  GenerateRouteResult,
  LatLon,
  PlannedRoute,
  RouteSource,
  SavedRoute,
  UserSettings,
} from "@run-far/shared";
import { api, ApiError } from "../lib/api.js";
import { formatMiles } from "../lib/units.js";
import { RouteMap } from "../components/RouteMap.js";
import { Button, FieldError, inputClass } from "../components/ui/index.js";

type Mode = "draw" | "ai";

const AI_EXAMPLES = [
  "5 mile loop",
  "3 easy miles through a park",
  "6 mile out-and-back along the water",
  "10K mostly on trails",
];

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
  const [snapError, setSnapError] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState(0);
  // Set when waypoints arrive with their geometry already known (an AI route, a saved route),
  // so the snap effect doesn't immediately re-route what the server just routed.
  const preSnapped = useRef<LatLon[] | null>(null);

  const [prompt, setPrompt] = useState("");
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const settingsQuery = useQuery<UserSettings>({
    queryKey: ["settings"],
    queryFn: () => api.get<UserSettings>("/settings"),
  });
  const storedLocation: LatLon | null =
    settingsQuery.data?.locationLat != null && settingsQuery.data?.locationLon != null
      ? [settingsQuery.data.locationLat, settingsQuery.data.locationLon]
      : null;

  const savedQuery = useQuery({
    queryKey: ["routes"],
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

  // Snap the drawn waypoints to real paths, debounced so a burst of taps routes once.
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
        const snapped = await api.post<PlannedRoute>("/routes/snap", { waypoints });
        if (!cancelled) {
          setRoute(snapped);
          setSnapError(null);
        }
      } catch (err) {
        if (!cancelled) setSnapError(errorMessage(err, "Couldn't snap the route to paths."));
      } finally {
        if (!cancelled) setSnapping(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [waypoints]);

  const editWaypoints = (next: LatLon[], from: RouteSource = "manual") => {
    setSource(from);
    setSavedNotice(null);
    setWaypoints(next);
  };

  const handleMapClick = (p: LatLon) => {
    if (mode === "ai") {
      // In AI mode a tap just moves the start point.
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
    if (last > 0 && sameStart(waypoints)) editWaypoints([...waypoints.slice(0, last), p, waypoints[last]!]);
    else editWaypoints([...waypoints, p]);
  };

  const handleWaypointMove = (index: number, p: LatLon) => {
    setSavedNotice(null);
    setSource("manual");
    setWaypoints((prev) => prev.map((w, i) => (i === index ? p : w)));
  };

  const isClosed = sameStart(waypoints);
  const startPoint = waypoints[0] ?? here;

  const generate = useMutation({
    mutationFn: (body: { start: LatLon; prompt: string }) => api.post<GenerateRouteResult>("/routes/generate", body),
    onSuccess: (res) => {
      setAiMessage(res.message);
      if (res.route) {
        preSnapped.current = res.route.waypoints;
        setWaypoints(res.route.waypoints);
        setRoute(res.route);
        setSource("ai");
        setName(res.route.name);
        setSnapError(null);
        setSavedNotice(null);
        setFitKey((k) => k + 1);
      }
    },
  });

  const save = useMutation({
    mutationFn: () =>
      api.post<SavedRoute>("/routes", {
        name: name.trim() || defaultName(route),
        source,
        waypoints: route!.waypoints,
        geometry: route!.geometry,
        distanceM: route!.distanceM,
      }),
    onSuccess: (saved) => {
      setSaveError(null);
      setSavedNotice(`Saved “${saved.name}”.`);
      void qc.invalidateQueries({ queryKey: ["routes"] });
    },
    onError: (err) => setSaveError(errorMessage(err, "Couldn't save the route.")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/routes/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["routes"] }),
  });

  const showSaved = (r: SavedRoute) => {
    preSnapped.current = r.waypoints;
    setWaypoints(r.waypoints);
    setRoute({ waypoints: r.waypoints, geometry: r.geometry, distanceM: r.distanceM });
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
            onClick={() => {
              setFitKey(0);
              editWaypoints([here]);
              setRoute(null);
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
              if (!startPoint || !prompt.trim()) return;
              generate.mutate({ start: startPoint, prompt: prompt.trim() });
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
            />
            <div className="flex flex-wrap gap-2">
              {AI_EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setPrompt(ex)}
                  className="rounded-full border border-border px-3 py-1 text-xs text-ink-secondary hover:border-ink-muted hover:text-ink-primary"
                >
                  {ex}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" disabled={!startPoint || !prompt.trim() || generate.isPending}>
                {generate.isPending ? "Mapping your run…" : "Map it"}
              </Button>
              <span className="text-xs text-ink-muted">
                {startPoint
                  ? waypoints[0]
                    ? "Starting from the point on the map. Tap the map to move it."
                    : "Starting from your current location. Tap the map to start somewhere else."
                  : "Tap the map to set a start point."}
              </span>
            </div>
          </form>
          <FieldError>{generate.isError ? errorMessage(generate.error, "Couldn't plan a route.") : null}</FieldError>
          {aiMessage && <p className="text-sm text-ink-primary">{aiMessage}</p>}
        </section>
      )}

      <RouteMap
        center={here ?? storedLocation}
        here={here}
        waypoints={waypoints}
        geometry={route?.geometry ?? []}
        onMapClick={handleMapClick}
        onWaypointMove={mode === "draw" ? handleWaypointMove : undefined}
        fitKey={fitKey}
      />

      <section className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-1 p-4">
        <div className="min-w-[7rem]">
          <div className="text-xs uppercase tracking-wide text-ink-muted">Distance</div>
          <div className="font-mono text-2xl text-ink-primary" aria-live="polite">
            {route ? formatMiles(route.distanceM) : "—"}
            {snapping && <span className="ml-2 text-xs text-ink-muted">routing…</span>}
          </div>
        </div>
        {mode === "draw" && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => editWaypoints(waypoints.slice(0, -1))} disabled={waypoints.length === 0}>
              Undo
            </Button>
            <Button onClick={() => editWaypoints([...waypoints, waypoints[0]!])} disabled={waypoints.length < 2 || isClosed}>
              Close loop
            </Button>
            <Button
              onClick={() => editWaypoints([...waypoints, ...waypoints.slice(0, -1).reverse()])}
              disabled={waypoints.length < 2 || isClosed}
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
            className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto"
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
              className={clsx(inputClass, "min-w-0 flex-1 sm:w-48")}
            />
            <Button type="submit" variant="primary" disabled={save.isPending || snapping}>
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
                    {formatMiles(r.distanceM)} · {r.source === "ai" ? "AI planned" : "Drawn"} ·{" "}
                    {new Date(r.createdAt).toLocaleDateString()}
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
        Routes follow OpenStreetMap paths and don't account for traffic, lighting, closures or elevation. Check the
        route before you run it.
      </p>
    </div>
  );
}

function sameStart(points: LatLon[]): boolean {
  return points.length > 1 && sameP(points[0]!, points[points.length - 1]!);
}

function sameP(a: LatLon, b: LatLon): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function defaultName(route: PlannedRoute | null): string {
  return route ? `${formatMiles(route.distanceM, 1)} run` : "My run";
}
