"use client";

import { useEffect, useState, type RefObject } from "react";
import { useReducedMotionPref } from "../preferences.js";

/**
 * What a decorative 3D object is allowed to be doing right now.
 *
 *  - `static`  — reduced motion, no IntersectionObserver, or not yet hydrated. The object sits
 *                in its resting pose and nothing moves. This is ALSO what the server renders,
 *                so the first client render matches it whatever the user's preference is.
 *  - `waiting` — it was below the fold when the page loaded and has not been scrolled to yet.
 *                It is held in its pre-entrance pose so it can arrive when it is seen.
 *  - `running` — on screen; idle loops and pointer tilt are live.
 *  - `paused`  — it has been seen but is off screen again; loops settle to rest and stop, so
 *                a long landing page is not animating six things nobody can see on a modest
 *                phone.
 */
export type DepthMotionState = "static" | "waiting" | "running" | "paused";

interface ViewState {
  inView: boolean;
  seen: boolean;
  /** Off screen at the first observation. Only these objects get an entrance: one that was
   *  already visible at load must not blink out and back in after hydration. */
  startedHidden: boolean;
}

export function useDepthMotion(ref: RefObject<Element | null>): DepthMotionState {
  const reduced = useReducedMotionPref();
  const [view, setView] = useState<ViewState | null>(null);

  useEffect(() => {
    const el = ref.current;
    // No observer under reduced motion: nothing will move, so there is nothing to pause.
    if (reduced || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        const visible = entry.isIntersecting;
        setView((prev) => ({
          inView: visible,
          seen: (prev?.seen ?? false) || visible,
          startedHidden: prev ? prev.startedHidden : !visible,
        }));
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, reduced]);

  // Reduced motion wins over everything, including an observation made before it was turned
  // on: the preference can change while the page is open.
  if (reduced || view == null) return "static";
  if (view.startedHidden && !view.seen) return "waiting";
  return view.inView ? "running" : "paused";
}
