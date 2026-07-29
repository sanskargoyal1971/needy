import { animate, motion, useMotionValue } from "framer-motion";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { duration as D, ease as E } from "./motion.config.js";
import { useReducedMotionPref } from "./preferences.js";

export interface InterpolatedMarkerProps {
  /** Target position in the parent's pixel space (project lat/lng → x/y before passing). */
  x: number;
  y: number;
  /** Heading in degrees (0 = up, clockwise). The marker rotates to face travel direction. */
  heading?: number;
  /** Milliseconds to glide from the previous point to this one. Should be ≥ the location
   *  update interval (3–5s) so the marker is still moving when the next point lands. */
  durationMs?: number;
  /** The marker glyph. Defaults to a small human silhouette — a person, not a car/pin (§3 Stage 4). */
  children?: ReactNode;
  size?: number;
}

/**
 * Smoothly interpolates a marker between successive GPS points (§2.3) — the single detail
 * that most decides whether tracking "feels alive". Do NOT re-render at each raw coordinate;
 * pass the latest (x, y) and this tweens from the previous one over `durationMs` via Framer's
 * imperative `animate()` on motion values, so travel is continuous and human, never teleporting.
 *
 * Reduced motion: snaps directly to each new position (no glide), still rotating to face travel.
 */
export function InterpolatedMarker({
  x,
  y,
  heading = 0,
  durationMs = D.markerTween * 1000,
  children,
  size = 34,
}: InterpolatedMarkerProps) {
  const reduced = useReducedMotionPref();
  const mx = useMotionValue(x);
  const my = useMotionValue(y);
  const rot = useMotionValue(heading);
  const firstRun = useRef(true);

  // Tween position toward each new (x, y). Near-linear easing so it doesn't "brake" mid-leg.
  useEffect(() => {
    if (reduced || firstRun.current) {
      mx.set(x);
      my.set(y);
      return;
    }
    const cx = animate(mx, x, { duration: durationMs / 1000, ease: E.travel });
    const cy = animate(my, y, { duration: durationMs / 1000, ease: E.travel });
    return () => {
      cx.stop();
      cy.stop();
    };
  }, [x, y, durationMs, reduced, mx, my]);

  // Rotate to face heading along the shortest angular path.
  useEffect(() => {
    const current = rot.get();
    const delta = ((((heading - current) % 360) + 540) % 360) - 180;
    const target = current + delta;
    if (reduced || firstRun.current) {
      rot.set(target);
    } else {
      const c = animate(rot, target, { duration: 0.5, ease: E.soft });
      return () => c.stop();
    }
  }, [heading, reduced, rot]);

  useEffect(() => {
    firstRun.current = false;
  }, []);

  const wrap: CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: size,
    height: size,
    marginLeft: -size / 2,
    marginTop: -size / 2,
    display: "grid",
    placeItems: "center",
    willChange: "transform",
  };

  return (
    <motion.div style={{ ...wrap, x: mx, y: my }}>
      {/* Only the glyph rotates; a label placed as a child would stay upright if separated. */}
      <motion.div style={{ rotate: rot, display: "grid", placeItems: "center" }}>
        {children ?? <DefaultSilhouette size={size} />}
      </motion.div>
    </motion.div>
  );
}

/** A small human silhouette — reinforces "a person is walking toward you", not a package. */
function DefaultSilhouette({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {/* subtle direction hint at the top */}
      <path d="M12 1 L15 6 L9 6 Z" fill="var(--needy-warm, #E8935A)" opacity="0.9" />
      <circle cx="12" cy="9.5" r="3" fill="var(--needy-warm, #E8935A)" />
      <path
        d="M6.5 20c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6z"
        fill="var(--needy-warm, #E8935A)"
      />
    </svg>
  );
}
