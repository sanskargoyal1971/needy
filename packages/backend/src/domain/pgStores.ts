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
           (id, requester_id, helper_id, category, state, origin_lat, origin_lng, title, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          task.id,
          task.requesterId,
          task.helperId,
          task.category,
          task.state,
          task.origin.lat,
          task.origin.lng,
          task.title,
          task.createdAt,
          task.updatedAt,
        ],
      );
      return task;
    },

    // Read-modify-write, mirroring the in-memory repo. Callers that need atomicity across a
    // read+update (matching accept) already serialize via the Redis match lock.
    async update(id, patch) {
      const existing = await this.get(id);
      if (!existing) throw new Error(`task not found: ${id}`);
      const next: Task = { ...existing, ...patch, id: existing.id };
      await pool.query(
        `UPDATE tasks SET
           requester_id = $2, helper_id = $3, category = $4, state = $5,
           origin_lat = $6, origin_lng = $7, title = $8, created_at = $9, updated_at = $10
         WHERE id = $1`,
        [
          next.id,
          next.requesterId,
          next.helperId,
          next.category,
          next.state,
          next.origin.lat,
          next.origin.lng,
          next.title,
          next.createdAt,
          next.updatedAt,
        ],
      );
      return next;
    },

    async activeForUser(userId) {
      const { rows } = await pool.query<TaskRow>(
        `SELECT * FROM tasks
         WHERE (requester_id = $1 OR helper_id = $1)
           AND state NOT IN ('completed', 'cancelled')
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
