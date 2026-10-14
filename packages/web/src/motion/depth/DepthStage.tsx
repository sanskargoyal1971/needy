"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { spring as S } from "../motion.config.js";
import { useDepthMotion, type DepthMotionState } from "./useDepthMotion.js";

/**
 * Every 3D object is drawn on a fixed 200×200 design canvas and scaled to fit, so the objects
 * can be authored in plain pixels (translateZ in particular has no percentage form) and still
 * shrink on a narrow phone.
 */
export const CANVAS = 200;

/** One idle cycle. Inside the 8–12s band the design rules set for breathing loops — slow
 *  enough to read as "alive", never as "hurry". */
export const IDLE_SECONDS = 10;

interface StageMotion {
  /** True only while the stage is on screen and motion is allowed. Children use it to run
   *  their own small loops (a door, a ripple) and to stop them with the stage. */
  running: boolean;
  state: DepthMotionState;
}

const StageCtx = createContext<StageMotion>({ running: false, state: "static" });

/** For the parts of an object that move on their own inside the stage. */
export function useStageMotion(): StageMotion {
  return useContext(StageCtx);
}

/** `useId` output is not safe inside `url(#…)` in every browser (it contains colons or
 *  guillemets depending on the React version), and SVG gradients need a page-unique id. */
export function useSvgId(prefix: string): string {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

export interface DepthStageProps {
  /** Largest rendered width in px. The stage shrinks below this to fit its container. */
  size: number;
  /** Resting rotation in degrees — the pose shown under reduced motion, so it should be the
   *  most legible angle of the object, not an arbitrary one. */
  pose?: { x: number; y: number };
  /** Idle rotateY swing in degrees either side of the pose. */
  sway?: number;
  /** Idle float height in px (design-canvas units). */
  lift?: number;
  /** Maximum pointer tilt in degrees. 0 turns tilt off. */
  tilt?: number;
  /** Seconds to offset the idle loop, so a row of objects does not move in lockstep. */
  delay?: number;
  /** False for a backdrop that sits behind real controls: the stage then takes no pointer
   *  events at all, so it can never swallow a click. */
  interactive?: boolean;
  /** A soft contact shadow under the object that breathes with its float. */
  shadow?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

const HIDDEN = { opacity: 0, y: 28, scale: 0.92, rotateX: 14 };
const SHOWN = { opacity: 1, y: 0, scale: 1, rotateX: 0 };

/**
 * The one place 3D motion is implemented. Objects (shield, pin, doorstep, tile) only describe
 * their faces; entrance, idle float, pointer tilt, pausing off screen and the reduced-motion
 * fallback all live here, so they behave identically everywhere and can be re-tuned at once.
 *
 * Built from CSS 3D transforms and Framer Motion rather than WebGL on purpose: the audience
 * skews to older people on modest phones, a three.js bundle would cost more than the whole
 * landing page, and the CSP allows no extra script origins. Only transform and opacity are
 * animated, so the browser can keep all of it on the compositor.
 *
 * Always aria-hidden: these are illustrations. Anything a reader needs is in the text beside
 * them.
 */
export function DepthStage({
  size,
  pose = { x: 8, y: -14 },
  sway = 12,
  lift = 6,
  tilt = 10,
  delay = 0,
  interactive = true,
  shadow = true,
  className = "",
  style,
  children,
}: DepthStageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const state = useDepthMotion(ref);
  const running = state === "running";
  const [scale, setScale] = useState(size / CANVAS);

  // Fit the fixed canvas to whatever width the layout gives the stage. A ResizeObserver
  // rather than a resize listener: the stage also changes width when a grid reflows.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width;
      if (w) setScale(w / CANVAS);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pointer tilt. The springs give the "picked up and set down" feel; the raw values are
  // written on pointermove and the springs smooth them on the animation frame, so a fast
  // mouse never produces a jumpy object.
  const px = useMotionValue(0);
  const py = useMotionValue(0);
  const sx = useSpring(px, { stiffness: 110, damping: 16, mass: 0.8 });
  const sy = useSpring(py, { stiffness: 110, damping: 16, mass: 0.8 });
  const tiltY = useTransform(sx, (v) => v * tilt * 2);
  const tiltX = useTransform(sy, (v) => -v * tilt * 2);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    // Mouse and pen only. A touch drag on a phone is someone scrolling the page, and turning
    // it into a tilt would make the page feel like it is fighting them.
    if (!running || tilt === 0 || e.pointerType === "touch") return;
    const r = e.currentTarget.getBoundingClientRect();
    px.set((e.clientX - r.left) / r.width - 0.5);
    py.set((e.clientY - r.top) / r.height - 0.5);
  };
  const onPointerLeave = () => {
    px.set(0);
    py.set(0);
  };

  const idle = running
    ? {
        y: [0, -lift, 0, -lift, 0],
        rotateY: [0, sway, 0, -sway, 0],
      }
    : { y: 0, rotateY: 0 };
  const idleTransition = running
    ? { duration: IDLE_SECONDS, ease: "easeInOut", repeat: Infinity, delay }
    : { duration: 0.8, ease: "easeOut" };

  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-motion={state}
      // `relative` unless the caller positions the stage itself: Tailwind emits `relative`
      // after `absolute`, so both classes together would silently pin it in the flow.
      className={`${/\b(absolute|fixed)\b/.test(className) ? "" : "relative "}select-none ${className}`}
      style={{
        width: "100%",
        maxWidth: size,
        aspectRatio: "1 / 1",
        perspective: 900,
        pointerEvents: interactive ? undefined : "none",
        ...style,
      }}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerLeave={interactive ? onPointerLeave : undefined}
    >
      <StageCtx.Provider value={{ running, state }}>
        {/* Entrance. `initial={false}` makes the server and the first client render paint the
            shown pose, so nothing is ever invisible without JavaScript. Only an object that
            was off screen at load is switched to HIDDEN — off screen, so nobody sees it go. */}
        <motion.div
          className="absolute inset-0"
          style={{ transformStyle: "preserve-3d" }}
          initial={false}
          animate={state === "waiting" ? HIDDEN : SHOWN}
          transition={
            state === "waiting"
              ? { duration: 0 }
              : { ...S.greet, opacity: { duration: 0.6, ease: "easeOut" } }
          }
        >
          {shadow && (
            <motion.div
              className="absolute rounded-[50%]"
              style={{
                left: "24%",
                width: "52%",
                bottom: "4%",
                height: "9%",
                background:
                  "radial-gradient(closest-side, rgba(15,92,92,0.28), rgba(15,92,92,0.10) 60%, rgba(15,92,92,0))",
              }}
              initial={false}
              animate={
                running
                  ? { scale: [1, 0.9, 1, 0.9, 1], opacity: [1, 0.75, 1, 0.75, 1] }
                  : { scale: 1, opacity: 1 }
              }
              transition={idleTransition}
            />
          )}
          <motion.div
            className="absolute inset-0"
            style={{ rotateX: tiltX, rotateY: tiltY, transformStyle: "preserve-3d" }}
          >
            <motion.div
              className="absolute inset-0"
              style={{
                transformStyle: "preserve-3d",
                // Promoted only while it is actually moving; a permanent will-change on every
                // object would hold a compositor layer each for the life of the page.
                willChange: running ? "transform" : undefined,
              }}
              initial={false}
              animate={idle}
              transition={idleTransition}
            >
              <div
                className="absolute left-1/2 top-1/2"
                style={{
                  width: CANVAS,
                  height: CANVAS,
                  transformStyle: "preserve-3d",
                  transform: `translate(-50%, -50%) scale(${scale}) rotateX(${pose.x}deg) rotateY(${pose.y}deg)`,
                }}
              >
                {children}
              </div>
            </motion.div>
          </motion.div>
        </motion.div>
      </StageCtx.Provider>
    </div>
  );
}

/** Absolute placement on the design canvas, with an optional depth. Keeps the object files
 *  readable as "what is where" rather than a wall of style objects. */
export function at(
  left: number,
  top: number,
  width: number,
  height: number,
  transform = "",
): CSSProperties {
  return {
    position: "absolute",
    left,
    top,
    width,
    height,
    transform: transform || undefined,
    transformStyle: "preserve-3d",
  };
}
