import type { DefaultEventsMap, Namespace, Socket } from "socket.io";
import { nanoid } from "nanoid";
import {
  NS,
  type SosAlert,
  type SosClientEvents,
  type SosServerEvents,
} from "@needy/shared";
import type { NamespaceRegistrar } from "../domain/deps.js";
import { keys } from "../domain/keys.js";
import { getTaskLocation } from "../domain/location-store.js";
import { consumeToken } from "../services/ratelimit.js";
import { requireParticipant } from "./guards.js";
import { emitSocketError, parseOrRefuse, sosCancelSchema, sosRaiseSchema } from "./validation.js";

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

type SosSocket = Socket<SosClientEvents, SosServerEvents, DefaultEventsMap, { user: { sub: string } }>;

const personalRoom = (userId: string) => `user:${userId}`;
/** Operators join this room to watch every live alert (trust & safety surface, Stage B). */
export const SOS_OPERATOR_ROOM = "sos:operators";

/** Generous but non-zero: a panicking user may well hit the button repeatedly, and each
 *  press should get through. This only exists to stop a compromised client turning the
 *  alarm channel into a flood, so the burst is large and the refill quick. */
const SOS_LIMIT = { capacity: 10, ratePerSec: 0.5 };

export const registerSos: NamespaceRegistrar = (deps) => {
  const nsp = deps.io.of(NS.sos) as unknown as Namespace<
    SosClientEvents,
    SosServerEvents,
    DefaultEventsMap,
    { user: { sub: string } }
  >;

  nsp.on("connection", (socket: SosSocket) => {
    const userId = socket.data.user.sub;
    socket.join(personalRoom(userId));

    socket.on("raise", async (payload, ack) => {
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
        const alert: SosAlert = {
          id: nanoid(),
          taskId: p.taskId,
          raisedBy: userId,
          kind: p.kind,
          status: "raised",
          at: tracked ? { lat: tracked.lat, lng: tracked.lng } : null,
          note: p.note ?? null,
          createdAt: now,
          updatedAt: now,
        };

        // Persist BEFORE acknowledging. The ack is what licenses the UI to tell a frightened
        // person that help is coming, so it must not be sent until the alert is durable.
        await deps.sos.create(alert);
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
      } catch (err) {
        deps.logger.error("sos raise failed", { err, taskId: p.taskId, userId });
        ack({ ok: false, error: "internal" });
      }
    });

    socket.on("cancel", async (payload, ack) => {
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

        const updated = await deps.sos.setStatus(p.alertId, "cancelled", deps.now());
        if (!updated) return ack({ ok: false, error: "not-found" });
        ack({ ok: true, alert: updated });

        deps.logger.warn("SOS cancelled by raiser", {
          alertId: updated.id,
          taskId: updated.taskId,
        });

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
  });
};
