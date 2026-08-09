"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  isSosOpen,
  NS,
  type SosAlert,
  type SosClientEvents,
  type SosServerEvents,
} from "@needy/shared";
import { API_BASE } from "@/lib/apiConfig";
import { adminClient, type AlertView } from "@/lib/adminClient";

/** ── The live operator feed ────────────────────────────────────────────────
 *  A polled console would be the wrong instrument. The gap between "someone pressed the
 *  button" and "an operator saw it" is the number this whole subsystem is judged on, and a
 *  30-second poll builds an average 15 seconds of that gap into the design on purpose.
 *
 *  So the queue is socket-fed, with REST used only for the enrichment the socket does not
 *  carry: `sos-raised` delivers the bare `SosAlert`, while the console wants the task and both
 *  parties' names and numbers. A live alert therefore arrives immediately in a minimal form
 *  and is upgraded a moment later — the operator sees the alarm at once and the phone number
 *  a beat behind, rather than seeing nothing until both are ready.
 *
 *  `connected` is surfaced and rendered. An operator staring at an empty queue must be able to
 *  tell "nothing is happening" from "this console stopped listening ten minutes ago"; those
 *  look identical otherwise, and only one of them is fine.
 */

export type FeedStatus = "connecting" | "watching" | "refused" | "disconnected";

type OperatorSocket = Socket<SosServerEvents, SosClientEvents>;

/** The socket's payload widened to the console's view type — `task`, `requester` and `helper`
 *  are absent until the REST enrichment lands. */
function bare(alert: SosAlert): AlertView {
  return { ...alert, task: null, requester: null, helper: null, raisedByRole: "unknown" };
}

export interface SosFeed {
  alerts: AlertView[];
  status: FeedStatus;
  error: string | null;
  /** Replace one alert in place, for the ack/resolve responses which return the full view. */
  replace: (alert: AlertView) => void;
  refresh: () => Promise<void>;
}

export function useSosFeed(): SosFeed {
  const [alerts, setAlerts] = useState<AlertView[]>([]);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<OperatorSocket | null>(null);

  /** Merge by id, keeping the richer copy.
   *
   *  This is what makes the deliberate backlog/live overlap on the server safe: `watch` reads
   *  the open queue BEFORE joining the room, so an alert raised in between arrives twice. The
   *  server chose a duplicate over a miss; this is the half that makes the duplicate
   *  invisible. Never keyed on anything but `id`. */
  const upsert = useCallback((incoming: AlertView) => {
    setAlerts((prev) => {
      const at = prev.findIndex((a) => a.id === incoming.id);
      const merged: AlertView =
        at === -1
          ? incoming
          : {
              ...prev[at],
              ...incoming,
              // A live socket payload has no context attached; it must not blank out context
              // the REST enrichment already provided.
              task: incoming.task ?? prev[at].task,
              requester: incoming.requester ?? prev[at].requester,
              helper: incoming.helper ?? prev[at].helper,
              raisedByRole:
                incoming.raisedByRole === "unknown" ? prev[at].raisedByRole : incoming.raisedByRole,
            };
      const next = at === -1 ? [...prev, merged] : prev.map((a, i) => (i === at ? merged : a));
      // Oldest first: the person waiting longest is the one to answer next. Closed alerts stay
      // in the list for the rest of the session rather than vanishing under the operator's
      // cursor — they are dimmed instead, so a mis-click is visible and undoable by reloading.
      return next.sort((a, b) => a.createdAt - b.createdAt);
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { alerts: open } = await adminClient.sosQueue("open");
      open.forEach(upsert);
      setError(null);
    } catch {
      setError("Could not load the alert queue.");
    }
  }, [upsert]);

  useEffect(() => {
    // withCredentials so the httpOnly access cookie rides along — there is no token to pass,
    // which is the point of the cookies being unreadable from script.
    const socket: OperatorSocket = io(`${API_BASE}${NS.sos}`, {
      withCredentials: true,
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setStatus("connecting");
      socket.emit("watch", (result) => {
        if (!result.ok) {
          setStatus("refused");
          setError(
            result.error === "not-authorized"
              ? "This account is not authorised for the alert feed."
              : "Could not subscribe to the alert feed.",
          );
          return;
        }
        setStatus("watching");
        setError(null);
        result.open.forEach((a) => upsert(bare(a)));
        // Enrich the backlog with task + participant context.
        void refresh();
      });
    });

    socket.on("sos-raised", (alert) => {
      upsert(bare(alert));
      // Fetch the context this payload does not carry. The alert is already on screen.
      void refresh();
    });
    socket.on("sos-updated", (alert) => upsert(bare(alert)));

    socket.on("disconnect", () => setStatus("disconnected"));
    socket.on("connect_error", () => {
      setStatus("disconnected");
      setError("Lost the connection to the alert feed.");
    });

    return () => {
      socket.off();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [upsert, refresh]);

  return { alerts, status, error, replace: upsert, refresh };
}

/** Split for rendering: open alerts on top, everything settled below. */
export function partitionAlerts(alerts: AlertView[]): { open: AlertView[]; closed: AlertView[] } {
  return {
    open: alerts.filter(isSosOpen),
    closed: alerts.filter((a) => !isSosOpen(a)).reverse(),
  };
}
