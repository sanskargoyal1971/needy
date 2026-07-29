import { AnimatePresence, motion } from "framer-motion";
import { useTaskExperience } from "../realtime/index.js";
import { LiveMap } from "./LiveMap.js";
import { formatEta } from "./shared.js";

/**
 * Stage 4 — Helper en route (§3). A real map (Leaflet/OSM via {@link LiveMap}) on which the
 * helper is a human silhouette that faces its travel direction and GLIDES between GPS points,
 * never teleporting — this is where "feels alive" is won technically. The ETA ticks smoothly
 * and warm milestones surface as the helper progresses, so it's never silence-until-arrival.
 */
export function EnRouteStage() {
  const { task, location, eta, milestones, helper } = useTaskExperience();
  const origin = task?.origin ?? { lat: 0, lng: 0 };
  const latestMilestone = milestones[milestones.length - 1];

  return (
    <div style={{ display: "grid", placeItems: "center", gap: 16, padding: "8px 0" }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <LiveMap
          origin={origin}
          helper={location ? { lat: location.lat, lng: location.lng } : null}
          heading={location?.heading ?? 0}
          durationMs={4000}
          height={260}
        />
      </div>

      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 22, fontWeight: 800 }}>
          {eta ? formatEta(eta.etaSeconds) : "finding the fastest way to you"}
        </div>
        <div style={{ fontSize: 14, color: "var(--needy-text-soft)", marginTop: 2 }}>
          {helper?.displayName ?? "Your helper"} is on the way
        </div>
      </div>

      <div style={{ minHeight: 28 }}>
        <AnimatePresence mode="wait">
          {latestMilestone && (
            <motion.div
              key={latestMilestone}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.4 }}
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--needy-warm)",
                background: "rgba(232,147,90,.12)",
                borderRadius: 999,
                padding: "5px 14px",
              }}
            >
              {latestMilestone}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
