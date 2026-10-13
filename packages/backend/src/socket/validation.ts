import { z } from "zod";
import { ADVANCEABLE_STATES, type SocketErrorPayload } from "@needy/shared";
import type { Socket } from "socket.io";

/** ── Socket payload validation (audit B7) ──────────────────────────────────
 *  Before this, zod was used across `auth/` and NOWHERE else: every socket handler
 *  destructured whatever the client sent and passed it straight to Redis. `NaN`,
 *  `Infinity`, out-of-range coordinates and non-strings reached `geoadd` and the ETA
 *  maths. `shared`'s `isLatLng` existed for exactly this and was never called.
 *
 *  Every handler now parses its payload here first and refuses on failure with a typed
 *  `error` event — never a silent drop, so a buggy client is debuggable rather than
 *  mysteriously ignored.
 */

/** A finite number — rejects NaN and ±Infinity, which `z.number()` alone permits. */
const finite = z.number().finite();

export const latLngSchema = z.object({
  lat: finite.min(-90).max(90),
  lng: finite.min(-180).max(180),
});

/** Ids are opaque nanoid/uuid strings. Bounded so a payload can't be a megabyte of text
 *  used as a Redis key. */
const id = z.string().min(1).max(128);

export const taskIdSchema = z.object({ taskId: id });

export const locationSchema = z.object({
  taskId: id,
  point: latLngSchema,
  /** Compass degrees. Normalised rather than rejected: clients wrap 360 inconsistently. */
  heading: finite.min(0).max(360).optional(),
  /** Sanity ceiling ~360 km/h — anything faster is a bad sensor reading, not a helper. */
  speedMps: finite.min(0).max(100).optional(),
});

export const publishAvailabilitySchema = z.object({
  point: latLngSchema,
  available: z.boolean(),
});

export const subscribeSchema = z.object({ helperId: id });

export const setActivitySchema = z.enum([
  "idle",
  "heading-to-task",
  "in-task",
  "just-finished-nearby",
]);

export const chatSendSchema = z.object({
  taskId: id,
  /** Client-generated dedup key (audit: previously accepted then ignored). */
  clientMsgId: z.string().min(1).max(128),
  body: z.string().min(1).max(2000),
});

export const chatTypingSchema = z.object({ taskId: id, isTyping: z.boolean() });

export const chatMarkReadSchema = z.object({
  taskId: id,
  /** Bounded so one call can't ask us to write thousands of rows. */
  messageIds: z.array(id).min(1).max(200),
});

export const advanceTaskSchema = z.object({
  taskId: id,
  to: z.enum(ADVANCEABLE_STATES as unknown as [string, ...string[]]),
});

export const sosRaiseSchema = z.object({
  taskId: id,
  kind: z.enum(["panic", "medical", "unsafe", "other"]),
  at: latLngSchema.optional(),
  note: z.string().max(1000).optional(),
});

export const sosCancelSchema = z.object({ alertId: id });

/** Emit a typed refusal. Namespaces declare `error` in their ServerEvents, but the cast
 *  keeps this usable from handlers whose socket is typed to a specific namespace. */
export function emitSocketError(socket: Socket, payload: SocketErrorPayload): void {
  (socket as unknown as { emit: (e: string, p: unknown) => void }).emit("error", payload);
}

/**
 * Normalise a possibly-absent acknowledgement into one that is always callable.
 *
 * The typed contract in `shared/events.ts` declares `ack` as required on `send`, but a socket
 * payload is whatever the wire delivers: a client — buggy, outdated, or hostile — can emit
 * `send` with no callback at all, and socket.io hands the handler `undefined`. Calling it then
 * throws `ack is not a function` *mid-handler*.
 *
 * That is not merely noise. In `send` the ack fires AFTER the message is persisted and BEFORE
 * it is broadcast, so the throw would leave the message durably stored and never delivered to
 * anyone — the sender sees nothing, the recipient sees nothing, and the row sits in Postgres.
 * A silent write-then-drop is the worst available outcome for a chat, and it is trivially
 * reachable from any client. Handlers therefore wrap the parameter once, at the top, and call
 * the result freely instead of remembering `?.` at six separate call sites.
 *
 * A dropped ack is logged at debug rather than refused: the message itself is well-formed and
 * the sender simply forfeits their receipt, which is a strictly better outcome than rejecting
 * a legitimate message because the client's socket.io version disagrees about callbacks.
 */
export function optionalAck<A extends (result: never) => void>(
  ack: A | undefined,
): (result: Parameters<A>[0]) => void {
  if (typeof ack === "function") return ack as (result: Parameters<A>[0]) => void;
  return () => {
    /* no callback supplied — nothing to acknowledge to */
  };
}

/**
 * Parse `payload` or refuse. Returns the typed value on success and `null` on failure,
 * having already emitted the error — so a handler reads:
 *
 *   const p = parseOrRefuse(socket, "location", locationSchema, payload);
 *   if (!p) return;
 *
 * `ack` is invoked too when the event is a request/response one, otherwise a validation
 * failure would hang the caller's promise forever.
 */
export function parseOrRefuse<T extends z.ZodTypeAny>(
  socket: Socket,
  event: string,
  schema: T,
  payload: unknown,
  ack?: (result: { ok: false; error: string }) => void,
): z.infer<T> | null {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data as z.infer<T>;

  const message = parsed.error.issues
    .map((i) => `${i.path.join(".") || "payload"}: ${i.message}`)
    .join("; ")
    .slice(0, 300);

  emitSocketError(socket, {
    event,
    code: "INVALID_PAYLOAD",
    message,
    ...(typeof (payload as { taskId?: unknown })?.taskId === "string"
      ? { taskId: (payload as { taskId: string }).taskId }
      : {}),
  });
  ack?.({ ok: false, error: "invalid-payload" });
  return null;
}
