import type { SosAlert, SosKind } from "@needy/shared";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { RedisClient } from "../redis.js";
import { keys } from "./keys.js";

/** ── SOS escalation: the schedule and the rules ─────────────────────────────
 *  A raised alarm used to reach exactly one place: the operator console. If nobody was looking
 *  at it — night shift, a closed laptop, a console that had quietly lost its socket — the
 *  alarm sat there and the person who pressed it waited on an empty room. This module holds
 *  the parts of escalation that the raise, acknowledge and cancel paths share with the sweep
 *  that does the paging (socket/sosEscalationSweep.ts): the durable schedule, and the pure
 *  rules for who is paged at which step.
 *
 *  It deliberately depends on Redis and config only, so the socket and HTTP handlers can arm
 *  and disarm escalation without holding an SMS provider.
 */

/** Once every tier has been paged, the top tier is paged again this many more times before
 *  the sweep stops. Paging forever would turn one forgotten alert into a phone that never
 *  stops; stopping after the top tier once would let a single missed text end escalation for
 *  good. Three more tries at the last interval is a pager's habit, not a principle. */
export const TOP_TIER_REPEATS = 3;

export type SosEscalationConfig = Config["sos"];

/** Total pages an alert can produce under this config. */
export function maxEscalationSteps(cfg: SosEscalationConfig): number {
  return cfg.oncallTiers.length === 0 ? 0 : cfg.oncallTiers.length + TOP_TIER_REPEATS;
}

/** The tier paged at 1-based `step`: one tier per step up the ladder, then the top one. */
export function tierForStep(cfg: SosEscalationConfig, step: number): number {
  return Math.min(step, cfg.oncallTiers.length);
}

/** Milliseconds to wait after page number `stepSent` before the next. */
export function intervalAfterStepMs(cfg: SosEscalationConfig, stepSent: number): number {
  const steps = cfg.escalationStepsSeconds;
  return steps[Math.min(stepSent - 1, steps.length - 1)]! * 1000;
}

/**
 * When this alert's next page is due, derived from DURABLE state alone, or null when nothing
 * further is owed (no longer raised, or the ladder is exhausted).
 *
 * This is what lets the Redis schedule be rebuilt: the sweep's reconcile pass calls it for
 * every raised alert, so an entry lost to a crash between claim and re-arm — or to a Redis
 * that lost its data — is put back where it belongs rather than leaving the alarm silent.
 */
export function nextEscalationDue(alert: SosAlert, cfg: SosEscalationConfig): number | null {
  if (alert.status !== "raised") return null;
  if (alert.escalationStep >= maxEscalationSteps(cfg)) return null;
  if (alert.escalationStep === 0) return alert.createdAt + cfg.escalateAfterSeconds * 1000;
  const last = alert.escalatedAt ?? alert.createdAt;
  return last + intervalAfterStepMs(cfg, alert.escalationStep);
}

/**
 * True when the page due at `due` is too late to be worth sending at `now`.
 *
 * Lateness, not age: in normal running a page is late by at most a sweep interval, so this
 * never truncates a ladder. It is true only when the sweep was not running when the page fell
 * due — a long outage, or a first deploy over alerts left `raised` from before escalation
 * existed (stale test and seed alarms among them). Paging those would send on-call a burst
 * about hour-old alarms and then walk each one up the whole ladder, which is how staff learn
 * to ignore the pager. They are logged at error level instead, so they are still looked at.
 */
export function isEscalationTooLate(due: number, now: number, cfg: SosEscalationConfig): boolean {
  return now - due > cfg.maxLatenessSeconds * 1000;
}

/**
 * The alert as a PARTICIPANT may see it: the escalation fields reset to their unescalated
 * values.
 *
 * Who on the staff side has been woken up, how many times and when is internal. The raiser's
 * screen already says what is true for them (an operator has, or has not, acknowledged), and
 * the other participant may be the very person the alarm is about — they have no business
 * learning how hard the platform is looking. So every channel that reaches a participant (the
 * personal-room fan-outs, the raise and cancel acks, the task snapshot) sends this, and only
 * the operator room and the admin API carry the real values.
 *
 * Reset rather than removed so the wire type stays `SosAlert`, which the participant clients
 * are written against; their UI does not read these fields. The values a participant sees
 * therefore mean "not disclosed", NOT "nobody was paged".
 */
export function participantSosView(alert: SosAlert): SosAlert {
  return { ...alert, escalationStep: 0, escalationTier: 0, escalatedAt: null };
}

/** Hosts a link sent to someone's phone must never point at: it would open on THEIR device. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "0.0.0.0" ||
    h === "[::1]" ||
    h === "[::]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

// ── the schedule ────────────────────────────────────────────────────────────

/**
 * Arm the first escalation for a newly raised alert. NX, so a repeat (a reconcile pass racing
 * the raise) never pushes an earlier deadline later.
 *
 * Never throws. The caller is the raise path, which has already told a frightened person
 * their alarm was received; a Redis hiccup here must not turn that into an error, and the
 * sweep's reconcile pass re-arms anything this missed from the database.
 */
export async function scheduleSosEscalation(
  redis: RedisClient,
  logger: Logger,
  alertId: string,
  dueAt: number,
): Promise<void> {
  try {
    await redis.zadd(keys.sosEscalationQueue(), "NX", dueAt, alertId);
  } catch (err) {
    logger.error("sos escalation could not be scheduled (reconcile will re-arm it)", {
      alertId,
      err: String(err),
    });
  }
}

/**
 * Disarm escalation: an operator acknowledged or resolved the alert, or the raiser stood it
 * down. Never throws, for the same reason as above — the acknowledgement is already committed
 * and must not become a 500. Not load-bearing on its own: the sweep re-reads the alert and
 * `recordEscalation` refuses anything not `raised`, so a removal that failed costs one wasted
 * claim, never a page.
 */
export async function cancelSosEscalation(
  redis: RedisClient,
  logger: Logger,
  alertId: string,
): Promise<void> {
  try {
    await redis.zrem(keys.sosEscalationQueue(), alertId);
  } catch (err) {
    logger.error("sos escalation could not be unscheduled (the sweep will drop it)", {
      alertId,
      err: String(err),
    });
  }
}

/** Same compare-and-remove as matching's `CLAIM_LAPSED_OFFER_SCRIPT`: read and delete in one
 *  round trip, and only if the entry is actually due. */
const CLAIM_DUE_ESCALATION_SCRIPT = `
local score = redis.call("zscore", KEYS[1], ARGV[1])
if score and tonumber(score) <= tonumber(ARGV[2]) then
  return redis.call("zrem", KEYS[1], ARGV[1])
else
  return 0
end`;

/**
 * Atomically take ownership of a DUE escalation entry. Exactly one caller across every
 * instance gets true for a given entry.
 *
 * The `score <= now` guard matters for the same reason it does for offers: the sweep reads
 * everything due and then works through the list, and by the time it reaches an entry that
 * entry may have been re-armed for a later step. A bare ZREM would steal the later step's
 * entry and the next page would never be scheduled.
 */
export async function claimDueEscalation(
  redis: RedisClient,
  alertId: string,
  now: number,
): Promise<boolean> {
  const claimed = await redis.eval(
    CLAIM_DUE_ESCALATION_SCRIPT,
    1,
    keys.sosEscalationQueue(),
    alertId,
    String(now),
  );
  return Number(claimed) === 1;
}

// ── the page ────────────────────────────────────────────────────────────────

const KIND_TEXT: Record<SosKind, string> = {
  panic: "panic",
  medical: "medical",
  unsafe: "feels-unsafe",
  other: "SOS",
};

/** Task ids are server-generated, but this string goes out over a carrier to a phone; anything
 *  that does not look like one of ours is not printed. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The text an on-call operator receives.
 *
 * Takes the handful of fields it may print, NOT a whole `SosAlert`. That is the privacy
 * control: the alert carries the raiser's position and free-text note, the hydrated view
 * carries both parties' names and phone numbers, and an SMS is plaintext that sits on a
 * carrier's systems and a lock screen. The on-call person needs to know that something is
 * unanswered, how serious and how long, and where to go to act on it — the console, behind a
 * staff login and a second factor, has everything else. A function that cannot see the
 * address cannot leak it.
 */
export function escalationMessage(
  input: { kind: SosKind; taskId: string; tier: number; unansweredMs: number },
  consoleOrigin: string,
): string {
  const minutes = Math.max(1, Math.round(input.unansweredMs / 60_000));
  const task = SAFE_ID.test(input.taskId) ? input.taskId : "(see console)";
  return (
    `Needy SOS: a ${KIND_TEXT[input.kind]} alarm on task ${task} has had no operator for ` +
    `${minutes} min (on-call tier ${input.tier}). Acknowledge it in the console: ` +
    `${consoleOrigin}/admin/sos`
  );
}

// ── boot ────────────────────────────────────────────────────────────────────

/**
 * Refuse to start a production process whose alarms can reach nobody.
 *
 * An empty on-call list is not a degraded mode: it is the exact failure escalation exists to
 * prevent, with the added harm that the code now LOOKS like it handles it. So production does
 * not warn and continue. Development has no phones to page and gets a warning on every boot
 * instead, loud enough that nobody mistakes a quiet console for a covered one.
 *
 * The console SMS adapter is called out separately, at error level in production: it is the
 * same no-one-is-reached outcome by another route, but refusing it here would also refuse
 * every OTP sign-in, which is a separate decision from this one (see `createSmsProvider`).
 *
 * A page that does reach somebody must also be something they can act on, so production
 * refuses a console link that is not https or that points at localhost.
 */
export function assertSosEscalationReachable(
  cfg: SosEscalationConfig,
  env: { isProduction: boolean; smsProvider: string },
  logger: Logger,
): void {
  // The page's console link. `webOrigin()` falls back to the first CORS origin and then to
  // http://localhost:3000, which is right for a laptop and a dead link in a page that wakes
  // someone at 3 a.m. — or, as plain http, a staff login over a connection anyone on the path
  // can read. Checked here rather than in config so the config module still loads under a
  // production NODE_ENV in tests that never boot the server.
  if (env.isProduction) {
    const url = new URL(cfg.consoleOrigin);
    if (url.protocol !== "https:") {
      throw new Error(
        "The SOS page's console link is not https in production. Set PUBLIC_WEB_ORIGIN to the " +
          "web app's public https origin.",
      );
    }
    if (isLoopbackHost(url.hostname)) {
      throw new Error(
        "The SOS page's console link points at localhost in production, which opens on the " +
          "on-call person's own phone. Set PUBLIC_WEB_ORIGIN to the web app's public origin.",
      );
    }
  }
  if (cfg.oncallTiers.length === 0) {
    if (env.isProduction) {
      throw new Error(
        "SOS_ONCALL_PHONES is empty in production. An SOS nobody acknowledges would page " +
          "no one. Set at least one on-call number.",
      );
    }
    logger.warn(
      "DEVELOPMENT: SOS_ONCALL_PHONES is empty — an alarm nobody acknowledges escalates to " +
        "NO ONE. Set it to exercise escalation.",
    );
  }
  if (env.smsProvider === "console") {
    const msg =
      "SOS escalation pages go through the CONSOLE SMS STUB — they are logged, not delivered. " +
      "Nobody's phone will ring until SMS_PROVIDER=twilio.";
    if (env.isProduction) logger.error(msg);
    else logger.warn(msg);
  }
}
