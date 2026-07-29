import type { Socket } from "socket.io";
import { NS, type LatLng, type LocationUpdate } from "@needy/shared";
import type { Deps, NamespaceRegistrar } from "../domain/deps.js";
import { setTaskLocation, upsertHelperGeo } from "../domain/location-store.js";
import { computeEta } from "../services/eta.js";
import type { SocketData } from "./auth.js";

/** ── /tracking (§2.3) ────────────────────────────────────────────────────────
 *  The task's helper emits `location` every 3–5s while en route; the server stamps,
 *  persists (current position only) and relays `helper-moved` + a recomputed `eta` to
 *  everyone in the task room. Smooth interpolation between these updates is the client's
 *  job, so we relay each update as-is without extra throttling. */
export const registerTracking: NamespaceRegistrar = (deps: Deps): void => {
  const nsp = deps.io.of(NS.tracking);

  nsp.on("connection", (socket: Socket) => {
    const { sub: userId } = (socket.data as SocketData).user;
    // Personal room so targeted server-side pushes can reach this user (§ convention).
    socket.join(`user:${userId}`);

    socket.on("join", async (payload: { taskId: string }) => {
      try {
        const task = await deps.tasks.get(payload.taskId);
        if (
          !task ||
          (task.requesterId !== userId && task.helperId !== userId)
        ) {
          socket.emit("error", {
            event: "join",
            taskId: payload.taskId,
            code: "NOT_A_PARTICIPANT",
          });
          return;
        }
        socket.join(`task:${payload.taskId}`);
      } catch (err) {
        deps.logger.error("tracking join failed", {
          err: String(err),
          userId,
          taskId: payload?.taskId,
        });
      }
    });

    socket.on("leave", (payload: { taskId: string }) => {
      try {
        // Leaving only drops this socket from the room; the stored location stays put —
        // clearing it on task terminal state is the http/matching layer's job.
        socket.leave(`task:${payload.taskId}`);
      } catch (err) {
        deps.logger.error("tracking leave failed", {
          err: String(err),
          userId,
          taskId: payload?.taskId,
        });
      }
    });

    socket.on(
      "location",
      async (payload: {
        taskId: string;
        point: LatLng;
        heading?: number;
        speedMps?: number;
      }) => {
        try {
          const task = await deps.tasks.get(payload.taskId);
          // Only the matched helper may report position for a task.
          if (!task || task.helperId !== userId) {
            socket.emit("error", {
              event: "location",
              taskId: payload.taskId,
              code: "NOT_TASK_HELPER",
            });
            return;
          }

          const update: LocationUpdate = {
            lat: payload.point.lat,
            lng: payload.point.lng,
            heading: payload.heading,
            speedMps: payload.speedMps,
            at: deps.now(),
          };

          await setTaskLocation(deps.redis.client, task.id, update);
          await upsertHelperGeo(
            deps.redis.client,
            userId,
            update.lng,
            update.lat,
          );

          const room = `task:${task.id}`;
          nsp.to(room).emit("helper-moved", { taskId: task.id, update });

          const eta = await computeEta(payload.point, task.origin);
          nsp.to(room).emit("eta", {
            taskId: task.id,
            etaSeconds: eta.etaSeconds,
            distanceMeters: eta.distanceMeters,
          });
        } catch (err) {
          deps.logger.error("tracking location failed", {
            err: String(err),
            userId,
            taskId: payload?.taskId,
          });
        }
      },
    );
  });
};
