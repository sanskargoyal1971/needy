"use client";

import { DepthStage, at, useSvgId } from "./DepthStage.js";

export interface DepthObjectProps {
  /** Largest rendered width in px; shrinks to fit its container. */
  size?: number;
  /** False when it sits behind real controls (see DepthStage). */
  interactive?: boolean;
  /** Seconds to offset the idle loop against its neighbours. */
  delay?: number;
  className?: string;
}

const SHIELD = "M50 4 L92 18 V58 C92 86 72 106 50 116 C28 106 8 86 8 58 V18 Z";
/** Slices of the extrusion. Eight reads as solid at the sway angle without costing much: each
 *  is one small SVG on the compositor. */
const SLICES = 8;

/**
 * The verification promise as an object: a teal shield, solid enough to have an edge, with a
 * check on its face. Used wherever the copy beside it is about helpers being ID-verified and
 * reviewed by a person — it illustrates that claim and nothing more.
 */
export function VerifiedShield3D({
  size = 180,
  interactive = true,
  delay = 0,
  className,
}: DepthObjectProps) {
  const face = useSvgId("shield-face");
  const sheen = useSvgId("shield-sheen");

  return (
    <DepthStage
      size={size}
      pose={{ x: 6, y: -18 }}
      sway={18}
      lift={6}
      interactive={interactive}
      delay={delay}
      className={className}
    >
      {/* A soft halo behind, so the silhouette separates from a busy background. */}
      <div
        style={{
          ...at(20, 18, 160, 160, "translateZ(-40px)"),
          borderRadius: "50%",
          background: "radial-gradient(closest-side, rgba(27,122,122,0.22), rgba(27,122,122,0))",
        }}
      />

      {/* The edge: the same outline repeated a few px apart in depth, darkening to the back. */}
      {Array.from({ length: SLICES }, (_, i) => (
        <svg
          key={i}
          viewBox="0 0 100 120"
          style={at(40, 28, 120, 144, `translateZ(${-(i + 1) * 2.5}px)`)}
        >
          <path d={SHIELD} fill={i === SLICES - 1 ? "#073B3B" : i % 2 ? "#0A4949" : "#0C5050"} />
        </svg>
      ))}

      <svg viewBox="0 0 100 120" style={at(40, 28, 120, 144, "translateZ(1px)")}>
        <defs>
          <linearGradient id={face} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#23908F" />
            <stop offset="0.55" stopColor="#1B7A7A" />
            <stop offset="1" stopColor="#0F5C5C" />
          </linearGradient>
          <linearGradient id={sheen} x1="0" y1="0" x2="0.6" y2="1">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.38" />
            <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={SHIELD} fill={`url(#${face})`} />
        <path
          d="M50 12 L84 23.5 V58 C84 81 68 98 50 107 C32 98 16 81 16 58 V23.5 Z"
          fill="none"
          stroke="#FFA087"
          strokeOpacity="0.55"
          strokeWidth="2"
        />
        <path
          d="M31 60 L45 74 L71 45"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d={SHIELD} fill={`url(#${sheen})`} />
      </svg>
    </DepthStage>
  );
}
