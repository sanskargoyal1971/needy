import { NS } from "@needy/shared";
import { maskPhone, type SmsProvider } from "../auth/providers.js";
import type { Deps } from "../domain/deps.js";
import { keys } from "../domain/keys.js";
import {
  claimDueEscalation,
  escalationMessage,
  intervalAfterStepMs,
  maxEscalationSteps,
  nextEscalationDue,
  tierForStep,
} from "../domain/sosEscalation.js";
import { SOS_OPERATOR_ROOM } from "./sos.js";

/** ── SOS escalation sweep ─────────────────────────────────────────────────
 *  Pages the on-call ladder for alarms nobody acknowledged. Modelled on matching's durable
 *  offer-expiry sweep (audit C19) and for the same reasons: the schedule is a Redis sorted set
 *  rather than a setTimeout, so a restart does not forget an alarm; and every due entry is
 *  claimed before anything is sent, so several instances sweeping at once page each step once.
 *
 *  Exactly-once rests on TWO guards, either of which would do on its own in the common case:
 *    1. `claimDueEscalation` — only one sweep removes a given schedule entry.
 *    2. `recordEscalation` — a compare-and-set on `status = 'raised'` and the step counter in
 *       Postgres. This one also covers the reconcile pass re-adding an entry another instance
 *       is half-way through handling, and an acknowledgement landing mid-sweep.
 *
 *  The step is RECORDED before the page is SENT. If the process dies between the two, that
 *  one page is lost and the next tier is still paged on schedule; the other order would
 *  instead page people about an alarm an operator acknowledged a moment earlier, every time
 *  the two raced, which teaches on-call staff to ignore the page.
 *
 *  ⚠ STUB IN DEVELOPMENT: with `SMS_PROVIDER=console` (the dev default) every page below is
 *  written to the log by `ConsoleSmsProvider` and delivered to nobody. Only `SMS_PROVIDER=
 *  twilio` makes a phone ring, and that adapter has not been exercised against the live
 *  Twilio API from this repository. Boot says so out loud (`assertSosEscalationReachable`).
 */

/** Same cadence as the offer sweep: cheap (one ZRANGEBYSCORE over a set that only holds live
 *  alarms) and well inside the precision anyone needs from a minute-scale threshold. */
const SWEEP_INTERVAL_MS = 1_000;

/** How often the schedule is rebuilt from Postgres. It only matters after a crash or a Redis
 *  data loss, so it can be slow; it runs once at start regardless. */
const RECONCILE_INTERVAL_MS = 60_000;

/** Upper bound on alerts reconciled per pass. Far beyond any real backlog of unanswered
 *  alarms; if it is ever reached, the oldest are the ones re-armed, which is the right end. */
const RECONCILE_LIMIT = 500;

export interface SosEscalationSweep {
  /** Page everything due now. Exposed for tests; `start` drives it on an interval. */
  sweepOnce(): Promise<void>;
  /** Re-arm the schedule from durable state. Idempotent. */
  reconcile(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createSosEscalationSweep(
  deps: Deps,
  opts: { sms: SmsProvider; sweepIntervalMs?: number; reconcileIntervalMs?: number },
): SosEscalationSweep {
  const cfg = deps.config.sos;
  const redis = deps.redis.client;
  const timers: ReturnType<typeof setInterval>[] = [];

  async function escalate(alertId: string): Promise<void> {
    const now = deps.now();
    if (!(await claimDueEscalation(redis, alertId, now))) return;

    const alert = await deps.sos.get(alertId);
    // Acknowledged, resolved or cancelled since it was scheduled: nothing is owed, and the
    // entry is already gone because we claimed it.
    if (!alert || alert.status !== "raised") return;

    if (cfg.oncallTiers.length === 0) {
      // Development only — production refuses to boot like this. Said every time, because each
      // time is an alarm that in a real deployment would have woken somebody.
      deps.logger.error("SOS UNACKNOWLEDGED and there is no on-call list to page", {
        alertId,
        taskId: alert.taskId,
        unansweredMs: now - alert.createdAt,
      });
      return;
    }

    // The ROW decides whether a page is due, not the schedule entry. An entry can be stale: the
    // reconcile pass may re-add one, from a row it read a moment before another instance
    // recorded the step, at that step's old deadline. Trusting it would page the NEXT tier
    // immediately, minutes early. So recompute, and if the alert is not due, put the entry
    // back at the deadline the row implies and leave it.
    const due = nextEscalationDue(alert, cfg);
    if (due == null) return;
    if (due > now) {
      await redis.zadd(keys.sosEscalationQueue(), "NX", due, alertId);
      return;
    }

    const step = alert.escalationStep + 1;
    const tier = tierForStep(cfg, step);

    const updated = await deps.sos.recordEscalation(alertId, alert.escalationStep, tier, now);
    // Lost the compare-and-set: an operator acknowledged in the gap, or another instance got
    // this step. Either way somebody else owns what happens next.
    if (!updated) return;

    // Re-arm BEFORE paging. A crash after this point still escalates to the next tier; a
    // crash before it is caught by reconcile, which derives the same deadline from the row.
    const final = step >= maxEscalationSteps(cfg);
    if (!final) {
      await redis.zadd(keys.sosEscalationQueue(), now + intervalAfterStepMs(cfg, step), alertId);
    }

    const phones = cfg.oncallTiers[tier - 1]!;
    const body = escalationMessage(
      { kind: alert.kind, taskId: alert.taskId, tier, unansweredMs: now - alert.createdAt },
      cfg.consoleOrigin,
    );
    const results = await Promise.allSettled(phones.map((p) => opts.sms.send(p, body)));
    const failed = phones.filter((_, i) => results[i]!.status === "rejected");

    // Error level, like the raise itself: an alarm that has gone unanswered long enough to wake
    // someone should trip whatever alerting watches this log.
    deps.logger.error("SOS ESCALATED to on-call", {
      alertId,
      taskId: alert.taskId,
      step,
      tier,
      final,
      delivered: phones.length - failed.length,
      failedTo: failed.map(maskPhone),
    });
    if (failed.length === phones.length) {
      deps.logger.error("SOS escalation reached NOBODY on this tier", { alertId, step, tier });
    }

    // The console learns it has been escalated over its feed, operators only. The participants
    // are not told: "on-call has been paged" is an internal fact, and the raiser's screen
    // already says what is true for them.
    deps.io.of(NS.sos).to(SOS_OPERATOR_ROOM).emit("sos-updated", updated);

    await deps.audit.record({
      action: "sos.escalated",
      actorId: null,
      actorRole: "system",
      subjectType: "sos",
      subjectId: alertId,
      // Counts, never numbers: this table is widely readable by staff and must not become a
      // directory of whose phone is on call.
      metadata: {
        taskId: alert.taskId,
        step,
        tier,
        final,
        recipients: phones.length,
        delivered: phones.length - failed.length,
        unansweredMs: now - alert.createdAt,
      },
    });
  }

  async function sweepOnce(): Promise<void> {
    try {
      const due = await redis.zrangebyscore(keys.sosEscalationQueue(), "-inf", deps.now());
      // Concurrently: one alert's slow carrier (Twilio's timeout is 8 s) must not hold up the
      // page for the next alarm in the list.
      await Promise.all(
        due.map((alertId) =>
          escalate(alertId).catch((err: unknown) => {
            deps.logger.error("sos escalation failed", { alertId, err: String(err) });
          }),
        ),
      );
    } catch (err) {
      deps.logger.error("sos escalation sweep failed", { err: String(err) });
    }
  }

  async function reconcile(): Promise<void> {
    try {
      const open = await deps.sos.listOpen(RECONCILE_LIMIT);
      for (const alert of open) {
        const due = nextEscalationDue(alert, cfg);
        if (due == null) continue;
        // NX: never move an existing deadline. If an instance is mid-way through this alert's
        // step, the row's compare-and-set makes whatever this adds harmless.
        await redis.zadd(keys.sosEscalationQueue(), "NX", due, alert.id);
      }
    } catch (err) {
      deps.logger.error("sos escalation reconcile failed", { err: String(err) });
    }
  }

  return {
    sweepOnce,
    reconcile,
    start() {
      void reconcile();
      const sweep = setInterval(() => void sweepOnce(), opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
      const rec = setInterval(
        () => void reconcile(),
        opts.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS,
      );
      // Don't keep the process alive purely for the sweep.
      sweep.unref?.();
      rec.unref?.();
      timers.push(sweep, rec);
    },
    stop() {
      for (const t of timers.splice(0)) clearInterval(t);
    },
  };
}
