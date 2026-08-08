import type { LatLng } from "@needy/shared";
import { RadarSweep, type RadarBlip } from "../motion/index.js";
import { useTaskExperience } from "../realtime/index.js";

/** Metres per degree of latitude. Longitude degrees are this scaled by cos(latitude). */
const METERS_PER_DEG_LAT = 111_320;
/** Never draw the radar tighter than this, so a single helper 200 m away doesn't get flung to
 *  the rim and read as "far". */
const MIN_RANGE_METERS = 1_500;
/** Never draw it wider than this either — roughly the backend's default MATCH_RADIUS_METERS,
 *  so anyone beyond it was never a real candidate anyway and sits on the rim. */
const MAX_RANGE_METERS = 10_000;

/**
 * Stage 1 — Searching (§3). RadarSweep reaching into the neighborhood, with real helpers
 * fading in as they surface. Copy names concrete signals ("3 helpers nearby are reviewing
 * your request"), never a bare "Searching…", so it reads as people, not a system thinking.
 */
export function SearchingStage() {
  const { helpersNearby, task } = useTaskExperience();
  const blips: RadarBlip[] = projectAll(helpersNearby.approxPoints, task?.origin ?? null).map(
    (p, i) => ({ id: `h-${i}`, x: p.x, y: p.y, delay: 0 }),
  );
  const count = helpersNearby.count;

  return (
    <div style={{ display: "grid", placeItems: "center", gap: 24, padding: "24px 0" }}>
      <RadarSweep size={260} blips={blips} />
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>
          {count > 0
            ? `${count} helper${count === 1 ? "" : "s"} nearby ${count === 1 ? "is" : "are"} reviewing your request`
            : "Reaching out to helpers near you"}
        </div>
        <div style={{ fontSize: 14, color: "var(--needy-text-soft)", marginTop: 6 }}>
          Someone real is about to say yes.
        </div>
      </div>
    </div>
  );
}

/** A helper's offset from the origin in metres — north and east positive. */
function offsetMeters(point: LatLng, origin: LatLng): { north: number; east: number } {
  // Local equirectangular projection: longitude degrees are narrower the further you are from
  // the equator, so scale them by cos(latitude). Accurate to well under a pixel across a
  // 10 km radius, and it needs no map library.
  return {
    north: (point.lat - origin.lat) * METERS_PER_DEG_LAT,
    east:
      (point.lng - origin.lng) *
      METERS_PER_DEG_LAT *
      Math.cos((origin.lat * Math.PI) / 180),
  };
}

/**
 * Project real helper coordinates into the radar's [-1, 1] space at their TRUE bearing and
 * proportional distance from the task origin.
 *
 * This replaces a `(v % 1) * 2 - 1` coordinate "fold" (audited). Taking a coordinate modulo 1
 * discards the whole degrees — the only part that says where on Earth you are — and keeps the
 * fraction, which for two helpers a kilometre apart is nearly identical. Bangalore's
 * 12.97/77.59 collapsed to (-0.06, 0.18): every helper piled up at the radar centre regardless
 * of where they actually were, which is the exact opposite of this stage's job.
 *
 * The radar's range adapts to the furthest helper (bounded by MIN/MAX_RANGE_METERS) so the
 * cluster always fills the dish, while bearings are preserved EXACTLY and distances stay
 * proportional to each other — only the overall zoom changes. Screen y is inverted because y
 * grows downward and north is up.
 */
function projectAll(points: LatLng[], origin: LatLng | null): { x: number; y: number }[] {
  // Before `matched`, `helpers-nearby` can land before the task itself does; with no origin
  // there is nothing to be relative TO, so park the blips at the centre rather than invent a
  // position we can't justify.
  if (!origin) return points.map(() => ({ x: 0, y: 0 }));

  const offsets = points.map((p) => offsetMeters(p, origin));
  const furthest = offsets.reduce((max, o) => Math.max(max, Math.hypot(o.north, o.east)), 0);
  const range = Math.min(MAX_RANGE_METERS, Math.max(MIN_RANGE_METERS, furthest));

  return offsets.map(({ north, east }) => {
    const distance = Math.hypot(north, east);
    if (distance < 1) return { x: 0, y: 0 }; // effectively on top of us; avoids 0/0 below
    // Scale radially: bearing is untouched, and anything past the range clamps to the rim.
    const unit = Math.min(1, distance / range) / distance;
    return { x: east * unit, y: -north * unit };
  });
}
