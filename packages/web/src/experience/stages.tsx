"use client";

import Link from "next/link";
import { useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  Copy,
  DoorOpen,
  Loader2,
  MessageCircle,
  ShieldAlert,
  ShieldCheck,
  Star,
  UserRound,
  Video,
} from "lucide-react";
import type { MatchedHelper, PublicTask } from "@needy/shared";
import { SoftScaleReveal } from "@/motion";
import { SandboxNote } from "@/components/ui";
import { paths } from "@/lib/paths";
import { taskClient } from "@/lib/taskClient";
import type { EtaView, LatLng } from "@/realtime";

/** ── The seven stages ──────────────────────────────────────────────────────
 *  One component per `task.state`, because the state IS the stage — that mapping is declared
 *  in the shared TaskState union and both sides switch on it rather than on anything either
 *  side computes.
 *
 *  The rule running through all of them: every moving thing on screen must be evidence of a
 *  real person doing something. The radar sweeps because helpers are genuinely being polled
 *  outward through the escalation ladder; the marker glides because a real phone reported a
 *  real position; the arrival highlight fires because the helper pressed a button at a door.
 *  Nothing here animates to fill time.
 */

// ── Stage 1: searching ───────────────────────────────────────────────────────

/**
 * The search, as the sheet under the map. The map above carries the evidence — the ripple runs
 * while offers are genuinely going out, and each dot is a real helper the server reached,
 * coarsened before it left the server so nobody can be located through a search. This card
 * says the same thing in words, with the real count.
 */
export function SearchingStage({
  helpersNearby,
}: {
  origin: LatLng;
  helpersNearby: { count: number; approxPoints: LatLng[]; restrictedNearby: number };
}) {
  const reached = helpersNearby.count;
  return (
    <div className="rounded-3xl bg-white p-6 shadow-[0_10px_30px_rgba(15,92,92,0.08)]">
      <div className="flex items-center gap-4">
        <span className="relative flex h-12 w-12 shrink-0 items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-primary/15 animate-ripple" />
          <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-primary text-white">
            <UserRound size={20} aria-hidden />
          </span>
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-xl font-bold text-gray-900">
            Looking for someone nearby
          </h2>
          {/* The count is the honest thing to show, and it is a real count — the server sends
              `helpers-nearby` as each ring of the escalation ladder is offered. */}
          <p className="mt-0.5 text-sm text-gray-600">
            {reached > 0
              ? `${reached} verified ${reached === 1 ? "helper has" : "helpers have"} your request. Waiting for one to accept.`
              : "Asking the helpers closest to you first. If nobody answers we'll widen the search."}
          </p>
        </div>
      </div>

      {reached > 0 && (
        <div className="mt-4 flex items-center gap-2">
          <div className="flex -space-x-2">
            {Array.from({ length: Math.min(reached, 5) }).map((_, i) => (
              <span
                key={i}
                className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-accent text-white"
              >
                <UserRound size={14} aria-hidden />
              </span>
            ))}
          </div>
          {reached > 5 && <span className="text-sm text-gray-500">+{reached - 5} more</span>}
        </div>
      )}

      {/* The difference between "nobody is around" and "someone is around and we will not
          introduce you". Those looked identical here: the search sat on "asking helpers
          closest to you" forever while the one person nearby had been deliberately filtered
          out, and nothing ever said so. A refusal the person it refuses cannot see is the
          worst of both worlds — they get neither the match nor the explanation.

          Deliberately a COUNT and nothing else. These are the people this requester is
          specifically not cleared to be matched with, so naming or placing them would leak
          exactly what the rule exists to withhold. */}
      {helpersNearby.count === 0 && helpersNearby.restrictedNearby > 0 && (
        <div className="mt-6 rounded-2xl bg-amber-50 p-4 text-left">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <ShieldAlert size={16} aria-hidden />
            {helpersNearby.restrictedNearby === 1
              ? "Someone is nearby, but we can't match you automatically"
              : `${helpersNearby.restrictedNearby} people are nearby, but we can't match you automatically`}
          </p>
          <p className="mt-1 text-sm text-amber-900">
            For safety we don&apos;t automatically pair two adults under 36 of different genders. It
            isn&apos;t about you — it applies to everyone, both ways round. We&apos;re still
            widening the search for someone else.
          </p>
          <Link
            href={paths.exceptions()}
            className="mt-3 inline-block text-sm font-semibold text-amber-900 underline"
          >
            Ask for a pairing review instead
          </Link>
        </div>
      )}
      <p className="mt-4 text-xs text-gray-500">
        You can close this page — we&apos;ll keep looking and it will be here when you come back.
      </p>
    </div>
  );
}

// ── Stage 1b: booked — a scheduled task with a named helper ──────────────────

/**
 * A request for one named person, waiting for them to say yes.
 *
 * Not the radar: this task is never offered to anyone else. It exists because the requester
 * asked for this person — sometimes after a human approved the pairing — and broadcasting it
 * would hand it to whoever tapped first. So this screen says plainly who is being asked, and
 * when, and what happens if the answer is no.
 */
export function BookedStage({ task }: { task: PublicTask }) {
  const scheduled = task.scheduledFor != null;
  return (
    <div className="rounded-3xl bg-white p-8 text-center shadow-[0_10px_30px_rgba(15,92,92,0.08)]">
      <CalendarClock size={28} className="mx-auto mb-3 text-primary" aria-hidden />
      <h2 className="font-display text-2xl font-bold text-gray-900">
        {scheduled ? "This booking is arranged" : "We've asked them for you"}
      </h2>
      <p className="mt-2 text-gray-600">
        {scheduled ? (
          <>
            It&apos;s set for{" "}
            <span className="font-semibold text-gray-900">
              {new Date(task.scheduledFor!).toLocaleString("en-IN", {
                weekday: "long",
                day: "numeric",
                month: "long",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
            , with the person you asked for. Nobody else will be offered it.
          </>
        ) : (
          <>
            Only the person you asked for can take this. They have a few minutes to answer, and
            you&apos;ll see them here the moment they do.
          </>
        )}
      </p>
      {scheduled && (
        <p className="mx-auto mt-4 max-w-md rounded-2xl bg-primary/5 p-4 text-left text-sm text-gray-700">
          A couple of hours before, we&apos;ll ask them to confirm. If they can&apos;t, we&apos;ll
          tell you straight away — at least half an hour before the start — so there&apos;s time to
          ask someone else.
        </p>
      )}
    </div>
  );
}

// ── Stage 2: matched — the reveal ────────────────────────────────────────────

export function MatchedStage({ helper }: { helper: MatchedHelper | null }) {
  return (
    <SoftScaleReveal className="rounded-3xl bg-white p-8 text-center shadow-[0_10px_30px_rgba(15,92,92,0.08)]">
      <div className="mb-4 flex justify-center">
        <HelperAvatar helper={helper} size={72} />
      </div>
      <p className="text-sm font-medium uppercase tracking-wide text-primary">
        Someone has accepted
      </p>
      <h2 className="mt-2 font-display text-3xl font-black text-gray-900">
        {helper?.displayName ?? "Your helper"}
      </h2>
      {/* A person, described the way you would describe a person — not a driver card with a
          licence plate. Rating and count are shown because they are earned by real work, and
          nothing else about them is shown because nothing else is any of the requester's
          business until they arrive. */}
      {helper && (
        <div className="mt-3 flex items-center justify-center gap-4 text-sm text-gray-600">
          {helper.rating > 0 && (
            <span className="inline-flex items-center gap-1">
              <Star size={14} className="fill-amber-400 text-amber-400" aria-hidden />
              {helper.rating.toFixed(1)}
            </span>
          )}
          {helper.helpedCount > 0 && <span>{helper.helpedCount} people helped</span>}
        </div>
      )}
      <p className="mt-4 text-gray-600">
        They&apos;re getting ready to set off. You&apos;ll see them move on the map.
      </p>
    </SoftScaleReveal>
  );
}

// ── Stage 3: verifying — an explicit stub ────────────────────────────────────

export function VerifyingStage({ helper }: { helper: MatchedHelper | null }) {
  return (
    <div className="rounded-3xl border border-gray-100 bg-white p-8 text-center">
      <Video size={28} className="mx-auto mb-3 text-primary" aria-hidden />
      <h2 className="font-display text-2xl font-bold text-gray-900">A quick look at each other</h2>
      <p className="mx-auto mt-2 max-w-md text-gray-600">
        {helper?.displayName ?? "Your helper"} is confirming who they are before setting off.
      </p>
      {/* AGENTS.md: anything stubbed is called out explicitly and never allowed to look
          finished. There is no WebRTC in this product yet, and a convincing fake video frame
          here would be exactly the kind of lie the whole platform is built to avoid. */}
      <div className="mt-6">
        <SandboxNote>
          The live video call is not built yet. This step currently just marks the task as verified
          — no camera is opened and no call takes place.
        </SandboxNote>
      </div>
    </div>
  );
}

// ── Stage 4: en route ────────────────────────────────────────────────────────

export function EnRouteStage({
  helper,
  eta,
  milestones,
}: {
  helper: MatchedHelper | null;
  eta: EtaView | null;
  milestones: string[];
}) {
  const name = helper?.displayName ?? "Your helper";
  return (
    <div className="space-y-4">
      <div className="rounded-3xl bg-white p-5 shadow-[0_10px_30px_rgba(15,92,92,0.08)]">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-primary">{name} is on the way</p>
            {eta ? (
              <>
                <p className="mt-1 font-display text-4xl font-black leading-none text-gray-900">
                  {Math.max(1, Math.round(eta.etaSeconds / 60))}
                  <span className="ml-1 text-lg font-bold text-gray-500">min</span>
                </p>
                <p className="mt-1.5 text-sm text-gray-500">
                  {formatDistance(eta.distanceMeters)} away
                  {/* Said, not hidden: a straight-line guess is not a route. */}
                  {eta.approximate && " · rough estimate"}
                </p>
              </>
            ) : (
              // Said plainly rather than shown as a stale number. An ETA that silently keeps
              // displaying its last value while the phone is in a dead zone is worse than none.
              <p className="mt-1 text-lg text-gray-600">Working out how long they&apos;ll be</p>
            )}
          </div>
          <HelperAvatar helper={helper} size={56} />
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-gray-100 pt-4">
          <div className="min-w-0">
            <p className="truncate font-semibold text-gray-900">{name}</p>
            {helper && (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 whitespace-nowrap text-sm text-gray-500">
                {helper.rating > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Star size={13} className="fill-amber-400 text-amber-400" aria-hidden />
                    {helper.rating.toFixed(1)}
                  </span>
                )}
                {helper.helpedCount > 0 && <span>{helper.helpedCount} helped</span>}
                <span className="inline-flex items-center gap-1 text-primary">
                  <ShieldCheck size={13} aria-hidden />
                  ID verified
                </span>
              </p>
            )}
          </div>
          <a
            href="#task-chat"
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-4 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/15"
          >
            <MessageCircle size={16} aria-hidden />
            Message
          </a>
        </div>
      </div>

      {/* The warmth of this screen comes from milestones crossed on a real journey, not from
          decoration. Each line was emitted when the ETA actually passed a threshold. */}
      {milestones.length > 0 && (
        <ul className="space-y-1.5 px-1">
          {milestones.map((m, i) => (
            <li key={`${m}-${i}`} className="flex items-center gap-2 text-sm text-gray-600">
              <CheckCircle2 size={14} className="text-primary" aria-hidden />
              {m}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The helper's face, or their initial when there is no photo to show. */
export function HelperAvatar({
  helper,
  size = 48,
}: {
  helper: MatchedHelper | null;
  size?: number;
}) {
  const initial = (helper?.displayName ?? "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-[#1B7A7A] font-display font-bold text-white ring-4 ring-primary/10"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      {initial}
    </span>
  );
}

function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
}

// ── Stage 5: arrived — and the requester's half of the handoff ───────────────

export function ArrivedStage({ task, helper }: { task: PublicTask; helper: MatchedHelper | null }) {
  const [code, setCode] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Read from the LIVE task, not from a fetch on mount.
   *
   * The first version called `GET /tasks/:id/handoff` once in an effect, which gets the
   * ordering exactly backwards: the requester is already sitting on this screen watching
   * their helper approach, and the brief is written afterwards, at the door. A one-shot read
   * would therefore almost always find `null` and stay there — a permanently empty "what
   * they'll do" panel and a permanently disabled code button, with nothing erroring.
   *
   * `POST /handoff/brief` broadcasts `task-updated` to both parties precisely so this is
   * unnecessary; the driver patches `task` and this re-renders. Same source of truth as every
   * other stage, which is the rule this file is built on.
   */
  const brief = task.serviceBrief;

  async function reveal() {
    setIssuing(true);
    setError(null);
    try {
      const res = await taskClient.revealCode(task.id);
      setCode(res.code);
    } catch {
      setError("Couldn't get a code. Ask your helper to send their plan first.");
    } finally {
      setIssuing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border-2 border-primary/30 bg-white p-6 text-center">
        <DoorOpen size={28} className="mx-auto mb-3 text-primary" aria-hidden />
        <h2 className="font-display text-2xl font-bold text-gray-900">
          {helper?.displayName ?? "Your helper"} is at your door
        </h2>
        <p className="mt-2 text-gray-600">Take a moment. Nothing starts until you say so.</p>
      </div>

      {/* What they say they will do, BEFORE the code exists. The order is the point: the code
          means "I have read this and I agree", so there must be something to read first — the
          server refuses to issue one without a brief for exactly this reason. */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <h3 className="font-semibold text-gray-900">What they&apos;ll do</h3>
        {brief ? (
          <p className="mt-2 whitespace-pre-wrap text-gray-700">{brief}</p>
        ) : (
          <p className="mt-2 text-gray-500">
            Waiting for {helper?.displayName ?? "your helper"} to send what they plan to do.
          </p>
        )}
      </div>

      {code ? (
        <div className="rounded-2xl border-2 border-primary bg-primary/5 p-6 text-center">
          <p className="text-sm text-gray-700">Read this out to the person at your door</p>
          {/* Spaced and very large. It is spoken aloud by someone who may be holding the
              phone at arm's length, and the whole security property depends on them reading
              it correctly. */}
          <p className="mt-2 font-display text-5xl font-black tracking-[0.2em] text-primary">
            {code}
          </p>
          <p className="mt-3 text-sm text-gray-600">
            Only give this to the person you can see. Don&apos;t send it in a message.
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={reveal}
          disabled={issuing || !brief}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 font-semibold text-white transition-colors hover:bg-primary-dark disabled:bg-gray-300"
        >
          {issuing ? (
            <Loader2 size={16} className="animate-spin" aria-hidden />
          ) : (
            <Copy size={16} aria-hidden />
          )}
          Show my code
        </button>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

// ── Stage 6: in progress — and the only way out of it ────────────────────────

/**
 * The work is happening. The requester is the one who says when it is finished.
 *
 * `TRANSITION_ACTORS["completed"]` lists the requester alone, and this screen is the only
 * place that edge is driven from — so the button is not a convenience, it is the transition.
 * A helper who could mark their own work complete would be closing the tracked, chattable,
 * SOS-capable window on their own say-so, from inside the requester's home. The asymmetry is
 * the whole point.
 *
 * Which is also why it confirms. One stray tap on a phone being put back in a pocket would
 * end the safety window early and silently; the second tap costs a moment and is plainly
 * labelled. This is the same reasoning as the alarm's two taps, pointing the other way.
 */
export function InProgressStage({
  helperName,
  onComplete,
}: {
  helperName: string;
  onComplete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="rounded-3xl border border-gray-100 bg-white p-6">
      <h2 className="font-display text-xl font-bold text-gray-900">{helperName} is helping you</h2>
      <p className="mt-1 text-gray-600">
        Message them if you need to. Press the red button if anything feels wrong.
      </p>

      {confirming ? (
        <div className="mt-5 rounded-2xl bg-gray-50 p-4">
          <p className="font-medium text-gray-900">Is {helperName} finished?</p>
          {/* Says what ends, rather than only what happens. Someone about to lose the alarm
              and the chat deserves to be told that is what they are agreeing to. */}
          <p className="mt-1 text-sm text-gray-600">
            This ends the visit. You will no longer be able to message {helperName} or raise an
            alarm from this screen.
          </p>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={onComplete}
              className="flex-1 rounded-xl bg-primary px-4 py-3 font-semibold text-white transition-colors hover:bg-primary-dark"
            >
              Yes, all done
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-xl px-4 py-3 font-medium text-gray-600 hover:text-gray-900"
            >
              Not yet
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-primary px-4 py-3 font-semibold text-primary transition-colors hover:bg-primary/5"
        >
          <CheckCircle2 size={16} aria-hidden />
          Mark this as done
        </button>
      )}
    </div>
  );
}

// ── Stage 7: completed ───────────────────────────────────────────────────────

export function CompletedStage({ helper }: { helper: MatchedHelper | null }) {
  return (
    <SoftScaleReveal className="rounded-3xl border border-gray-100 bg-white p-8 text-center">
      <CheckCircle2 size={32} className="mx-auto mb-3 text-emerald-600" aria-hidden />
      <h2 className="font-display text-2xl font-bold text-gray-900">All done</h2>
      <p className="mt-2 text-gray-600">
        {helper?.displayName
          ? `${helper.displayName} has finished helping you.`
          : "Your request is complete."}
      </p>
    </SoftScaleReveal>
  );
}

/** The search ran every ring and nobody accepted. Said plainly, with the next step in reach:
 *  a person who needed help still needs it, and "try again" is the honest offer. */
export function UnmatchedStage({ named = false }: { named?: boolean }) {
  return (
    <div className="rounded-3xl border border-gray-100 bg-white p-8 text-center">
      <h2 className="font-display text-2xl font-bold text-gray-900">
        {named ? "They can't make it this time" : "Nobody was available this time"}
      </h2>
      <p className="mt-2 text-gray-600">
        {named
          ? "The person you asked for couldn't take this one. Nothing was charged. You can ask the verified helpers near you instead."
          : "We asked the verified helpers near you, widening the search each time, and no one could take it. Nothing was charged. Helpers come and go through the day, so it is worth asking again."}
      </p>
      <Link
        href={paths.newRequest}
        className="mt-6 inline-flex items-center justify-center rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
      >
        Ask again
      </Link>
      <p className="mt-4 text-sm text-gray-500">If this is an emergency, call 112.</p>
    </div>
  );
}

export function CancelledStage() {
  return (
    <div className="rounded-3xl border border-gray-100 bg-white p-8 text-center">
      <h2 className="font-display text-2xl font-bold text-gray-900">Request cancelled</h2>
      <p className="mt-2 text-gray-600">
        Nothing was charged. You can ask for help again whenever you need it.
      </p>
    </div>
  );
}
