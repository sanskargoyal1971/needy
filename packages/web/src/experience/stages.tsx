"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Copy,
  DoorOpen,
  Loader2,
  Star,
  Video,
} from "lucide-react";
import type { MatchedHelper, PublicTask } from "@needy/shared";
import { RadarSweep, SoftScaleReveal } from "@/motion";
import { LiveMap } from "@/lib/LiveMap";
import { SandboxNote } from "@/components/ui";
import { taskClient } from "@/lib/taskClient";
import type { EtaView, LatLng, LocationUpdate } from "@/realtime";

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

export function SearchingStage({
  helpersNearby,
}: {
  helpersNearby: { count: number; approxPoints: LatLng[] };
}) {
  return (
    <div className="rounded-3xl border border-gray-100 bg-white p-8 text-center">
      <div className="mx-auto mb-6 flex justify-center">
        <RadarSweep size={180} />
      </div>
      <h2 className="font-display text-2xl font-bold text-gray-900">
        Looking for someone nearby
      </h2>
      {/* The count is the honest thing to show, and it is a real count — the server sends
          `helpers-nearby` with coarsened pins as each ring of the escalation ladder is
          offered. "Searching…" with a spinner would be the same screen carrying no
          information. */}
      <p className="mt-2 text-gray-600">
        {helpersNearby.count > 0
          ? `We've reached ${helpersNearby.count} ${
              helpersNearby.count === 1 ? "helper" : "helpers"
            } close to you. Waiting for someone to accept.`
          : "Asking helpers closest to you first. If nobody answers we'll widen the search."}
      </p>
      <p className="mt-4 text-sm text-gray-500">
        You can close this page — we&apos;ll keep looking and it will be here when you come
        back.
      </p>
    </div>
  );
}

// ── Stage 2: matched — the reveal ────────────────────────────────────────────

export function MatchedStage({ helper }: { helper: MatchedHelper | null }) {
  return (
    <SoftScaleReveal className="rounded-3xl border border-gray-100 bg-white p-8 text-center">
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
      <h2 className="font-display text-2xl font-bold text-gray-900">
        A quick look at each other
      </h2>
      <p className="mx-auto mt-2 max-w-md text-gray-600">
        {helper?.displayName ?? "Your helper"} is confirming who they are before setting off.
      </p>
      {/* AGENTS.md: anything stubbed is called out explicitly and never allowed to look
          finished. There is no WebRTC in this product yet, and a convincing fake video frame
          here would be exactly the kind of lie the whole platform is built to avoid. */}
      <div className="mt-6">
        <SandboxNote>
          The live video call is not built yet. This step currently just marks the task as
          verified — no camera is opened and no call takes place.
        </SandboxNote>
      </div>
    </div>
  );
}

// ── Stage 4: en route ────────────────────────────────────────────────────────

export function EnRouteStage({
  task,
  helper,
  location,
  eta,
  milestones,
}: {
  task: PublicTask;
  helper: MatchedHelper | null;
  location: LocationUpdate | null;
  eta: EtaView | null;
  milestones: string[];
}) {
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-3xl border border-gray-100 bg-white">
        <LiveMap
          origin={task.origin}
          helper={location ? { lat: location.lat, lng: location.lng } : null}
          heading={location?.heading ?? 0}
          height={300}
        />
        <div className="p-5">
          <h2 className="font-display text-xl font-bold text-gray-900">
            {helper?.displayName ?? "Your helper"} is on the way
          </h2>
          <p className="mt-1 text-gray-600">
            {eta
              ? `About ${Math.max(1, Math.round(eta.etaSeconds / 60))} minutes away`
              : // Said plainly rather than shown as a stale number. An ETA that silently
                // keeps displaying its last value while the phone is in a dead zone is worse
                // than none, because it is indistinguishable from a live one.
                "Working out how long they'll be"}
          </p>
        </div>
      </div>

      {/* The warmth of this screen comes from milestones crossed on a real journey, not from
          decoration. Each line was emitted when the ETA actually passed a threshold. */}
      {milestones.length > 0 && (
        <ul className="space-y-1.5">
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

// ── Stage 5: arrived — and the requester's half of the handoff ───────────────

export function ArrivedStage({
  task,
  helper,
}: {
  task: PublicTask;
  helper: MatchedHelper | null;
}) {
  const [brief, setBrief] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const view = await taskClient.handoff(task.id);
        setBrief(view.serviceBrief);
      } catch {
        setError("Couldn't load what your helper plans to do.");
      } finally {
        setLoading(false);
      }
    })();
  }, [task.id]);

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
        <p className="mt-2 text-gray-600">
          Take a moment. Nothing starts until you say so.
        </p>
      </div>

      {/* What they say they will do, BEFORE the code exists. The order is the point: the code
          means "I have read this and I agree", so there must be something to read first — the
          server refuses to issue one without a brief for exactly this reason. */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <h3 className="font-semibold text-gray-900">What they&apos;ll do</h3>
        {loading ? (
          <Loader2 className="mt-2 animate-spin text-primary" aria-label="Loading" />
        ) : brief ? (
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
