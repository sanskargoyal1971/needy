import type { ChatMessage, MatchedHelper, Task } from "@needy/shared";
import type { DbPool } from "../db.js";
import type {
  HelperProfileRepository,
  MessageRepository,
  TaskRepository,
} from "./stores.js";

/**
 * Postgres implementations of the durable repositories (§2.5). They satisfy exactly the same
 * interfaces as the in-memory versions in stores.ts, so nothing in the socket/HTTP layers
 * changes — index.ts simply chooses these when DATABASE_URL is configured.
 *
 * epoch-ms columns are BIGINT; pg returns those as strings, so every read coerces with
 * Number() (pg-mem may hand back numbers — Number() is a no-op there).
 */

interface TaskRow {
  id: string;
  requester_id: string;
  helper_id: string | null;
  category: string;
  state: string;
  origin_lat: number | string;
  origin_lng: number | string;
  title: string;
  description: string;
  price: number | string;
  service_code: string | null;
  scheduled_for: number | string | null;
  service_brief: string | null;
  handoff_otp_hash: string | null;
  handoff_otp_expires_at: number | string | null;
  handoff_verified_at: number | string | null;
  created_at: number | string;
  updated_at: number | string;
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    requesterId: r.requester_id,
    helperId: r.helper_id,
    category: r.category as Task["category"],
    state: r.state as Task["state"],
    origin: { lat: Number(r.origin_lat), lng: Number(r.origin_lng) },
    title: r.title,
    description: r.description,
    price: Number(r.price),
    serviceCode: r.service_code ?? null,
    scheduledFor: r.scheduled_for == null ? null : Number(r.scheduled_for),
    serviceBrief: r.service_brief ?? null,
    handoffOtpHash: r.handoff_otp_hash ?? null,
    handoffOtpExpiresAt:
      r.handoff_otp_expires_at == null ? null : Number(r.handoff_otp_expires_at),
    handoffVerifiedAt: r.handoff_verified_at == null ? null : Number(r.handoff_verified_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function createPgTaskRepo(pool: DbPool): TaskRepository {
  return {
    async get(id) {
      const { rows } = await pool.query<TaskRow>(`SELECT * FROM tasks WHERE id = $1`, [id]);
      return rows[0] ? rowToTask(rows[0]) : null;
    },

    async create(task) {
      await pool.query(
        `INSERT INTO tasks
           (id, requester_id, helper_id, category, state, origin_lat, origin_lng, title,
            description, price, service_code, scheduled_for, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          task.id,
          task.requesterId,
          task.helperId,
          task.category,
          task.state,
          task.origin.lat,
          task.origin.lng,
          task.title,
          task.description,
          task.price,
          task.serviceCode,
          task.scheduledFor,
          task.createdAt,
          task.updatedAt,
        ],
      );
      return task;
    },

    /**
     * Atomic partial update (audit C14).
     *
     * This used to be a read-modify-write that SELECTed the row, merged the patch in JS, and
     * then rewrote EVERY column — including `created_at` and `requester_id`. Two concurrent
     * callers would each read the same snapshot and the second write would silently discard
     * the first's change (a lost update). The Redis match lock only serializes `accept`;
     * `advance-task` and the SOS/chat paths were unprotected.
     *
     * Now a single UPDATE sets only the columns actually present in the patch and returns the
     * committed row, so the value we hand back is what the database really holds rather than
     * what we hoped it would hold. Immutable columns (`id`, `requester_id`, `created_at`) are
     * never writable: a task must not be able to change hands or backdate itself.
     */
    async update(id, patch) {
      const sets: string[] = [];
      const values: unknown[] = [id];
      const put = (column: string, value: unknown): void => {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      };

      if (patch.helperId !== undefined) put("helper_id", patch.helperId);
      if (patch.category !== undefined) put("category", patch.category);
      if (patch.state !== undefined) put("state", patch.state);
      if (patch.origin !== undefined) {
        put("origin_lat", patch.origin.lat);
        put("origin_lng", patch.origin.lng);
      }
      if (patch.title !== undefined) put("title", patch.title);
      if (patch.description !== undefined) put("description", patch.description);
      if (patch.price !== undefined) put("price", patch.price);
      if (patch.serviceCode !== undefined) put("service_code", patch.serviceCode);
      if (patch.scheduledFor !== undefined) put("scheduled_for", patch.scheduledFor);
      if (patch.serviceBrief !== undefined) put("service_brief", patch.serviceBrief);
      if (patch.handoffOtpHash !== undefined) put("handoff_otp_hash", patch.handoffOtpHash);
      if (patch.handoffOtpExpiresAt !== undefined)
        put("handoff_otp_expires_at", patch.handoffOtpExpiresAt);
      if (patch.handoffVerifiedAt !== undefined)
        put("handoff_verified_at", patch.handoffVerifiedAt);
      // Always stamp updatedAt so a caller that forgets can't leave a stale timestamp; an
      // explicit value in the patch still wins (callers pass deps.now() for test determinism).
      put("updated_at", patch.updatedAt ?? Date.now());

      const { rows } = await pool.query<TaskRow>(
        `UPDATE tasks SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
        values,
      );
      if (!rows[0]) throw new Error(`task not found: ${id}`);
      return rowToTask(rows[0]);
    },

    async activeForUser(userId) {
      const { rows } = await pool.query<TaskRow>(
        `SELECT * FROM tasks
         WHERE (requester_id = $1 OR helper_id = $1)
           AND state NOT IN ('completed', 'cancelled', 'unmatched')
         ORDER BY created_at DESC`,
        [userId],
      );
      return rows.map(rowToTask);
    },
  };
}

interface MessageRow {
  id: string;
  task_id: string;
  sender_id: string;
  body: string;
  created_at: number | string;
  status: string;
}

function rowToMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    taskId: r.task_id,
    senderId: r.sender_id,
    body: r.body,
    createdAt: Number(r.created_at),
    status: r.status as ChatMessage["status"],
  };
}

export function createPgMessageRepo(pool: DbPool): MessageRepository {
  return {
    async append(message) {
      await pool.query(
        `INSERT INTO messages (id, task_id, sender_id, body, created_at, status)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [message.id, message.taskId, message.senderId, message.body, message.createdAt, message.status],
      );
      return message;
    },

    async list(taskId) {
      const { rows } = await pool.query<MessageRow>(
        `SELECT * FROM messages WHERE task_id = $1 ORDER BY created_at ASC`,
        [taskId],
      );
      return rows.map(rowToMessage);
    },

    async setStatus(messageId, status) {
      const { rows } = await pool.query<MessageRow>(
        `UPDATE messages SET status = $2 WHERE id = $1 RETURNING *`,
        [messageId, status],
      );
      return rows[0] ? rowToMessage(rows[0]) : null;
    },

    /** Task-scoped status write (audit A3). `setStatus` keys on a global message id alone,
     *  which let `mark-read` flip receipts on ANY message in the system. The task id in the
     *  WHERE clause makes the caller's authorization for *that task* actually bind to the row
     *  being written, rather than being checked and then ignored. */
    async setStatusForTask(messageId, taskId, status) {
      const { rows } = await pool.query<MessageRow>(
        `UPDATE messages SET status = $3 WHERE id = $1 AND task_id = $2 RETURNING *`,
        [messageId, taskId, status],
      );
      return rows[0] ? rowToMessage(rows[0]) : null;
    },

    async get(messageId) {
      const { rows } = await pool.query<MessageRow>(
        `SELECT * FROM messages WHERE id = $1`,
        [messageId],
      );
      return rows[0] ? rowToMessage(rows[0]) : null;
    },
  };
}

interface HelperRow {
  id: string;
  display_name: string;
  photo_url: string;
  rating: number | string;
  helped_count: number | string;
}

export function createPgHelperProfileRepo(pool: DbPool): HelperProfileRepository {
  return {
    async get(helperId) {
      const { rows } = await pool.query<HelperRow>(`SELECT * FROM helpers WHERE id = $1`, [
        helperId,
      ]);
      const r = rows[0];
      if (!r) return null;
      const profile: Omit<MatchedHelper, "etaSeconds"> = {
        id: r.id,
        displayName: r.display_name,
        photoUrl: r.photo_url,
        rating: Number(r.rating),
        helpedCount: Number(r.helped_count),
      };
      return profile;
    },
    async addEarnings(helperId, amount) {
      await pool.query(
        `UPDATE helpers SET total_earnings = total_earnings + $2, helped_count = helped_count + 1 WHERE id = $1`,
        [helperId, amount],
      );
    },
  };
}

/** Bundle the three repos over one pool, matching the shape index.ts expects. */
export function createPgRepositories(pool: DbPool) {
  return {
    tasks: createPgTaskRepo(pool),
    messages: createPgMessageRepo(pool),
    helpers: createPgHelperProfileRepo(pool),
  };
}
