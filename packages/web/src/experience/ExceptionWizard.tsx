"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Clock, Loader2, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { EXCEPTION_REVIEW_SLA_MS } from "@needy/shared";
import { FormError } from "@/components/ui";
import { CameraCapture } from "@/onboarding/CameraCapture";
import { absoluteTime } from "@/admin/format";
import { paths } from "@/lib/paths";
import { taskClient, type ParticipantException } from "@/lib/taskClient";

/** ── The exception, from either side ───────────────────────────────────────
 *  A restricted pairing can be unlocked, once, for one ordered pair, by both people recording
 *  a short video saying who they are and that they want this specific booking — and a person
 *  on the safety team watching both.
 *
 *  **The wait is the mechanism, not the friction.** Everything on this screen is written to
 *  say so. A same-minute "I consent" checkbox would be indistinguishable from the coercion the
 *  rule exists to detect: someone standing over a person's shoulder can produce a tick
 *  instantly, and can produce a video almost as easily — but they cannot easily still be there
 *  a day later when a stranger watches it and decides. So the screen never apologises for the
 *  delay, never shows a progress bar implying it could go faster, and never suggests a way to
 *  hurry it. It states when an answer is due and leaves.
 *
 *  It also never promises the outcome. "Under review" is not "nearly approved", and the copy
 *  is careful not to let someone who has just recorded a video believe the booking is settled.
 */
export function ExceptionWizard({ helperId }: { helperId?: string }) {
  const [items, setItems] = useState<ParticipantException[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const load = useCallback(async () => {
    try {
      const { exceptions } = await taskClient.myExceptions();
      setItems(exceptions);
      setError(null);
    } catch {
      setError("Couldn't load your requests. Check your connection and try again.");
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Opening is only ever reachable from the requester's side, because only they know who they
  // wanted to book. The helper always arrives at an exception that already exists.
  async function open() {
    if (!helperId) return;
    setOpening(true);
    setError(null);
    try {
      await taskClient.openException(helperId);
      await load();
    } catch {
      setError("Couldn't start that request. Please try again.");
    } finally {
      setOpening(false);
    }
  }

  const forThisHelper = helperId
    ? (items ?? []).find((e) => e.helperId === helperId)
    : undefined;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-3xl font-bold text-gray-900">Pairing reviews</h1>
      <p className="mt-2 text-gray-600">
        Some pairings need a person on our safety team to look at them before they can go
        ahead. This is where those stand.
      </p>

      {error && (
        <div className="mt-4">
          <FormError>{error}</FormError>
        </div>
      )}

      {items == null ? (
        <div className="flex justify-center py-12">
          <Loader2 className="animate-spin text-primary" aria-label="Loading" />
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {items.map((e) => (
            <ExceptionCard key={e.id} exception={e} onChanged={load} />
          ))}

          {helperId && !forThisHelper && (
            <div className="rounded-2xl border-2 border-amber-200 bg-amber-50 p-5">
              <ShieldAlert size={20} className="mb-2 text-amber-700" aria-hidden />
              <h2 className="font-display text-lg font-bold text-gray-900">
                Ask for this pairing to be reviewed
              </h2>
              <p className="mt-1 text-sm text-amber-900">
                You&apos;ll each record a short video saying who you are and that you both want
                this booking. Someone on our team watches both and decides within one working
                day.
              </p>
              <button
                type="button"
                onClick={open}
                disabled={opening}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 font-semibold text-white transition-colors hover:bg-primary-dark disabled:bg-gray-300"
              >
                {opening && <Loader2 size={16} className="animate-spin" aria-hidden />}
                Start the review
              </button>
            </div>
          )}

          {items.length === 0 && !helperId && (
            <p className="py-8 text-center text-gray-500">
              You have no pairing reviews open.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ExceptionCard({
  exception: e,
  onChanged,
}: {
  exception: ParticipantException;
  onChanged: () => Promise<void>;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mineSubmitted =
    e.myRole === "requester" ? e.requesterVideoSubmitted : e.helperVideoSubmitted;
  const theirsSubmitted =
    e.myRole === "requester" ? e.helperVideoSubmitted : e.requesterVideoSubmitted;

  async function upload(blob: Blob, filename: string) {
    setUploading(true);
    setError(null);
    try {
      await taskClient.uploadExceptionVideo(e.id, blob, filename);
      await onChanged();
    } catch {
      setError("That didn't upload. Check your connection and record it again.");
    } finally {
      setUploading(false);
    }
  }

  if (e.status === "approved") {
    return (
      <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-5">
        <ShieldCheck size={20} className="mb-2 text-emerald-700" aria-hidden />
        <h2 className="font-display text-lg font-bold text-gray-900">
          You and {e.otherName} can go ahead
        </h2>
        <p className="mt-1 text-sm text-gray-700">
          {/* Says the constraint out loud rather than letting them discover it at the point of
              booking. An approval is not a licence to summon someone right now: the whole
              design is that this pairing is arranged in advance, and the booking screen will
              refuse an immediate one. */}
          This booking needs to be arranged for a set time rather than requested on the spot.
          {e.expiresAt != null && (
            <> This approval lasts until {absoluteTime(e.expiresAt)}.</>
          )}
        </p>
        {e.myRole === "requester" && (
          <Link
            href={`${paths.newRequest}?helperId=${encodeURIComponent(e.helperId)}`}
            className="mt-4 block rounded-xl bg-primary px-4 py-3 text-center font-semibold text-white transition-colors hover:bg-primary-dark"
          >
            Book a time with {e.otherName}
          </Link>
        )}
      </div>
    );
  }

  if (e.status === "rejected") {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <XCircle size={20} className="mb-2 text-gray-500" aria-hidden />
        <h2 className="font-display text-lg font-bold text-gray-900">
          This pairing wasn&apos;t approved
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          {/* The reviewer's note is shown verbatim when there is one. A refusal with no reason
              is the kind of thing people invent a reason for. */}
          {e.reviewNote ??
            "Our team looked at this and decided not to go ahead. You can still ask for help from anyone else."}
        </p>
      </div>
    );
  }

  if (e.status === "under_review") {
    return (
      <div className="rounded-2xl border-2 border-gray-200 bg-white p-5">
        <Clock size={20} className="mb-2 text-primary" aria-hidden />
        <h2 className="font-display text-lg font-bold text-gray-900">
          Being reviewed by our team
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          Both videos are in. Someone will watch them and decide
          {e.reviewDueBy != null ? <> by {absoluteTime(e.reviewDueBy)}</> : <> shortly</>}.
        </p>
        {/* States the reason for the wait instead of apologising for it. This is the sentence
            the whole feature exists to be able to say honestly. */}
        <p className="mt-3 rounded-xl bg-gray-50 px-3 py-2.5 text-sm text-gray-600">
          We take a day on purpose. A decision made in the moment can be pushed; one made a day
          later, by someone who isn&apos;t in the room, can&apos;t be.
        </p>
      </div>
    );
  }

  // awaiting_videos
  return (
    <div className="rounded-2xl border-2 border-amber-200 bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">
        {e.myRole === "helper"
          ? `${e.otherName} has asked to be paired with you`
          : `Your review with ${e.otherName}`}
      </h2>

      <ul className="mt-3 space-y-1.5 text-sm">
        <li className="flex items-center gap-2">
          {mineSubmitted ? (
            <CheckCircle2 size={14} className="text-emerald-600" aria-hidden />
          ) : (
            <Clock size={14} className="text-gray-400" aria-hidden />
          )}
          <span className={mineSubmitted ? "text-gray-600" : "font-medium text-gray-900"}>
            {mineSubmitted ? "Your video is in" : "Your video — still needed"}
          </span>
        </li>
        <li className="flex items-center gap-2">
          {theirsSubmitted ? (
            <CheckCircle2 size={14} className="text-emerald-600" aria-hidden />
          ) : (
            <Clock size={14} className="text-gray-400" aria-hidden />
          )}
          <span className="text-gray-600">
            {theirsSubmitted
              ? `${e.otherName}'s video is in`
              : `Waiting on ${e.otherName} too`}
          </span>
        </li>
      </ul>

      {!mineSubmitted && (
        <div className="mt-4">
          <p className="mb-3 text-sm text-gray-600">
            Record a few seconds saying your name, that you know who {e.otherName} is, and that
            you want this booking to go ahead. Nobody sees it except our safety team.
          </p>
          <CameraCapture
            mode="video"
            maxDurationSeconds={30}
            disabled={uploading}
            onCapture={(blob, filename) => void upload(blob, filename)}
          />
          {uploading && (
            <p className="mt-2 flex items-center gap-2 text-sm text-gray-500">
              <Loader2 size={14} className="animate-spin" aria-hidden />
              Sending your video…
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-sm text-red-700">
              {error}
            </p>
          )}
        </div>
      )}

      {mineSubmitted && !theirsSubmitted && (
        <p className="mt-4 rounded-xl bg-gray-50 px-3 py-2.5 text-sm text-gray-600">
          Nothing more for you to do yet. Once {e.otherName} has recorded theirs, our team has
          {" "}
          {Math.round(EXCEPTION_REVIEW_SLA_MS / (60 * 60 * 1000))} hours to decide.
        </p>
      )}
    </div>
  );
}
