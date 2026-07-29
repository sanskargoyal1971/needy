import type { ChatMessage, Task, MatchedHelper } from "@needy/shared";

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
}

/** Minimal helper-profile lookup for the match reveal card (§3 Stage 2). Backed by
 *  KYC-verified profile data in production; in-memory seed for Phase 1. */
export interface HelperProfileRepository {
  get(helperId: string): Promise<Omit<MatchedHelper, "etaSeconds"> | null>;
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
        (t) =>
          (t.requesterId === userId || t.helperId === userId) &&
          t.state !== "completed" &&
          t.state !== "cancelled",
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
  };
}
