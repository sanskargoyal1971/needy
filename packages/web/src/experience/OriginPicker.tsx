"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Crosshair, Loader2, MapPin } from "lucide-react";
import type { LatLng } from "@needy/shared";
import { useAuth } from "@/auth/AuthProvider";
import { GOOGLE_MAP_ID, loadGoogleMaps, markerContent, onMapsAuthFailure } from "@/lib/googleMaps";
import { MapUnavailable } from "@/lib/MapUnavailable";

/** ── Where are you? ────────────────────────────────────────────────────────
 *  A draggable pin on a real map, seeded from the device's own position.
 *
 *  Three deliberate choices:
 *
 *   1. **The saved home area is the fallback, not the default.** Onboarding captured an
 *      `areaLabel` with coarse coordinates, and it is tempting to just use them. But this
 *      field decides where a stranger is sent, and "the part of town I live in" is not that.
 *      Device position is asked for first; the saved area only fills in when the browser
 *      refuses or has no fix.
 *   2. **Refusing location is not an error.** Plenty of people decline the prompt, and an
 *      elderly user on an old phone may simply have no GPS fix indoors. The pin stays
 *      draggable and the copy says what to do, rather than blocking the form on a permission.
 *   3. **Google Maps is loaded lazily**, on first mount, through the shared loader — the
 *      SDK is a browser script and has nothing to do during Next's server render.
 */

/** Bengaluru city centre. Only ever reached when there is no device fix AND no saved area —
 *  a pin somewhere plausible that the person can drag is better than an empty grey box. */
const FALLBACK: LatLng = { lat: 12.9716, lng: 77.5946 };

export function OriginPicker({
  value,
  onChange,
}: {
  value: LatLng | null;
  onChange: (point: LatLng) => void;
}) {
  const { state: auth } = useAuth();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Nothing to find when the form already has a point.
  const [locating, setLocating] = useState(value == null);
  const [note, setNote] = useState<string | null>(null);

  // Read by the seed effect at the moment it runs, without making it re-run: it seeds ONCE.
  // Re-running would re-request geolocation and snap the pin back every time the user drags it.
  const seedInputs = useEffectEvent(() => ({
    hasValue: value != null,
    savedArea:
      auth.status === "authenticated" && auth.user.areaLat != null && auth.user.areaLng != null
        ? { lat: auth.user.areaLat, lng: auth.user.areaLng }
        : null,
  }));
  const placePin = useEffectEvent((point: LatLng, message: string | null) => {
    onChange(point);
    setNote(message);
    setLocating(false);
  });

  // Seed the pin once, from the best source available.
  useEffect(() => {
    const { hasValue, savedArea } = seedInputs();
    if (hasValue) return;
    let cancelled = false;

    let settled = false;
    const settle = (point: LatLng, message: string | null) => {
      if (cancelled || settled) return;
      settled = true;
      placePin(point, message);
    };

    const fallBack = () =>
      settle(
        savedArea ?? FALLBACK,
        savedArea
          ? "We couldn't get your exact location, so we've used your home area. Drag the pin if you're somewhere else."
          : "We couldn't get your location. Drag the pin to where you are.",
      );

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      settle(savedArea ?? FALLBACK, "Drag the pin to where you are.");
      return;
    }

    // The browser's own `timeout` only starts once permission is granted. A permission prompt
    // that is simply never answered — easy to miss, and common with this audience — fires
    // neither callback, and the form sat on "Finding where you are…" for ever. This is the
    // clock for that case. If a real fix arrives later it is ignored rather than yanking a
    // pin the person may already have moved.
    const giveUp = setTimeout(fallBack, 12_000);

    navigator.geolocation.getCurrentPosition(
      (pos) => settle({ lat: pos.coords.latitude, lng: pos.coords.longitude }, null),
      fallBack,
      // A long timeout on purpose: an indoor fix is slow, and failing over to a coarse home
      // area after two seconds would send a helper to the wrong place more often than waiting
      // ten would inconvenience anyone.
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );

    return () => {
      cancelled = true;
      clearTimeout(giveUp);
    };
  }, []);

  const hasPoint = value != null;
  const startPoint = useEffectEvent(() => value);
  const movePin = useEffectEvent((point: LatLng) => {
    onChange(point);
    setNote(null);
  });

  // Mount the map once a point exists.
  useEffect(() => {
    const start = startPoint();
    if (!start || !containerRef.current || mapRef.current) return;
    let disposed = false;

    const offAuth = onMapsAuthFailure(() => setFailure("The Google Maps key was rejected."));
    loadGoogleMaps()
      .then(({ maps, marker }) => {
        if (disposed || !containerRef.current) return;
        const map = new maps.Map(containerRef.current, {
          center: start,
          zoom: 16,
          mapId: GOOGLE_MAP_ID,
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
          // A pin the user drags is the input; the map itself does not need to scroll-zoom and
          // trapping the page scroll inside it on a phone is a small hostility.
          gestureHandling: "cooperative",
        });
        mapRef.current = map;

        const pin = new marker.AdvancedMarkerElement({
          map,
          position: start,
          gmpDraggable: true,
          title: "Your location — drag to adjust",
          content: markerContent(
            `<div class="relative w-8 h-8 rounded-full bg-[#0F5C5C] shadow-[0_4px_12px_rgba(15,92,92,0.6)] flex items-center justify-center animate-pulse-slow border-[3px] border-white cursor-grab active:cursor-grabbing">
               <div class="absolute inset-0 rounded-full animate-ping bg-[#0F5C5C]/40"></div>
               <div class="w-2 h-2 rounded-full bg-white shadow-inner"></div>
             </div>`,
          ),
        });
        pin.addListener("dragend", () => {
          const p = pin.position;
          if (!p) return;
          const ll = p instanceof google.maps.LatLng ? p.toJSON() : { lat: p.lat, lng: p.lng };
          movePin({ lat: Number(ll.lat), lng: Number(ll.lng) });
        });
        // Tapping the map moves the pin too — dragging a small marker is hard with an unsteady
        // hand, and this is the audience where that matters most.
        map.addListener("click", (e: google.maps.MapMouseEvent) => {
          if (!e.latLng) return;
          const ll = e.latLng.toJSON();
          pin.position = ll;
          movePin(ll);
        });
      })
      .catch((err: unknown) => {
        if (!disposed)
          setFailure(err instanceof Error ? err.message : "Google Maps failed to load.");
      });

    return () => {
      disposed = true;
      offAuth();
      mapRef.current = null;
    };
    // Keyed on WHETHER a point exists, not on the point itself: the map is created once, at
    // the moment there is somewhere to centre it, and every later change comes from the user
    // moving the marker inside it. Depending on `value` would tear the map down and rebuild
    // it on each drag.
  }, [hasPoint]);

  return (
    <div>
      <div className="overflow-hidden rounded-[24px] border border-white/50 bg-white/20 backdrop-blur-xl shadow-[0_20px_50px_rgba(15,92,92,0.2)] transform perspective-1000 rotate-x-1 relative z-10">
        {failure ? (
          <MapUnavailable height={224} reason={failure} />
        ) : locating ? (
          <div className="flex h-56 flex-col items-center justify-center gap-2 text-gray-500">
            <Loader2 className="animate-spin text-primary" aria-hidden />
            <span className="text-sm">Finding where you are…</span>
          </div>
        ) : (
          <div ref={containerRef} className="h-56 w-full" aria-label="Your location" />
        )}
      </div>

      {note && (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-amber-700">
          <Crosshair size={13} className="mt-0.5 shrink-0" aria-hidden />
          {note}
        </p>
      )}
      {value && !note && (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-gray-500">
          <MapPin size={13} aria-hidden />
          {value.lat.toFixed(5)}, {value.lng.toFixed(5)}
        </p>
      )}
    </div>
  );
}
