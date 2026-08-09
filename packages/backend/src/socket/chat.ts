import type { DefaultEventsMap, Namespace, Socket } from "socket.io";
import { nanoid } from "nanoid";
import {
  NS,
  type ChatClientEvents,
  type ChatMessage,
  type ChatServerEvents,
} from "@needy/shared";
import type { Deps, NamespaceRegistrar } from "../domain/deps.js";
import { keys } from "../domain/keys.js";
import { emitSignal } from "../domain/abuseStore.js";
import { CHAT_LIMIT, consumeToken, type RateLimit } from "../services/ratelimit.js";
import { requireLiveParticipant, requireParticipant } from "./guards.js";
import { joinRoom, leaveRoom } from "./rooms.js";
import {
  chatMarkReadSchema,
  chatSendSchema,
  chatTypingSchema,
  emitSocketError,
  optionalAck,
  parseOrRefuse,
  taskIdSchema,
} from "./validation.js";
import type { SocketData } from "./auth.js";

/** ── /chat (§2.5) ──────────────────────────────────────────────────────────
 *  In-task messaging with typing indicators and sent→delivered→read receipts.
 *
 *  AUTHORIZATION (audit A3 — the most serious finding in this namespace). Only `join`
 *  ever checked participation. `send`, `typing` and `mark-read` checked NOTHING, so any
 *  holder of any valid JWT could:
 *    - `send` with an arbitrary taskId and have the message PERSISTED and broadcast into a
 *      stranger's private conversation (the room fan-out happily accepts a room the sender
 *      never joined — `nsp.to(room)` does not require membership),
 *    - flip receipts via `mark-read` on ANY message id in the global id space.
 *  Every mutating handler now opens with `requireLiveParticipant`, and `mark-read`
 *  additionally binds each write to the task (see below). Rooms are a fan-out mechanism,
 *  NEVER a security boundary — do not reintroduce "they're in the room, so they're allowed".
 *
 *  Every payload is parsed with the zod schemas in validation.ts first (audit B7), and
 *  every refusal surfaces as a typed `error` event (plus the ack where the contract has
 *  one) rather than a silent drop, so a misbehaving client is debuggable. */

type ChatSocket = Socket<
  ChatClientEvents,
  ChatServerEvents,
  DefaultEventsMap,
  SocketData
>;

const room = (taskId: string): string => `task:${taskId}`;

/**
 * How long a `clientMsgId` reservation survives (audit: clientMsgId was accepted and then
 * IGNORED, so an optimistic resend after a reconnect double-posted the message).
 *
 * A resend happens within seconds of the drop, so this only needs to comfortably outlive a
 * reconnect + retry cycle; 15 minutes is generous and keeps the key space bounded. Expressed
 * in real ms for Redis PX rather than via deps.now(), because it is a storage-lifetime
 * concern, not a decision the tests need to control.
 */
const CHAT_DEDUP_TTL_MS = 15 * 60 * 1000;

/** Typing indicators were entirely unbounded (audit C20 — the keys.bucket comment lists
 *  `typing` among the unlimited actions). A human toggles typing a handful of times per
 *  message, so a burst of 20 refilling at 4/s is invisible to a real client while stopping a
 *  loop from using the indicator as an amplified broadcast channel into a task room. */
const TYPING_LIMIT: RateLimit = { capacity: 20, ratePerSec: 4 };

/** `mark-read` was left unbounded. It is not harmless: one call carries up to 200 ids and each
 *  id costs a `messages.get`, so an authorized participant can drive ~200 repository reads per
 *  frame with no ceiling at all (and, before the already-read skip below, one room broadcast
 *  per id per replay). A real client marks a visible page read a few times a second at most, so
 *  a burst of 10 refilling at 2/s is invisible to it and caps the amplification. */
const MARK_READ_LIMIT: RateLimit = { capacity: 10, ratePerSec: 2 };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const registerChat: NamespaceRegistrar = (deps) => {
  const nsp = deps.io.of(NS.chat) as unknown as Namespace<
    ChatClientEvents,
    ChatServerEvents,
    DefaultEventsMap,
    SocketData
  >;
  const { client } = deps.redis;

  nsp.on("connection", (socket: ChatSocket) => {
    const userId = socket.data.user.sub;
    // Personal room so future direct pushes can target a user by id (§ convention).
    // Failure is logged and surfaced by `joinRoom`; there is nothing to abort here (the
    // per-task rooms below are what carry messages), so this is not awaited.
    void joinRoom(deps, socket, "connection", `user:${userId}`, { userId });

    socket.on("join", async (payload) => {
      const p = parseOrRefuse(socket, "join", taskIdSchema, payload);
      if (!p) return;
      try {
        // `requireParticipant`, not `requireLiveParticipant`: joining is read-only, and a
        // client re-opening a completed task should still be able to sit in the room and
        // receive the final receipt changes. Only the mutating handlers demand a live task.
        const participation = await requireParticipant(
          deps,
          socket,
          "join",
          userId,
          p.taskId,
        );
        if (!participation) return;
        // A join that fails leaves the client OUT of the room while its UI shows an open chat:
        // messages would be sent successfully and never received. `joinRoom` reports it, and
        // returning here is what stops us treating an unsubscribed client as subscribed.
        if (!(await joinRoom(deps, socket, "join", room(p.taskId), { userId }))) return;
      } catch (err) {
        deps.logger.error("chat join failed", { err: String(err), taskId: p.taskId, userId });
        emitSocketError(socket, {
          event: "join",
          code: "INTERNAL",
          message: "could not join task chat",
          taskId: p.taskId,
        });
      }
    });

    socket.on("leave", (payload) => {
      const p = parseOrRefuse(socket, "leave", taskIdSchema, payload);
      if (!p) return;
      void leaveRoom(deps, socket, "leave", room(p.taskId), { userId });
    });

    socket.on("send", async (payload, rawAck) => {
      // The contract types `ack` as required, but the wire is not bound by the contract: a client
      // that emits `send` with no callback would otherwise make every `ack(...)` below throw —
      // and the first one fires after the message is persisted but before it is broadcast,
      // durably storing a message that is delivered to nobody. Normalise once, here.
      const ack = optionalAck(rawAck);
      const p = parseOrRefuse(socket, "send", chatSendSchema, payload, ack);
      if (!p) return;
      const { taskId, clientMsgId } = p;

      try {
        // Rate limit BEFORE the authorization lookup: an unauthorized flood must also be
        // bounded, otherwise refusing it still costs a task read per message.
        const allowed = await consumeToken(
          client,
          keys.chatBucket(userId),
          CHAT_LIMIT,
          deps.now(),
        );
        if (!allowed) {
          emitSocketError(socket, {
            event: "send",
            code: "RATE_LIMITED",
            message: "too many messages; slow down",
            taskId,
          });
          // Emitted on every refusal, not on a threshold. The bucket has already absorbed the
          // legitimate burst — reaching this branch at all means the sender kept going past
          // it, and the console scores on the accumulation rather than on any single event.
          await emitSignal(deps.abuse, "chat.flood", userId, deps.now(), { taskId });
          ack({ ok: false, error: "rate-limited" });
          return;
        }

        // ── A3: participation is REQUIRED here, not just in `join`. ──
        const participation = await requireLiveParticipant(
          deps,
          socket,
          "send",
          userId,
          taskId,
          ack,
        );
        if (!participation) return;

        // The schema enforces 1–2000 chars, but " " passes `min(1)` and is not a message.
        const body = p.body.trim();
        if (body.length === 0) {
          emitSocketError(socket, {
            event: "send",
            code: "INVALID_PAYLOAD",
            message: "body: message is blank",
            taskId,
          });
          ack({ ok: false, error: "invalid-payload" });
          return;
        }

        // ── clientMsgId dedup ────────────────────────────────────────────────
        // Reserve the id with SET NX, never GET-then-SET: two resends racing on the same
        // clientMsgId (a reconnect flush firing while the original ack was still in flight)
        // would both read "absent" and both append. The reserved VALUE is the messageId we
        // are about to commit, so a duplicate can resolve the original row from the key
        // alone.
        const dedupKey = keys.chatDedup(taskId, clientMsgId);
        const messageId = nanoid();
        const reserved = await client.set(
          dedupKey,
          messageId,
          "PX",
          CHAT_DEDUP_TTL_MS,
          "NX",
        );

        if (reserved !== "OK") {
          const original = await resolveDuplicate(deps, client, taskId, dedupKey);
          if (original) {
            // Return the ORIGINAL message, so the client's optimistic copy reconciles
            // against the row that already exists instead of spawning a second one.
            ack({ ok: true, message: original });
            return;
          }
          // The reservation exists but its row isn't readable yet (or the winner rolled
          // back). Say so honestly and let the client retry rather than risk a double-post.
          emitSocketError(socket, {
            event: "send",
            code: "INTERNAL",
            message: "duplicate send still committing; retry",
            taskId,
          });
          ack({ ok: false, error: "duplicate-in-flight" });
          return;
        }

        const message: ChatMessage = {
          id: messageId,
          taskId,
          senderId: userId,
          body,
          createdAt: deps.now(),
          status: "sent",
        };

        try {
          await deps.messages.append(message);
        } catch (err) {
          // Release the reservation, otherwise a failed write would poison this clientMsgId
          // for the whole TTL and the client's retry could never succeed.
          await client.del(dedupKey);
          throw err;
        }

        ack({ ok: true, message });

        // Fan out to everyone in the task room (including the sender, so their
        // optimistic message can reconcile against the authoritative server copy).
        nsp.to(room(taskId)).emit("message", message);

        // It reached the server and the room: promote sent → delivered. Task-scoped write
        // for the same reason mark-read is (see below) — the row must belong to this task.
        await deps.messages.setStatusForTask(message.id, taskId, "delivered");
        nsp
          .to(room(taskId))
          .emit("receipt-changed", { taskId, messageId: message.id, status: "delivered" });
      } catch (err) {
        deps.logger.error("chat send failed", { err: String(err), taskId, userId });
        ack({ ok: false, error: "internal" });
      }
    });

    socket.on("typing", async (payload) => {
      const p = parseOrRefuse(socket, "typing", chatTypingSchema, payload);
      if (!p) return;
      const { taskId, isTyping } = p;
      try {
        const allowed = await consumeToken(
          client,
          keys.bucket("chat-typing", userId),
          TYPING_LIMIT,
          deps.now(),
        );
        if (!allowed) {
          emitSocketError(socket, {
            event: "typing",
            code: "RATE_LIMITED",
            message: "too many typing updates",
            taskId,
          });
          return;
        }

        // ── A3: a stranger could previously push a typing indicator into any task room,
        // which both leaks that they know the task id and fakes the presence of a person.
        const participation = await requireLiveParticipant(
          deps,
          socket,
          "typing",
          userId,
          taskId,
        );
        if (!participation) return;

        // Relay to others only; the sender already knows it's typing.
        socket.to(room(taskId)).emit("helper-typing", { taskId, userId, isTyping });
      } catch (err) {
        deps.logger.error("chat typing relay failed", { err: String(err), taskId, userId });
      }
    });

    socket.on("mark-read", async (payload) => {
      const p = parseOrRefuse(socket, "mark-read", chatMarkReadSchema, payload);
      if (!p) return;
      const { taskId, messageIds } = p;
      try {
        // Bounded BEFORE the per-id repository reads below, for the same reason `send` limits
        // before its authorization lookup: otherwise a 200-id frame costs 200 `messages.get`
        // calls however often it is repeated, and a participant can replay it in a loop.
        const allowed = await consumeToken(
          client,
          keys.bucket("chat-mark-read", userId),
          MARK_READ_LIMIT,
          deps.now(),
        );
        if (!allowed) {
          emitSocketError(socket, {
            event: "mark-read",
            code: "RATE_LIMITED",
            message: "too many read receipts; slow down",
            taskId,
          });
          return;
        }

        const participation = await requireLiveParticipant(
          deps,
          socket,
          "mark-read",
          userId,
          taskId,
        );
        if (!participation) return;

        // Being a participant of `taskId` is necessary but NOT sufficient: the ids come from
        // the client and `setStatus` keys on the GLOBAL message id space, so a participant of
        // their own task could otherwise flip receipts on a stranger's conversation. Two
        // further checks per id:
        //   1. the message must actually belong to THIS task, and
        //   2. it must not be the caller's own message — marking your own message read is
        //      meaningless, and allowing it would let a sender forge "they read it".
        // `setStatusForTask` re-asserts (1) in the write itself, so the check can't be
        // bypassed by a row that changes between the read and the write.
        let refused = 0;
        for (const messageId of messageIds) {
          const existing = await deps.messages.get(messageId);
          if (!existing || existing.taskId !== taskId) {
            refused += 1;
            continue;
          }
          // Skipped, NOT refused: a client marking a visible page read naturally includes its
          // own messages, so this is expected traffic rather than a client bug.
          if (existing.senderId === userId) continue;

          // Already read — skip silently. `setStatusForTask` is a blind UPDATE, so without this
          // a replayed mark-read re-emits `receipt-changed` into the room for a row that did not
          // change: a participant could replay one frame in a loop and turn `mark-read` into an
          // amplified broadcast channel (the same reason `typing` is rate limited). Re-marking a
          // page read on scroll is also completely normal client traffic, so this is the common
          // case, not an edge one.
          if (existing.status === "read") continue;

          const updated = await deps.messages.setStatusForTask(messageId, taskId, "read");
          if (!updated) {
            refused += 1;
            continue;
          }
          // Only broadcast receipts we actually wrote — a fan-out for a row we refused would
          // tell every client a lie.
          nsp
            .to(room(taskId))
            .emit("receipt-changed", { taskId, messageId, status: "read" });
        }

        // Ids that don't live in this task are refused loudly (one aggregate error, not one
        // per id) rather than silently dropped: for a well-behaved client this can't happen,
        // so it is either a real bug or someone probing the global id space. The message
        // deliberately reports only a COUNT — naming which ids were rejected would confirm
        // whether an id exists elsewhere.
        if (refused > 0) {
          emitSocketError(socket, {
            event: "mark-read",
            code: "NOT_AUTHORIZED",
            message: `${refused} message id(s) do not belong to this task`,
            taskId,
          });
        }
      } catch (err) {
        deps.logger.error("chat mark-read failed", { err: String(err), taskId, userId });
      }
    });
  });
};

/**
 * Resolve the message a losing duplicate `send` should be handed back.
 *
 * The reservation is written before the row is appended, so a true simultaneous duplicate can
 * observe the key while the winner's `append` is still in flight. A short bounded poll covers
 * that window; we deliberately do NOT block indefinitely — returning null and asking the
 * client to retry is better than holding an ack open, and far better than appending a second
 * row (which is the exact bug this whole mechanism exists to prevent).
 */
async function resolveDuplicate(
  deps: Deps,
  client: Deps["redis"]["client"],
  taskId: string,
  dedupKey: string,
): Promise<ChatMessage | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const originalId = await client.get(dedupKey);
    // The key vanished — the winner rolled back its reservation after a failed write, so
    // there is nothing to reconcile against and the caller should retry cleanly.
    if (originalId == null) return null;

    const original = await deps.messages.get(originalId);
    // The taskId guard matters even here: the key is task-scoped, but never trust a stored
    // id to point where you assume it does.
    if (original && original.taskId === taskId) return original;

    await sleep(20);
  }
  deps.logger.warn("chat dedup: reserved message never materialized", { taskId, dedupKey });
  return null;
}
