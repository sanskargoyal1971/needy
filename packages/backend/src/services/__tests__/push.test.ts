import RedisMock from "ioredis-mock";
import { WebPushError } from "web-push";
import { describe, expect, it, vi } from "vitest";
import { config } from "../../config.js";
import { createPiiCipher } from "../../crypto/pii.js";
import { keys } from "../../domain/keys.js";
import type { RedisClient } from "../../redis.js";
import {
  createPushService,
  isPushServiceEndpoint,
  pushSubscriptionSchema,
  renderPush,
  type PushTransport,
} from "../push.js";

const cipher = createPiiCipher({
  currentKey: "test-current-key-0123456789abcdef",
  previousKeys: [],
  indexKey: "test-index-key-0123456789abcdef",
});
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: "BOrandom-p256dh-key-material-1234", auth: "auth-secret-1" },
};

function service(
  transport: PushTransport,
  push = { publicKey: "pub", privateKey: "priv", subject: "mailto:x@y.z" },
) {
  const redis = new RedisMock() as unknown as RedisClient;
  const svc = createPushService({
    config: { ...config, push },
    redis,
    logger: logger as never,
    cipher,
    transport,
  });
  return { svc, redis };
}

describe("push service", () => {
  it("is off without VAPID keys, and sends nothing", async () => {
    const transport = vi.fn<PushTransport>();
    const { svc } = service(transport, { publicKey: "", privateKey: "", subject: "" });
    expect(svc.enabled).toBe(false);
    expect(svc.publicKey).toBe("");
    expect(await svc.send("u1", { kind: "matched", taskId: "t", helperName: "A" })).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it("stores the subscription sealed, never in the clear", async () => {
    const { svc, redis } = service(vi.fn<PushTransport>());
    await svc.subscribe("u1", SUB);
    const stored = await redis.hgetall(keys.pushSubs("u1"));
    const values = Object.values(stored);
    expect(values).toHaveLength(1);
    expect(values[0]).not.toContain("fcm.googleapis.com");
    expect(values[0]).not.toContain(SUB.keys.auth);
    // Re-registering the same device replaces, it does not duplicate.
    await svc.subscribe("u1", SUB);
    expect(await redis.hlen(keys.pushSubs("u1"))).toBe(1);
  });

  it("refuses an endpoint that is not a browser push service", async () => {
    const { svc } = service(vi.fn<PushTransport>());
    await expect(
      svc.subscribe("u1", { ...SUB, endpoint: "https://attacker.example/collect" }),
    ).rejects.toThrow();
    expect(isPushServiceEndpoint("https://web.push.apple.com/abc")).toBe(true);
    expect(isPushServiceEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(
      true,
    );
    expect(isPushServiceEndpoint("http://fcm.googleapis.com/x")).toBe(true); // schema rejects http
    expect(
      pushSubscriptionSchema.safeParse({ ...SUB, endpoint: "http://fcm.googleapis.com/x" }).success,
    ).toBe(false);
  });

  it("caps the number of devices per person", async () => {
    const { svc, redis } = service(vi.fn<PushTransport>());
    for (let i = 0; i < 8; i += 1) {
      await svc.subscribe("u1", { ...SUB, endpoint: `${SUB.endpoint}-${i}` });
    }
    expect(await redis.hlen(keys.pushSubs("u1"))).toBe(5);
  });

  it("sends to every device, with a TTL and no location in the payload", async () => {
    const transport = vi.fn<PushTransport>().mockResolvedValue({ statusCode: 201 });
    const { svc } = service(transport);
    await svc.subscribe("h1", SUB);
    await svc.subscribe("h1", { ...SUB, endpoint: `${SUB.endpoint}-tablet` });

    const sent = await svc.send(
      "h1",
      { kind: "offer", taskId: "t1", title: "Carry shopping", distanceMeters: 640, expiresAt: 0 },
      { ttlSeconds: 42 },
    );

    expect(sent).toBe(2);
    const [sub, payload, opts] = transport.mock.calls[0]!;
    expect(sub.endpoint).toContain("fcm.googleapis.com");
    expect(opts).toEqual({ TTL: 42, urgency: "high" });
    const body = JSON.parse(payload) as Record<string, unknown>;
    expect(body).toMatchObject({ kind: "offer", url: "/helper", tag: "offer:t1" });
    expect(String(body.body)).toContain("about 600 m away");
    expect(payload).not.toMatch(/lat|lng/);
  });

  it("forgets a device the push service says is gone", async () => {
    const transport = vi
      .fn<PushTransport>()
      .mockRejectedValue(new WebPushError("gone", 410, {}, "", SUB.endpoint));
    const { svc, redis } = service(transport);
    await svc.subscribe("u1", SUB);
    expect(await svc.send("u1", { kind: "arrived", taskId: "t", helperName: "Priya" })).toBe(0);
    expect(await redis.hlen(keys.pushSubs("u1"))).toBe(0);
  });

  it("never throws into the caller, and never logs the endpoint", async () => {
    const transport = vi.fn<PushTransport>().mockRejectedValue(new Error("network down"));
    const { svc } = service(transport);
    await svc.subscribe("u1", SUB);
    await expect(svc.send("u1", { kind: "matched", taskId: "t", helperName: "A" })).resolves.toBe(
      0,
    );
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain("fcm.googleapis.com");
  });

  it("words each message for the person reading it", () => {
    expect(renderPush({ kind: "matched", taskId: "t9", helperName: "Meera" })).toMatchObject({
      title: "Meera is coming to help",
      url: "/app/task/t9",
    });
    expect(renderPush({ kind: "arrived", taskId: "t9", helperName: "Meera" }).title).toBe(
      "Meera is at your door",
    );
  });
});
