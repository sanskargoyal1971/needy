/** A single geographic point. Longitude first is Redis GEO's convention; we keep
 *  the object form explicit everywhere to avoid lat/lng transposition bugs. */
export interface LatLng {
  lat: number;
  lng: number;
}

/** A location update carried over the /tracking socket. `heading` (degrees, 0 = north,
 *  clockwise) lets the client rotate the human silhouette marker to face travel direction
 *  (§3 Stage 4). `at` is the server-stamped epoch ms the update was received. */
export interface LocationUpdate extends LatLng {
  heading?: number;
  speedMps?: number;
  at: number;
}

export function isLatLng(v: unknown): v is LatLng {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as LatLng).lat === "number" &&
    typeof (v as LatLng).lng === "number" &&
    Math.abs((v as LatLng).lat) <= 90 &&
    Math.abs((v as LatLng).lng) <= 180
  );
}
