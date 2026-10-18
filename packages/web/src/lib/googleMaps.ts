/// <reference types="google.maps" />
"use client";

/** ── Google Maps loader ─────────────────────────────────────────────────────
 *  One script tag for the whole app, injected on first use. Both maps (the origin picker and
 *  live tracking) go through here, so the SDK is never loaded twice.
 *
 *  Injected from JS rather than a <Script> tag on purpose: the document CSP is nonce-based
 *  with `strict-dynamic` (see proxy.ts), which trusts a script that an already-trusted script
 *  creates. The SDK then loads its own chunks the same way.
 *
 *  The key is a BROWSER key — it is inlined into the client bundle and visible to anyone who
 *  opens devtools. That is how the Maps JavaScript API works; the protection is restricting the
 *  key in Google Cloud Console (API restriction to Maps JavaScript API, plus an HTTP-referrer or
 *  app restriction), never keeping it secret.
 */

export const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
/** Advanced markers require a Map ID. `DEMO_MAP_ID` is Google's own id for development; set a
 *  real one (with the brand styling attached in Cloud Console) for production. */
export const GOOGLE_MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAP_ID || "DEMO_MAP_ID";

export type MapsLibraries = {
  maps: google.maps.MapsLibrary;
  marker: google.maps.MarkerLibrary;
  geometry: google.maps.GeometryLibrary;
};

let loading: Promise<MapsLibraries> | null = null;

declare global {
  interface Window {
    __needyMapsReady?: () => void;
    /** Google calls this global when the key is rejected (bad key, API not enabled, billing). */
    gm_authFailure?: () => void;
  }
}

const authFailureListeners = new Set<() => void>();

/** Subscribe to the SDK's key-rejected signal. The SDK reports it once, globally, and only
 *  after the script has loaded — so a map that rendered can still turn into an error. */
export function onMapsAuthFailure(fn: () => void): () => void {
  authFailureListeners.add(fn);
  return () => authFailureListeners.delete(fn);
}

export function loadGoogleMaps(): Promise<MapsLibraries> {
  if (!GOOGLE_MAPS_API_KEY) {
    return Promise.reject(new Error("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not set"));
  }
  loading ??= new Promise<void>((resolve, reject) => {
    window.gm_authFailure = () => authFailureListeners.forEach((fn) => fn());
    window.__needyMapsReady = () => resolve();
    const params = new URLSearchParams({
      key: GOOGLE_MAPS_API_KEY,
      v: "weekly",
      loading: "async",
      callback: "__needyMapsReady",
      region: "IN",
    });
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => {
      // Let a later mount try again rather than caching the failure for the page's lifetime.
      loading = null;
      script.remove();
      reject(new Error("Google Maps failed to load"));
    };
    document.head.appendChild(script);
  }).then(async () => ({
    maps: (await google.maps.importLibrary("maps")) as google.maps.MapsLibrary,
    marker: (await google.maps.importLibrary("marker")) as google.maps.MarkerLibrary,
    geometry: (await google.maps.importLibrary("geometry")) as google.maps.GeometryLibrary,
  }));
  return loading;
}

/** Build a marker's DOM content from a trusted, static HTML string (never user input).
 *  Advanced markers anchor at the content's bottom-centre; every Needy marker is a dot whose
 *  centre is the point, so the content is shifted down by half its height. */
export function markerContent(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  el.style.transform = "translateY(50%)";
  return el;
}
