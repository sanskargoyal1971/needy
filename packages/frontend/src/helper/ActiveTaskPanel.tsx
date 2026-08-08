import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  advanceableNextStates,
  canActorTransition,
  isTerminal,
  type ChatMessage,
  type TaskState,
} from "@needy/shared";
import { TypingDots, spring } from "../motion/index.js";
import { useHelperDriver, useHelperExperience } from "../realtime/index.js";
import { SosLiveBanner as SharedSosLiveBanner } from "../safety/SosControl.js";
import { useHelperSosPort } from "../safety/usePorts.js";
import { HelperSosButton } from "./HelperSosButton.js";
import { formatDistance, formatOwnEta } from "./format.js";

/**
 * ── The helper's live task ─────────────────────────────────────────────────
 *
 * Everything the helper does after winning an offer happens here: driving the lifecycle
 * forward, talking to the requester, seeing their own ETA, and pulling the alarm.
 *
 * This is the screen the audit's most invisible bugs lived behind, because nothing could reach
 * it. A6's `getTaskLocation(helperId)` — reading a location keyed by the wrong id, so the ETA
 * was always null — only shows up when a real helper emits `location` from a real device on a
 * real task. B13's `ME = "me"` only shows up when two DIFFERENT ids are in one chat. Both
 * needed a helper client to exist before they could be seen at all.
 */
export function ActiveTaskPanel() {
  const { task, eta, sos } = useHelperExperience();
  if (!task) return null;

  const finished = isTerminal(task.state);

  return (
    <section style={{ display: "grid", gap: 14 }}>
      <TaskHeader />

      {/* The alarm banner outranks everything else on the screen when it is live. */}
      <AnimatePresence>{sos && <SosLiveBanner />}</AnimatePresence>

      {finished ? (
        <FinishedNotice />
      ) : (
        <>
          {eta && (
            <p
              role="status"
              style={{
                margin: 0,
                textAlign: "center",
                fontSize: 15,
                fontWeight: 700,
                color: "var(--needy-text-soft)",
              }}
            >
              {/* The SAME number the requester is looking at, computed by the server from our
                  reported position. Showing it here is not decoration: when the two parties talk
                  about "five minutes" in chat they need to mean the same five minutes. */}
              {formatOwnEta(eta.etaSeconds)} · {formatDistance(eta.distanceMeters)} to go
            </p>
          )}
          <AdvanceControls />
          <ChatPane />
          <FooterActions />
        </>
      )}
    </section>
  );
}

/** What the helper agreed to do, kept on screen throughout. A helper who accepted an errand
 *  four minutes ago while walking should not have to remember what it was. */
function TaskHeader() {
  const { task } = useHelperExperience();
  if (!task) return null;
  return (
    <header
      style={{
        background: "var(--needy-surface)",
        border: "1px solid var(--needy-border)",
        borderRadius: 18,
        padding: 16,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 800,
          letterSpacing: 0.3,
          textTransform: "uppercase",
          color: "var(--needy-text-soft)",
        }}
      >
        {STAGE_LABEL[task.state]}
      </div>
      <h2 style={{ margin: "6px 0 0", fontSize: 18, fontWeight: 800, lineHeight: 1.3 }}>
        {task.title}
      </h2>
    </header>
  );
}

/** Where we are, in the helper's own terms. The state names are engineering vocabulary
 *  ("in-progress", "verifying"); nobody standing at a front door thinks in those. */
const STAGE_LABEL: Record<TaskState, string> = {
  searching: "Finding a helper",
  matched: "You've accepted this",
  verifying: "Checking each other's ID",
  "en-route": "You're on your way",
  arrived: "You've arrived",
  "in-progress": "Helping now",
  completed: "Finished",
  cancelled: "Cancelled",
};

/**
 * ── Lifecycle controls, gated by the shared actor matrix (audit B12) ────────
 *
 * Two independent filters, both from `@needy/shared`, so the button that exists and the edge
 * the server permits are literally the same rule rather than two that drift:
 *
 *   1. `advanceableNextStates(from)` — is this edge legal in the state machine at all?
 *   2. `canActorTransition("helper", to)` — may a HELPER be the one to take it?
 *
 * The second is what the audit added. It removes `completed` from this list entirely, and that
 * omission is deliberate and load-bearing: only the requester closes a task. A helper who could
 * mark their own work complete could end the tracked, chattable, SOS-capable window on their
 * own say-so, which is the one edge where the vulnerable party has to hold the switch.
 *
 * `cancelled` is legal for a helper but pulled out of the main row — see {@link FooterActions}.
 */
function AdvanceControls() {
  const { task } = useHelperExperience();
  const driver = useHelperDriver();
  if (!task) return null;

  const next = advanceableNextStates(task.state)
    .filter((to) => canActorTransition("helper", to))
    .filter((to) => to !== "cancelled");

  if (next.length === 0) {
    return (
      <p
        style={{
          margin: 0,
          textAlign: "center",
          fontSize: 13.5,
          lineHeight: 1.5,
          color: "var(--needy-text-soft)",
        }}
      >
        {/* The `in-progress` case, and it needs saying. The helper has finished the work and
            there is no "done" button for them — by design (see above). Without this line the
            screen looks broken at exactly the moment they want to leave. */}
        {task.state === "in-progress"
          ? "When you're finished, ask them to tap “All done” on their phone — only they can close the request."
          : "Nothing to do here just now."}
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {next.map((to) => (
        <motion.button
          key={to}
          onClick={() => driver.advanceTo(to)}
          whileTap={{ scale: 0.97 }}
          transition={spring.greet}
          style={{
            // 56px: pressed one-handed, outdoors, often while carrying something.
            minHeight: 56,
            border: "none",
            borderRadius: 16,
            background: "var(--needy-warm)",
            color: "#fff",
            fontSize: 16.5,
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          {ADVANCE_COPY[to]}
        </motion.button>
      ))}
    </div>
  );
}

/** First person, present tense, phrased as the thing the helper is about to do — not the state
 *  name they are setting. `completed` is here for exhaustiveness only; the matrix never offers
 *  it to a helper. */
const ADVANCE_COPY: Record<TaskState, string> = {
  searching: "Search",
  matched: "Accept",
  verifying: "Start the ID check",
  "en-route": "I've set off",
  arrived: "I'm here",
  "in-progress": "Start helping",
  completed: "All done",
  cancelled: "Cancel",
};

/**
 * Chat with the requester.
 *
 * `userId` comes from the driver, never from a constant (audit B13). On the helper side that bug
 * would have been even more confusing than on the requester's: with a hardcoded "me" every
 * message the REQUESTER sent would have rendered as the helper's own, so the helper would read
 * their own words as a reply.
 */
function ChatPane() {
  const { messages, otherTyping, userId } = useHelperExperience();
  const driver = useHelperDriver();
  const [draft, setDraft] = useState("");
  const typingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mark inbound messages read once they're on screen. Filtered on `senderId !== userId` so we
  // never mark our own — which is what the `ME = "me"` bug caused.
  useEffect(() => {
    const unread = messages
      .filter((m) => m.senderId !== userId && m.status !== "read")
      .map((m) => m.id);
    if (unread.length) driver.markRead(unread);
  }, [messages, driver, userId]);

  // The typing debounce timer must not outlive the pane, or it fires `setTyping(false)` into a
  // disposed driver after the task ends.
  useEffect(
    () => () => {
      if (typingRef.current) clearTimeout(typingRef.current);
    },
    [],
  );

  const send = () => {
    if (!draft.trim()) return;
    driver.sendMessage(draft);
    setDraft("");
    driver.setTyping(false);
    if (typingRef.current) clearTimeout(typingRef.current);
  };

  const onDraft = (v: string) => {
    setDraft(v);
    driver.setTyping(true);
    if (typingRef.current) clearTimeout(typingRef.current);
    typingRef.current = setTimeout(() => driver.setTyping(false), 900);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: 300,
        gap: 10,
        background: "var(--needy-surface)",
        border: "1px solid var(--needy-border)",
        borderRadius: 18,
        padding: 12,
      }}
    >
      <MessageList messages={messages} otherTyping={otherTyping} myUserId={userId} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Message them…"
          aria-label="Message the person you're helping"
          style={{
            flex: 1,
            padding: "12px 16px",
            borderRadius: 999,
            border: "1px solid var(--needy-border)",
            background: "var(--needy-surface-2)",
            color: "var(--needy-text)",
            fontSize: 15,
          }}
        />
        <button
          onClick={send}
          style={{
            border: "none",
            background: "var(--needy-warm)",
            color: "#fff",
            borderRadius: 999,
            padding: "12px 18px",
            fontSize: 15,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function MessageList({
  messages,
  otherTyping,
  myUserId,
}: {
  messages: ChatMessage[];
  otherTyping: boolean;
  /** Passed in rather than re-read from the store so there is exactly one source of "who am I"
   *  in this subtree (audit B13). */
  myUserId: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, otherTyping]);

  if (messages.length === 0 && !otherTyping) {
    return (
      <div
        style={{
          flex: 1,
          display: "grid",
          placeItems: "center",
          textAlign: "center",
          fontSize: 13.5,
          lineHeight: 1.5,
          color: "var(--needy-text-soft)",
          padding: "0 16px",
        }}
      >
        Say hello — a short message before you arrive puts people at ease.
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 2,
      }}
    >
      {messages.map((m) => {
        const mine = m.senderId === myUserId;
        return (
          <div
            key={m.id}
            data-testid={mine ? "msg-mine" : "msg-theirs"}
            style={{
              alignSelf: mine ? "flex-end" : "flex-start",
              maxWidth: "78%",
              display: "flex",
              flexDirection: "column",
              alignItems: mine ? "flex-end" : "flex-start",
              gap: 2,
            }}
          >
            <div
              style={{
                background: mine ? "var(--needy-warm)" : "var(--needy-surface-2)",
                color: mine ? "#fff" : "var(--needy-text)",
                border: mine ? "none" : "1px solid var(--needy-border)",
                borderRadius: 16,
                padding: "9px 14px",
                fontSize: 14.5,
                lineHeight: 1.4,
              }}
            >
              {m.body}
            </div>
            {mine && (
              <span style={{ fontSize: 10, color: "var(--needy-text-soft)" }}>{m.status}</span>
            )}
          </div>
        );
      })}

      {otherTyping && (
        <div
          style={{
            alignSelf: "flex-start",
            background: "var(--needy-surface-2)",
            border: "1px solid var(--needy-border)",
            borderRadius: 16,
            padding: "10px 14px",
          }}
          aria-label="They are typing"
        >
          <TypingDots color="warm" />
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

/** The alarm, and the way out. Both are consequential, so both sit at the bottom away from the
 *  buttons the helper taps every few minutes — nobody should reach SOS or cancel by accident
 *  while aiming for "I'm here". */
function FooterActions() {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        justifyContent: "space-between",
        paddingTop: 4,
      }}
    >
      <CancelAction />
      <HelperSosButton />
    </div>
  );
}

/**
 * Withdrawing. The actor matrix permits either party to cancel at any point, which is right —
 * a helper who is unwell or has misjudged the distance must be able to withdraw rather than
 * simply not turn up, since the requester is otherwise left waiting on someone who is not
 * coming.
 *
 * Two taps, not one, and never in the primary row: it is destructive and irreversible for the
 * person waiting.
 */
function CancelAction() {
  const driver = useHelperDriver();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        style={{
          border: "none",
          background: "transparent",
          color: "var(--needy-text-soft)",
          fontSize: 13.5,
          fontWeight: 600,
          textDecoration: "underline",
          cursor: "pointer",
          padding: "10px 2px",
        }}
      >
        I can't do this after all
      </button>
    );
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontSize: 13, color: "var(--needy-text-soft)" }}>
        They'll be told straight away.
      </span>
      <button
        onClick={() => driver.advanceTo("cancelled")}
        style={{
          border: "1px solid var(--needy-border)",
          background: "var(--needy-surface)",
          color: "var(--needy-text)",
          borderRadius: 12,
          padding: "10px 14px",
          fontSize: 13.5,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Withdraw
      </button>
      <button
        onClick={() => setConfirming(false)}
        style={{
          border: "none",
          background: "transparent",
          color: "var(--needy-text-soft)",
          fontSize: 13.5,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Keep going
      </button>
    </div>
  );
}

/**
 * A live alarm on this task, whoever raised it.
 *
 * If the REQUESTER raised it, the helper is very often the person who can act first — they are
 * the one in the room. So this is not an operator-only concern, and it is not decoration: it
 * shows the alarm is real and recorded, and gives the raiser the only honest way to stand it
 * down. It uses alarm red, which is reserved for exactly this.
 */
function SosLiveBanner() {
  // Delegates to the shared banner for the same reason `HelperSosButton` does: the requester
  // side had no banner at all, and duplicating this one to give them it would have been a second
  // divergent copy of a safety surface. See `safety/sosPort.ts`.
  const port = useHelperSosPort();
  return <SharedSosLiveBanner port={port} />;
}

/** The close. A completed task gets thanks; a cancelled one gets a plain statement and no
 *  blame, because the helper may well not be the one who cancelled it. Dismissal is the
 *  helper's own tap rather than a timer, so a slow reader isn't cut off mid-sentence. */
function FinishedNotice() {
  const { task } = useHelperExperience();
  const driver = useHelperDriver();
  if (!task) return null;
  const completed = task.state === "completed";

  return (
    <div style={{ display: "grid", gap: 12, placeItems: "center", textAlign: "center", padding: "18px 8px" }}>
      <div style={{ fontSize: 19, fontWeight: 800 }}>
        {completed ? "Thank you — that really helped" : "This request has ended"}
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 14,
          lineHeight: 1.55,
          color: "var(--needy-text-soft)",
          maxWidth: 300,
        }}
      >
        {completed
          ? "They've confirmed you finished. Someone's day went better because you turned up."
          : "It was cancelled, so there's nothing more to do. That happens — it isn't a mark against you."}
      </p>
      <button
        onClick={() => driver.dismissFinishedTask()}
        style={{
          minHeight: 52,
          border: "none",
          borderRadius: 16,
          background: "var(--needy-warm)",
          color: "#fff",
          fontSize: 16,
          fontWeight: 800,
          padding: "0 26px",
          cursor: "pointer",
        }}
      >
        Back to requests
      </button>
    </div>
  );
}
