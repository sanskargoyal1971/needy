import webpush, { WebPushError, type PushSubscription } from "web-push";
import { z } from "zod";
import { pii, type PiiCipher } from "../crypto/pii.js";
import { keys } from "../domain/keys.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { RedisClient } from "../redis.js";

/** ── Web push ──────────────────────────────────────────────────────────────
 *  The channel that reaches a person whose tab is closed or whose phone is locked. Everything
 *  realtime still goes over the socket; push is the second copy of the few events that someone
 *  must not miss because they put their phone down:
 *
 *   - an OFFER, to each helper it went out to (they have the offer window to answer);
 *   - "someone accepted" and "they're at your door", to the requester.
 *
 *  ── storage ────────────────────────────────────────────────────────────────
 *  Subscriptions live in Redis, one hash per user, rather than in Postgres. They are a cache of
 *  something the browser owns: the client re-registers its subscription every time the page
 *  loads, so a lost hash heals on the next visit rather than losing anything durable. Each value
 *  is sealed with the PII cipher — the endpoint plus keys are exactly what is needed to send
 *  that device a notification, so they are treated as a credential, never stored or logged in
 *  the clear. The field is a blind index of the endpoint, so re-registering replaces rather
 *  than duplicates.
 *
 *  ── payloads ───────────────────────────────────────────────────────────────
 *  Small, and never carrying a location: an offer push says what is needed and roughly how
 *  far, the same as the offer card. The exact address is still only ever sent to the helper
 *  who wins the accept.
 */

/** Per user, so a person with a phone, a tablet and a laptop gets all three, but nobody can
 *  register an unbounded number of endpoints. */
const MAX_SUBSCRIPTIONS_PER_USER = 5;
/** Push services reject payloads over ~4 KB; titles are capped well below that already. */
const MAX_BODY_CHARS = 140;

export const pushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(1024)
    // Only real push services. A subscription is a URL the SERVER will POST to; accepting any
    // URL would turn this endpoint into a way to make the backend send requests anywhere.
    .refine((u) => u.startsWith("https://"), "endpoint must be https"),
  keys: z.object({
    p256dh: z.string().min(16).max(256),
    auth: z.string().min(8).max(64),
  }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

export type PushMessage =
  | {
      kind: "offer";
      taskId: string;
      title: string;
      distanceMeters: number | null;
      expiresAt: number;
      direct?: boolean;
      scheduledFor?: number | null;
    }
  | { kind: "matched"; taskId: string; helperName: string }
  | { kind: "arrived"; taskId: string; helperName: string }
  | { kind: "unconfirmed"; taskId: string; helperName: string };

export interface PushService {
  readonly enabled: boolean;
  readonly publicKey: string;
  subscribe(userId: string, sub: PushSubscriptionInput): Promise<void>;
  unsubscribe(userId: string, endpoint: string): Promise<void>;
  /** Fire-and-forget from the caller's point of view: never throws, never blocks a match. */
  send(userId: string, message: PushMessage, opts?: { ttlSeconds?: number }): Promise<number>;
}

const CONTEXT = "push-subscription";
const INDEX_PURPOSE = "push-endpoint";

/** Allow-list of push service hosts. Browsers only ever hand out endpoints on these. */
const PUSH_HOSTS = [
  /\.googleapis\.com$/, // Chrome, Edge (FCM)
  /\.push\.services\.mozilla\.com$/, // Firefox
  /\.push\.apple\.com$/, // Safari, iOS home-screen apps
  /\.notify\.windows\.com$/, // legacy Edge / Windows
];

export function isPushServiceEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return PUSH_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

/** What the notification says. Kept here so the server decides the wording, not the payload. */
export function renderPush(message: PushMessage): {
  title: string;
  body: string;
  url: string;
  tag: string;
} {
  const clip = (s: string) =>
    s.length > MAX_BODY_CHARS ? `${s.slice(0, MAX_BODY_CHARS - 1)}…` : s;
  switch (message.kind) {
    case "offer": {
      const d = message.distanceMeters;
      const far =
        d == null
          ? null
          : d < 1000
            ? `${Math.round(d / 100) * 100} m`
            : `${(d / 1000).toFixed(1)} km`;
      // Formatted in India time: the server's own zone is UTC in a container.
      const when =
        message.scheduledFor != null
          ? new Date(message.scheduledFor).toLocaleString("en-IN", {
              weekday: "short",
              hour: "numeric",
              minute: "2-digit",
              timeZone: "Asia/Kolkata",
            })
          : null;
      const detail = [
        message.title,
        when ? `booked for ${when}` : null,
        far ? `about ${far} away` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        title: message.direct ? "Someone asked for you by name" : "Someone nearby needs help",
        body: clip(detail),
        url: "/helper",
        tag: `offer:${message.taskId}`,
      };
    }
    case "matched":
      return {
        title: `${message.helperName} is coming to help`,
        body: "Open Needy to see who they are and follow them on the map.",
        url: `/app/task/${message.taskId}`,
        tag: `task:${message.taskId}`,
      };
    case "unconfirmed":
      return {
        title: `${message.helperName} can't make it this time`,
        body: "Nothing was charged. You can ask someone else nearby from the app.",
        url: `/app/task/${message.taskId}`,
        tag: `task:${message.taskId}`,
      };
    case "arrived":
      return {
        title: `${message.helperName} is at your door`,
        body: "Check what they'll do, then show them your code.",
        url: `/app/task/${message.taskId}`,
        tag: `task:${message.taskId}`,
      };
  }
}

/** Seam for tests: the one function that talks to the network. */
export type PushTransport = (
  sub: PushSubscription,
  payload: string,
  opts: { TTL: number; urgency: "high" | "normal" },
) => Promise<{ statusCode: number }>;

export function createPushService(deps: {
  config: Config;
  redis: RedisClient;
  logger: Logger;
  cipher?: PiiCipher;
  transport?: PushTransport;
}): PushService {
  const { config, redis, logger } = deps;
  const cipher = deps.cipher ?? pii;
  const { publicKey, privateKey, subject } = config.push;
  const enabled = Boolean(publicKey && privateKey && subject);

  const transport: PushTransport =
    deps.transport ??
    ((sub, payload, opts) =>
      webpush.sendNotification(sub, payload, {
        ...opts,
        vapidDetails: { subject, publicKey, privateKey },
        timeout: 5_000,
      }));

  if (!enabled) logger.info("web push off — VAPID keys not configured");

  const field = (endpoint: string) => cipher.blindIndex(INDEX_PURPOSE, endpoint);

  return {
    enabled,
    publicKey: enabled ? publicKey : "",

    async subscribe(userId, sub) {
      if (!isPushServiceEndpoint(sub.endpoint)) throw new Error("not a push service endpoint");
      const key = keys.pushSubs(userId);
      await redis.hset(key, field(sub.endpoint), cipher.encrypt(JSON.stringify(sub), CONTEXT));
      // Oldest-first trim. HLEN is tiny; the cap stops one account registering endless devices.
      const all = await redis.hkeys(key);
      if (all.length > MAX_SUBSCRIPTIONS_PER_USER) {
        await redis.hdel(key, ...all.slice(0, all.length - MAX_SUBSCRIPTIONS_PER_USER));
      }
    },

    async unsubscribe(userId, endpoint) {
      await redis.hdel(keys.pushSubs(userId), field(endpoint));
    },

    async send(userId, message, opts = {}) {
      if (!enabled) return 0;
      let delivered = 0;
      try {
        const key = keys.pushSubs(userId);
        const stored = await redis.hgetall(key);
        const payload = JSON.stringify({ kind: message.kind, ...renderPush(message) });
        const ttl = Math.max(0, Math.round(opts.ttlSeconds ?? 300));
        await Promise.all(
          Object.entries(stored).map(async ([f, sealed]) => {
            let sub: PushSubscription;
            try {
              sub = JSON.parse(cipher.decrypt(sealed, CONTEXT)) as PushSubscription;
            } catch {
              // Sealed under a retired key or corrupt: useless, and the browser re-registers.
              await redis.hdel(key, f);
              return;
            }
            try {
              await transport(sub, payload, { TTL: ttl, urgency: "high" });
              delivered += 1;
            } catch (err) {
              const status = err instanceof WebPushError ? err.statusCode : undefined;
              // 404/410: the browser has dropped this subscription for good.
              if (status === 404 || status === 410) {
                await redis.hdel(key, f);
                return;
              }
              // Never log the endpoint: it is the credential for this device.
              logger.warn("web push failed", { userId, kind: message.kind, status });
            }
          }),
        );
      } catch (err) {
        logger.warn("web push send failed", { userId, kind: message.kind, err: String(err) });
      }
      return delivered;
    },
  };
}

/** Off until `installPushService` runs at startup — and permanently off in tests that never
 *  call it, which is what keeps every existing matching test free of a network dependency. */
const disabledPush: PushService = {
  enabled: false,
  publicKey: "",
  subscribe: () => Promise.reject(new Error("push disabled")),
  unsubscribe: () => Promise.resolve(),
  send: () => Promise.resolve(0),
};
let active: PushService = disabledPush;

/** Process-wide, like the logger. Push is a side channel every module may use and none may
 *  depend on, so it is installed once rather than threaded through `Deps`. */
export function installPushService(service: PushService): void {
  active = service;
}
export function pushService(): PushService {
  return active;
}
