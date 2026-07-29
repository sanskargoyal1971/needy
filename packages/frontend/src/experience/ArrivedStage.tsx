import { useEffect, useState } from "react";
import { ArrivalHighlight } from "../motion/index.js";
import { useTaskExperience } from "../realtime/index.js";
import { HelperAvatar } from "./shared.js";

/**
 * Stage 5 — Arrival (§3). A distinct, calm, no-mistake moment: the warm ArrivalHighlight
 * bloom and a clear "Priya is here". Deliberately unambiguous and gentle, since this beat
 * matters most for elderly/vulnerable users who need certainty a real person has arrived.
 * (An optional, user-toggleable chime would be triggered here by the caller.)
 */
export function ArrivedStage() {
  const { helper } = useTaskExperience();
  const [arrived, setArrived] = useState(false);

  // Trigger the bloom on mount (the stage only renders once the task reaches "arrived").
  useEffect(() => setArrived(true), []);

  return (
    <div style={{ display: "grid", placeItems: "center", padding: "24px 0" }}>
      <ArrivalHighlight active={arrived} style={{ width: 320 }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            padding: 28,
            borderRadius: 20,
            background: "var(--needy-surface)",
            border: "1px solid var(--needy-border)",
            textAlign: "center",
          }}
        >
          {helper && <HelperAvatar helper={helper} size={72} />}
          <div style={{ fontSize: 22, fontWeight: 800 }}>
            {helper?.displayName ?? "Your helper"} is here
          </div>
          <div style={{ fontSize: 14, color: "var(--needy-text-soft)" }}>
            at your gate — you can head out to meet them
          </div>
        </div>
      </ArrivalHighlight>
    </div>
  );
}
