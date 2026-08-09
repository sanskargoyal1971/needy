"use client";

import Link from "next/link";
import { useCallback } from "react";
import { CircleSlash, Loader2, MapPinOff, Settings2, WifiOff } from "lucide-react";
import { isTerminal, type TaskState } from "@needy/shared";
import { useHelperDriver, useHelperExperience } from "@/realtime";
import { paths } from "@/lib/paths";
import { Chat } from "./Chat";
import { HelperTask } from "./HelperTask";
import { OfferCard } from "./OfferCard";
import { SosButton } from "./SosButton";
import { usePositionReporting } from "./usePositionReporting";

/** ── The helper's screen ───────────────────────────────────────────────────
 *  One route for the two states a helper is ever in: waiting for work, or doing some.
 *
 *  Not two routes, deliberately. An accepted task arrives as a socket event — the helper is
 *  looking at a list of offers and then they are not — and a navigation triggered by an event
 *  means the browser's back button leads to a screen describing a world that no longer exists.
 *  Switching on `task` keeps the URL stable and makes a reload land in the right place, which
 *  matters most for the person whose phone died halfway to someone's front door.
 */
export function HelperExperience() {
  const driver = useHelperDriver();
  const state = useHelperExperience();
  const { task, offers, available, connection, lastClosed, lastError } = state;

  /**
   * Report position while we are advertising OR on a live task, and not otherwise.
   *
   * Both halves matter. Without the first, a helper toggles "available", nothing is ever
   * published, and they sit on a screen that says they are available while being invisible to
   * every search — the exact silent failure the availability TTL was written to avoid. Without
   * the second, the requester's map freezes the moment the helper is matched.
   */
  const positionStatus = usePositionReporting(
    driver,
    available || (task != null && !isTerminal(task.state)),
  );

  const onSend = useCallback((body: string) => driver.sendMessage(body), [driver]);
  const onTyping = useCallback((t: boolean) => driver.setTyping(t), [driver]);
  const onRead = useCallback((ids: string[]) => driver.markRead(ids), [driver]);
  const onRaise = useCallback(
    (kind: Parameters<typeof driver.raiseSos>[0]) => driver.raiseSos(kind),
    [driver],
  );
  const onCancelSos = useCallback((id: string) => driver.cancelSos(id), [driver]);
  const onAdvance = useCallback((to: TaskState) => driver.advanceTo(to), [driver]);

  return (
    <div className="mx-auto max-w-2xl space-y-5 px-4 py-8 sm:px-6">
      {connection !== "online" && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-900 ring-1 ring-inset ring-amber-200"
        >
          <WifiOff size={14} aria-hidden />
          {connection === "resyncing"
            ? "Reconnected — catching up."
            : connection === "reconnecting"
              ? "Connection lost. Trying to reconnect…"
              : connection === "connecting"
                ? "Connecting…"
                : "You're offline. You won't receive work until this clears."}
        </div>
      )}

      {/* A refusal from the server is shown, never swallowed. The one that matters most here is
          an unverified account: the server hard-filters candidates on KYC, so the toggle would
          otherwise sit on "available" forever with no offer ever arriving and nothing on screen
          to explain why. */}
      {lastError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-900 ring-1 ring-inset ring-red-200"
        >
          <CircleSlash size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            {lastError.code === "NOT_AUTHORIZED"
              ? "Your account isn't cleared for work yet, so you can't be offered any. If you think that's wrong, contact us."
              : lastError.message}
          </span>
        </div>
      )}

      {task ? (
        <>
          <HelperTask
            task={task}
            eta={state.eta}
            onAdvance={onAdvance}
            onDismiss={() => driver.dismissFinishedTask()}
          />

          {!isTerminal(task.state) && (
            <Chat
              messages={state.messages}
              userId={state.userId}
              otherTyping={state.otherTyping}
              otherName="them"
              onSend={onSend}
              onTyping={onTyping}
              onRead={onRead}
            />
          )}

          {/* The helper gets the same alarm as the requester, and for the same reason: a
              helper alone in a stranger's home can be the one who is not safe. */}
          <SosButton alert={state.sos} onRaise={onRaise} onCancel={onCancelSos} />
        </>
      ) : (
        <>
          <AvailabilityCard
            available={available}
            positionStatus={positionStatus}
            onToggle={() => driver.setAvailable(!available)}
          />

          {offers.length > 0 && (
            <ul className="space-y-3">
              {offers.map((offer) => (
                <OfferCard
                  key={offer.taskId}
                  offer={offer}
                  onAccept={() => driver.accept(offer.taskId)}
                  onDecline={() => driver.decline(offer.taskId)}
                />
              ))}
            </ul>
          )}

          {/* Why a card went away, rather than letting it vanish under a thumb. Losing a race
              is the ordinary outcome of a simultaneous broadcast and should read as ordinary. */}
          {offers.length === 0 && lastClosed && (
            <p className="text-center text-sm text-gray-500">
              {lastClosed.reason === "already-taken"
                ? "Someone else got there first. Another will come along."
                : lastClosed.reason === "cancelled"
                  ? "That request was cancelled."
                  : "That one timed out."}
            </p>
          )}

          {available && offers.length === 0 && !lastClosed && (
            <p className="text-center text-sm text-gray-500">
              Nothing nearby right now. We&apos;ll let you know the moment someone needs help.
            </p>
          )}

          <Link
            href={paths.helperServices}
            className="flex items-center justify-center gap-2 text-sm font-medium text-primary hover:underline"
          >
            <Settings2 size={14} aria-hidden />
            What I can help with
          </Link>
        </>
      )}
    </div>
  );
}

function AvailabilityCard({
  available,
  positionStatus,
  onToggle,
}: {
  available: boolean;
  positionStatus: ReturnType<typeof usePositionReporting>;
  onToggle: () => void;
}) {
  // Advertising without a fix is the state worth naming: the toggle is on, the server has
  // nothing to index, and no offer can ever arrive. It looks identical to a quiet afternoon.
  const blind = available && (positionStatus === "denied" || positionStatus === "unavailable");
  const waiting = available && positionStatus === "locating";

  return (
    <div
      className={`rounded-3xl border-2 p-6 ${
        available ? "border-primary/40 bg-primary/5" : "border-gray-200 bg-white"
      }`}
    >
      <h1 className="font-display text-2xl font-bold text-gray-900">
        {available ? "You're available" : "You're off duty"}
      </h1>
      <p className="mt-1 text-gray-600">
        {available
          ? "People nearby can be matched with you. Keep this page open."
          : "Turn this on when you're ready to help someone nearby."}
      </p>

      <button
        type="button"
        onClick={onToggle}
        aria-pressed={available}
        className={`mt-5 w-full rounded-xl px-4 py-4 text-lg font-semibold transition-colors ${
          available
            ? "border-2 border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
            : "bg-primary text-white hover:bg-primary-dark"
        }`}
      >
        {available ? "Stop for now" : "I'm available to help"}
      </button>

      {waiting && (
        <p className="mt-3 flex items-center justify-center gap-2 text-sm text-gray-500">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          Finding where you are…
        </p>
      )}

      {blind && (
        <p
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
        >
          <MapPinOff size={14} className="mt-0.5 shrink-0" aria-hidden />
          {positionStatus === "denied"
            ? "We can't see where you are, so nobody can be matched with you. Allow location for this site and it'll start working."
            : "Your device can't find your location, so nobody can be matched with you yet."}
        </p>
      )}
    </div>
  );
}
