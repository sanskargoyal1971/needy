import { RadarSweep, type RadarBlip } from "../motion/index.js";
import { useTaskExperience } from "../realtime/index.js";

/**
 * Stage 1 — Searching (§3). RadarSweep reaching into the neighborhood, with real helpers
 * fading in as they surface. Copy names concrete signals ("3 helpers nearby are reviewing
 * your request"), never a bare "Searching…", so it reads as people, not a system thinking.
 */
export function SearchingStage() {
  const { helpersNearby } = useTaskExperience();
  const blips: RadarBlip[] = helpersNearby.approxPoints.map((p, i) => ({
    // approxPoints arrive as normalized offsets from the mock, or coarse lat/lng from the
    // server; both are clamped into the radar's [-1,1] space here.
    id: `h-${i}`,
    x: clampUnit(p.lng),
    y: clampUnit(p.lat),
    delay: 0,
  }));
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

function clampUnit(v: number): number {
  if (v >= -1 && v <= 1) return v;
  // Fold a raw coordinate into a stable-ish position on the radar.
  return Math.max(-1, Math.min(1, (v % 1) * 2 - 1));
}
