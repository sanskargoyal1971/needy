import { motion } from "framer-motion";
import { SoftScaleReveal, color as tokens } from "../motion/index.js";
import { useReducedMotionPref } from "../motion/preferences.js";
import { useTaskExperience } from "../realtime/index.js";
import { HelperAvatar } from "./shared.js";

/**
 * Stage 7 — Task completion (§3). A warm, human close — not a generic checkmark. A subtle,
 * non-gamified particle moment paired with the helper's photo and a person-framed summary
 * ("Priya helped you for 47 minutes today"), reinforcing the relationship was with a person,
 * not a transaction, before the rating screen.
 */
export function CompletedStage() {
  const { helper, task } = useTaskExperience();
  const minutes = task ? Math.max(1, Math.round((task.updatedAt - task.createdAt) / 60000)) : null;

  return (
    <div style={{ position: "relative", display: "grid", placeItems: "center", padding: "28px 0" }}>
      <Particles />
      <SoftScaleReveal>
        <div
          style={{
            position: "relative",
            zIndex: 1,
            width: 340,
            maxWidth: "100%",
            background: "var(--needy-surface)",
            border: "1px solid var(--needy-border)",
            borderRadius: 22,
            padding: 28,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
            textAlign: "center",
          }}
        >
          {helper && <HelperAvatar helper={helper} size={80} />}
          <div style={{ fontSize: 20, fontWeight: 800 }}>Thank you for trusting Needy</div>
          <div style={{ fontSize: 15, color: "var(--needy-text-soft)" }}>
            {helper?.displayName ?? "Your helper"} helped you
            {minutes ? ` for ${minutes} minute${minutes === 1 ? "" : "s"}` : ""} today.
          </div>
          {/* The "Rate {helper}" button that used to sit here had NO onClick — it was the third
              instance of the same defect as the SOS button and the missing cancel flow: a
              control promising an action the app does not take. Tapping it did nothing at all,
              which for the closing beat of the experience reads as the app being broken.

              It is removed rather than left inert. Rating needs a `ratings` table, a repository,
              a route and a screen; that is real work owned by the product-flow pass, and the
              rule this codebase now holds to is that nothing ships on screen offering an action
              it cannot perform. The warm close stands on its own until the flow exists. */}
        </div>
      </SoftScaleReveal>
    </div>
  );
}

/** A restrained particle-lite bloom — celebratory but calm, and skipped entirely under
 *  reduced motion. */
function Particles() {
  const reduced = useReducedMotionPref();
  if (reduced) return null;
  const hues = [tokens.warm, tokens.warmSoft, tokens.presence];
  const bits = Array.from({ length: 14 }, (_, i) => {
    const angle = (i / 14) * Math.PI * 2;
    const dist = 90 + (i % 4) * 22;
    return {
      id: i,
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist,
      hue: hues[i % hues.length],
      delay: (i % 5) * 0.03,
    };
  });
  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}>
      {bits.map((b) => (
        <motion.span
          key={b.id}
          style={{
            position: "absolute",
            width: 8,
            height: 8,
            borderRadius: 2,
            background: b.hue,
          }}
          initial={{ x: 0, y: 0, opacity: 0, scale: 0.6 }}
          animate={{ x: b.dx, y: b.dy, opacity: [0, 1, 0], scale: 1, rotate: 120 }}
          transition={{ duration: 1.5, ease: "easeOut", delay: b.delay }}
        />
      ))}
    </div>
  );
}
