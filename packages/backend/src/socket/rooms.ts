import type { Socket } from "socket.io";
import type { Deps } from "../domain/deps.js";
import { emitSocketError } from "./validation.js";

/** ── Room membership ───────────────────────────────────────────────────────
 *  `socket.join()` looks synchronous and is, with the default in-memory adapter. With the
 *  Redis adapter it returns a Promise, and if that Promise rejects — Redis blip, failover
 *  mid-call — the socket is simply not in the room. Nothing throws at the call site, so the
 *  handler carries on and acks success while the user sits in a task they will never receive
 *  a message or a location update for.
 *
 *  Every call site therefore goes through these two helpers rather than calling `join`/`leave`
 *  directly (the lint rule below is what keeps that true). A failed join is reported to the
 *  client as an error, because a client that knows it isn't subscribed can retry, whereas one
 *  that believes it is subscribed will sit staring at a screen that never updates.
 */

/**
 * Join `room`, reporting failure rather than swallowing it.
 *
 * @returns true when membership is established. On false the caller must NOT proceed as
 *   though the client is subscribed — return early.
 */
export async function joinRoom(
  deps: Deps,
  socket: Socket,
  event: string,
  roomName: string,
  context?: Record<string, unknown>,
): Promise<boolean> {
  try {
    // `await` on a possibly-synchronous return is harmless; on the Redis adapter it is the
    // whole point.
    await socket.join(roomName);
    return true;
  } catch (err) {
    deps.logger.error("room join failed", { err, event, room: roomName, ...context });
    emitSocketError(socket, {
      event,
      code: "INTERNAL",
      message: "could not subscribe to updates — please retry",
    });
    return false;
  }
}

/**
 * Leave `room`. Unlike joining, a failure here is not worth interrupting the user over: the
 * socket will be dropped from every room when it disconnects anyway, so the worst case is
 * that a client keeps receiving updates it no longer displays. It is still logged, because a
 * pattern of these means the adapter is unhealthy.
 */
export async function leaveRoom(
  deps: Deps,
  socket: Socket,
  event: string,
  roomName: string,
  context?: Record<string, unknown>,
): Promise<void> {
  try {
    await socket.leave(roomName);
  } catch (err) {
    deps.logger.warn("room leave failed", { err, event, room: roomName, ...context });
  }
}
