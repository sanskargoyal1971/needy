"use client";

import { motion } from "framer-motion";
import { DepthStage, IDLE_SECONDS, at, useStageMotion, useSvgId } from "./DepthStage.js";
import type { DepthObjectProps } from "./VerifiedShield3D.js";

const PIN = "M30 78 C30 78 4 48 4 28 A26 26 0 0 1 56 28 C56 48 30 78 30 78 Z";
const TILE_TILT = 62;

/**
 * "Someone close by": a pin standing on a small neighbourhood tile, with a slow ripple where
 * it touches down. It illustrates a nearby match — it is not a map and shows no real place.
 */
export function MapPin3D({
  size = 220,
  interactive = true,
  delay = 0,
  className,
}: DepthObjectProps) {
  return (
    <DepthStage
      size={size}
      pose={{ x: 0, y: -10 }}
      sway={10}
      lift={0}
      interactive={interactive}
      delay={delay}
      shadow={false}
      className={className}
    >
      <Tile />
      <Pin />
    </DepthStage>
  );
}

function Tile() {
  const { running } = useStageMotion();
  return (
    // The tile lies flat: rotated about its own centre, which stays at canvas (100, 122) —
    // exactly where the pin's tip is placed, so the pin always stands on the middle of it.
    <div
      style={{
        ...at(30, 52, 140, 140, `rotateX(${TILE_TILT}deg) rotateZ(-28deg)`),
        borderRadius: 24,
        background: [
          // Two streets crossing, drawn as gradients rather than an image so there is no
          // request and nothing to load.
          "linear-gradient(90deg, transparent 44%, #DCEBEA 44%, #DCEBEA 56%, transparent 56%)",
          "linear-gradient(0deg, transparent 30%, #E6F0F0 30%, #E6F0F0 38%, transparent 38%)",
          "linear-gradient(135deg, #FFFDF9, #F4EEE4)",
        ].join(","),
        // The offset shadow lies in the tile's own plane, so it reads as the tile's front edge.
        boxShadow:
          "0 0 0 1px rgba(15,92,92,0.08), 0 12px 0 -1px #E2D8C9, 0 30px 36px -8px rgba(15,92,92,0.28)",
      }}
    >
      {/* A park and two blocks, so it reads as a neighbourhood and not a chessboard. */}
      <div
        style={{
          ...at(12, 12, 40, 30),
          borderRadius: 10,
          background: "rgba(95,185,142,0.30)",
        }}
      />
      <div style={{ ...at(90, 14, 34, 26), borderRadius: 8, background: "#E6F0F0" }} />
      <div style={{ ...at(16, 100, 30, 26), borderRadius: 8, background: "#FBE3DA" }} />

      {/* Touch-down ripple. Two rings half a cycle apart so there is always one in flight. */}
      {[0, 1].map((i) => (
        <motion.div
          key={i}
          style={{
            ...at(50, 50, 40, 40),
            borderRadius: "50%",
            border: "3px solid rgba(255,122,89,0.75)",
          }}
          initial={false}
          animate={
            running
              ? { scale: [0.5, 2.4], opacity: [0.7, 0] }
              : { scale: 1.3, opacity: i ? 0 : 0.35 }
          }
          transition={
            running
              ? {
                  duration: IDLE_SECONDS / 2,
                  ease: "easeOut",
                  repeat: Infinity,
                  delay: (i * IDLE_SECONDS) / 4,
                }
              : { duration: 0.6 }
          }
        />
      ))}
      <div
        style={{
          ...at(58, 58, 24, 24),
          borderRadius: "50%",
          background: "radial-gradient(closest-side, rgba(15,92,92,0.45), rgba(15,92,92,0))",
        }}
      />
    </div>
  );
}

function Pin() {
  const { running } = useStageMotion();
  const body = useSvgId("pin-body");
  const shine = useSvgId("pin-shine");
  return (
    <motion.div
      // Tip of the pin at canvas (100, 122): the tile's centre.
      style={at(68, 37, 64, 85)}
      initial={false}
      animate={running ? { y: [0, -10, 0, -10, 0] } : { y: 0 }}
      transition={
        running
          ? { duration: IDLE_SECONDS, ease: "easeInOut", repeat: Infinity }
          : { duration: 0.8, ease: "easeOut" }
      }
    >
      {[3, 2, 1].map((i) => (
        <svg key={i} viewBox="0 0 60 80" style={at(0, 0, 64, 85, `translateZ(${-i * 2.5}px)`)}>
          <path d={PIN} fill={i === 3 ? "#A9432C" : "#C9533A"} />
        </svg>
      ))}
      <svg viewBox="0 0 60 80" style={at(0, 0, 64, 85, "translateZ(1px)")}>
        <defs>
          <linearGradient id={body} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#FFA087" />
            <stop offset="0.5" stopColor="#FF7A59" />
            <stop offset="1" stopColor="#E8603F" />
          </linearGradient>
          <linearGradient id={shine} x1="0" y1="0" x2="0.7" y2="1">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.45" />
            <stop offset="0.45" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={PIN} fill={`url(#${body})`} />
        <circle cx="30" cy="28" r="11" fill="#FFFFFF" />
        <circle cx="30" cy="28" r="5" fill="#0F5C5C" />
        <path d={PIN} fill={`url(#${shine})`} />
      </svg>
    </motion.div>
  );
}
