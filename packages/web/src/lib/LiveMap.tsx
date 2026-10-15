"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { animate, useMotionValue } from "framer-motion";
import { useEffect, useEffectEvent, useRef } from "react";
import type { LatLng } from "@needy/shared";
import { duration as D, ease as E } from "../motion/index.js";
import { useReducedMotionPref } from "../motion/preferences.js";

const TILE_URL =
  process.env.NEXT_PUBLIC_MAP_TILE_URL ?? "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION =
  process.env.NEXT_PUBLIC_MAP_ATTRIBUTION ??
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
  // Read when the map is created, without making that effect re-run (it mounts once).
  const mountOrigin = useEffectEvent(() => origin);

  // ── mount: create the map, tiles, and the destination marker ────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const start = mountOrigin();
    const map = L.map(containerRef.current, {
      center: [start.lat, start.lng],
      zoom: 15,
      zoomControl: false,
      attributionControl: true,
      // The page scrolls past this map; a wheel that zooms it instead traps the scroll.
      scrollWheelZoom: false,
    });
    L.tileLayer(TILE_URL, {
      attribution: ATTRIBUTION,
      maxZoom: 19,
      // The document policy is `no-referrer` (see proxy.ts), and OpenStreetMap refuses
      // tile requests that carry no Referer at all. Scoped to the tile images so every other
      // outbound request still sends nothing; `origin` never includes a path.
      referrerPolicy: "origin",
    }).addTo(map);
    L.marker([start.lat, start.lng], {
      icon: destinationIcon(),
      interactive: false,
      keyboard: false,
    }).addTo(map);
    mapRef.current = map;
    // Leaflet needs a size recalc if the container animated in.
    setTimeout(() => map.invalidateSize(), 0);
    return () => {
      // Halt any pan/zoom in flight first: Leaflet's transition-end handlers otherwise fire
      // against panes that `remove()` has already torn down.
      map.stop();
      map.remove();
      mapRef.current = null;
      helperMarkerRef.current = null;
      fittedRef.current = false;
      firstPointRef.current = true;
    };
  }, []);

  // ── helper position: glide the marker in geographic space ───────────────────
  const hLat = helper?.lat;
  const hLng = helper?.lng;
  // The heading (for the first icon) and the origin (for the first fit) are read when a point
  // arrives; a change to either alone is not a new point and must not restart the glide.
  const frameInputs = useEffectEvent(() => ({ heading, origin }));
  useEffect(() => {
    const map = mapRef.current;
    if (!map || hLat == null || hLng == null) return;
    const helper = { lat: hLat, lng: hLng };
    const { heading, origin } = frameInputs();

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
      map.fitBounds(L.latLngBounds([origin.lat, origin.lng], [helper.lat, helper.lng]).pad(0.4), {
        animate: false,
      });
    }
    firstPointRef.current = false;

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [hLat, hLng, durationMs, reduced, mvLat, mvLng]);

  // ── heading: rotate the silhouette to face travel ──────────────────────────
  useEffect(() => {
    const el = helperMarkerRef.current
      ?.getElement()
      ?.querySelector<HTMLElement>(".needy-silhouette");
    if (el) el.style.transform = `rotate(${heading}deg)`;
  }, [heading]);

  return (
    <div
      ref={containerRef}
      className="w-full rounded-[24px] overflow-hidden border border-white/50 shadow-[0_20px_50px_rgba(15,92,92,0.2)] bg-white/20 backdrop-blur-xl relative z-10"
      style={{ height }}
      aria-label="Live map showing your helper's location"
    />
  );
}

function destinationIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    html: `<div class="relative w-6 h-6 rounded-full bg-[#0F5C5C] shadow-[0_4px_12px_rgba(15,92,92,0.6)] flex items-center justify-center animate-pulse-slow border-[3px] border-white">
             <div class="absolute inset-0 rounded-full animate-ping bg-[#0F5C5C]/40"></div>
             <div class="w-1.5 h-1.5 rounded-full bg-white shadow-inner"></div>
           </div>`,
  });
}

function silhouetteIcon(heading: number): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    html: `<div class="needy-silhouette relative" style="transition:transform .4s ease;will-change:transform;transform:rotate(${heading}deg);">
      <div class="absolute inset-0 rounded-full bg-[#FF7A59]/30 animate-glow filter blur-md"></div>
      <svg width="40" height="40" viewBox="0 0 24 24" class="relative drop-shadow-[0_4px_8px_rgba(0,0,0,0.5)]">
        <path d="M12 1 L16 8 L8 8 Z" fill="url(#helper-grad)" />
        <circle cx="12" cy="11" r="3.5" fill="url(#helper-grad)"/>
        <path d="M5.5 22c0-4 2.5-7 6.5-7s6.5 3 6.5 7z" fill="url(#helper-grad)"/>
        <defs>
          <linearGradient id="helper-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#FF7A59"/>
            <stop offset="100%" stop-color="#E05A39"/>
          </linearGradient>
        </defs>
      </svg></div>`,
  });
}
