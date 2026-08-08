import { AnimatePresence, motion } from "framer-motion";
import type { TaskState } from "@needy/shared";
import { useReducedMotionPref } from "../motion/preferences.js";
import { useTaskExperience } from "../realtime/index.js";
import { CancelRequestControl } from "./CancelRequestControl.js";
import { ConnectionBanner } from "./ConnectionBanner.js";
import { SearchingStage } from "./SearchingStage.js";
import { MatchedStage } from "./MatchedStage.js";
import { VerifyingStage } from "./VerifyingStage.js";
import { EnRouteStage } from "./EnRouteStage.js";
import { ArrivedStage } from "./ArrivedStage.js";
import { InTaskStage } from "./InTaskStage.js";
import { CompletedStage } from "./CompletedStage.js";

/**
 * The orchestrator. It switches purely on the server-authoritative `task.state` (§3) — the
 * single field that decides which stage's animation is on screen — so the whole task lifecycle
 * is driven by real events, not client guesswork. Stages cross-fade so transitions feel like
 * one continuous, calm progression rather than page swaps.
 */
export function TaskExperience() {
  const { task, connection } = useTaskExperience();
  const state = task?.state;
  // The stage cross-fade used to animate unconditionally: only the `motion/` primitive library
  // consulted this preference, while the raw `motion.*` usages written inline across the app
  // ignored it. A user who has asked their OS for less motion still got a fade on every one of
  // the seven stage changes.
  const reduced = useReducedMotionPref();

  return (
    <main
      // A real landmark and heading: this route previously rendered a bare <div> with no <h1>,
      // so a screen-reader user landing here had nothing to orient by and no way to skip to it.
      aria-labelledby="task-experience-heading"
      style={{ maxWidth: 420, margin: "0 auto", padding: "16px 16px 40px" }}
    >
      <h1 id="task-experience-heading" style={SR_ONLY}>
        Your request for help
      </h1>
      <ConnectionBanner connection={connection} />
      <AnimatePresence mode="wait">
        <motion.div
          key={state ?? "idle"}
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.35 }}
        >
          {renderStage(state)}
        </motion.div>
      </AnimatePresence>
      <CancelRequestControl />
    </main>
  );
}

/** Visually hidden, still announced. Used for the heading that gives this route its landmark
 *  name without adding a title above an experience whose whole design is one calm focal point. */
const SR_ONLY: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

function renderStage(state: TaskState | undefined) {
  switch (state) {
    case "searching":
      return <SearchingStage />;
    case "matched":
      return <MatchedStage />;
    case "verifying":
      return <VerifyingStage />;
    case "en-route":
      return <EnRouteStage />;
    case "arrived":
      return <ArrivedStage />;
    case "in-progress":
      return <InTaskStage />;
    case "completed":
      return <CompletedStage />;
    case "cancelled":
      return <CancelledStage />;
    default:
      return <Centered>Ready when you are.</Centered>;
  }
}

/**
 * The close for a withdrawn request.
 *
 * Deliberately carries no "ask for help again" button yet. There is no task-creation screen to
 * send anyone to — the only thing that has ever created a task is the demo harness, which
 * hardcodes one. A button routing nowhere would be a third instance of the exact defect this
 * pass is closing, so the honest version says what happened and stops there until the creation
 * flow exists.
 */
function CancelledStage() {
  return (
    <div
      role="status"
      style={{
        display: "grid",
        placeItems: "center",
        gap: 8,
        minHeight: 240,
        textAlign: "center",
        padding: "0 12px",
      }}
    >
      <div style={{ fontSize: 19, fontWeight: 800 }}>This request was cancelled</div>
      <p style={{ margin: 0, fontSize: 16, lineHeight: 1.55, color: "var(--needy-text-soft)", maxWidth: 300 }}>
        Nobody is on their way, and you haven't been charged. If you still need a hand, you can
        ask again whenever you're ready.
      </p>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: 240, color: "var(--needy-text-soft)" }}>
      {children}
    </div>
  );
}
