import type { DefaultEventsMap, Namespace, Socket } from "socket.io";
import { nanoid } from "nanoid";
import {
  NS,
  type ChatClientEvents,
  type ChatMessage,
  type ChatServerEvents,
} from "@needy/shared";
import type { NamespaceRegistrar } from "../domain/deps.js";
import { keys } from "../domain/keys.js";
import { CHAT_LIMIT, consumeToken } from "../services/ratelimit.js";
import type { SocketData } from "./auth.js";

/** ── /chat (§2.5) ──────────────────────────────────────────────────────────
 *  In-task messaging with typing indicators and sent→delivered→read receipts.
 *  Chat is scoped to per-task rooms; only task participants may join and speak. */

type ChatSocket = Socket<
  ChatClientEvents,
  ChatServerEvents,
  DefaultEventsMap,
  SocketData
>;

const room = (taskId: string): string => `task:${taskId}`;

/** No structured `error` event lives in ChatServerEvents, so surface handler-level
 *  refusals (e.g. joining a task you aren't part of) on a plain `error` channel. */
function emitError(socket: ChatSocket, event: string, message: string): void {
  (socket as Socket).emit("error", { event, message });
}

export const registerChat: NamespaceRegistrar = (deps) => {
  const nsp = deps.io.of(NS.chat) as unknown as Namespace<
    ChatClientEvents,
    ChatServerEvents,
    DefaultEventsMap,
    SocketData
  >;

  nsp.on("connection", (socket: ChatSocket) => {
    const userId = socket.data.user.sub;
    // Personal room so future direct pushes can target a user by id (§ convention).
    socket.join(`user:${userId}`);

    socket.on("join", async ({ taskId }) => {
      try {
        const task = await deps.tasks.get(taskId);
        const isParticipant =
          task != null &&
          (task.requesterId === userId || task.helperId === userId);
        if (!isParticipant) {
          emitError(socket, "join", "not a task participant");
          return;
        }
        socket.join(room(taskId));
      } catch (err) {
        deps.logger.error("chat join failed", { err, taskId, userId });
      }
    });

    socket.on("leave", ({ taskId }) => {
      try {
        socket.leave(room(taskId));
      } catch (err) {
        deps.logger.error("chat leave failed", { err, taskId, userId });
      }
    });

    socket.on("send", async ({ taskId, body }, ack) => {
      try {
        const allowed = await consumeToken(
          deps.redis.client,
          keys.chatBucket(userId),
          CHAT_LIMIT,
          deps.now(),
        );
        if (!allowed) {
          ack({ ok: false, error: "rate-limited" });
          return;
        }

        const trimmed = body.trim();
        if (trimmed.length === 0 || trimmed.length > 2000) {
          ack({ ok: false, error: "invalid-body" });
          return;
        }

        const message: ChatMessage = {
          id: nanoid(),
          taskId,
          senderId: userId,
          body: trimmed,
          createdAt: deps.now(),
          status: "sent",
        };
        await deps.messages.append(message);
        ack({ ok: true, message });

        // Fan out to everyone in the task room (including the sender, so their
        // optimistic message can reconcile against the authoritative server copy).
        nsp.to(room(taskId)).emit("message", message);

        // It reached the server and the room: promote sent → delivered.
        await deps.messages.setStatus(message.id, "delivered");
        nsp
          .to(room(taskId))
          .emit("receipt-changed", { taskId, messageId: message.id, status: "delivered" });
      } catch (err) {
        deps.logger.error("chat send failed", { err, taskId, userId });
        ack({ ok: false, error: "internal" });
      }
    });

    socket.on("typing", ({ taskId, isTyping }) => {
      try {
        // Relay to others only; the sender already knows it's typing.
        socket.to(room(taskId)).emit("helper-typing", { taskId, userId, isTyping });
      } catch (err) {
        deps.logger.error("chat typing relay failed", { err, taskId, userId });
      }
    });

    socket.on("mark-read", async ({ taskId, messageIds }) => {
      try {
        for (const messageId of messageIds) {
          await deps.messages.setStatus(messageId, "read");
          nsp
            .to(room(taskId))
            .emit("receipt-changed", { taskId, messageId, status: "read" });
        }
      } catch (err) {
        deps.logger.error("chat mark-read failed", { err, taskId, userId });
      }
    });
  });
};
