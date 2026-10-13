"use client";

import { useState } from "react";
import { AlertTriangle, Check, Loader2, Phone, ShieldCheck, X } from "lucide-react";
import type { SosAlert, SosKind } from "@needy/shared";
import { SOSGlow } from "@/components/SOSGlow";
import { SUPPORT_PHONE } from "@/lib/apiConfig";

/** ── The alarm ─────────────────────────────────────────────────────────────
 *  The other end of the operator console built in Phase 4. Until this component existed the
 *  console had nothing to answer: the raise path was reachable only over a raw socket, so the
 *  product shipped a screen for staff to handle emergencies and no way for a user to declare
 *  one.
 *
 *  The rule this component exists to obey, and the one the original UI-only button broke: the
 *  interface may claim help has been notified ONLY once the server has acknowledged a durable
 *  alert. Before that it may say it is trying. `raiseSos` resolves `null` on refusal, rate
 *  limit or a dead socket, and that resolves to a VISIBLE FAILURE with a phone number — never
 *  a reassuring animation over a request nobody received. A safety control that only looks
 *  like it worked converts a real emergency into a silent one, which is worse than no button.
 *
 *  Two taps, not one. The first opens the sheet, the second names what is wrong. A single-tap
 *  alarm on a phone in a pocket produces false alarms, and every false alarm spends an
 *  operator's attention that a real one needs — but the second tap is a large, plainly
 *  labelled choice, not a "are you sure?" that punishes hesitation.
 */

const KINDS: { kind: SosKind; label: string; hint: string }[] = [
  { kind: "medical", label: "Medical", hint: "Someone needs a doctor or an ambulance" },
  { kind: "unsafe", label: "I feel unsafe", hint: "Something about this situation is wrong" },
  { kind: "panic", label: "Emergency", hint: "I need help right now" },
  { kind: "other", label: "Something else", hint: "" },
];

type Phase = "idle" | "choosing" | "sending" | "sent" | "failed";

export function SosButton({
  alert,
  userId,
  onRaise,
  onCancel,
}: {
  /** The live alert from the server, or null. Never local state — see the file note. */
  alert: SosAlert | null;
  /**
   * The viewer's own id, so this component can tell "my alarm" from "theirs".
   *
   * Not cosmetic. Without it the screen told the OTHER party "your alarm has been recorded"
   * and offered them "this was a mistake — stand it down" for an alarm they had not raised.
   * The server refuses that cancel (only the raiser may withdraw one, which is right: a helper
   * who is the reason for the alarm must not be able to switch it off), so the button was a
   * control that could only ever fail — on the one screen where a control that does nothing is
   * least acceptable.
   */
  userId: string;
  onRaise: (kind: SosKind) => Promise<SosAlert | null>;
  onCancel: (alertId: string) => Promise<boolean>;
}) {
  const [phase, setPhase] = useState<Phase>("idle");

  // An alert the SERVER knows about outranks any local phase. This also covers the alarm
  // raised by the other party: a helper's alert appears on the requester's screen without
  // this component ever having been touched.
  if (alert && alert.status !== "cancelled") {
    return <AlertLive alert={alert} mine={alert.raisedBy === userId} onCancel={onCancel} />;
  }

  async function raise(kind: SosKind) {
    setPhase("sending");
    const created = await onRaise(kind);
    // `null` is a real, expected outcome and it must not be swallowed.
    setPhase(created ? "sent" : "failed");
  }

  if (phase === "failed") {
    return (
      <div
        role="alert"
        className="rounded-2xl border-2 border-red-300 bg-red-50 p-4 text-sm text-red-900"
      >
        <p className="flex items-center gap-2 font-semibold">
          <X size={16} aria-hidden />
          We could not raise the alarm
        </p>
        {/* The most important sentence in the app. It does not apologise and it does not
            suggest retrying first — it gives the alternative that does not depend on us. */}
        <p className="mt-1">
          Your alarm did not reach us. Please call{" "}
          {SUPPORT_PHONE ? (
            <a href={`tel:${SUPPORT_PHONE}`} className="font-semibold underline">
              {SUPPORT_PHONE}
            </a>
          ) : (
            "emergency services"
          )}{" "}
          now.
        </p>
        <button
          type="button"
          onClick={() => setPhase("choosing")}
          className="mt-3 rounded-xl bg-red-600 px-4 py-2 font-semibold text-white"
        >
          Try again
        </button>
      </div>
    );
  }

  if (phase === "choosing" || phase === "sending") {
    return (
      <div className="rounded-2xl border-2 border-red-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <p className="font-display font-bold text-gray-900">What is happening?</p>
          <button
            type="button"
            onClick={() => setPhase("idle")}
            disabled={phase === "sending"}
            className="rounded-lg p-1 text-gray-400 hover:text-gray-700"
            aria-label="Close"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="space-y-2">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              disabled={phase === "sending"}
              onClick={() => void raise(k.kind)}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-gray-200 px-4 py-3 text-left transition-colors hover:border-red-300 hover:bg-red-50 disabled:opacity-50"
            >
              <span>
                <span className="block font-semibold text-gray-900">{k.label}</span>
                {k.hint && <span className="block text-sm text-gray-600">{k.hint}</span>}
              </span>
              {phase === "sending" && (
                <Loader2 size={16} className="animate-spin text-red-600" aria-hidden />
              )}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-gray-500">
          Both you and the person helping you will see that an alarm was raised.
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <SOSGlow onClick={() => setPhase("choosing")}>
        <AlertTriangle size={22} aria-hidden />
        <span className="sr-only">Raise an alarm</span>
      </SOSGlow>
      <p className="text-sm text-gray-600">
        Something wrong? <span className="font-medium text-gray-900">Press for help.</span>
      </p>
    </div>
  );
}

/** What the raiser sees once the server has the alarm. The claim made here is exactly the one
 *  the server has earned — "recorded", then "an operator is on it" only once `acknowledgedBy`
 *  is actually set by a human taking ownership in the console. */
function AlertLive({
  alert,
  mine,
  onCancel,
}: {
  alert: SosAlert;
  /** Whether the viewer is the one who raised it. Decides both what this claims and what it
   *  offers — see the note on `SosButton`'s `userId`. */
  mine: boolean;
  onCancel: (alertId: string) => Promise<boolean>;
}) {
  const [standing, setStanding] = useState(false);
  const owned = alert.acknowledgedBy != null;

  // The other party's alarm. They are told, because they are in the situation and a silent
  // alarm beside them would be worse — but it is not theirs to describe or to withdraw.
  if (!mine) {
    return (
      <div role="status" className="rounded-2xl border-2 border-red-300 bg-red-50 p-4">
        <p className="flex items-center gap-2 font-display font-bold text-gray-900">
          <AlertTriangle size={18} className="text-red-700" aria-hidden />
          The other person has raised an alarm
        </p>
        <p className="mt-1 text-sm text-gray-700">
          {owned
            ? "Our safety team has it and is looking at it now. Stay where you are unless you are in danger."
            : "Our safety team has been notified. Stay where you are unless you are in danger."}
        </p>
        {SUPPORT_PHONE && (
          <a
            href={`tel:${SUPPORT_PHONE}`}
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
          >
            <Phone size={14} aria-hidden />
            Call us
          </a>
        )}
      </div>
    );
  }

  return (
    <div
      role="status"
      className={`rounded-2xl border-2 p-4 ${
        owned ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"
      }`}
    >
      <p className="flex items-center gap-2 font-display font-bold text-gray-900">
        {owned ? (
          <ShieldCheck size={18} className="text-emerald-700" aria-hidden />
        ) : (
          <Check size={18} className="text-red-700" aria-hidden />
        )}
        {owned ? "Someone is dealing with this" : "Your alarm has been recorded"}
      </p>
      <p className="mt-1 text-sm text-gray-700">
        {owned
          ? "A member of our safety team has your alarm and is looking at it now."
          : "Our safety team has been notified and will pick this up. If you are in immediate danger, call emergency services."}
      </p>

      {SUPPORT_PHONE && (
        <a
          href={`tel:${SUPPORT_PHONE}`}
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
        >
          <Phone size={14} aria-hidden />
          Call us instead
        </a>
      )}

      {/* Standing down is offered plainly — a false alarm someone cannot withdraw is a reason
          not to press the button next time. The record is kept server-side regardless. */}
      <button
        type="button"
        disabled={standing}
        onClick={() => {
          setStanding(true);
          void onCancel(alert.id).finally(() => setStanding(false));
        }}
        className="mt-3 block text-sm text-gray-500 underline hover:text-gray-800 disabled:opacity-50"
      >
        This was a mistake — stand it down
      </button>
    </div>
  );
}
