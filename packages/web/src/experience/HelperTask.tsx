"use client";

import { useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  DoorOpen,
  KeyRound,
  Loader2,
  Navigation,
  Route,
  Video,
} from "lucide-react";
import { isTerminal, type PublicTask } from "@needy/shared";
import { SandboxNote } from "@/components/ui";
import { AuthError } from "@/lib/authClient";
import { taskClient } from "@/lib/taskClient";
import type { EtaView } from "@/realtime";

/** ── The task, from the helper's side ──────────────────────────────────────
 *  The mirror of the requester's stage set, and deliberately not a re-skin of it. The requester
 *  is watching; the helper is doing. Every screen here therefore has exactly one obvious next
 *  action, sized for a thumb, because it will be read on a phone while walking.
 *
 *  The lifecycle edges offered are only the ones this role may actually take —
 *  `TRANSITION_ACTORS` gives `en-route` and `arrived` to the helper, `completed` to the
 *  requester alone, and `in-progress` to NOBODY, because that edge belongs to the handoff and
 *  nothing else. So there is no "start work" button here: entering the code is what starts the
 *  work, and offering a button beside it would be offering a way around it.
 */
export function HelperTask({
  task,
  eta,
  onAdvance,
  onDismiss,
}: {
  task: PublicTask;
  eta: EtaView | null;
  onAdvance: (to: "verifying" | "en-route" | "arrived" | "cancelled") => void;
  onDismiss: () => void;
}) {
  if (isTerminal(task.state)) {
    return <FinishedStage task={task} onDismiss={onDismiss} />;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-3xl bg-white p-6 shadow-[0_10px_30px_rgba(15,92,92,0.08)]">
        <p className="text-sm font-medium uppercase tracking-wide text-primary">
          You are helping with
        </p>
        <h2 className="mt-1 font-display text-xl font-bold text-gray-900">{task.title}</h2>
        {task.description && <p className="mt-2 text-gray-600">{task.description}</p>}
        {(task.state === "matched" || task.state === "verifying" || task.state === "en-route") && (
          // Turn-by-turn belongs to an app built for it. The accepted helper holds the exact
          // origin (only the winner is ever sent it), so this hands that point to Google Maps.
          <a
            href={`https://www.google.com/maps/dir/?api=1&destination=${task.origin.lat},${task.origin.lng}&travelmode=two-wheeler`}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-4 flex items-center justify-center gap-2 rounded-xl border-2 border-primary/20 bg-primary/5 px-4 py-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/10"
          >
            <Route size={16} aria-hidden />
            Directions in Google Maps
          </a>
        )}
      </div>

      {task.state === "matched" && (
        <Step
          icon={<Navigation size={20} aria-hidden />}
          title="Ready to set off?"
          body="Let them know you're on your way. They'll see you move on their map."
          action="I'm on my way"
          onAction={() => onAdvance("en-route")}
        />
      )}

      {task.state === "verifying" && (
        <div className="rounded-3xl border border-gray-100 bg-white p-6">
          <Video size={22} className="mb-2 text-primary" aria-hidden />
          <h3 className="font-display text-lg font-bold text-gray-900">A quick hello</h3>
          {/* Called out rather than dressed up, per AGENTS.md: there is no WebRTC in this
              product, and a screen that looked like a video call would be claiming a check
              actually happened. */}
          <div className="mt-3">
            <SandboxNote>
              The live video call is not built yet. Nothing is recorded and no call takes place —
              this step only marks the task as verified.
            </SandboxNote>
          </div>
          <button
            type="button"
            onClick={() => onAdvance("en-route")}
            className="mt-4 w-full rounded-xl bg-primary px-4 py-3.5 font-semibold text-white transition-colors hover:bg-primary-dark"
          >
            I&apos;m on my way
          </button>
        </div>
      )}

      {task.state === "en-route" && (
        <Step
          icon={<DoorOpen size={20} aria-hidden />}
          title={
            eta
              ? `About ${Math.max(1, Math.round(eta.etaSeconds / 60))} minutes away`
              : "On your way"
          }
          // Says what pressing it does to the other person, because that is what makes it a
          // claim rather than a step: it puts "they are at the door" on someone's screen.
          body="Press this when you're actually at the door — they'll be told you've arrived."
          action="I've arrived"
          onAction={() => onAdvance("arrived")}
        />
      )}

      {task.state === "arrived" && <HandoffStage task={task} />}

      {task.state === "in-progress" && (
        <div className="rounded-3xl border border-gray-100 bg-white p-6">
          <CheckCircle2 size={22} className="mb-2 text-emerald-600" aria-hidden />
          <h3 className="font-display text-lg font-bold text-gray-900">You&apos;re helping</h3>
          <p className="mt-1 text-gray-600">
            When you&apos;re finished, they&apos;ll confirm it on their phone and this will close.
            If anything feels wrong, press the red button.
          </p>
        </div>
      )}

      {/* Pulling out is possible up to the moment work starts, and is deliberately quiet: a
          helper who genuinely cannot continue must have a way to say so, but it is a decision
          with someone waiting at the other end of it, not a button to brush against. */}
      {!isTerminal(task.state) && task.state !== "in-progress" && (
        <button
          type="button"
          onClick={() => onAdvance("cancelled")}
          className="w-full text-sm text-gray-500 underline hover:text-gray-800"
        >
          I can&apos;t do this one
        </button>
      )}
    </div>
  );
}

function Step({
  icon,
  title,
  body,
  action,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="rounded-3xl border border-gray-100 bg-white p-6">
      <span className="text-primary">{icon}</span>
      <h3 className="mt-2 font-display text-lg font-bold text-gray-900">{title}</h3>
      <p className="mt-1 text-gray-600">{body}</p>
      <button
        type="button"
        onClick={onAction}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 font-semibold text-white transition-colors hover:bg-primary-dark"
      >
        {action}
        <ArrowRight size={16} aria-hidden />
      </button>
    </div>
  );
}

/** ── The doorstep handoff, helper side ─────────────────────────────────────
 *  Write what you will do, then type the code they read to you.
 *
 *  The order is enforced by the server — no brief, no code — and it is the whole point: the
 *  code means "I have read what you intend to do and I agree", so there must be something to
 *  read before there is anything to agree to.
 *
 *  The code is never sent here. It travels through the air between two people standing in front
 *  of each other, which is what makes typing it evidence of PRESENCE rather than evidence of
 *  holding a phone. Five wrong attempts destroy it and the requester simply reveals another.
 */
function HandoffStage({ task }: { task: PublicTask }) {
  const [brief, setBrief] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);

  // Read from the live task rather than held locally, so a reload mid-handoff shows the brief
  // already sent instead of an empty box inviting it to be written twice.
  const submitted = task.serviceBrief != null;

  async function sendBrief() {
    setBusy(true);
    setError(null);
    try {
      await taskClient.submitBrief(task.id, brief.trim());
    } catch {
      setError("Couldn't send that. Check you're still connected and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function enterCode() {
    setBusy(true);
    setError(null);
    try {
      await taskClient.verifyCode(task.id, code.trim());
      // No local state change on success: the server transitions the task and broadcasts it,
      // and this screen re-renders from that. Advancing locally would be this component
      // asserting a transition it does not own.
    } catch (err) {
      const refusal = err instanceof AuthError ? err : null;
      const kind = refusal?.code;
      const remaining = refusal?.details?.attemptsRemaining;
      setAttemptsLeft(typeof remaining === "number" ? remaining : null);
      setError(
        kind === "code-invalid"
          ? "That code isn't right. Ask them to read it out again."
          : kind === "too-many-attempts"
            ? "Too many tries — that code is now dead. Ask them to show a new one."
            : kind === "code-expired"
              ? "That code has expired. Ask them to show a new one."
              : kind === "no-code-issued"
                ? "They haven't shown you a code yet."
                : "Couldn't check that code. Try again in a moment.",
      );
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  if (!submitted) {
    return (
      <div className="rounded-3xl border-2 border-primary/30 bg-white p-6">
        <DoorOpen size={22} className="mb-2 text-primary" aria-hidden />
        <h3 className="font-display text-lg font-bold text-gray-900">
          Tell them what you&apos;ll do
        </h3>
        <p className="mt-1 text-gray-600">
          They&apos;ll read this before they let you in. Be specific, and say what you won&apos;t be
          doing too.
        </p>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={4}
          maxLength={1000}
          placeholder="I'll carry your shopping up to the flat and put it on the kitchen counter. I won't go into any other room."
          className="mt-3 w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={sendBrief}
          // Ten characters is the server's own minimum. Matching it here means the refusal
          // arrives before the round trip rather than as an error on a full form.
          disabled={busy || brief.trim().length < 10}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 font-semibold text-white transition-colors hover:bg-primary-dark disabled:bg-gray-300"
        >
          {busy && <Loader2 size={16} className="animate-spin" aria-hidden />}
          Send it to them
        </button>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-3xl border-2 border-primary/30 bg-white p-6">
      <KeyRound size={22} className="mb-2 text-primary" aria-hidden />
      <h3 className="font-display text-lg font-bold text-gray-900">Ask them for their code</h3>
      <p className="mt-1 text-gray-600">
        They have a six-digit code on their screen. Ask them to read it to you, and type it in here.
      </p>

      <div className="mt-3 rounded-xl bg-gray-50 p-3 text-sm text-gray-600">
        <span className="font-medium text-gray-900">What you told them:</span> {task.serviceBrief}
      </div>

      <input
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        // `inputMode` rather than `type="number"`: a numeric keypad without the spinner, the
        // scroll-wheel-changes-the-value behaviour, or the leading zero being eaten — and the
        // code is a string of six digits, not a quantity.
        inputMode="numeric"
        autoComplete="off"
        placeholder="000000"
        className="mt-4 w-full rounded-xl border-2 border-gray-300 px-4 py-4 text-center font-display text-3xl font-black tracking-[0.3em] text-gray-900 outline-none focus:border-primary"
      />

      <button
        type="button"
        onClick={enterCode}
        disabled={busy || code.length !== 6}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 font-semibold text-white transition-colors hover:bg-primary-dark disabled:bg-gray-300"
      >
        {busy && <Loader2 size={16} className="animate-spin" aria-hidden />}
        Start
      </button>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
          {attemptsLeft != null && attemptsLeft > 0 && (
            <>
              {" "}
              <span className="font-semibold">
                {attemptsLeft} {attemptsLeft === 1 ? "try" : "tries"} left before the code stops
                working.
              </span>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** A finished task stays on screen until the helper clears it themselves — see
 *  `HelperDriver.dismissFinishedTask`. The requester confirming completion must not yank the
 *  screen away from someone still reading it. */
function FinishedStage({ task, onDismiss }: { task: PublicTask; onDismiss: () => void }) {
  const completed = task.state === "completed";
  return (
    <div className="rounded-3xl border border-gray-100 bg-white p-8 text-center">
      <CheckCircle2
        size={32}
        className={`mx-auto mb-3 ${completed ? "text-emerald-600" : "text-gray-400"}`}
        aria-hidden
      />
      <h2 className="font-display text-2xl font-bold text-gray-900">
        {completed ? "Thank you" : "This one was cancelled"}
      </h2>
      <p className="mt-2 text-gray-600">
        {completed
          ? "They've confirmed you're finished. That's one more person helped."
          : "Nothing more is needed from you."}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-5 w-full rounded-xl bg-primary px-4 py-3 font-semibold text-white transition-colors hover:bg-primary-dark"
      >
        Back to available
      </button>
    </div>
  );
}
