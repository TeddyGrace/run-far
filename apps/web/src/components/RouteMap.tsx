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

export interface RouteMapProps {
  /** Where to centre the map when it first has somewhere to be. */
  center: LatLon | null;
  /** The athlete's live position, drawn as a pulsing dot. */
  here: LatLon | null;
  waypoints: LatLon[];
  geometry: LatLon[];
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

const HERE_ICON = L.divIcon({
  className: "",
  iconSize: [16, 16],
  iconAnchor: [8, 8],
  html: `<div style="width:16px;height:16px;border-radius:9999px;background:${INFO};border:3px solid ${INK};box-shadow:0 0 0 6px rgba(124,150,184,.25)"></div>`,
});

export function RouteMap({ center, here, waypoints, geometry, onMapClick, onWaypointMove, fitKey }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
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
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true }).setView([39.5, -98.35], 4);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      className: "route-map-tiles",
    }).addTo(map);
    map.on("click", (e: L.LeafletMouseEvent) => clickRef.current?.([e.latlng.lat, e.latlng.lng]));
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

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
    else hereRef.current = L.marker(here, { icon: HERE_ICON, interactive: false, keyboard: false }).addTo(map);
  }, [here]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (geometry.length > 1) {
      // A dark casing under the accent line keeps the route legible over busy tiles.
      L.polyline(geometry, { color: SURFACE, weight: 8, opacity: 0.6 }).addTo(layer);
      L.polyline(geometry, { color: ACCENT, weight: 5, opacity: 0.95 }).addTo(layer);
    } else if (waypoints.length > 1) {
      L.polyline(waypoints, { color: ACCENT, weight: 3, dashArray: "6 6", opacity: 0.8 }).addTo(layer);
    }
    const last = waypoints.length - 1;
    const closesLoop =
      last > 0 && waypoints[0]![0] === waypoints[last]![0] && waypoints[0]![1] === waypoints[last]![1];
    waypoints.forEach((p, i) => {
      if (closesLoop && i === last) return; // drawn under the start marker already
      const isStart = i === 0;
      const isEnd = i === last;
      const marker = L.marker(p, {
        icon: dotIcon(isStart ? "S" : isEnd ? "F" : String(i), isStart ? ACCENT : isEnd ? INK : INFO),
        draggable: Boolean(moveRef.current),
        keyboard: false,
      }).addTo(layer);
      marker.on("dragend", () => {
        const ll = marker.getLatLng();
        moveRef.current?.(i, [ll.lat, ll.lng]);
        // Dragging the start of a closed loop moves its finish with it.
        if (isStart && closesLoop) moveRef.current?.(last, [ll.lat, ll.lng]);
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
    <div
      ref={containerRef}
      className="h-[55vh] min-h-[320px] w-full overflow-hidden rounded-lg border border-border md:h-[600px]"
      role="application"
      aria-label="Route map. Tap to add points to your route."
    />
  );
}
