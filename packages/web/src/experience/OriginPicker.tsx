"use client";

import { useEffect, useRef, useState } from "react";
import { Crosshair, Loader2, MapPin } from "lucide-react";
import type { LatLng } from "@needy/shared";
// The stylesheet is imported STATICALLY while the library itself is loaded lazily below.
// Leaflet's JS touches `window` at import time, which throws during Next's server render of a
// client component; its CSS does not, and Next's bundler only understands a static CSS import
// anyway — a dynamic `import("…css")` is a type error and would not be emitted.
import "leaflet/dist/leaflet.css";
import { useAuth } from "@/auth/AuthProvider";

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
 *   3. **Leaflet is loaded lazily.** It touches `window` at import time, so a static import
 *      in a page that Next renders on the server throws during the render, not at runtime in
 *      the browser where it would at least be obvious.
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
  const mapRef = useRef<unknown>(null);
  const [locating, setLocating] = useState(true);
  const [note, setNote] = useState<string | null>(null);

  // Seed the pin once, from the best source available.
  useEffect(() => {
    if (value) {
      setLocating(false);
      return;
    }
    let cancelled = false;

    const savedArea =
      auth.status === "authenticated" &&
      auth.user.areaLat != null &&
      auth.user.areaLng != null
        ? { lat: auth.user.areaLat, lng: auth.user.areaLng }
        : null;

    const settle = (point: LatLng, message: string | null) => {
      if (cancelled) return;
      onChange(point);
      setNote(message);
      setLocating(false);
    };

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      settle(savedArea ?? FALLBACK, "Drag the pin to where you are.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => settle({ lat: pos.coords.latitude, lng: pos.coords.longitude }, null),
      () =>
        settle(
          savedArea ?? FALLBACK,
          savedArea
            ? "We couldn't get your exact location, so we've used your home area. Drag the pin if you're somewhere else."
            : "We couldn't get your location. Drag the pin to where you are.",
        ),
      // A long timeout on purpose: an indoor fix is slow, and failing over to a coarse home
      // area after two seconds would send a helper to the wrong place more often than waiting
      // ten would inconvenience anyone.
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );

    return () => {
      cancelled = true;
    };
    // Seeds ONCE, deliberately. `value` and `onChange` are omitted from the deps because
    // re-running this would re-request geolocation and snap the pin back every time the user
    // drags it — the effect's whole job is to produce a first value, not to track it.
  }, []);

  // Mount the map once a point exists.
  useEffect(() => {
    if (!value || !containerRef.current || mapRef.current) return;
    let disposed = false;

    void (async () => {
      const L = (await import("leaflet")).default;
      if (disposed || !containerRef.current) return;

      const map = L.map(containerRef.current, {
        center: [value.lat, value.lng],
        zoom: 16,
        // A pin the user drags is the input; the map itself does not need to scroll-zoom and
        // trapping the page scroll inside it on a phone is a small hostility.
        scrollWheelZoom: false,
      });
      mapRef.current = map;

      L.tileLayer(
        process.env.NEXT_PUBLIC_MAP_TILE_URL ??
          "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
          attribution:
            process.env.NEXT_PUBLIC_MAP_ATTRIBUTION ?? "&copy; OpenStreetMap contributors",
          maxZoom: 19,
        },
      ).addTo(map);

      const marker = L.marker([value.lat, value.lng], { draggable: true }).addTo(map);
      marker.on("dragend", () => {
        const { lat, lng } = marker.getLatLng();
        onChange({ lat, lng });
        setNote(null);
      });
      // Tapping the map moves the pin too — dragging a small marker is hard with an unsteady
      // hand, and this is the audience where that matters most.
      map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
        marker.setLatLng(e.latlng);
        onChange({ lat: e.latlng.lat, lng: e.latlng.lng });
        setNote(null);
      });
    })();

    return () => {
      disposed = true;
      const map = mapRef.current as { remove?: () => void } | null;
      map?.remove?.();
      mapRef.current = null;
    };
    // Keyed on WHETHER a point exists, not on the point itself: the map is created once, at
    // the moment there is somewhere to centre it, and every later change comes from the user
    // moving the marker inside it. Depending on `value` would tear the map down and rebuild
    // it on each drag.
  }, [value != null]);

  return (
    <div>
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-gray-50">
        {locating ? (
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
