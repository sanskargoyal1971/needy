import { BreathingPulse } from "../motion/index.js";
import { useTaskExperience } from "../realtime/index.js";
import { HelperAvatar } from "./shared.js";

/**
 * Stage 3 — Video verification (§3). Framed explicitly as "seeing a real person", not
 * "starting a video call": a glassmorphism frame with a warm vignette rather than a flat
 * Zoom-style rectangle, and a connecting state that's a soft heartbeat ring (BreathingPulse)
 * around a silhouette — never a generic buffering spinner.
 */
export function VerifyingStage() {
  const { helper } = useTaskExperience();

  return (
    <div style={{ display: "grid", placeItems: "center", gap: 18, padding: "16px 0" }}>
      <div
        style={{
          position: "relative",
          width: 300,
          height: 380,
          borderRadius: 24,
          overflow: "hidden",
          background: "linear-gradient(160deg, rgba(232,147,90,.18), rgba(95,185,142,.14))",
          border: "1px solid rgba(255,255,255,.35)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          boxShadow: "0 20px 60px rgba(0,0,0,.18)",
          display: "grid",
          placeItems: "center",
        }}
      >
        {/* warm vignette */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(circle at 50% 42%, transparent 45%, rgba(20,17,14,.28) 100%)",
            pointerEvents: "none",
          }}
        />
        <BreathingPulse size={190} color="calm" intensity="base">
          {helper ? (
            <HelperAvatar helper={helper} size={96} />
          ) : (
            <div
              style={{
                width: 96,
                height: 96,
                borderRadius: "50%",
                background: "rgba(255,255,255,.5)",
              }}
            />
          )}
        </BreathingPulse>
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>
          Connecting you with {helper?.displayName ?? "your helper"}
        </div>
        <div style={{ fontSize: 14, color: "var(--needy-text-soft)", marginTop: 4 }}>
          A quick hello, so you can see who's coming.
        </div>
      </div>
    </div>
  );
}
