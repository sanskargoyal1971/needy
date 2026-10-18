"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef } from "react";
import { Loader2, WifiOff } from "lucide-react";
import { isTerminal } from "@needy/shared";
import { useDriver, useTaskExperience } from "@/realtime";
import { LiveMap } from "@/lib/LiveMap";
import { usePushState } from "@/lib/push";
import { paths } from "@/lib/paths";
import { Chat } from "./Chat";
import { TASK_ALARM_ID } from "@/components/SOSGlow";
import { SosButton } from "./SosButton";
import {
  ArrivedStage,
  BookedStage,
  CancelledStage,
  UnmatchedStage,
  CompletedStage,
  EnRouteStage,
  InProgressStage,
  MatchedStage,
  SearchingStage,
  VerifyingStage,
} from "./stages";

/** ── The live task ─────────────────────────────────────────────────────────
 *  The screen the whole realtime engine was built for, and the one that has been missing: the
 *  drivers, the event contracts and the motion vocabulary all existed and nothing rendered
 *  them.
 *
 *  It switches on `task.state` and NOTHING ELSE. Not on a local step counter, not on which
 *  action the user last took — the server owns the lifecycle, broadcasts `task-updated` on
 *  every transition, and this component's only job is to show the truth it is told. That is
 *  what makes the screen correct after a reload, after a reconnect, and for the party who was
 *  not the one who caused the transition.
 */
export function TaskExperience({ taskId }: { taskId: string }) {
  const driver = useDriver();
  const state = useTaskExperience();
  const { task, helper, connection } = state;
  const startedRef = useRef<string | null>(null);
  // Re-confirms this device's push subscription with the server on every visit; never prompts.
  usePushState();
  const searchOpenedRef = useRef<string | null>(null);

  // Join the task's rooms and seed from the snapshot. Guarded by id so a re-render cannot
  // re-enter, and re-run when the id changes so navigating between two tasks works.
  useEffect(() => {
    if (startedRef.current === taskId) return;
    startedRef.current = taskId;
    driver.start(taskId);
  }, [driver, taskId]);

  /**
   * Open the search exactly once for a task that is still `searching`.
   *
   * The request screen creates the task over REST and routes here; the durable row exists but
   * no offer has gone out, because broadcasting is the live half and belongs to the socket.
   * Doing it here rather than on the request screen means a reload mid-search re-opens it
   * rather than leaving a task nobody was ever offered — which is the failure that would be
   * invisible, since the screen would show a perfectly convincing radar forever.
   */
  useEffect(() => {
    if (!task || task.state !== "searching") return;
    // A booking made for one specific person is not a search and must never be broadcast: the
    // exception that unlocked it was granted for that ordered pair, so handing the task to
    // whoever accepts first would place it with someone the approval does not cover. The
    // server refuses this too — this is the client not asking for something it knows is wrong.
    if (task.helperId != null) return;
    if (searchOpenedRef.current === task.id) return;
    searchOpenedRef.current = task.id;
    driver.requestHelp();
  }, [driver, task]);

  const onSend = useCallback((body: string) => driver.sendMessage(body), [driver]);
  const onTyping = useCallback((t: boolean) => driver.setTyping(t), [driver]);
  const onRead = useCallback((ids: string[]) => driver.markRead(ids), [driver]);
  const onRaise = useCallback(
    (kind: Parameters<typeof driver.raiseSos>[0]) => driver.raiseSos(kind),
    [driver],
  );
  const onCancelSos = useCallback((id: string) => driver.cancelSos(id), [driver]);

  if (!task && state.taskUnavailable) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
        <h1 className="font-display text-2xl text-gray-900">We can&apos;t find this request</h1>
        <p className="text-sm text-gray-600">
          It may have been made from another account, or the link is incomplete.
        </p>
        <Link
          href={paths.requesterHome}
          className="rounded-2xl bg-primary px-5 py-3 text-sm font-semibold text-white"
        >
          Back to your requests
        </Link>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="animate-spin text-primary" aria-label="Loading your request" />
      </div>
    );
  }

  const otherName = helper?.displayName ?? "your helper";
  /** Chat and the alarm are available from the moment a real person is attached, and stay
   *  available through completion — an alarm raised moments after a task was marked complete
   *  is exactly the case that must not be refused. */
  // A named helper who has not accepted (a booking, or one who said no) is not a companion:
  // there is nobody to message and nobody on the way to raise an alarm about.
  const hasCompanion =
    task.helperId != null && task.state !== "searching" && task.state !== "unmatched";

  /** The map leads every stage where somebody is being looked for or is on their way — the
   *  way a ride app does. Booked (nobody is coming yet) and the finished states have nothing
   *  for a map to show. */
  const booked = task.state === "searching" && task.helperId != null;
  const showMap =
    !booked && ["searching", "matched", "verifying", "en-route", "arrived"].includes(task.state);
  const searching = task.state === "searching" && !booked;
  const tracking = task.state === "en-route" || task.state === "arrived";

  return (
    <div className="mx-auto max-w-2xl">
      {showMap && (
        <div className="overflow-hidden sm:mt-6 sm:rounded-[28px] sm:px-0">
          <LiveMap
            bleed
            origin={task.origin}
            height="min(52vh, 460px)"
            searching={searching}
            nearby={searching ? state.helpersNearby.approxPoints : []}
            helper={
              tracking && state.location
                ? { lat: state.location.lat, lng: state.location.lng }
                : null
            }
            heading={state.location?.heading ?? 0}
            route={task.state === "en-route" ? (state.eta?.polyline ?? null) : null}
          />
        </div>
      )}
      <div
        className={`relative z-10 space-y-5 bg-background px-4 pb-10 sm:px-6 ${
          showMap
            ? "-mt-7 rounded-t-[28px] pt-5 shadow-[0_-12px_30px_rgba(15,92,92,0.10)] sm:mt-4 sm:rounded-[28px] sm:shadow-none"
            : "pt-8"
        }`}
      >
        {showMap && (
          <div className="mx-auto h-1.5 w-12 rounded-full bg-gray-300 sm:hidden" aria-hidden />
        )}
        {/* Connection state is never hidden. §2.1: the app must not silently pretend it is live
          during a drop — on this screen in particular, a frozen map that looks live is how
          someone concludes their helper has stopped moving. */}
        {connection !== "online" && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-900 ring-1 ring-inset ring-amber-200"
          >
            <WifiOff size={14} aria-hidden />
            {connection === "resyncing"
              ? "Reconnected — catching up on what you missed."
              : connection === "reconnecting"
                ? "Connection lost. Trying to reconnect…"
                : connection === "connecting"
                  ? "Connecting…"
                  : "You are offline. What you see may be out of date."}
          </div>
        )}

        {task.state === "searching" &&
          (task.helperId != null ? (
            // Assigned already: held for one person, never broadcast. See BookedStage.
            <BookedStage task={task} />
          ) : (
            <SearchingStage origin={task.origin} helpersNearby={state.helpersNearby} />
          ))}
        {task.state === "matched" && <MatchedStage helper={helper} />}
        {task.state === "verifying" && <VerifyingStage helper={helper} />}
        {task.state === "en-route" && (
          <EnRouteStage helper={helper} eta={state.eta} milestones={state.milestones} />
        )}
        {task.state === "arrived" && <ArrivedStage task={task} helper={helper} />}
        {task.state === "in-progress" && (
          <InProgressStage
            helperName={otherName}
            onComplete={() => driver.advanceTo("completed")}
          />
        )}
        {task.state === "completed" && <CompletedStage helper={helper} />}
        {task.state === "cancelled" && <CancelledStage />}
        {task.state === "unmatched" && <UnmatchedStage named={task.helperId != null} />}

        {hasCompanion && !isTerminal(task.state) && (
          <div id="task-chat" className="scroll-mt-24">
            <Chat
              messages={state.messages}
              userId={state.userId}
              otherTyping={state.otherTyping}
              otherName={otherName}
              onSend={onSend}
              onTyping={onTyping}
              onRead={onRead}
            />
          </div>
        )}

        {/* The alarm sits below the stage rather than floating over it: a control that overlaps
          the map is a control someone hits while pinching to zoom. */}
        {hasCompanion && (
          <div id={TASK_ALARM_ID}>
            <SosButton
              alert={state.sos}
              userId={state.userId}
              onRaise={onRaise}
              onCancel={onCancelSos}
            />
          </div>
        )}

        {/* Cancelling is offered while a search is still open — before anyone has committed to
          travelling, changing your mind costs nobody anything. It disappears once a helper is
          on the way, where it becomes a decision with a person on the other end of it. */}
        {task.state === "searching" && (
          <button
            type="button"
            onClick={() => driver.advanceTo("cancelled")}
            className="w-full text-sm text-gray-500 underline hover:text-gray-800"
          >
            Cancel this request
          </button>
        )}

        {isTerminal(task.state) && (
          <Link
            href={paths.requesterHome}
            className="block w-full rounded-xl bg-primary px-4 py-3 text-center text-sm font-semibold text-white"
          >
            Back to home
          </Link>
        )}
      </div>
    </div>
  );
}
