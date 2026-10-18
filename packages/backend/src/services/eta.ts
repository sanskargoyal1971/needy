import type { LatLng } from "@needy/shared";
import { config } from "../config.js";
import { logger } from "../logger.js";

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in meters. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export interface EtaResult {
  etaSeconds: number;
  distanceMeters: number;
  /** true when we fell back to a straight-line estimate (no routing provider). */
  approximate: boolean;
  /** Google encoded polyline of the road route, when a provider supplied one. */
  polyline?: string;
}

/**
 * How long a routed answer is reused for one task, and how far the helper may move before it is
 * asked again. Location ticks arrive every few seconds and each Routes call is billed; a route
 * does not change meaningfully in 25 s or 150 m. Between calls the cached ETA is scaled by the
 * remaining straight-line distance, so the number still falls as the helper approaches.
 */
const ROUTE_REUSE_MS = 25_000;
const ROUTE_REUSE_METERS = 150;
const ROUTE_CACHE_MAX = 5_000;

interface CachedRoute {
  at: number;
  from: LatLng;
  to: LatLng;
  result: EtaResult;
}
const routeCache = new Map<string, CachedRoute>();

/** Test seam: forget every cached route. */
export function clearRouteCache(): void {
  routeCache.clear();
}

/** Recompute ETA on each location update (§2.3). Prefer a routing provider for real-road
 *  distance/time; straight-line reads as obviously fake to locals, so when we fall back we
 *  say so (flag + log) rather than pretending.
 *
 *  `cacheKey` (the task id) enables reuse of a recent routed answer — see ROUTE_REUSE_MS. */
export async function computeEta(
  from: LatLng,
  to: LatLng,
  opts: { cacheKey?: string; now?: number } = {},
): Promise<EtaResult> {
  // A few metres from the door there is no route to ask for (Routes answers `{}`), and the
  // straight line IS the answer.
  const nearlyThere = haversineMeters(from, to) < 40;
  if (config.directions.provider && config.directions.apiKey && !nearlyThere) {
    const now = opts.now ?? Date.now();
    const cached = opts.cacheKey ? routeCache.get(opts.cacheKey) : undefined;
    if (
      cached &&
      now - cached.at < ROUTE_REUSE_MS &&
      haversineMeters(cached.from, from) < ROUTE_REUSE_METERS &&
      haversineMeters(cached.to, to) < 1
    ) {
      return scaleCached(cached, from, to);
    }
    try {
      const result = await routeViaProvider(from, to);
      if (opts.cacheKey) remember(opts.cacheKey, { at: now, from, to, result });
      return result;
    } catch (err) {
      logger.warn("directions provider failed; falling back to haversine", {
        err: String(err),
      });
    }
  }
  const distanceMeters = haversineMeters(from, to);
  // ~1.4 m/s walking-ish blended pace; deliberately conservative for the fallback.
  const etaSeconds = Math.round(distanceMeters / 1.4);
  return { etaSeconds, distanceMeters, approximate: !nearlyThere };
}

/** Shrink a cached route's time and distance in proportion to how much closer the helper is. */
function scaleCached(cached: CachedRoute, from: LatLng, to: LatLng): EtaResult {
  const then = haversineMeters(cached.from, cached.to);
  const nowDist = haversineMeters(from, to);
  const ratio = then > 0 ? Math.min(1.5, nowDist / then) : 1;
  return {
    ...cached.result,
    etaSeconds: Math.max(0, Math.round(cached.result.etaSeconds * ratio)),
    distanceMeters: Math.max(0, Math.round(cached.result.distanceMeters * ratio)),
  };
}

function remember(key: string, entry: CachedRoute): void {
  routeCache.delete(key);
  routeCache.set(key, entry);
  // Map iteration is insertion order, so the first key is the least recently written.
  while (routeCache.size > ROUTE_CACHE_MAX) {
    const oldest = routeCache.keys().next().value;
    if (oldest === undefined) break;
    routeCache.delete(oldest);
  }
}

async function routeViaProvider(from: LatLng, to: LatLng): Promise<EtaResult> {
  if (config.directions.provider !== "google") {
    throw new Error(`directions provider '${config.directions.provider}' not implemented`);
  }
  return googleRoute(from, to);
}

/** Google Routes API `computeRoutes`. The key goes in a header, never the URL, so it cannot
 *  end up in an access log or in the error string logged above. */
async function googleRoute(from: LatLng, to: LatLng): Promise<EtaResult> {
  const travelMode = config.directions.travelMode;
  const trafficAware = travelMode === "DRIVE" || travelMode === "TWO_WHEELER";
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    signal: AbortSignal.timeout(3_000),
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": config.directions.apiKey,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
      destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
      travelMode,
      ...(trafficAware ? { routingPreference: "TRAFFIC_AWARE" } : {}),
      regionCode: "IN",
    }),
  });
  if (!res.ok) throw new Error(`routes api ${res.status}`);
  const body = (await res.json()) as {
    routes?: {
      duration?: string;
      distanceMeters?: number;
      polyline?: { encodedPolyline?: string };
    }[];
  };
  const route = body.routes?.[0];
  // An empty object means "no route" (e.g. same point, or unroutable) — fall back honestly.
  if (!route?.duration) throw new Error("routes api returned no route");
  return {
    etaSeconds: Math.round(Number.parseFloat(route.duration)),
    distanceMeters: route.distanceMeters ?? Math.round(haversineMeters(from, to)),
    approximate: false,
    ...(route.polyline?.encodedPolyline ? { polyline: route.polyline.encodedPolyline } : {}),
  };
}
