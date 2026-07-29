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
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export interface EtaResult {
  etaSeconds: number;
  distanceMeters: number;
  /** true when we fell back to a straight-line estimate (no routing provider). */
  approximate: boolean;
}

/** Recompute ETA on each location update (§2.3). Prefer a routing provider for real-road
 *  distance/time; straight-line reads as obviously fake to locals, so when we fall back we
 *  say so (flag + log) rather than pretending. Provider integration is a single seam here. */
export async function computeEta(from: LatLng, to: LatLng): Promise<EtaResult> {
  if (config.directions.provider && config.directions.apiKey) {
    try {
      return await routeViaProvider(from, to);
    } catch (err) {
      logger.warn("directions provider failed; falling back to haversine", {
        err: String(err),
      });
    }
  }
  const distanceMeters = haversineMeters(from, to);
  // ~1.4 m/s walking-ish blended pace; deliberately conservative for the fallback.
  const etaSeconds = Math.round(distanceMeters / 1.4);
  return { etaSeconds, distanceMeters, approximate: true };
}

/** Placeholder for Google/Mapbox Directions. Kept isolated so wiring a real key is a
 *  one-function change and the rest of the app is provider-agnostic. */
async function routeViaProvider(_from: LatLng, _to: LatLng): Promise<EtaResult> {
  throw new Error(
    `directions provider '${config.directions.provider}' not implemented yet`,
  );
}
