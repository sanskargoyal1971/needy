"use client";

import { animate, useMotionValue } from "framer-motion";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { LocateFixed } from "lucide-react";
import type { LatLng } from "@needy/shared";
import { duration as D, ease as E } from "../motion/index.js";
import { useReducedMotionPref } from "../motion/preferences.js";
import { GOOGLE_MAP_ID, loadGoogleMaps, markerContent, onMapsAuthFailure } from "./googleMaps";
import { MapUnavailable } from "./MapUnavailable";

export interface LiveMapProps {
  /** The task origin — the requester's door. */
  origin: LatLng;
  /** Latest helper position (null before the first location update). */
  helper: LatLng | null;
  /** Heading in degrees (0 = north, clockwise) to face the silhouette. */
  heading?: number;
  /** Glide window between points — should be ≥ the location cadence (3–5s) so the marker is
   *  still moving when the next point lands. */
  durationMs?: number;
  /** A number of pixels, or any CSS length ("46vh"). */
  height?: number | string;
  /** Google encoded polyline of the road route from the helper to the origin. */
  route?: string | null;
  /** Coarsened positions of helpers the search has reached (never exact — see matching.ts). */
  nearby?: LatLng[];
  /** A search is running: draw the ripple widening out from the origin. */
  searching?: boolean;
  /** Which end of the trip the viewer is. Only changes the aria label. */
  viewer?: "requester" | "helper";
  /** Square-cornered, edge-to-edge — for a map that is the top of a screen, not a card. */
  bleed?: boolean;
}

/**
 * The task map, on Google Maps. One component for every map a task shows: the search (ripple
 * over the origin, coarse dots for the helpers it reached), the trip (route line, the helper
 * gliding along it) and the doorstep.
 *
 * The crucial detail from §2.3 is preserved: the helper is interpolated in GEOGRAPHIC space —
 * Framer motion values tween lat/lng between successive GPS points — and the advanced marker is
 * re-positioned every frame, so the human silhouette GLIDES continuously and stays correctly
 * glued to the map through pan/zoom, never teleporting per coordinate.
 *
 * Every mark on it is evidence of something real: the dots are positions the server reported
 * (coarsened), the line is a route Google computed, the ripple runs only while the server is
 * actually offering the task outward. Reduced motion: the marker snaps and the ripple is still.
 */
export function LiveMap({
  origin,
  helper,
  heading = 0,
  durationMs = D.markerTween * 1000,
  height = 260,
  route = null,
  nearby = [],
  searching = false,
  viewer = "requester",
  bleed = false,
}: LiveMapProps) {
  const reduced = useReducedMotionPref();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const libsRef = useRef<{
    marker: google.maps.MarkerLibrary;
    geometry: google.maps.GeometryLibrary;
    maps: google.maps.MapsLibrary;
  } | null>(null);
  const originMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const helperMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const nearbyMarkersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const routeLinesRef = useRef<google.maps.Polyline[]>([]);
  const fittedRef = useRef<"none" | "nearby" | "helper">("none");
  const firstPointRef = useRef(true);
  // Stops the in-flight glide animation + motion-value subscriptions for the previous point.
  const cleanupRef = useRef<(() => void) | null>(null);
  // The SDK loads asynchronously; anything that arrives before it does is replayed on ready.
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Interpolated position lives in motion values; the marker reads them every frame.
  const mvLat = useMotionValue(helper?.lat ?? origin.lat);
  const mvLng = useMotionValue(helper?.lng ?? origin.lng);
  // Read when the map is created, without making that effect re-run (it mounts once).
  const mountOrigin = useEffectEvent(() => origin);

  // ── mount: load the SDK, create the map and the origin marker ───────────────
  useEffect(() => {
    let disposed = false;
    const offAuth = onMapsAuthFailure(() => setFailure("The Google Maps key was rejected."));
    loadGoogleMaps()
      .then(({ maps, marker, geometry }) => {
        if (disposed || !containerRef.current) return;
        const start = mountOrigin();
        const map = new maps.Map(containerRef.current, {
          center: start,
          zoom: 15,
          mapId: GOOGLE_MAP_ID,
          disableDefaultUI: true,
          clickableIcons: false,
          // The page scrolls past this map; a wheel that zooms it instead traps the scroll.
          gestureHandling: "cooperative",
        });
        originMarkerRef.current = new marker.AdvancedMarkerElement({
          map,
          position: start,
          content: markerContent(originHtml(false)),
          zIndex: 1,
        });
        mapRef.current = map;
        libsRef.current = { marker, geometry, maps };
        setReady(true);
      })
      .catch((err: unknown) => {
        if (!disposed)
          setFailure(err instanceof Error ? err.message : "Google Maps failed to load.");
      });
    return () => {
      disposed = true;
      offAuth();
      for (const m of [
        originMarkerRef.current,
        helperMarkerRef.current,
        ...nearbyMarkersRef.current,
      ]) {
        if (m) m.map = null;
      }
      routeLinesRef.current.forEach((l) => l.setMap(null));
      routeLinesRef.current = [];
      nearbyMarkersRef.current = [];
      mapRef.current = null;
      originMarkerRef.current = null;
      helperMarkerRef.current = null;
      fittedRef.current = "none";
      firstPointRef.current = true;
    };
  }, []);

  // ── the search ripple lives on the origin marker ────────────────────────────
  useEffect(() => {
    const m = originMarkerRef.current;
    if (!ready || !m) return;
    m.content = markerContent(originHtml(searching && !reduced));
  }, [ready, searching, reduced]);

  // ── coarse dots for the helpers the search reached ──────────────────────────
  const nearbyKey = nearby.map((p) => `${p.lat},${p.lng}`).join("|");
  const nearbyInputs = useEffectEvent(() => ({ points: nearby, origin }));
  useEffect(() => {
    const map = mapRef.current;
    const libs = libsRef.current;
    if (!ready || !map || !libs) return;
    nearbyMarkersRef.current.forEach((m) => (m.map = null));
    const { points, origin } = nearbyInputs();
    nearbyMarkersRef.current = points.map(
      (p, i) =>
        new libs.marker.AdvancedMarkerElement({
          map,
          position: p,
          content: markerContent(nearbyHtml(i)),
        }),
    );
    // Frame the search: you plus everyone it reached. Only while nobody is travelling — once a
    // helper is on the map, the trip owns the camera.
    if (points.length > 0 && fittedRef.current !== "helper") {
      const bounds = new google.maps.LatLngBounds();
      bounds.extend(origin);
      points.forEach((p) => bounds.extend(p));
      map.fitBounds(bounds, 64);
      fittedRef.current = "nearby";
    }
  }, [ready, nearbyKey]);

  // ── the road route ──────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    const libs = libsRef.current;
    if (!ready || !map || !libs) return;
    routeLinesRef.current.forEach((l) => l.setMap(null));
    routeLinesRef.current = [];
    if (!route) return;
    const path = libs.geometry.encoding.decodePath(route);
    // A white casing under the teal line, the way every map app draws a route: it stays
    // legible over busy streets and parks alike.
    routeLinesRef.current = [
      new libs.maps.Polyline({
        map,
        path,
        strokeColor: "#ffffff",
        strokeOpacity: 1,
        strokeWeight: 9,
        zIndex: 1,
      }),
      new libs.maps.Polyline({
        map,
        path,
        strokeColor: "#0F5C5C",
        strokeOpacity: 0.95,
        strokeWeight: 5,
        zIndex: 2,
      }),
    ];
  }, [ready, route]);

  // ── helper position: glide the marker in geographic space ───────────────────
  const hLat = helper?.lat;
  const hLng = helper?.lng;
  // The heading (for the first icon) and the origin (for the first fit) are read when a point
  // arrives; a change to either alone is not a new point and must not restart the glide.
  const frameInputs = useEffectEvent(() => ({ heading, origin }));
  useEffect(() => {
    const map = mapRef.current;
    const libs = libsRef.current;
    if (!ready || !map || !libs || hLat == null || hLng == null) return;
    const helper = { lat: hLat, lng: hLng };
    const { heading, origin } = frameInputs();

    // Lazily create the helper marker on the first real point.
    if (!helperMarkerRef.current) {
      helperMarkerRef.current = new libs.marker.AdvancedMarkerElement({
        map,
        position: { lat: mvLat.get(), lng: mvLng.get() },
        content: markerContent(silhouetteHtml(heading)),
        zIndex: 3,
      });
    }

    const place = () => {
      if (helperMarkerRef.current) {
        helperMarkerRef.current.position = { lat: mvLat.get(), lng: mvLng.get() };
      }
    };

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
    if (fittedRef.current !== "helper") {
      fittedRef.current = "helper";
      fitTrip(map, origin, helper);
    }
    firstPointRef.current = false;

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [ready, hLat, hLng, durationMs, reduced, mvLat, mvLng]);

  // ── heading: rotate the silhouette to face travel ──────────────────────────
  useEffect(() => {
    const content = helperMarkerRef.current?.content as HTMLElement | null | undefined;
    const el = content?.querySelector<HTMLElement>(".needy-silhouette");
    if (el) el.style.transform = `rotate(${heading}deg)`;
  }, [heading]);

  /** Re-frame on demand — after someone has panned away and lost the trip. */
  function recenter() {
    const map = mapRef.current;
    if (!map) return;
    if (hLat != null && hLng != null) fitTrip(map, origin, { lat: hLat, lng: hLng });
    else {
      map.panTo(origin);
      map.setZoom(15);
    }
  }

  const cssHeight = typeof height === "number" ? `${height}px` : height;
  if (failure) return <MapUnavailable height={cssHeight} reason={failure} />;

  return (
    <div className="relative w-full" style={{ height: cssHeight }}>
      <div
        ref={containerRef}
        className={`h-full w-full overflow-hidden bg-[#e9efe9] ${
          bleed
            ? ""
            : "rounded-[24px] border border-white/50 shadow-[0_20px_50px_rgba(15,92,92,0.2)]"
        }`}
        aria-label={
          viewer === "helper"
            ? "Map showing you and the person you're going to"
            : "Live map showing your helper's location"
        }
      />
      {ready && (
        <button
          type="button"
          onClick={recenter}
          aria-label="Re-centre the map"
          className="absolute right-3 top-3 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white text-primary shadow-[0_6px_18px_rgba(15,92,92,0.25)] transition-transform active:scale-95"
        >
          <LocateFixed size={20} aria-hidden />
        </button>
      )}
    </div>
  );
}

function fitTrip(map: google.maps.Map, a: LatLng, b: LatLng) {
  const bounds = new google.maps.LatLngBounds();
  bounds.extend(a);
  bounds.extend(b);
  // Extra bottom padding: on the task screens a sheet overlaps the lower edge of the map.
  map.fitBounds(bounds, { top: 72, right: 56, bottom: 96, left: 56 });
}

/** The requester's door. While a search runs, two staggered rings widen out from it. */
function originHtml(searching: boolean): string {
  const rings = searching
    ? `<div class="pointer-events-none absolute left-1/2 top-1/2 h-[220px] w-[220px] -translate-x-1/2 -translate-y-1/2">
         <div class="absolute inset-0 rounded-full border-2 border-[#1B7A7A]/50 bg-[#1B7A7A]/10 animate-ripple"></div>
         <div class="absolute inset-0 rounded-full border-2 border-[#1B7A7A]/40 bg-[#1B7A7A]/5 animate-ripple" style="animation-delay:1.6s"></div>
       </div>`
    : "";
  return `<div class="relative w-7 h-7">
     ${rings}
     <div class="relative w-7 h-7 rounded-full bg-[#0F5C5C] shadow-[0_4px_12px_rgba(15,92,92,0.6)] flex items-center justify-center border-[3px] border-white">
       <div class="w-2 h-2 rounded-full bg-white"></div>
     </div>
   </div>`;
}

/** One helper the search reached, at a deliberately coarse position. */
function nearbyHtml(i: number): string {
  return `<div class="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-[#FF7A59] shadow-[0_4px_10px_rgba(224,90,57,0.45)] animate-pulse-slow" style="animation-delay:${(i % 5) * 0.4}s">
     <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8z"/></svg>
   </div>`;
}

function silhouetteHtml(heading: number): string {
  return `<div class="needy-silhouette relative" style="transition:transform .4s ease;will-change:transform;transform:rotate(${heading}deg);">
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
      </svg></div>`;
}
