"use client";

import type { ReactNode } from "react";
import { DepthStage, at } from "./DepthStage.js";
import type { DepthObjectProps } from "./VerifiedShield3D.js";

const TONES = {
  teal: { face: "linear-gradient(145deg, #23908F, #1B7A7A 50%, #0F5C5C)", edge: "#0A4949" },
  coral: { face: "linear-gradient(145deg, #FFA087, #FF7A59 55%, #E8603F)", edge: "#C9533A" },
} as const;

const LAYERS = 6;

export interface IconTile3DProps extends DepthObjectProps {
  tone?: keyof typeof TONES;
  /** The icon on the tile's face. Rendered white; pass it without a colour class. */
  children: ReactNode;
}

/**
 * A thick, rounded tile carrying one icon — the step markers in "How it works". A single
 * shared object so the four steps are visibly one family and cannot drift apart per screen.
 */
export function IconTile3D({
  tone = "teal",
  size = 104,
  interactive = true,
  delay = 0,
  className,
  children,
}: IconTile3DProps) {
  const t = TONES[tone];
  return (
    <DepthStage
      size={size}
      pose={{ x: 12, y: -16 }}
      sway={9}
      lift={5}
      tilt={14}
      interactive={interactive}
      delay={delay}
      className={className}
    >
      {Array.from({ length: LAYERS }, (_, i) => (
        <div
          key={i}
          style={{
            ...at(38, 34, 124, 124, `translateZ(${-(i + 1) * 3.5}px)`),
            borderRadius: 32,
            background: t.edge,
            filter: `brightness(${1 - i * 0.05})`,
          }}
        />
      ))}
      <div
        style={{
          ...at(38, 34, 124, 124, "translateZ(1px)"),
          borderRadius: 32,
          background: t.face,
          boxShadow: "inset 0 3px 0 rgba(255,255,255,0.28), inset 0 -4px 0 rgba(0,0,0,0.10)",
          color: "#FFFFFF",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Lifted slightly off the face so the icon catches the tilt like an embossed mark. */}
        <div style={{ transform: "translateZ(8px) scale(2.2)", display: "flex" }}>{children}</div>
      </div>
    </DepthStage>
  );
}
