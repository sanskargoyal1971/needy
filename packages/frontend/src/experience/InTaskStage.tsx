import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import type { ChatMessage } from "@needy/shared";
import { TypingDots } from "../motion/index.js";
import { useDriver, useTaskExperience } from "../realtime/index.js";
import { SosControl, SosLiveBanner } from "../safety/SosControl.js";
import { useRequesterSosPort } from "../safety/usePorts.js";

/**
 * Stage 6 — In-task (§3). Live chat with the same breathing TypingDots as the rest of the
 * app, delivery/read receipts, and the SOS control. SOS idles as a soft glow-pulse; on press
 * it escalates into a deliberate, unmistakable state (scale + red radiate + shake) kept
 * visually distinct from every other motion, since ambiguity here has real consequences.
 */
export function InTaskStage() {
  // `userId` comes from the driver, which is the only thing that actually knows who we are.
  // This used to be a module-level `const ME = "me"` (audit B13): true only for the scripted
  // mock, so against the live backend — where ids look like `req-a1b2c3` — every message the
  // user sent rendered left-aligned as the helper's, receipts never showed, and the markRead
  // effect below marked the user's OWN messages as read.
  const { messages, otherTyping, helper, userId } = useTaskExperience();
  const driver = useDriver();
  const sosPort = useRequesterSosPort();
  const [draft, setDraft] = useState("");
  const typingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mark unread INBOUND messages as read once they're on screen.
  useEffect(() => {
    const unread = messages
      .filter((m) => m.senderId !== userId && m.status !== "read")
      .map((m) => m.id);
    if (unread.length) driver.markRead(unread);
  }, [messages, driver, userId]);

  const send = () => {
    if (!draft.trim()) return;
    driver.sendMessage(draft);
    setDraft("");
    driver.setTyping(false);
  };

  const onDraft = (v: string) => {
    setDraft(v);
    driver.setTyping(true); // debounced relay to the helper (§2.5)
    if (typingRef.current) clearTimeout(typingRef.current);
    typingRef.current = setTimeout(() => driver.setTyping(false), 900);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: 460, gap: 12 }}>
      {/* A live alarm outranks the conversation, so it sits above it and is announced. */}
      <AnimatePresence>{sosPort.sos && <SosLiveBanner port={sosPort} />}</AnimatePresence>

      <MessageList
        messages={messages}
        otherTyping={otherTyping}
        helperName={helper?.displayName}
        myUserId={userId}
      />

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <input
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={`Message ${helper?.displayName ?? "your helper"}…`}
          style={{
            flex: 1,
            padding: "12px 16px",
            borderRadius: 999,
            border: "1px solid var(--needy-border)",
            background: "var(--needy-surface)",
            color: "var(--needy-text)",
            fontSize: 14,
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
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Send
        </button>
        <SosControl port={sosPort} />
      </div>
    </div>
  );
}

function MessageList({
  messages,
  otherTyping,
  helperName,
  myUserId,
}: {
  messages: ChatMessage[];
  otherTyping: boolean;
  helperName?: string;
  /** Passed in rather than re-derived here so there is exactly one source of "who am I". */
  myUserId: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, otherTyping]);

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 4,
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
                background: mine ? "var(--needy-warm)" : "var(--needy-surface)",
                color: mine ? "#fff" : "var(--needy-text)",
                border: mine ? "none" : "1px solid var(--needy-border)",
                borderRadius: 16,
                padding: "9px 14px",
                fontSize: 14,
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
            background: "var(--needy-surface)",
            border: "1px solid var(--needy-border)",
            borderRadius: 16,
            padding: "10px 14px",
          }}
          aria-label={`${helperName ?? "Helper"} is typing`}
        >
          <TypingDots color="warm" />
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

/* The local `SosButton` that used to live here has been deleted, not refactored.
 *
 * It was a `useState` flag driving an infinite red pulse-and-shake, with no `raiseSos` behind it
 * — `NeedyDriver` had no such method to call. Pressing it told the user help was coming while
 * emitting nothing to any server, and a reload erased the "alarm" entirely. It also ignored
 * `useReducedMotionPref`, making it the app's most physically risky animation as well as its
 * most dishonest one.
 *
 * It is replaced by the shared `<SosControl>` above, which both roles now use: it raises a
 * durable alert over the `/sos` namespace, waits for the server's ack before claiming anything,
 * and says so plainly when the alarm did not go through. See `safety/sosPort.ts` for why there
 * is exactly one implementation rather than one per role. */
