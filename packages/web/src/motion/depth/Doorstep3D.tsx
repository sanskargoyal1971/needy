"use client";

import { motion } from "framer-motion";
import { KeyRound } from "lucide-react";
import { DepthStage, IDLE_SECONDS, at, useStageMotion } from "./DepthStage.js";
import type { DepthObjectProps } from "./VerifiedShield3D.js";

/**
 * "A code at your door": a front door, slightly ajar with warm light behind it, and a small
 * code tag hovering in front. The tag shows dots, never digits — a picture of a code that
 * looks like a real one is exactly the kind of thing a scam page would show.
 */
export function Doorstep3D({
  size = 180,
  interactive = true,
  delay = 0,
  className,
}: DepthObjectProps) {
  return (
    <DepthStage
      size={size}
      pose={{ x: 6, y: -24 }}
      sway={10}
      lift={4}
      interactive={interactive}
      delay={delay}
      className={className}
    >
      <Wall />
      <Door />
      <CodeTag />
    </DepthStage>
  );
}

function Wall() {
  return (
    <>
      {/* Front of the wall */}
      <div
        style={{
          ...at(36, 28, 120, 150),
          borderRadius: 20,
          background: "linear-gradient(160deg, #FFFFFF, #F3ECE2)",
          boxShadow: "inset 0 -3px 0 rgba(0,0,0,0.04), inset 0 2px 0 rgba(255,255,255,0.8)",
        }}
      />
      {/* Its thickness: a right side and a top, folded back 18px. These are what make it an
          object rather than a card when it turns. */}
      <div
        style={{
          ...at(147, 38, 18, 130, "translateZ(-9px) rotateY(90deg)"),
          background: "linear-gradient(180deg, #E9E0D3, #DCD1C1)",
        }}
      />
      <div
        style={{
          ...at(46, 19, 100, 18, "translateZ(-9px) rotateX(90deg)"),
          background: "#F1EADF",
        }}
      />
      {/* Warm light through the open door */}
      <div
        style={{
          ...at(66, 66, 60, 102, "translateZ(0.5px)"),
          borderRadius: "30px 30px 6px 6px",
          background: "radial-gradient(circle at 50% 62%, #FFE2C4, #FFA087 58%, #E8603F)",
        }}
      />
      {/* Doormat, lying flat in front of the step */}
      <div
        style={{
          ...at(60, 168, 72, 26, "rotateX(78deg)"),
          transformOrigin: "50% 0%",
          borderRadius: 6,
          background: "linear-gradient(90deg, #FF7A59, #FF9474)",
          opacity: 0.9,
        }}
      />
    </>
  );
}

function Door() {
  const { running } = useStageMotion();
  return (
    <motion.div
      style={{
        ...at(66, 66, 60, 102),
        transformOrigin: "0% 50%",
        borderRadius: "30px 30px 6px 6px",
        background: "linear-gradient(135deg, #23908F, #1B7A7A 45%, #0F5C5C)",
        boxShadow: "inset 0 0 0 4px rgba(255,255,255,0.10)",
      }}
      initial={false}
      // Hinged on the left. Resting ajar, so the static pose already tells the story; the
      // idle loop only opens it a little further and back, once per cycle.
      animate={running ? { rotateY: [-16, -38, -16] } : { rotateY: -16 }}
      transition={
        running
          ? { duration: IDLE_SECONDS, ease: "easeInOut", repeat: Infinity }
          : { duration: 0.8, ease: "easeOut" }
      }
    >
      <div
        style={{
          ...at(10, 22, 40, 30),
          borderRadius: "16px 16px 4px 4px",
          border: "2px solid rgba(255,255,255,0.18)",
        }}
      />
      <div
        style={{
          ...at(10, 60, 40, 30),
          borderRadius: 4,
          border: "2px solid rgba(255,255,255,0.18)",
        }}
      />
      <div
        style={{
          ...at(46, 54, 8, 8, "translateZ(2px)"),
          borderRadius: "50%",
          background: "#FFA087",
        }}
      />
    </motion.div>
  );
}

function CodeTag() {
  const { running } = useStageMotion();
  return (
    // The depth sits on a plain wrapper, not on the motion.div: framer-motion writes its own
    // `transform` from the values it animates and drops any transform string in `style`, so a
    // translateZ there is silently lost and the tag lands flat on the wall's plane, where it
    // z-fights the wall front as the stage sways.
    <div style={at(120, 40, 70, 42, "translateZ(38px)")}>
      <CodeTagFace running={running} />
    </div>
  );
}

function CodeTagFace({ running }: { running: boolean }) {
  return (
    <motion.div
      style={{
        position: "absolute",
        inset: 0,
        transformStyle: "preserve-3d",
        borderRadius: 14,
        background: "#FFFFFF",
        boxShadow: "0 10px 20px -6px rgba(15,92,92,0.35), 0 2px 4px rgba(15,92,92,0.12)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
      }}
      initial={false}
      animate={running ? { y: [0, -6, 0, -6, 0] } : { y: 0 }}
      transition={
        running
          ? { duration: IDLE_SECONDS, ease: "easeInOut", repeat: Infinity, delay: 1.2 }
          : { duration: 0.8, ease: "easeOut" }
      }
    >
      <KeyRound size={16} color="#0F5C5C" strokeWidth={2.5} />
      <span style={{ display: "flex", gap: 4 }}>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            style={{ width: 6, height: 6, borderRadius: "50%", background: "#FF7A59" }}
          />
        ))}
      </span>
    </motion.div>
  );
}
