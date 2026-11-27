import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LatLon } from "@run-far/shared";

// Hex mirrors of the tailwind tokens — Leaflet draws to SVG with inline styles, so it can't
// read class names.
const ACCENT = "#4FB0A6";
const SURFACE = "#121815";
const INK = "#EDEAE2";
const INFO = "#7C96B8";

// Used until /routes/config answers (and in dev, where it's the same thing).
const DEFAULT_TILES = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
};

export interface RouteMapProps {
  tileUrl?: string;
  tileAttribution?: string;
  /** Where to centre the map when it first has somewhere to be. */
  center: LatLon | null;
  /** The athlete's live position, drawn as a dot with a halo. */
  here: LatLon | null;
  waypoints: LatLon[];
  geometry: LatLon[];
  /** Called for a tap/click, and for Enter/Space with the map focused (at the map's centre,
   * under the crosshair) — the keyboard path for building a route. */
  onMapClick?: (point: LatLon) => void;
  onWaypointMove?: (index: number, point: LatLon) => void;
  /** Bump to re-fit the map to the current route (e.g. after the AI returns one). */
  fitKey?: number;
}

function dotIcon(label: string, fill: string): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    html: `<div style="width:22px;height:22px;border-radius:9999px;background:${fill};border:2px solid ${SURFACE};color:${SURFACE};font:600 11px/18px Inter,system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.5)">${label}</div>`,
  });
}

// The halo is wider than a route marker on purpose: when the route starts where the athlete
// is standing, the start marker sits on top of this dot, and the ring is what still shows
// "you are here" around it.
const HERE_ICON = L.divIcon({
  className: "",
  iconSize: [44, 44],
  iconAnchor: [22, 22],
  html: `<div class="route-here-halo"></div><div style="position:absolute;left:14px;top:14px;width:16px;height:16px;border-radius:9999px;background:${INFO};border:3px solid ${INK}"></div>`,
});

export function RouteMap({
  tileUrl,
  tileAttribution,
  center,
  here,
  waypoints,
  geometry,
  onMapClick,
  onWaypointMove,
  fitKey,
}: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tilesRef = useRef<L.TileLayer | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const hereRef = useRef<L.Marker | null>(null);
  const centeredRef = useRef(false);
  // Handlers change identity every render; read them through refs so the map's listeners are
  // registered once and never go stale.
  const clickRef = useRef(onMapClick);
  const moveRef = useRef(onWaypointMove);
  clickRef.current = onMapClick;
  moveRef.current = onWaypointMove;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const map = L.map(el, { zoomControl: true, attributionControl: true, keyboard: true }).setView([39.5, -98.35], 4);
    map.on("click", (e: L.LeafletMouseEvent) => clickRef.current?.([e.latlng.lat, e.latlng.lng]));
    // Leaflet's own keyboard handling pans with the arrows and zooms with +/-; Enter/Space
    // adds a point under the crosshair.
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === el && clickRef.current) {
        e.preventDefault();
        const c = map.getCenter();
        clickRef.current([c.lat, c.lng]);
      }
    };
    el.addEventListener("keydown", onKey);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      el.removeEventListener("keydown", onKey);
      map.remove();
      mapRef.current = null;
      tilesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const url = tileUrl ?? DEFAULT_TILES.url;
    const attribution = tileAttribution ?? DEFAULT_TILES.attribution;
    tilesRef.current?.remove();
    tilesRef.current = L.tileLayer(url, {
      maxZoom: 19,
      attribution,
      className: "route-map-tiles",
      detectRetina: false,
    }).addTo(map);
  }, [tileUrl, tileAttribution]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !center || centeredRef.current) return;
    centeredRef.current = true;
    map.setView(center, 15);
  }, [center]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!here) {
      hereRef.current?.remove();
      hereRef.current = null;
      return;
    }
    if (hereRef.current) hereRef.current.setLatLng(here);
    else
      hereRef.current = L.marker(here, {
        icon: HERE_ICON,
        interactive: false,
        keyboard: false,
        zIndexOffset: -1000,
      }).addTo(map);
  }, [here]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (geometry.length > 1) {
      // A dark casing under the accent line keeps the route legible over busy tiles.
      L.polyline(geometry, { color: SURFACE, weight: 8, opacity: 0.6, interactive: false }).addTo(layer);
      L.polyline(geometry, { color: ACCENT, weight: 5, opacity: 0.95, interactive: false }).addTo(layer);
    } else if (waypoints.length > 1) {
      L.polyline(waypoints, { color: ACCENT, weight: 3, dashArray: "6 6", opacity: 0.8, interactive: false }).addTo(layer);
    }
    const last = waypoints.length - 1;
    const drawn = new Set<string>();
    waypoints.forEach((p, i) => {
      // One marker per spot: an out-and-back revisits its outbound points on the way home,
      // and a closed loop finishes on its start; stacked markers would hide each other.
      const spot = `${p[0]},${p[1]}`;
      if (drawn.has(spot)) return;
      drawn.add(spot);
      const isStart = i === 0;
      const isEnd = i === last;
      const marker = L.marker(p, {
        icon: dotIcon(isStart ? "S" : isEnd ? "F" : String(i), isStart ? ACCENT : isEnd ? INK : INFO),
        draggable: Boolean(moveRef.current),
        keyboard: false,
        title: isStart ? "Start" : isEnd ? "Finish" : `Point ${i}`,
      }).addTo(layer);
      marker.on("dragend", () => {
        const ll = marker.getLatLng();
        // Move every waypoint at this spot: a loop's finish with its start, and an
        // out-and-back's return point with its outbound twin.
        waypoints.forEach((w, j) => {
          if (w[0] === p[0] && w[1] === p[1]) moveRef.current?.(j, [ll.lat, ll.lng]);
        });
      });
    });
  }, [waypoints, geometry]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitKey) return;
    const pts = geometry.length > 1 ? geometry : waypoints;
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [32, 32] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  return (
    <div className="route-map relative">
      <div
        ref={containerRef}
        className="h-[55vh] min-h-[320px] w-full overflow-hidden rounded-lg border border-border md:h-[600px]"
        role="application"
        aria-label="Route map. Tap to add a point. With the map focused, arrow keys pan, plus and minus zoom, and Enter adds a point at the crosshair."
      />
      {/* Only shown while the map has keyboard focus: it marks where Enter will add a point. */}
      <div className="route-map-crosshair pointer-events-none absolute left-1/2 top-1/2 z-[500] -translate-x-1/2 -translate-y-1/2" aria-hidden>
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke={INK} strokeWidth="2">
          <circle cx="14" cy="14" r="5" />
          <path d="M14 0v7M14 21v7M0 14h7M21 14h7" />
        </svg>
      </div>
    </div>
  );
}
