import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { animate, useMotionValue } from "framer-motion";
import { useEffect, useRef } from "react";
import type { LatLng } from "@needy/shared";
import { color, duration as D, ease as E } from "../motion/index.js";
import { useReducedMotionPref } from "../motion/preferences.js";

const TILE_URL =
  import.meta.env.VITE_MAP_TILE_URL ??
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION =
  import.meta.env.VITE_MAP_ATTRIBUTION ??
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export interface LiveMapProps {
  /** Destination — "you". */
  origin: LatLng;
  /** Latest helper position (null before the first location update). */
  helper: LatLng | null;
  /** Heading in degrees (0 = north, clockwise) to face the silhouette. */
  heading?: number;
  /** Glide window between points — should be ≥ the location cadence (3–5s) so the marker is
   *  still moving when the next point lands. */
  durationMs?: number;
  height?: number;
}

/**
 * The live tracking map (§3 Stage 4) on a real map SDK (Leaflet + OSM tiles). The crucial
 * detail from §2.3 is preserved: the helper is interpolated in GEOGRAPHIC space — Framer motion
 * values tween lat/lng between successive GPS points — and Leaflet projects that onto the map
 * every frame, so the human silhouette GLIDES continuously and stays correctly glued to the
 * map through pan/zoom, never teleporting per coordinate. A person walking toward you, not a pin.
 *
 * Reduced motion: the marker snaps to each new position instead of gliding.
 */
export function LiveMap({
  origin,
  helper,
  heading = 0,
  durationMs = D.markerTween * 1000,
  height = 260,
}: LiveMapProps) {
  const reduced = useReducedMotionPref();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const helperMarkerRef = useRef<L.Marker | null>(null);
  const fittedRef = useRef(false);
  const firstPointRef = useRef(true);
  // Stops the in-flight glide animation + motion-value subscriptions for the previous point.
  const cleanupRef = useRef<(() => void) | null>(null);

  // Interpolated position lives in motion values; Leaflet reads them to place the marker.
  const mvLat = useMotionValue(helper?.lat ?? origin.lat);
  const mvLng = useMotionValue(helper?.lng ?? origin.lng);
  const originRef = useRef(origin);
  originRef.current = origin;

  // ── mount: create the map, tiles, and the destination marker ────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, {
      center: [originRef.current.lat, originRef.current.lng],
      zoom: 15,
      zoomControl: false,
      attributionControl: true,
    });
    L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
    L.marker([originRef.current.lat, originRef.current.lng], {
      icon: destinationIcon(),
      interactive: false,
      keyboard: false,
    }).addTo(map);
    mapRef.current = map;
    // Leaflet needs a size recalc if the container animated in.
    setTimeout(() => map.invalidateSize(), 0);
    return () => {
      map.remove();
      mapRef.current = null;
      helperMarkerRef.current = null;
      fittedRef.current = false;
      firstPointRef.current = true;
    };
  }, []);

  // ── helper position: glide the marker in geographic space ───────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !helper) return;

    // Lazily create the helper marker on the first real point.
    if (!helperMarkerRef.current) {
      helperMarkerRef.current = L.marker([mvLat.get(), mvLng.get()], {
        icon: silhouetteIcon(heading),
        interactive: false,
        keyboard: false,
      }).addTo(map);
    }

    const place = () => helperMarkerRef.current?.setLatLng([mvLat.get(), mvLng.get()]);

    if (reduced || firstPointRef.current) {
      mvLat.set(helper.lat);
      mvLng.set(helper.lng);
      place();
    } else {
      const cLat = animate(mvLat, helper.lat, { duration: durationMs / 1000, ease: E.travel });
      const cLng = animate(mvLng, helper.lng, { duration: durationMs / 1000, ease: E.travel });
      const off1 = mvLat.on("change", place);
      const off2 = mvLng.on("change", place);
      cleanupRef.current = () => {
        cLat.stop();
        cLng.stop();
        off1();
        off2();
      };
    }

    // Frame both origin and helper the first time we have a fix.
    if (!fittedRef.current) {
      fittedRef.current = true;
      map.fitBounds(
        L.latLngBounds([origin.lat, origin.lng], [helper.lat, helper.lng]).pad(0.4),
        { animate: false },
      );
    }
    firstPointRef.current = false;

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
    // origin is stable per task; intentionally keyed on the incoming point.
  }, [helper?.lat, helper?.lng, durationMs, reduced]);

  // ── heading: rotate the silhouette to face travel ──────────────────────────
  useEffect(() => {
    const el = helperMarkerRef.current?.getElement()?.querySelector<HTMLElement>(".needy-silhouette");
    if (el) el.style.transform = `rotate(${heading}deg)`;
  }, [heading]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height,
        borderRadius: 18,
        overflow: "hidden",
        border: "1px solid var(--needy-border)",
        // Keep map chrome legible on both themes.
        background: "var(--needy-surface-2)",
      }}
      aria-label="Live map showing your helper's location"
    />
  );
}

function destinationIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color.presence};box-shadow:0 0 0 6px ${color.presence}33;"></div>`,
  });
}

function silhouetteIcon(heading: number): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    html: `<div class="needy-silhouette" style="transition:transform .4s ease;will-change:transform;transform:rotate(${heading}deg);">
      <svg width="34" height="34" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))">
        <path d="M12 1 L15 6 L9 6 Z" fill="${color.warm}" opacity="0.9"/>
        <circle cx="12" cy="9.5" r="3" fill="${color.warm}"/>
        <path d="M6.5 20c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6z" fill="${color.warm}"/>
      </svg></div>`,
  });
}
