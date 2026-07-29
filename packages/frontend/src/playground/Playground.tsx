import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrivalHighlight,
  BreathingPulse,
  InterpolatedMarker,
  RadarSweep,
  SoftScaleReveal,
  TypingDots,
  spring,
  type RadarBlip,
} from "../motion/index.js";
import { useMotionPreferences } from "../motion/preferences.js";
import { Button, Slider, Stage, Toggle } from "./ui.js";

/**
 * The isolated review surface for the motion vocabulary (§5.2). Each primitive gets its own
 * card with live controls so pacing/intensity can be tuned before any of it is wired to real
 * socket data in Phase 3. The reduced-motion toggle in the toolbar previews every fallback.
 */
export function Playground() {
  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "28px 20px 80px" }}>
      <Toolbar />
      <div
        style={{
          display: "grid",
          gap: 20,
          gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
        }}
      >
        <BreathingDemo />
        <RadarDemo />
        <RevealDemo />
        <MarkerDemo />
        <TypingDemo />
        <ArrivalDemo />
        <SosDemo />
      </div>
    </div>
  );
}

function Toolbar() {
  const { override, setOverride } = useMotionPreferences();
  const [dark, setDark] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  return (
    <header style={{ marginBottom: 24, display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22 }}>Needy · Motion Vocabulary</h1>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--needy-text-soft)" }}>
          Every animation is evidence of a real, present human — tuned here in isolation before wiring to live data.
        </p>
      </div>
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11, color: "var(--needy-text-soft)" }}>Motion</span>
          <div style={{ display: "inline-flex", border: "1px solid var(--needy-border)", borderRadius: 10, overflow: "hidden" }}>
            {(["system", "allow", "reduce"] as const).map((o) => (
              <button
                key={o}
                onClick={() => setOverride(o)}
                style={{
                  border: "none",
                  padding: "6px 12px",
                  fontSize: 12,
                  cursor: "pointer",
                  background: override === o ? "var(--needy-warm)" : "transparent",
                  color: override === o ? "#fff" : "var(--needy-text)",
                }}
              >
                {o === "reduce" ? "reduced" : o}
              </button>
            ))}
          </div>
        </div>
        <Toggle label="Dark" checked={dark} onChange={setDark} />
      </div>
    </header>
  );
}

// ── Stage 1 — Searching ──────────────────────────────────────────────────────
function RadarDemo() {
  const [blips, setBlips] = useState<RadarBlip[]>([]);
  const [rings, setRings] = useState(3);
  const timers = useRef<number[]>([]);

  const search = () => {
    setBlips([]);
    timers.current.forEach(clearTimeout);
    // Helpers "surface" one by one, as if being found in the neighborhood.
    const found: RadarBlip[] = Array.from({ length: 3 }, (_, i) => ({
      id: `h${i}-${Math.random().toString(36).slice(2)}`,
      x: Math.cos((i / 3) * Math.PI * 2 + 0.6) * (0.5 + i * 0.15),
      y: Math.sin((i / 3) * Math.PI * 2 + 0.6) * (0.5 + i * 0.15),
    }));
    timers.current = found.map((b, i) =>
      window.setTimeout(() => setBlips((prev) => [...prev, b]), 700 + i * 900),
    );
  };

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return (
    <Stage
      title="RadarSweep"
      spec="Stage 1"
      blurb="Reaching into the neighborhood — not a spinner. Real helpers fade in as they're found."
      controls={
        <>
          <Button tone="warm" onClick={search}>Search for a helper</Button>
          <Slider label="rings" value={rings} min={2} max={5} onChange={setRings} />
          <span style={{ fontSize: 12, color: "var(--needy-text-soft)" }}>
            {blips.length} helper{blips.length === 1 ? "" : "s"} nearby reviewing your request
          </span>
        </>
      }
    >
      <RadarSweep ringCount={rings} blips={blips} />
    </Stage>
  );
}

// ── Base — Breathing ─────────────────────────────────────────────────────────
function BreathingDemo() {
  const [intensity, setIntensity] = useState(0.6);
  return (
    <Stage
      title="BreathingPulse"
      spec="Base §4"
      blurb="The shared 'alive' motion every other component echoes. Shown here behind an SOS button."
      controls={<Slider label="intensity" value={intensity} min={0} max={1} step={0.05} onChange={setIntensity} />}
    >
      <BreathingPulse size={150} color="warm" intensity={intensity}>
        <div
          style={{
            width: 84,
            height: 84,
            borderRadius: "50%",
            background: "var(--needy-warm)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            fontWeight: 700,
            letterSpacing: 1,
          }}
        >
          SOS
        </div>
      </BreathingPulse>
    </Stage>
  );
}

// ── Stage 2 — Match reveal ──────────────────────────────────────────────────
function RevealDemo() {
  const [key, setKey] = useState(0);
  return (
    <Stage
      title="SoftScaleReveal"
      spec="Stage 2"
      blurb="Someone walked up to greet you — a soft scale-in with one breath of overshoot, never a pop-in."
      controls={<Button tone="warm" onClick={() => setKey((k) => k + 1)}>Replay match</Button>}
    >
      <SoftScaleReveal key={key}>
        <HelperCard />
      </SoftScaleReveal>
    </Stage>
  );
}

function HelperCard() {
  return (
    <div
      style={{
        display: "flex",
        gap: 14,
        alignItems: "center",
        background: "var(--needy-surface)",
        border: "1px solid var(--needy-border)",
        borderRadius: 14,
        padding: 16,
        maxWidth: 300,
      }}
    >
      <div style={{ width: 56, height: 56, borderRadius: "50%", background: "var(--needy-warm)", display: "grid", placeItems: "center", color: "#fff", fontWeight: 700, fontSize: 20 }}>
        P
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <strong style={{ fontSize: 16 }}>Priya · ★ 4.9</strong>
        <span style={{ fontSize: 13, color: "var(--needy-text-soft)" }}>
          8 minutes away · has helped 34 people nearby
        </span>
      </div>
    </div>
  );
}

// ── Stage 4 — Live tracking ─────────────────────────────────────────────────
function MarkerDemo() {
  const BOX = { w: 300, h: 200 };
  const [pos, setPos] = useState({ x: 40, y: 160, heading: 0 });
  const [auto, setAuto] = useState(true);

  const step = () =>
    setPos((prev) => {
      const nx = 30 + Math.random() * (BOX.w - 60);
      const ny = 30 + Math.random() * (BOX.h - 60);
      const heading = (Math.atan2(nx - prev.x, -(ny - prev.y)) * 180) / Math.PI;
      return { x: nx, y: ny, heading };
    });

  useEffect(() => {
    if (!auto) return;
    const id = window.setInterval(step, 4000);
    return () => clearInterval(id);
  }, [auto]);

  return (
    <Stage
      title="InterpolatedMarker"
      spec="Stage 4"
      blurb="Glides between GPS points instead of teleporting — the detail that most makes tracking feel alive. A person, not a pin."
      controls={
        <>
          <Button onClick={step}>Send next location</Button>
          <Toggle label="auto (every 4s)" checked={auto} onChange={setAuto} />
        </>
      }
    >
      <div
        style={{
          position: "relative",
          width: BOX.w,
          height: BOX.h,
          borderRadius: 12,
          background:
            "repeating-linear-gradient(0deg, transparent 0 22px, rgba(127,127,127,.08) 22px 23px), repeating-linear-gradient(90deg, transparent 0 22px, rgba(127,127,127,.08) 22px 23px)",
          border: "1px solid var(--needy-border)",
          overflow: "hidden",
        }}
      >
        <InterpolatedMarker x={pos.x} y={pos.y} heading={pos.heading} durationMs={4000} />
      </div>
    </Stage>
  );
}

// ── Stage 6 — Typing ─────────────────────────────────────────────────────────
function TypingDemo() {
  return (
    <Stage
      title="TypingDots"
      spec="Stage 6"
      blurb="'Priya is typing…' on the same breath curve as everything else — a real person, mid-thought."
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 12,
          background: "var(--needy-surface)",
          border: "1px solid var(--needy-border)",
          borderRadius: 999,
          padding: "12px 18px",
        }}
      >
        <span style={{ fontSize: 13, color: "var(--needy-text-soft)" }}>Priya is typing</span>
        <TypingDots color="warm" />
      </div>
    </Stage>
  );
}

// ── Stage 5 — Arrival ────────────────────────────────────────────────────────
function ArrivalDemo() {
  const [arrived, setArrived] = useState(false);
  return (
    <Stage
      title="ArrivalHighlight"
      spec="Stage 5"
      blurb="Calm, unmistakable certainty a real person has arrived — soft bloom, never jarring."
      controls={
        <>
          <Button tone="warm" onClick={() => setArrived(true)}>Priya arrives</Button>
          <Button onClick={() => setArrived(false)}>Reset</Button>
        </>
      }
    >
      <ArrivalHighlight active={arrived} style={{ width: 280 }}>
        <div
          style={{
            padding: 24,
            borderRadius: 16,
            background: "var(--needy-surface)",
            border: "1px solid var(--needy-border)",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700 }}>
            {arrived ? "Priya is here" : "Priya is arriving"}
          </div>
          <div style={{ fontSize: 13, color: "var(--needy-text-soft)", marginTop: 4 }}>
            {arrived ? "at your gate" : "2 min away"}
          </div>
        </div>
      </ArrivalHighlight>
    </Stage>
  );
}

// ── Stage 6 — SOS escalation (composed from the vocabulary) ──────────────────
function SosDemo() {
  const [armed, setArmed] = useState(false);
  return (
    <Stage
      title="SOS · composition"
      spec="Stage 6"
      blurb="Idle = BreathingPulse glow. Pressed = a deliberate, unmistakable escalation kept visually distinct from every other motion in the app."
      controls={
        armed ? (
          <Button onClick={() => setArmed(false)}>Cancel</Button>
        ) : (
          <Button tone="alarm" onClick={() => setArmed(true)}>Press SOS</Button>
        )
      }
    >
      <div style={{ position: "relative", display: "grid", placeItems: "center", width: 180, height: 180 }}>
        <AnimatePresence>
          {armed &&
            [0, 1, 2].map((i) => (
              <motion.div
                key={i}
                style={{
                  position: "absolute",
                  width: 96,
                  height: 96,
                  borderRadius: "50%",
                  border: "2px solid var(--needy-alarm)",
                }}
                initial={{ scale: 0.7, opacity: 0.6 }}
                animate={{ scale: 2.1, opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 1.4, ease: "easeOut", repeat: Infinity, delay: i * 0.45 }}
              />
            ))}
        </AnimatePresence>

        {armed ? (
          <motion.div
            animate={{ scale: [1, 1.08, 1], x: [0, -3, 3, -3, 3, 0] }}
            transition={{ scale: { repeat: Infinity, duration: 0.9 }, x: { repeat: Infinity, duration: 0.5 } }}
            style={sosButtonStyle(true)}
          >
            SOS
          </motion.div>
        ) : (
          <BreathingPulse size={150} color="alarm" intensity="subtle">
            <motion.div whileTap={{ scale: 0.92 }} transition={spring.alarm} style={sosButtonStyle(false)}>
              SOS
            </motion.div>
          </BreathingPulse>
        )}
      </div>
    </Stage>
  );
}

function sosButtonStyle(armed: boolean) {
  return {
    width: 88,
    height: 88,
    borderRadius: "50%",
    background: "var(--needy-alarm)",
    color: "#fff",
    display: "grid",
    placeItems: "center",
    fontWeight: 800,
    letterSpacing: 1,
    boxShadow: armed ? "0 0 30px var(--needy-alarm)" : "0 4px 14px rgba(0,0,0,.15)",
  } as const;
}
