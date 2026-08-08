import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AVAILABILITY_TTL_MS,
  AWAY_AFTER_MS,
  CLIENT_HEARTBEAT_INTERVAL_MS,
  type SosAlert,
  type Task,
} from "@needy/shared";

/**
 * ── The helper client, which is the half of the protocol nothing exercised ────
 *
 * The audit's A1 (idle helpers can never be discovered), A2 ("test it BOTH ways"), A6 (the ETA
 * read with the wrong key) and B13 (`ME = "me"`) all live on the helper's side of the wire, and
 * before this file there was no helper client at all — so none of them could be reproduced,
 * let alone regression-tested. The requester's suite is the sibling of this one
 * (heartbeat.test.ts); the transport rules are asserted again here rather than assumed shared,
 * because they are implemented in a second class and "the other client does it" is exactly the
 * assumption that let A2 ship.
 *
 * The socket.io Manager is stubbed rather than a server stood up: what is under test is the
 * CLIENT's discipline — which namespace a position goes to, that a timer exists and is singular,
 * that a claim is only made after an ack. Those are all decisions made before a byte leaves the
 * process. The real-Redis proofs of the server side are in
 * backend/src/socket/__tests__/presence.availability.test.ts.
 */

interface FakeSocket {
  connected: boolean;
  active: boolean;
  emit: ReturnType<typeof vi.fn>;
  on: (event: string, handler: (...args: unknown[]) => void) => FakeSocket;
  removeAllListeners: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  fire: (event: string, ...args: unknown[]) => void;
}

function makeSocket(): FakeSocket {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const socket: FakeSocket = {
    connected: false,
    active: true,
    emit: vi.fn(),
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return socket;
    },
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(),
    fire(event, ...args) {
      for (const h of handlers.get(event) ?? []) h(...args);
    },
  };
  return socket;
}

const sockets = new Map<string, FakeSocket>();
let manager: { fire: (event: string, ...args: unknown[]) => void } | null = null;

vi.mock("socket.io-client", () => {
  class FakeManager {
    private readonly handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    constructor() {
      manager = this;
    }
    socket(namespace: string): FakeSocket {
      const s = makeSocket();
      sockets.set(namespace, s);
      return s;
    }
    on(event: string, handler: (...a: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }
    fire(event: string, ...args: unknown[]): void {
      for (const h of this.handlers.get(event) ?? []) h(...args);
    }
    removeAllListeners = vi.fn();
  }
  return { Manager: FakeManager };
});

const { RealHelperClient } = await import("../helperClient.js");

const ME = "helper-me-1";
const THEM = "requester-them-1";
const HERE = { lat: 12.9716, lng: 77.5946 };
const MOVED = { lat: 12.9725, lng: 77.5951 };
const TASK_ID = "task-h-1";

function socket(ns: string): FakeSocket {
  const s = sockets.get(ns);
  if (!s) throw new Error(`${ns} socket was never created`);
  return s;
}

/** All frames of one kind on one namespace, payload only. */
function frames(ns: string, event: string): unknown[] {
  return socket(ns)
    .emit.mock.calls.filter((c) => c[0] === event)
    .map((c) => c[1]);
}

/** Invoke the ack callback of the LAST frame of this kind, as the server would. */
function ackLast(ns: string, event: string, result: unknown): void {
  const calls = socket(ns).emit.mock.calls.filter((c) => c[0] === event);
  const last = calls[calls.length - 1];
  if (!last) throw new Error(`no ${event} frame on ${ns} to acknowledge`);
  const ack = last[2] as ((r: unknown) => void) | undefined;
  if (typeof ack !== "function") throw new Error(`${event} was emitted without an ack`);
  ack(result);
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    requesterId: THEM,
    helperId: ME,
    category: "errand",
    state: "matched",
    origin: HERE,
    title: "Pick up medicine",
    description: "test", price: 100, createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const NAMESPACES = ["/presence", "/tracking", "/chat", "/matching", "/sos"];
const connectAll = (): void => {
  for (const ns of NAMESPACES) {
    socket(ns).connected = true;
    socket(ns).fire("connect");
  }
};

let client: InstanceType<typeof RealHelperClient>;

/** The snapshot fetch fires on every /matching connect. Resolved with an empty session by
 *  default; a case that cares overrides it before connecting. */
function stubSnapshot(activeTasks: unknown[] = []): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        userId: ME,
        serverTime: 0,
        activeTasks,
      }),
    })),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets.clear();
  manager = null;
  stubSnapshot();
  client = new RealHelperClient({
    baseUrl: "http://localhost:4000",
    token: "t",
    userId: ME,
  });
});

afterEach(() => {
  client.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── A2, helper side ─────────────────────────────────────────────────────────

describe("helper presence heartbeat (audit A2, the second direction)", () => {
  const beats = (): number =>
    socket("/presence").emit.mock.calls.filter((c) => c[0] === "heartbeat").length;

  it("beats on /presence once connected, and not before", () => {
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS * 3);
    expect(beats()).toBe(0);

    connectAll();
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS * 3);
    expect(beats()).toBe(3);
  });

  it("beats fast enough that one dropped beat cannot make a helper unmatchable", () => {
    // The consequence is sharper for a helper than a requester: matching only considers
    // `online-available` candidates, so an `away` flip stops work arriving with no symptom
    // anywhere in the helper's UI.
    expect(CLIENT_HEARTBEAT_INTERVAL_MS * 2).toBeLessThan(AWAY_AFTER_MS);
  });

  it("keeps exactly ONE interval across a reconnect", () => {
    connectAll();
    socket("/presence").connected = false;
    socket("/presence").fire("disconnect", "transport close");
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS * 3);
    expect(beats()).toBe(0); // silent while down

    socket("/presence").connected = true;
    socket("/presence").fire("connect");
    // A leaked second interval would double this.
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS * 2);
    expect(beats()).toBe(2);
  });

  it("stops beating permanently after dispose", () => {
    connectAll();
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS);
    expect(beats()).toBe(1);
    client.dispose();
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS * 10);
    expect(beats()).toBe(1);
  });
});

// ── A1, helper side ─────────────────────────────────────────────────────────

describe("idle availability publishing (audit A1, helper side)", () => {
  it("publishes immediately on toggle-on rather than one interval later", () => {
    connectAll();
    client.reportPosition(HERE);
    // A position while unavailable advertises nothing — the toggle is the consent.
    expect(frames("/presence", "publish-availability")).toHaveLength(0);

    client.setAvailable(true);
    expect(frames("/presence", "publish-availability")).toEqual([
      { point: HERE, available: true },
    ]);
    expect(client.getState().available).toBe(true);
  });

  it("re-publishes before the server-side TTL can lapse", () => {
    connectAll();
    client.reportPosition(HERE);
    client.setAvailable(true);

    // The server expresses availability decay as a freshness score swept at
    // AVAILABILITY_TTL_MS, because Redis GEO has no per-member expiry. A client that published
    // once would drop out of the candidate pool about a minute later with its UI still saying
    // "You're available" — the same invisible failure as A1 itself.
    vi.advanceTimersByTime(AVAILABILITY_TTL_MS);
    const count = frames("/presence", "publish-availability").length;
    expect(count).toBeGreaterThanOrEqual(3); // initial + at least two refreshes

    // And the margin is real: two consecutive lost publishes still fit inside the TTL.
    const [first, second] = frames("/presence", "publish-availability");
    expect(first).toEqual({ point: HERE, available: true });
    expect(second).toEqual({ point: HERE, available: true });
  });

  it("de-lists explicitly on toggle-off instead of waiting for the TTL", () => {
    connectAll();
    client.reportPosition(HERE);
    client.setAvailable(true);
    client.setAvailable(false);

    const sent = frames("/presence", "publish-availability");
    expect(sent[sent.length - 1]).toEqual({ point: HERE, available: false });

    // And the republish timer is genuinely gone — otherwise the next tick would silently
    // re-list a helper who has switched off.
    const after = sent.length;
    vi.advanceTimersByTime(AVAILABILITY_TTL_MS * 2);
    expect(frames("/presence", "publish-availability")).toHaveLength(after);
  });

  it("surfaces an unverified refusal instead of leaving the toggle on forever", () => {
    connectAll();
    client.reportPosition(HERE);
    client.setAvailable(true);

    // The server hard-filters candidates on kyc:"verified" (B11), so this is the ORDINARY
    // outcome for a new helper — not an edge case. Swallowing it leaves the toggle reading
    // "Available" with no offer ever arriving and nothing on screen to explain why.
    ackLast("/presence", "publish-availability", { ok: false, error: "not-a-verified-helper" });

    const s = client.getState();
    expect(s.available).toBe(false);
    expect(s.lastError?.code).toBe("NOT_AUTHORIZED");
    expect(s.lastError?.message).toBe("not-a-verified-helper");

    // Stopped retrying: hammering an endpoint that will keep refusing burns the rate limit
    // the real publish needs once verification completes.
    const after = frames("/presence", "publish-availability").length;
    vi.advanceTimersByTime(AVAILABILITY_TTL_MS * 2);
    expect(frames("/presence", "publish-availability")).toHaveLength(after);
  });

  it("re-asserts availability on reconnect without waiting for the interval", () => {
    connectAll();
    client.reportPosition(HERE);
    client.setAvailable(true);
    const before = frames("/presence", "publish-availability").length;

    socket("/presence").connected = false;
    socket("/presence").fire("disconnect", "transport close");
    socket("/presence").connected = true;
    socket("/presence").fire("connect");

    // A reconnect gets a fresh presence row but NOT a fresh geo entry — the sweep may already
    // have evicted it — so a helper who reconnected mid-window would be unfindable until the
    // next tick.
    expect(frames("/presence", "publish-availability").length).toBe(before + 1);
  });

  it("gives back the availability entry on dispose (audit B9)", () => {
    connectAll();
    client.reportPosition(HERE);
    client.setAvailable(true);
    client.dispose();

    const sent = frames("/presence", "publish-availability");
    expect(sent[sent.length - 1]).toEqual({ point: HERE, available: false });
  });
});

// ── A1's other half: one entry point, two destinations ──────────────────────

describe("position routing: /presence when idle, /tracking when on a live task (audit A1)", () => {
  function winTask(state: Task["state"]): void {
    connectAll();
    socket("/matching").fire("matched", {
      task: task({ state }),
      helper: {
        id: ME,
        displayName: "Me",
        photoUrl: "",
        rating: 5,
        helpedCount: 1,
        etaSeconds: null,
      },
    });
  }

  it("sends an idle position to publish-availability and NOT to /tracking", () => {
    connectAll();
    client.setAvailable(true);
    client.reportPosition(MOVED);

    expect(frames("/tracking", "location")).toHaveLength(0);
    const sent = frames("/presence", "publish-availability");
    expect(sent[sent.length - 1]).toEqual({ point: MOVED, available: true });
  });

  it("sends an en-route position to /tracking and NOT to publish-availability", () => {
    winTask("en-route");
    const before = frames("/presence", "publish-availability").length;

    client.reportPosition(MOVED, { heading: 210, speedMps: 1.4 });

    expect(frames("/tracking", "location")).toEqual([
      { taskId: TASK_ID, point: MOVED, heading: 210, speedMps: 1.4 },
    ]);
    // The server DE-LISTS a helper from the availability index on every /tracking tick,
    // precisely so someone on a live task stops being offered more work. A client that also
    // published availability would be fighting that on every position update — and the loser
    // would be a second requester matched to a helper already walking somewhere else.
    expect(frames("/presence", "publish-availability")).toHaveLength(before);
  });

  it("does NOT track in a state the server would refuse (matched, before en-route)", () => {
    winTask("matched");
    client.reportPosition(MOVED);
    // `matched` is not in TASK_STATES_WITH_LIVE_TRACKING, so `location` would be refused with
    // NOT_AUTHORIZED. The client reads the same shared list the server gates on rather than
    // keeping its own copy, which is what stops the two drifting.
    expect(frames("/tracking", "location")).toHaveLength(0);
  });

  it("stops advertising the moment an offer is won", () => {
    connectAll();
    client.reportPosition(HERE);
    client.setAvailable(true);
    const before = frames("/presence", "publish-availability").length;

    socket("/matching").emit.mockClear();
    client.accept(TASK_ID);
    ackLast("/matching", "accept", { won: true, task: task() });

    expect(client.getState().available).toBe(false);
    // Won at `matched`, which is BEFORE the first /tracking tick that would de-list us, so
    // without this the helper stays a candidate for someone else's request in the gap.
    vi.advanceTimersByTime(AVAILABILITY_TTL_MS * 2);
    expect(frames("/presence", "publish-availability")).toHaveLength(before);
  });
});

// ── offers ──────────────────────────────────────────────────────────────────

describe("competing offers", () => {
  const offer = (taskId: string, expiresAt: number) => ({
    taskId,
    category: "errand" as const,
    origin: HERE,
    title: "Pick up medicine",
    distanceMeters: 400,
    expiresAt,
  });

  it("holds several offers at once, soonest-to-expire first", () => {
    connectAll();
    socket("/matching").fire("offer", offer("t-late", Date.now() + 50_000));
    socket("/matching").fire("offer", offer("t-soon", Date.now() + 10_000));

    // A simultaneous broadcast is the whole design — a helper genuinely may be offered two
    // requests, and the one about to lapse is the one worth deciding on first.
    expect(client.getState().offers.map((o) => o.taskId)).toEqual(["t-soon", "t-late"]);
  });

  it("replaces rather than stacks a re-broadcast of the same task", () => {
    connectAll();
    socket("/matching").fire("offer", offer(TASK_ID, Date.now() + 30_000));
    socket("/matching").fire("offer", offer(TASK_ID, Date.now() + 30_000));
    expect(client.getState().offers).toHaveLength(1);
  });

  it("drops a lapsed offer on its own rather than waiting on the server sweep", () => {
    connectAll();
    socket("/matching").fire("offer", offer(TASK_ID, Date.now() + 5_000));
    vi.advanceTimersByTime(6_500);

    // The server's durable sweep runs on an interval and may be up to a second behind. A card
    // that can no longer be accepted must not keep inviting a tap — the helper taps, loses, and
    // learns not to trust the button.
    expect(client.getState().offers).toHaveLength(0);
    expect(client.getState().lastClosed).toEqual({ taskId: TASK_ID, reason: "expired" });
  });

  it("says why an offer went away when someone else won it", () => {
    connectAll();
    socket("/matching").fire("offer", offer(TASK_ID, Date.now() + 30_000));
    client.accept(TASK_ID);
    ackLast("/matching", "accept", { won: false, reason: "already-taken" });

    expect(client.getState().offers).toHaveLength(0);
    expect(client.getState().lastClosed).toEqual({
      taskId: TASK_ID,
      reason: "already-taken",
    });
    // Losing a race is the normal outcome of a simultaneous broadcast, so it is reported as an
    // outcome and NOT as `lastError`.
    expect(client.getState().lastError).toBeNull();
  });

  it("ignores offers while already holding a live task", () => {
    connectAll();
    socket("/matching").fire("matched", {
      task: task({ state: "en-route" }),
      helper: { id: ME, displayName: "Me", photoUrl: "", rating: 5, helpedCount: 1, etaSeconds: null },
    });
    socket("/matching").fire("offer", offer("t-other", Date.now() + 30_000));
    // Accepting a second task would strand the first requester; the server refuses it anyway,
    // so a card we cannot act on is only a trap.
    expect(client.getState().offers).toHaveLength(0);
  });
});

// ── B13 ─────────────────────────────────────────────────────────────────────

describe("chat identity (audit B13)", () => {
  it("carries the authenticated id in state rather than a placeholder", () => {
    // The bug was `const ME = "me"` at the root of the requester view-model. On the helper side
    // it would be worse: every message the REQUESTER sent would render as the helper's own, so
    // the helper reads their own words as a reply.
    expect(client.getState().userId).toBe(ME);
  });

  it("treats the other party's typing as theirs and its own echo as not", () => {
    connectAll();
    socket("/matching").fire("matched", {
      task: task(),
      helper: { id: ME, displayName: "Me", photoUrl: "", rating: 5, helpedCount: 1, etaSeconds: null },
    });

    socket("/chat").fire("helper-typing", { taskId: TASK_ID, userId: THEM, isTyping: true });
    expect(client.getState().otherTyping).toBe(true);

    // The event name is historical and carries EITHER party's state, so the id filter is what
    // makes it mean "them".
    socket("/chat").fire("helper-typing", { taskId: TASK_ID, userId: ME, isTyping: false });
    expect(client.getState().otherTyping).toBe(true);
  });

  it("does not wipe already-received messages when `matched` is re-broadcast", () => {
    connectAll();
    socket("/matching").fire("matched", {
      task: task(),
      helper: { id: ME, displayName: "Me", photoUrl: "", rating: 5, helpedCount: 1, etaSeconds: null },
    });
    socket("/chat").fire("message", {
      id: "m1",
      taskId: TASK_ID,
      senderId: THEM,
      body: "I'm by the blue door",
      sentAt: 1,
      status: "sent",
    });
    expect(client.getState().messages).toHaveLength(1);

    // A reconnect re-broadcast of the SAME task must be idempotent. Clearing per-task fields
    // unconditionally would erase a message the helper has been told about and will never be
    // told about again.
    socket("/matching").fire("matched", {
      task: task(),
      helper: { id: ME, displayName: "Me", photoUrl: "", rating: 5, helpedCount: 1, etaSeconds: null },
    });
    expect(client.getState().messages).toHaveLength(1);
  });
});

// ── SOS ─────────────────────────────────────────────────────────────────────

describe("SOS never claims more than the server confirmed", () => {
  const alert = (over: Partial<SosAlert> = {}): SosAlert =>
    ({
      id: "sos-1",
      taskId: TASK_ID,
      raisedBy: ME,
      kind: "unsafe",
      status: "open",
      raisedAt: 1,
      at: HERE,
      note: null,
      ...over,
    }) as SosAlert;

  function onTask(): void {
    connectAll();
    socket("/matching").fire("matched", {
      task: task({ state: "en-route" }),
      helper: { id: ME, displayName: "Me", photoUrl: "", rating: 5, helpedCount: 1, etaSeconds: null },
    });
    client.reportPosition(HERE);
  }

  it("resolves with the persisted alert and only then holds it in state", async () => {
    onTask();
    const pending = client.raiseSos("unsafe");

    // Nothing is claimed yet. This is the whole difference from the audited button, which set a
    // local flag synchronously and showed a red armed banner while no server had been told.
    expect(client.getState().sos).toBeNull();

    ackLast("/sos", "raise", { ok: true, alert: alert() });
    await expect(pending).resolves.toMatchObject({ id: "sos-1" });
    expect(client.getState().sos).toMatchObject({ id: "sos-1", status: "open" });
  });

  it("sends our last known position, because the server's fallback does not exist yet", () => {
    onTask();
    void client.raiseSos("medical", "she's fallen");
    expect(frames("/sos", "raise")).toEqual([
      { taskId: TASK_ID, kind: "medical", at: HERE, note: "she's fallen" },
    ]);
    // The server falls back to the task's last TRACKED location — which for a helper who has
    // not gone en-route is absent. An alarm with no location is dramatically less useful.
  });

  it("resolves null on refusal and records the failure, never a false reassurance", async () => {
    onTask();
    const pending = client.raiseSos("panic");
    ackLast("/sos", "raise", { ok: false, error: "rate-limited" });

    await expect(pending).resolves.toBeNull();
    expect(client.getState().sos).toBeNull();
    expect(client.getState().lastError?.code).toBe("RATE_LIMITED");
  });

  it("resolves null immediately when the socket is down instead of hanging", async () => {
    onTask();
    socket("/sos").connected = false;

    // A promise that never settles leaves the UI on "Sending…" forever, during precisely the
    // emergency it exists for. The honest answer is available instantly and the UI can offer a
    // phone call instead.
    await expect(client.raiseSos("panic")).resolves.toBeNull();
    expect(client.getState().lastError?.message).toBe("not connected");
  });

  it("shows the REQUESTER's alert, and clears it when it is stood down", () => {
    onTask();
    socket("/sos").fire("sos-raised", alert({ id: "sos-2", raisedBy: THEM }));
    // The helper is very often the person in the room and able to act first, so this is not
    // an operator-only concern.
    expect(client.getState().sos).toMatchObject({ id: "sos-2", raisedBy: THEM });

    socket("/sos").fire("sos-updated", alert({ id: "sos-2", raisedBy: THEM, status: "cancelled" }));
    expect(client.getState().sos).toBeNull();
  });

  it("ignores an alert belonging to a different task", () => {
    onTask();
    socket("/sos").fire("sos-raised", alert({ id: "sos-3", taskId: "some-other-task" }));
    // A stranger's emergency must not appear on this helper's screen.
    expect(client.getState().sos).toBeNull();
  });

  it("does not carry an alert from one task onto the next", () => {
    onTask();
    socket("/sos").fire("sos-raised", alert());
    expect(client.getState().sos).not.toBeNull();

    socket("/matching").emit.mockClear();
    client.accept("task-h-2");
    ackLast("/matching", "accept", { won: true, task: task({ id: "task-h-2" }) });

    expect(client.getState().sos).toBeNull();
    expect(client.getState().messages).toHaveLength(0);
  });
});

// ── the finished-task screen ────────────────────────────────────────────────

describe("finishing a task", () => {
  function completeIt(state: Task["state"]): void {
    connectAll();
    socket("/matching").fire("matched", {
      task: task({ state: "in-progress" }),
      helper: { id: ME, displayName: "Me", photoUrl: "", rating: 5, helpedCount: 1, etaSeconds: null },
    });
    socket("/matching").fire("task-updated", { task: task({ state }) });
  }

  it("hands back the task rooms as soon as the task is terminal (audit B9)", () => {
    completeIt("completed");
    expect(frames("/tracking", "leave")).toEqual([{ taskId: TASK_ID }]);
    expect(frames("/chat", "leave")).toEqual([{ taskId: TASK_ID }]);
  });

  it("keeps the finished task on screen until the helper dismisses it", () => {
    completeIt("completed");
    // Not a timer: the requester confirming completion must not yank the closing words away
    // from someone still reading them.
    expect(client.getState().task?.state).toBe("completed");
    client.dismissFinishedTask();
    expect(client.getState().task).toBeNull();
  });

  it("refuses to dismiss a task that is still live", () => {
    connectAll();
    socket("/matching").fire("matched", {
      task: task({ state: "en-route" }),
      helper: { id: ME, displayName: "Me", photoUrl: "", rating: 5, helpedCount: 1, etaSeconds: null },
    });
    client.dismissFinishedTask();
    // Abandoning live work has to go through advanceTo("cancelled") so the requester is
    // actually told; otherwise the helper simply vanishes from a screen someone is watching.
    expect(client.getState().task?.state).toBe("en-route");
  });
});

// ── §2.1 resync ─────────────────────────────────────────────────────────────

describe("reconnect resync (§2.1)", () => {
  it("recovers an accepted task from the snapshot after a reload", async () => {
    // The offer that produced this task is long gone from Redis, so without the snapshot a
    // helper who refreshed mid-task returns to an empty "no work" screen while the requester's
    // app still shows them en route.
    stubSnapshot([
      {
        task: task({ state: "en-route" }),
        helper: null,
        messages: [
          { id: "m1", taskId: TASK_ID, senderId: THEM, body: "hi", sentAt: 1, status: "sent" },
        ],
        lastKnownLocation: null,
        eta: { etaSeconds: 300, distanceMeters: 600 },
      },
    ]);

    connectAll();
    await vi.waitFor(() => expect(client.getState().task?.id).toBe(TASK_ID));

    expect(client.getState().messages).toHaveLength(1);
    expect(client.getState().eta).toEqual({ etaSeconds: 300, distanceMeters: 600 });
    // Rooms re-joined for exactly what we hold.
    expect(frames("/tracking", "join")).toContainEqual({ taskId: TASK_ID });
    expect(frames("/chat", "join")).toContainEqual({ taskId: TASK_ID });
    await vi.waitFor(() => expect(client.getState().connection).toBe("online"));
  });

  it("clears a task the server says we no longer hold", async () => {
    connectAll();
    socket("/matching").fire("matched", {
      task: task({ state: "en-route" }),
      helper: { id: ME, displayName: "Me", photoUrl: "", rating: 5, helpedCount: 1, etaSeconds: null },
    });
    expect(client.getState().task).not.toBeNull();

    // The snapshot is the authoritative post-drop truth, so a task it does not list is gone —
    // e.g. the requester cancelled while we were offline.
    socket("/matching").fire("connect");
    await vi.waitFor(() => expect(client.getState().task).toBeNull());
  });

  it("does not let an in-flight snapshot erase a task won while it was open", async () => {
    // The failure this guards: the snapshot describes the server as of when it was REQUESTED.
    // On a phone that HTTP call is open for a noticeable moment, and an `accept` ack can land
    // inside it. Applying the older answer afterwards takes away a task the helper watched
    // themselves win — they tapped Accept, saw it land, and the screen went empty.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        // Deliberately empty: the server had not yet committed the accept when we asked.
        return { ok: true, json: async () => ({ userId: ME, serverTime: 0, activeTasks: [] }) };
      }),
    );

    connectAll(); // starts the resync, which now blocks on `gate`
    client.accept(TASK_ID);
    ackLast("/matching", "accept", { won: true, task: task() });
    expect(client.getState().task?.id).toBe(TASK_ID);

    release();
    await vi.waitFor(() => expect(client.getState().connection).toBe("online"));
    expect(client.getState().task?.id).toBe(TASK_ID);
  });

  it("keeps a live task on screen when the snapshot fetch FAILS", async () => {
    connectAll();
    socket("/matching").fire("matched", {
      task: task({ state: "en-route" }),
      helper: { id: ME, displayName: "Me", photoUrl: "", rating: 5, helpedCount: 1, etaSeconds: null },
    });

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    socket("/matching").fire("connect");

    // A failed snapshot is not evidence the task ended. Clearing it would drop a helper out of
    // a task they are physically in the middle of because one HTTP call failed.
    await vi.waitFor(() => expect(client.getState().lastError?.event).toBe("snapshot"));
    expect(client.getState().task?.id).toBe(TASK_ID);
  });
});

// ── C22 ─────────────────────────────────────────────────────────────────────

describe("connection honesty (audit C22)", () => {
  it("says `offline` for a drop socket.io will not retry", () => {
    connectAll();
    socket("/matching").fire("disconnect", "io server disconnect");
    expect(client.getState().connection).toBe("offline");
  });

  it("says `reconnecting` for a transient drop", () => {
    connectAll();
    socket("/matching").fire("disconnect", "ping timeout");
    expect(client.getState().connection).toBe("reconnecting");
  });

  it("says `offline` once backoff is exhausted", () => {
    connectAll();
    socket("/matching").fire("disconnect", "transport close");
    manager?.fire("reconnect_failed");
    expect(client.getState().connection).toBe("offline");
  });
});
