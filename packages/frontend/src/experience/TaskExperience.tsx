import { AnimatePresence, motion } from "framer-motion";
import type { TaskState } from "@needy/shared";
import { useTaskExperience } from "../realtime/index.js";
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

  return (
    <div style={{ maxWidth: 420, margin: "0 auto", padding: "16px 16px 40px" }}>
      <ConnectionBanner connection={connection} />
      <AnimatePresence mode="wait">
        <motion.div
          key={state ?? "idle"}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35 }}
        >
          {renderStage(state)}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

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
      return <Centered>This request was cancelled.</Centered>;
    default:
      return <Centered>Ready when you are.</Centered>;
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: 240, color: "var(--needy-text-soft)" }}>
      {children}
    </div>
  );
}
