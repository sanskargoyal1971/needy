import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ChatMessage } from "@needy/shared";
import { BreathingPulse, TypingDots, spring } from "../motion/index.js";
import { useDriver, useTaskExperience } from "../realtime/index.js";

const ME = "me";

/**
 * Stage 6 — In-task (§3). Live chat with the same breathing TypingDots as the rest of the
 * app, delivery/read receipts, and the SOS control. SOS idles as a soft glow-pulse; on press
 * it escalates into a deliberate, unmistakable state (scale + red radiate + shake) kept
 * visually distinct from every other motion, since ambiguity here has real consequences.
 */
export function InTaskStage() {
  const { messages, otherTyping, helper } = useTaskExperience();
  const driver = useDriver();
  const [draft, setDraft] = useState("");
  const typingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mark unread inbound messages as read once they're on screen.
  useEffect(() => {
    const unread = messages
      .filter((m) => m.senderId !== ME && m.status !== "read")
      .map((m) => m.id);
    if (unread.length) driver.markRead(unread);
  }, [messages, driver]);

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
      <MessageList messages={messages} otherTyping={otherTyping} helperName={helper?.displayName} />

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
        <SosButton />
      </div>
    </div>
  );
}

function MessageList({
  messages,
  otherTyping,
  helperName,
}: {
  messages: ChatMessage[];
  otherTyping: boolean;
  helperName?: string;
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
        const mine = m.senderId === ME;
        return (
          <div
            key={m.id}
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

function SosButton() {
  const [armed, setArmed] = useState(false);

  if (armed) {
    return (
      <div style={{ position: "relative", width: 52, height: 52 }}>
        <AnimatePresence>
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                border: "2px solid var(--needy-alarm)",
              }}
              initial={{ scale: 0.7, opacity: 0.6 }}
              animate={{ scale: 2, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.4, ease: "easeOut", repeat: Infinity, delay: i * 0.45 }}
            />
          ))}
        </AnimatePresence>
        <motion.button
          onClick={() => setArmed(false)}
          animate={{ scale: [1, 1.08, 1], x: [0, -2, 2, -2, 2, 0] }}
          transition={{
            scale: { repeat: Infinity, duration: 0.9 },
            x: { repeat: Infinity, duration: 0.5 },
          }}
          style={sosStyle(true)}
          aria-label="Cancel SOS"
        >
          Cancel
        </motion.button>
      </div>
    );
  }

  return (
    <BreathingPulse size={64} color="alarm" intensity="subtle">
      <motion.button
        onClick={() => setArmed(true)}
        whileTap={{ scale: 0.92 }}
        transition={spring.alarm}
        style={sosStyle(false)}
        aria-label="Send SOS"
      >
        SOS
      </motion.button>
    </BreathingPulse>
  );
}

function sosStyle(armed: boolean) {
  return {
    width: 52,
    height: 52,
    borderRadius: "50%",
    border: "none",
    background: "var(--needy-alarm)",
    color: "#fff",
    fontWeight: 800,
    fontSize: armed ? 12 : 13,
    cursor: "pointer",
    boxShadow: armed ? "0 0 22px var(--needy-alarm)" : "0 3px 10px rgba(0,0,0,.15)",
  } as const;
}
