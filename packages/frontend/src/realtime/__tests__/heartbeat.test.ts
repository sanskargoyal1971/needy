import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_HEARTBEAT_INTERVAL_MS } from "@needy/shared";

/**
 * A2 proof. The client MUST beat on /presence or the server's away-sweep flips the user to
 * `away` after AWAY_AFTER_MS and matching — which only considers `online-available` helpers —
 * stops offering them anything at all. The frontend previously emitted no heartbeat from
 * anywhere, so every real user went permanently unmatchable about half a minute in.
 *
 * We stub socket.io-client rather than stand up a server: what's under test is purely the
 * client's timer discipline (start on connect, stop on disconnect/dispose, and — the subtle
 * one — exactly ONE interval across a reconnect, since a leaked duplicate would silently
 * double the beat rate for the rest of the session).
 */

interface FakeSocket {
  connected: boolean;
  /** Mirrors socket.io's real `socket.active`: false once the socket has been destroyed and
   *  will never be retried (a REFUSED handshake, or `io server disconnect`). */
  active: boolean;
  emit: ReturnType<typeof vi.fn>;
  on: (event: string, handler: (...args: unknown[]) => void) => FakeSocket;
  removeAllListeners: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  /** Test-only: drive a server→client event. */
  fire: (event: string, ...args: unknown[]) => void;
}

function makeSocket(): FakeSocket {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const socket: FakeSocket = {
    connected: false,
    active: true, // socket.io's default: this socket still intends to reconnect
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

/** Namespace → the fake socket handed to the client, so a test can drive its events. */
const sockets = new Map<string, FakeSocket>();
/** The most recently constructed fake Manager, so a test can fire Manager-level events
 *  (reconnect_attempt / reconnect_failed) that no individual socket owns. */
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

// Imported after vi.mock so the client picks up the fake Manager.
const { RealNeedyClient } = await import("../socketClient.js");

function presenceSocket(): FakeSocket {
  const s = sockets.get("/presence");
  if (!s) throw new Error("presence socket was never created");
  return s;
}

/** How many times the client asked /presence for a heartbeat. */
function beats(): number {
  return presenceSocket().emit.mock.calls.filter((c) => c[0] === "heartbeat").length;
}

/** Simulate a successful (re)connect of the /presence socket. */
function connect(): void {
  const s = presenceSocket();
  s.connected = true;
  s.fire("connect");
}

function disconnect(): void {
  const s = presenceSocket();
  s.connected = false;
  s.fire("disconnect", "transport close");
}

describe("RealNeedyClient presence heartbeat (audit A2)", () => {
  let client: InstanceType<typeof RealNeedyClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.clear();
    client = new RealNeedyClient({
      baseUrl: "http://localhost:4000",
      token: "t",
      userId: "req-abc123",
    });
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
  });

  it("emits a heartbeat at CLIENT_HEARTBEAT_INTERVAL_MS once the presence socket connects", () => {
    // Nothing before connect: beating into a dead socket is pointless.
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS * 3);
    expect(beats()).toBe(0);

    connect();
    // The server stamps a fresh lastActiveAt on connect, so the first beat is due one full
    // interval later, not immediately.
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS - 1);
    expect(beats()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(beats()).toBe(1);

    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS * 4);
    expect(beats()).toBe(5);
  });

  it("beats fast enough that a single missed beat cannot trip the server's away sweep", async () => {
    const { AWAY_AFTER_MS } = await import("@needy/shared");
    // Two consecutive beats must still fit inside the away threshold, or one dropped beat
    // flips the user to `away` and makes them unmatchable.
    expect(CLIENT_HEARTBEAT_INTERVAL_MS * 2).toBeLessThan(AWAY_AFTER_MS);
  });

  it("stops beating on disconnect and resumes on reconnect", () => {
    connect();
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS * 2);
    expect(beats()).toBe(2);

    disconnect();
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS * 5);
    expect(beats()).toBe(2); // silent while down

    connect(); // socket.io re-fires `connect` after a successful reconnect
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS * 2);
    expect(beats()).toBe(4);
  });

  it("keeps exactly ONE interval after a reconnect (no duplicate beat)", () => {
    connect();
    disconnect();
    connect();
    // A second leaked interval would double this to 4.
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS * 2);
    expect(beats()).toBe(2);
  });

  it("keeps exactly ONE interval even if `connect` fires twice without a disconnect", () => {
    // socket.io shouldn't do this, but the guard is cheap and a duplicate beat is its own bug.
    connect();
    connect();
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS * 3);
    expect(beats()).toBe(3);
  });

  it("stops beating permanently after dispose", () => {
    connect();
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS);
    expect(beats()).toBe(1);

    client.dispose();
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS * 10);
    expect(beats()).toBe(1);

    // A late `connect` after dispose must not resurrect the interval either.
    connect();
    vi.advanceTimersByTime(CLIENT_HEARTBEAT_INTERVAL_MS * 3);
    expect(beats()).toBe(1);
  });
});

describe("RealNeedyClient connection state (audit C22)", () => {
  let client: InstanceType<typeof RealNeedyClient>;

  beforeEach(() => {
    sockets.clear();
    client = new RealNeedyClient({
      baseUrl: "http://localhost:4000",
      token: "t",
      userId: "req-abc123",
    });
  });
  afterEach(() => client.dispose());

  function matching(): FakeSocket {
    const s = sockets.get("/matching");
    if (!s) throw new Error("matching socket was never created");
    return s;
  }

  it("assigns `offline` when the drop is one socket.io will NOT retry", () => {
    // `offline` was declared in ConnectionState but never assigned by any driver, so the
    // genuinely-not-coming-back case was mislabelled as the reassuring "reconnecting".
    matching().fire("disconnect", "io server disconnect");
    expect(client.getState().connection).toBe("offline");
  });

  it("assigns `offline` once reconnection backoff is exhausted", () => {
    matching().fire("disconnect", "transport close");
    manager?.fire("reconnect_attempt");
    expect(client.getState().connection).toBe("reconnecting");

    // Backoff gave up — continuing to promise "hold on" would be a lie.
    manager?.fire("reconnect_failed");
    expect(client.getState().connection).toBe("offline");
  });

  it("still says `reconnecting` for a transient drop it WILL retry", () => {
    matching().fire("disconnect", "ping timeout");
    expect(client.getState().connection).toBe("reconnecting");
  });

  // Verified against a real socket.io 4.8 server: rejecting the handshake in namespace
  // middleware emits ONLY `connect_error` (never `disconnect`), and socket.io has already
  // called destroy() by then, so `socket.active === false` and that namespace is never retried
  // even though the Manager keeps reconnecting the transport underneath. The access JWT is
  // short-lived and nothing refreshes it, so this is the ORDINARY expiry path — mapping it to
  // `reconnecting` left the user reading "hold on, we haven't lost your helper" forever.
  it("assigns `offline` when the handshake is REFUSED and the socket will never be retried", () => {
    const m = matching();
    m.active = false; // socket.io destroy()s the socket before emitting connect_error
    m.fire("connect_error", new Error("invalid or expired token"));
    expect(client.getState().connection).toBe("offline");
  });

  it("still says `reconnecting` for a transport-level connect_error that WILL be retried", () => {
    const m = matching();
    m.active = true; // transport failure: the socket still intends to reconnect
    m.fire("connect_error", new Error("websocket error"));
    expect(client.getState().connection).toBe("reconnecting");
  });
});

describe("RealNeedyClient subscription release (audit B9)", () => {
  let client: InstanceType<typeof RealNeedyClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.clear();
    client = new RealNeedyClient({
      baseUrl: "http://localhost:4000",
      token: "t",
      userId: "req-abc123",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function socket(ns: string): FakeSocket {
    const s = sockets.get(ns);
    if (!s) throw new Error(`${ns} socket was never created`);
    return s;
  }

  function matchTask(state = "matched"): void {
    socket("/matching").fire("matched", {
      task: {
        id: "task-1",
        requesterId: "req-abc123",
        helperId: "helper-1",
        category: "errand",
        state,
        origin: { lat: 12.9716, lng: 77.5946 },
        title: "t",
        description: "test", price: 100, createdAt: 0,
        updatedAt: 0,
      },
      helper: {
        id: "helper-1",
        displayName: "Priya",
        photoUrl: "",
        rating: 5,
        helpedCount: 1,
        etaSeconds: 60,
      },
    });
  }

  function emitted(ns: string, event: string): unknown[][] {
    return socket(ns).emit.mock.calls.filter((c) => c[0] === event);
  }

  it("unsubscribes from helper presence and leaves task rooms on dispose", () => {
    client.start("task-1");
    for (const ns of ["/presence", "/tracking", "/chat", "/matching"]) socket(ns).connected = true;
    matchTask();
    expect(emitted("/presence", "subscribe")).toHaveLength(1);

    client.dispose();
    expect(emitted("/presence", "unsubscribe")).toEqual([
      ["unsubscribe", { helperId: "helper-1" }],
    ]);
    expect(emitted("/tracking", "leave")).toHaveLength(1);
    expect(emitted("/chat", "leave")).toHaveLength(1);
  });

  it("releases subscriptions as soon as the task reaches a terminal state", () => {
    client.start("task-1");
    for (const ns of ["/presence", "/tracking", "/chat", "/matching"]) socket(ns).connected = true;
    matchTask();

    socket("/matching").fire("task-updated", {
      task: {
        id: "task-1",
        requesterId: "req-abc123",
        helperId: "helper-1",
        category: "errand",
        state: "completed",
        origin: { lat: 12.9716, lng: 77.5946 },
        title: "t",
        description: "test", price: 100, createdAt: 0,
        updatedAt: 0,
      },
    });

    expect(emitted("/presence", "unsubscribe")).toHaveLength(1);
    // ...and dispose afterwards must not double-emit it.
    client.dispose();
    expect(emitted("/presence", "unsubscribe")).toHaveLength(1);
  });

  it("subscribes to a helper's presence only once across repeated matched events", () => {
    client.start("task-1");
    for (const ns of ["/presence", "/tracking", "/chat", "/matching"]) socket(ns).connected = true;
    matchTask();
    matchTask();
    expect(emitted("/presence", "subscribe")).toHaveLength(1);
    client.dispose();
  });
});
