import type { DefaultEventsMap, Namespace, Socket } from "socket.io";
import { nanoid } from "nanoid";
import {
  makeSosAlert,
  NS,
  type SosAlert,
  type SosClientEvents,
  type SosServerEvents,
} from "@needy/shared";
import { emitSignal } from "../domain/abuseStore.js";
import type { Deps, NamespaceRegistrar } from "../domain/deps.js";
import { keys } from "../domain/keys.js";
import { getTaskLocation } from "../domain/location-store.js";
import { cancelSosEscalation, scheduleSosEscalation } from "../domain/sosEscalation.js";
import { consumeToken } from "../services/ratelimit.js";
import { requireParticipant } from "./guards.js";
import { joinRoom, leaveRoom } from "./rooms.js";
import {
  emitSocketError,
  optionalAck,
  parseOrRefuse,
  sosCancelSchema,
  sosRaiseSchema,
} from "./validation.js";

/** ── /sos ──────────────────────────────────────────────────────────────────
 *  The SOS button previously existed only as local component state: arming it set a React
 *  flag and nothing else. No server was told, no record was kept, no operator could see it.
 *  For an app whose users are explicitly elderly and vulnerable, a safety control that only
 *  *looks* like it works is worse than none — it converts a real emergency into a silent one.
 *
 *  This namespace makes the alarm real: durable (Postgres, so it survives a restart and can
 *  be audited afterwards), fanned out to both participants and any operator listener, and
 *  ACKNOWLEDGED back to the raiser so the UI can only claim "help has been notified" once
 *  the server has actually accepted responsibility for it.
 *
 *  Deliberately permissive by comparison with the rest of the app: EITHER participant may
 *  raise (a helper can be the one at risk), and we do not gate on task state beyond
 *  participation. When the question is "is somebody in danger", a false positive costs an
 *  operator a phone call; a false negative is the thing we are here to prevent. */

type SosSocket = Socket<
  SosClientEvents,
  SosServerEvents,
  DefaultEventsMap,
  { user: { sub: string } }
>;

/** Exported so the admin console's fan-out addresses the same rooms this namespace does —
 *  two hand-rolled `user:${id}` templates that drift apart would mean an operator's
 *  acknowledgement reaching the console and never reaching the frightened person. */
export const personalRoom = (userId: string) => `user:${userId}`;
/** Operators join this room to watch every live alert (trust & safety surface, Stage B). */
export const SOS_OPERATOR_ROOM = "sos:operators";

/** Generous but non-zero: a panicking user may well hit the button repeatedly, and each
 *  press should get through. This only exists to stop a compromised client turning the
 *  alarm channel into a flood, so the burst is large and the refill quick. */
const SOS_LIMIT = { capacity: 10, ratePerSec: 0.5 };

/** A console subscribes once per connection; a reconnect loop is the only legitimate repeat. */
const WATCH_LIMIT = { capacity: 5, ratePerSec: 0.2 };

/** How many alerts from one account within `SOS_REPEAT_WINDOW_MS` before the pattern is worth
 *  a human's attention. Set above the rate limiter's burst so the signal means "a sustained
 *  pattern", not "someone pressed the button twice while frightened".
 *
 *  Emphatically NOT an enforcement threshold — crossing it blocks nothing. A person raising
 *  four alarms in an hour is at least as likely to be in genuine trouble as to be abusing the
 *  button, which is exactly why a person reads it rather than a rule acting on it. */
const SOS_REPEAT_THRESHOLD = 4;
const SOS_REPEAT_WINDOW_MS = 60 * 60 * 1000;

/** A stand-down this fast is not a change of mind about an emergency. */
const SOS_INSTANT_CANCEL_MS = 15_000;

/** Cap on the backlog handed to a newly-connected operator. A console that has been unwatched
 *  for a long time should render the queue, not the entire history of the platform. */
const OPERATOR_BACKLOG_LIMIT = 100;

/**
 * May this socket watch every alert on the platform?
 *
 * Checked against the DURABLE user record, not the JWT's `role` claim, and this is the whole
 * point of the function. Access tokens live 15 minutes: a demoted admin, or one whose account
 * was blocked mid-incident, would otherwise keep a live window onto every emergency on the
 * platform — with locations and free-text notes — until their token happened to expire. The
 * feed is the most sensitive read in the system, so it pays a database round trip on
 * subscribe. It is once per socket, not per alert.
 */
async function isOperator(deps: Deps, userId: string): Promise<boolean> {
  const user = await deps.users.getById(userId);
  return Boolean(user && user.role === "admin" && user.blockedAt == null);
}

export const registerSos: NamespaceRegistrar = (deps) => {
  const nsp = deps.io.of(NS.sos) as unknown as Namespace<
    SosClientEvents,
    SosServerEvents,
    DefaultEventsMap,
    { user: { sub: string } }
  >;

  nsp.on("connection", (socket: SosSocket) => {
    const userId = socket.data.user.sub;
    void joinRoom(deps, socket, "connection", personalRoom(userId), { userId });

    socket.on("raise", async (payload, rawAck) => {
      // A missing callback must never be the reason an alarm fails. Without this, a client that
      // emits `raise` with no ack throws inside the handler — and on the success path that throw
      // lands after the alert is persisted but before the operator room is notified, so the row
      // exists and nobody is told. For an SOS that is the single worst outcome in the system.
      const ack = optionalAck(rawAck);
      const p = parseOrRefuse(socket as unknown as Socket, "raise", sosRaiseSchema, payload, ack);
      if (!p) return;

      try {
        const allowed = await consumeToken(
          deps.redis.client,
          keys.bucket("sos", userId),
          SOS_LIMIT,
          deps.now(),
        );
        if (!allowed) {
          emitSocketError(socket as unknown as Socket, {
            event: "raise",
            code: "RATE_LIMITED",
            message: "too many alerts",
            taskId: p.taskId,
          });
          return ack({ ok: false, error: "rate-limited" });
        }

        // Participation only — NOT requireLiveParticipant. An alarm raised moments after a
        // task was marked completed is exactly the case we must not refuse.
        const part = await requireParticipant(
          deps,
          socket as unknown as Socket,
          "raise",
          userId,
          p.taskId,
          ack,
        );
        if (!part) return;

        // Prefer the client's own reading; fall back to the last tracked position for the
        // task so responders still have somewhere to go if GPS is unavailable on the device.
        const tracked = p.at ?? (await getTaskLocation(deps.redis.client, p.taskId));
        const now = deps.now();
        const alert: SosAlert = makeSosAlert({
          id: nanoid(),
          taskId: p.taskId,
          raisedBy: userId,
          kind: p.kind,
          at: tracked ? { lat: tracked.lat, lng: tracked.lng } : null,
          note: p.note ?? null,
          createdAt: now,
          updatedAt: now,
        });

        // Persist BEFORE acknowledging. The ack is what licenses the UI to tell a frightened
        // person that help is coming, so it must not be sent until the alert is durable.
        await deps.sos.create(alert);

        // Arm escalation: if no operator acknowledges within the threshold, the on-call ladder
        // is paged (socket/sosEscalationSweep.ts). Before the ack, for the same reason the row
        // is: the ack is what lets the raiser's screen say help has been notified, and "if
        // nobody at the console answers, someone's phone rings" is part of that promise. It
        // costs one Redis write and never throws; the sweep's reconcile pass re-arms from the
        // row if it is lost.
        await scheduleSosEscalation(
          deps.redis.client,
          deps.logger,
          alert.id,
          now + deps.config.sos.escalateAfterSeconds * 1000,
        );
        ack({ ok: true, alert });

        // Log at error level: an SOS should trip alerting, not sit in a debug stream.
        deps.logger.error("SOS RAISED", {
          alertId: alert.id,
          taskId: alert.taskId,
          raisedBy: alert.raisedBy,
          kind: alert.kind,
        });

        const { task } = part;
        nsp
          .to(personalRoom(task.requesterId))
          .to(personalRoom(task.helperId ?? task.requesterId))
          .to(SOS_OPERATOR_ROOM)
          .emit("sos-raised", alert);

        // AGENTS.md requires an audit row for "every SOS trigger". The action constant has
        // existed in audit/log.ts since the log was written and nothing ever recorded it, so
        // the one event the requirement names by name was the one event missing from the
        // table. Deliberately after the fan-out: notifying people beats bookkeeping, and the
        // audit writer already swallows its own failures rather than propagating them.
        //
        // The note is NOT copied into the metadata. It is free text typed by someone in
        // distress and may contain anything at all; it belongs on the alert row an operator
        // reads deliberately, not in a long-lived table that is widely readable by staff.
        await deps.audit.record({
          action: "sos.raised",
          actorId: userId,
          subjectType: "sos",
          subjectId: alert.id,
          metadata: {
            taskId: alert.taskId,
            kind: alert.kind,
            hasLocation: alert.at != null,
          },
        });

        // A pattern worth a human's attention — never an automatic consequence.
        const recentCount = await deps.sos.countRaisedBySince(userId, now - SOS_REPEAT_WINDOW_MS);
        if (recentCount >= SOS_REPEAT_THRESHOLD) {
          await emitSignal(deps.abuse, "sos.repeated", userId, now, {
            taskId: alert.taskId,
            metadata: { countInWindow: recentCount, windowMs: SOS_REPEAT_WINDOW_MS },
          });
        }
      } catch (err) {
        deps.logger.error("sos raise failed", { err, taskId: p.taskId, userId });
        ack({ ok: false, error: "internal" });
      }
    });

    socket.on("cancel", async (payload, rawAck) => {
      const ack = optionalAck(rawAck);
      const p = parseOrRefuse(socket as unknown as Socket, "cancel", sosCancelSchema, payload, ack);
      if (!p) return;

      try {
        const existing = await deps.sos.get(p.alertId);
        if (!existing) return ack({ ok: false, error: "not-found" });

        // Only the person who raised it may stand it down. A helper must not be able to
        // silence a requester's alarm about them — that is precisely the abuse case.
        if (existing.raisedBy !== userId) {
          emitSocketError(socket as unknown as Socket, {
            event: "cancel",
            code: "NOT_AUTHORIZED",
            message: "only the raiser may cancel an alert",
            taskId: existing.taskId,
          });
          return ack({ ok: false, error: "not-authorized" });
        }

        const now = deps.now();
        const updated = await deps.sos.setStatus(p.alertId, "cancelled", now);
        if (!updated) return ack({ ok: false, error: "not-found" });
        // Nobody should be woken about an alarm its raiser has withdrawn. Never throws.
        await cancelSosEscalation(deps.redis.client, deps.logger, updated.id);
        ack({ ok: true, alert: updated });

        deps.logger.warn("SOS cancelled by raiser", {
          alertId: updated.id,
          taskId: updated.taskId,
        });

        // An alarm withdrawn within seconds was never an emergency — most likely a misfire in
        // a pocket, occasionally someone testing what the button does. Either way it costs an
        // operator a look, so a habit of it is worth surfacing. One is not a habit; the
        // console scores on the accumulation.
        if (now - updated.createdAt <= SOS_INSTANT_CANCEL_MS) {
          await emitSignal(deps.abuse, "sos.cancelled_immediately", userId, now, {
            taskId: updated.taskId,
            metadata: { heldForMs: now - updated.createdAt },
          });
        }

        const task = await deps.tasks.get(updated.taskId);
        nsp
          .to(personalRoom(updated.raisedBy))
          .to(personalRoom(task?.requesterId ?? updated.raisedBy))
          .to(personalRoom(task?.helperId ?? updated.raisedBy))
          .to(SOS_OPERATOR_ROOM)
          .emit("sos-updated", updated);
      } catch (err) {
        deps.logger.error("sos cancel failed", { err, alertId: p.alertId, userId });
        ack({ ok: false, error: "internal" });
      }
    });

    // ── the operator feed ────────────────────────────────────────────────────
    //
    // SOS_OPERATOR_ROOM has existed since the SOS namespace was written, and until now NOTHING
    // ever joined it outside a test. Every alert was being broadcast to an empty room: the
    // fan-out looked complete in the code and reached no operator in production. This handler
    // is the missing half — without it the console cannot exist, and "an operator has been
    // notified" was as untrue as the original local-useState button it replaced.
    socket.on("watch", async (rawAck) => {
      const ack = optionalAck(rawAck);
      try {
        // Bounded because this handler is not free: it costs a user lookup plus a query over
        // the open-alert index, and the authorization check comes AFTER, so an unauthorised
        // socket could otherwise drive both by looping the event. A console subscribes once
        // per connection, so a burst of five is invisible to it.
        const allowed = await consumeToken(
          deps.redis.client,
          keys.bucket("sos-watch", userId),
          WATCH_LIMIT,
          deps.now(),
        );
        if (!allowed) {
          emitSocketError(socket as unknown as Socket, {
            event: "watch",
            code: "RATE_LIMITED",
            message: "too many subscribe attempts",
          });
          return ack({ ok: false, error: "rate-limited" });
        }

        if (!(await isOperator(deps, userId))) {
          emitSocketError(socket as unknown as Socket, {
            event: "watch",
            code: "NOT_AUTHORIZED",
            message: "operator feed is admin-only",
          });
          // Logged at warn: a non-admin socket asking for the platform-wide emergency feed is
          // either a client bug or someone probing, and both are worth seeing.
          deps.logger.warn("non-operator asked to watch the SOS feed", { userId });
          return ack({ ok: false, error: "not-authorized" });
        }

        // Read the backlog BEFORE joining, then join, then ack.
        //
        // The order matters and the overlap is deliberate. Joining first would let an alert
        // raised in the intervening moment arrive as a live event before the console has any
        // list to add it to. Reading first means an alert raised between the read and the join
        // could be missed by both — so instead the read comes first and the join second, which
        // makes the failure mode a DUPLICATE (the console sees it in the backlog and again as
        // an event) rather than a MISS. A duplicate emergency is a redraw; a missed one is the
        // whole system failing at its one job. Consoles key alerts by id.
        const open = await deps.sos.listOpen(OPERATOR_BACKLOG_LIMIT);
        const joined = await joinRoom(
          deps,
          socket as unknown as Socket,
          "watch",
          SOS_OPERATOR_ROOM,
          {
            userId,
          },
        );
        if (!joined) return ack({ ok: false, error: "subscribe-failed" });

        deps.logger.info("operator watching the SOS feed", { userId, backlog: open.length });
        ack({ ok: true, open });
      } catch (err) {
        deps.logger.error("sos watch failed", { err, userId });
        ack({ ok: false, error: "internal" });
      }
    });

    socket.on("unwatch", () => {
      void leaveRoom(deps, socket as unknown as Socket, "unwatch", SOS_OPERATOR_ROOM, { userId });
    });
  });
};
