import type { Socket } from "socket.io";
import {
  AWAY_AFTER_MS,
  HEARTBEAT_INTERVAL_MS,
  NS,
  type Presence,
} from "@needy/shared";
import type { NamespaceRegistrar } from "../domain/deps.js";
import {
  addPresenceSub,
  listPresenceSubs,
  patchPresence,
  readPresence,
  removePresenceSub,
} from "../domain/presence-store.js";
import type { SocketData } from "./auth.js";

/** /presence namespace (§2.2). Owns the socket wiring and the single away-sweep; the
 *  Redis hash shape itself lives in domain/presence-store so matching stays in lockstep.
 *  Presence-changed is fanned out only to a helper's subscribers, never globally. */
export const registerPresence: NamespaceRegistrar = (deps) => {
  const nsp = deps.io.of(NS.presence);
  const { client } = deps.redis;

  /** userIds with at least one live socket — the away-sweep only scans these so we never
   *  flip already-offline users, and it doubles as the sweep's work set. */
  const connected = new Set<string>();

  /** Fan a presence change out to everyone subscribed to this user (§2.2 scoping). */
  const broadcast = async (presence: Presence): Promise<void> => {
    const subs = await listPresenceSubs(client, presence.userId);
    for (const requesterId of subs) {
      nsp.to("user:" + requesterId).emit("presence-changed", presence);
    }
  };

  nsp.on("connection", (socket: Socket) => {
    const { sub: userId } = (socket.data as SocketData).user;
    socket.join("user:" + userId);
    connected.add(userId);

    void (async () => {
      try {
        const presence = await patchPresence(client, userId, {
          state: "online-available",
          activity: "idle",
          lastActiveAt: deps.now(),
        });
        await broadcast(presence);
      } catch (err) {
        deps.logger.error("presence: connect init failed", { err, userId });
      }
    })();

    socket.on("heartbeat", () => {
      void (async () => {
        try {
          const current = await readPresence(client, userId);
          // A heartbeat proves the user is back; lift a prior away flip.
          const state =
            current?.state === "away" ? "online-available" : current?.state;
          const presence = await patchPresence(client, userId, {
            lastActiveAt: deps.now(),
            ...(state ? { state } : {}),
          });
          await broadcast(presence);
        } catch (err) {
          deps.logger.error("presence: heartbeat failed", { err, userId });
        }
      })();
    });

    socket.on("set-activity", (activity) => {
      void (async () => {
        try {
          const presence = await patchPresence(client, userId, {
            activity,
            lastActiveAt: deps.now(),
          });
          await broadcast(presence);
        } catch (err) {
          deps.logger.error("presence: set-activity failed", { err, userId });
        }
      })();
    });

    socket.on("subscribe", ({ helperId }) => {
      void (async () => {
        try {
          await addPresenceSub(client, helperId, userId);
          // Hand the subscriber the helper's current presence so the UI has initial state
          // without waiting for the next change.
          const presence = await readPresence(client, helperId);
          if (presence) socket.emit("presence-changed", presence);
        } catch (err) {
          deps.logger.error("presence: subscribe failed", {
            err,
            userId,
            helperId,
          });
        }
      })();
    });

    socket.on("unsubscribe", ({ helperId }) => {
      void (async () => {
        try {
          await removePresenceSub(client, helperId, userId);
        } catch (err) {
          deps.logger.error("presence: unsubscribe failed", {
            err,
            userId,
            helperId,
          });
        }
      })();
    });

    socket.on("disconnect", () => {
      connected.delete(userId);
      void (async () => {
        try {
          const presence = await patchPresence(client, userId, {
            state: "offline",
          });
          await broadcast(presence);
        } catch (err) {
          deps.logger.error("presence: disconnect failed", { err, userId });
        }
      })();
    });
  });

  // Single away-sweep for the whole namespace (never per-socket): flip anyone who has gone
  // AWAY_AFTER_MS without a beat from online-* to away. The constant already encodes two
  // missed beats, so we never flip on a single miss.
  const sweep = setInterval(() => {
    void (async () => {
      const cutoff = deps.now() - AWAY_AFTER_MS;
      for (const userId of connected) {
        try {
          const current = await readPresence(client, userId);
          if (!current) continue;
          if (!current.state.startsWith("online-")) continue;
          if (current.lastActiveAt > cutoff) continue;
          const presence = await patchPresence(client, userId, {
            state: "away",
          });
          await broadcast(presence);
        } catch (err) {
          deps.logger.error("presence: away-sweep failed", { err, userId });
        }
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the process alive purely for the sweep.
  sweep.unref?.();
};
