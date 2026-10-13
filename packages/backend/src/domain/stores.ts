import { isTerminal, type ChatMessage, type Task, type MatchedHelper } from "@needy/shared";

/** Durable data lives behind these interfaces so Phase 1 can run on in-memory impls and
 *  later swap to Postgres without touching any namespace/service code. */
export interface TaskRepository {
  get(taskId: string): Promise<Task | null>;
  create(task: Task): Promise<Task>;
  update(taskId: string, patch: Partial<Task>): Promise<Task>;
  activeForUser(userId: string): Promise<Task[]>;
}

export interface MessageRepository {
  append(message: ChatMessage): Promise<ChatMessage>;
  list(taskId: string): Promise<ChatMessage[]>;
  setStatus(messageId: string, status: ChatMessage["status"]): Promise<ChatMessage | null>;
  /** Task-scoped status write (audit A3). `setStatus` keys on a global message id, so
   *  `mark-read` could flip receipts on ANY message in the system regardless of which task
   *  the caller belonged to. Binding the task id into the write makes the caller's
   *  authorization for that task actually constrain the row being changed. Returns null when
   *  the message doesn't exist OR belongs to a different task — the caller cannot tell which,
   *  which is deliberate: otherwise this becomes an oracle for probing message ids. */
  setStatusForTask(
    messageId: string,
    taskId: string,
    status: ChatMessage["status"],
  ): Promise<ChatMessage | null>;
  get(messageId: string): Promise<ChatMessage | null>;
}

/** Minimal helper-profile lookup for the match reveal card (§3 Stage 2). Backed by
 *  KYC-verified profile data in production; in-memory seed for Phase 1. */
export interface HelperProfileRepository {
  get(helperId: string): Promise<Omit<MatchedHelper, "etaSeconds"> | null>;
  addEarnings(helperId: string, amount: number): Promise<void>;
}

// ── In-memory implementations (Phase 1) ─────────────────────────────────────

export function createInMemoryTaskRepo(): TaskRepository {
  const tasks = new Map<string, Task>();
  return {
    async get(id) {
      return tasks.get(id) ?? null;
    },
    async create(task) {
      tasks.set(task.id, task);
      return task;
    },
    async update(id, patch) {
      const existing = tasks.get(id);
      if (!existing) throw new Error(`task not found: ${id}`);
      // Respect an updatedAt supplied in the patch (callers pass deps.now()); the id is
      // pinned so a patch can never repoint the row.
      const next = { ...existing, ...patch, id: existing.id };
      tasks.set(id, next);
      return next;
    },
    async activeForUser(userId) {
      return [...tasks.values()].filter(
        (t) => (t.requesterId === userId || t.helperId === userId) && !isTerminal(t.state),
      );
    },
  };
}

export function createInMemoryMessageRepo(): MessageRepository {
  const byTask = new Map<string, ChatMessage[]>();
  const byId = new Map<string, ChatMessage>();
  return {
    async append(message) {
      const list = byTask.get(message.taskId) ?? [];
      list.push(message);
      byTask.set(message.taskId, list);
      byId.set(message.id, message);
      return message;
    },
    async list(taskId) {
      return byTask.get(taskId) ?? [];
    },
    async setStatus(messageId, status) {
      const msg = byId.get(messageId);
      if (!msg) return null;
      msg.status = status;
      return msg;
    },
    async setStatusForTask(messageId, taskId, status) {
      const msg = byId.get(messageId);
      // The taskId check is the point: without it a caller authorized for one task could
      // rewrite receipts on another task's messages (audit A3).
      if (!msg || msg.taskId !== taskId) return null;
      msg.status = status;
      return msg;
    },
    async get(messageId) {
      return byId.get(messageId) ?? null;
    },
  };
}

export function createInMemoryHelperProfileRepo(
  seed: Record<string, Omit<MatchedHelper, "etaSeconds">> = {},
): HelperProfileRepository {
  const profiles = new Map(Object.entries(seed));
  return {
    async get(helperId) {
      return profiles.get(helperId) ?? null;
    },
    async addEarnings(_helperId, _amount) {
      // Intentionally a no-op. The in-memory store backs tests and the no-Postgres dev boot,
      // where the seeded profile has no earnings ledger to credit; the Postgres store in
      // pgStores.ts is the one that actually persists. Named with `_` so the unused-args rule
      // records this as deliberate rather than an unfinished implementation.
    },
  };
}
