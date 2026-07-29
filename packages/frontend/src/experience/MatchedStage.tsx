import { SoftScaleReveal } from "../motion/index.js";
import { useTaskExperience } from "../realtime/index.js";
import { HelperAvatar } from "./shared.js";

/**
 * Stage 2 — Match found (§3), the app's most important emotional beat. Not a toast: a
 * dedicated reveal of the KYC-verified helper — photo, name, rating, and a human line —
 * animating in like someone walking up to greet you (SoftScaleReveal's gentle breath),
 * never a data card populating.
 */
export function MatchedStage() {
  const { helper } = useTaskExperience();
  if (!helper) return null;

  const etaLine =
    helper.etaSeconds != null
      ? `${Math.max(1, Math.round(helper.etaSeconds / 60))} minutes away`
      : "on their way to you";

  return (
    <div style={{ display: "grid", placeItems: "center", padding: "24px 0" }}>
      <SoftScaleReveal>
        <div
          style={{
            width: 340,
            maxWidth: "100%",
            background: "var(--needy-surface)",
            border: "1px solid var(--needy-border)",
            borderRadius: 20,
            padding: 24,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
            boxShadow: "0 14px 40px rgba(0,0,0,.08)",
          }}
        >
          <HelperAvatar helper={helper} size={88} />
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 800 }}>
              {helper.displayName} · ★ {helper.rating.toFixed(1)}
            </div>
            <div style={{ fontSize: 14, color: "var(--needy-text-soft)", marginTop: 4 }}>
              {helper.displayName} is {etaLine} and has helped {helper.helpedCount} people nearby
            </div>
          </div>
        </div>
      </SoftScaleReveal>
    </div>
  );
}
