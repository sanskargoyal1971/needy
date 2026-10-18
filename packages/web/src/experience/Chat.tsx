"use client";

import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import type { ChatMessage } from "@needy/shared";
import { TypingDots } from "@/motion";

/** ── In-task chat ──────────────────────────────────────────────────────────
 *  Deliberately plain. Two people who are about to meet, or have just met, need to say short
 *  practical things to each other — "I'm at the gate", "the lift is out" — and anything more
 *  elaborate than a list of messages and a box is in the way.
 *
 *  `userId` comes from the driver's state, never from a component's assumption. The audit
 *  found a `const ME = "me"` here that was only true for the scripted mock: against a live
 *  backend every message the user sent rendered as if the other party had sent it, receipts
 *  never appeared, and the mark-read effect marked the user's own messages as read.
 */
export function Chat({
  messages,
  userId,
  otherTyping,
  otherName,
  onSend,
  onTyping,
  onRead,
}: {
  messages: ChatMessage[];
  userId: string;
  otherTyping: boolean;
  otherName: string;
  onSend: (body: string) => void;
  onTyping: (isTyping: boolean) => void;
  onRead: (ids: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const typingRef = useRef(false);

  // Mark the other party's unread messages as read whenever the list changes. Filtered to
  // THEIRS: marking your own messages read is meaningless and was a real bug.
  useEffect(() => {
    const unread = messages
      .filter((m) => m.senderId !== userId && m.status !== "read")
      .map((m) => m.id);
    if (unread.length > 0) onRead(unread);
  }, [messages, userId, onRead]);

  // Scroll the message LIST to its end, never the page. `scrollIntoView` scrolled every
  // scrollable ancestor too, so opening a task with any history yanked the whole screen down
  // to the chat — past the map and the stage card, which are what someone opened it to see.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length, otherTyping]);

  // Stop advertising "typing" when the component goes away mid-compose, otherwise the other
  // party is left watching dots from someone who has closed the screen.
  useEffect(() => {
    return () => {
      if (typingRef.current) onTyping(false);
    };
  }, [onTyping]);

  function change(value: string) {
    setDraft(value);
    const isTyping = value.length > 0;
    if (isTyping !== typingRef.current) {
      typingRef.current = isTyping;
      onTyping(isTyping);
    }
  }

  function send() {
    const body = draft.trim();
    if (!body) return;
    onSend(body);
    setDraft("");
    typingRef.current = false;
    onTyping(false);
  }

  return (
    <div className="flex flex-col rounded-2xl border border-gray-200 bg-white">
      <div ref={listRef} className="max-h-72 min-h-32 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="py-6 text-center text-sm text-gray-500">
            Say hello, or tell {otherName} anything they need to know.
          </p>
        )}
        {messages.map((m) => {
          const mine = m.senderId === userId;
          return (
            <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm ${
                  mine ? "bg-primary text-white" : "bg-gray-100 text-gray-900"
                }`}
              >
                {m.body}
                {mine && (
                  // Receipts only on your own messages — a receipt on someone else's is
                  // meaningless, and showing one is how the sender/receiver mix-up above
                  // stayed invisible for as long as it did.
                  <span className="ml-2 text-[10px] uppercase opacity-70">{m.status}</span>
                )}
              </div>
            </div>
          );
        })}
        {otherTyping && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <TypingDots />
            <span>{otherName} is typing</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-gray-100 p-3">
        <input
          value={draft}
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          maxLength={2000}
          placeholder={`Message ${otherName}`}
          aria-label={`Message ${otherName}`}
          className="flex-1 rounded-xl border-0 px-3 py-2.5 text-sm text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-primary"
        />
        <button
          type="button"
          onClick={send}
          disabled={!draft.trim()}
          aria-label="Send"
          className="rounded-xl bg-primary p-2.5 text-white transition-colors hover:bg-primary-dark disabled:bg-gray-300"
        >
          <Send size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
}
