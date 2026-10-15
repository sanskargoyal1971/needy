import { NS } from "@needy/shared";
import { maskPhone, type SmsProvider } from "../auth/providers.js";
import type { Deps } from "../domain/deps.js";
import { keys } from "../domain/keys.js";
import { metrics, type AppMetrics } from "../metrics/appMetrics.js";
import {
  claimDueEscalation,
  escalationMessage,
  intervalAfterStepMs,
  isEscalationTooLate,
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

/** Alerts read per reconcile query. A page size, not a cap: reconcile keeps paging until it
 *  has seen every raised alert, so no alarm is left un-armed behind a long backlog. */
const RECONCILE_PAGE_SIZE = 500;

/** How many skipped alert ids one "too late to page" log line names. The count is always
 *  exact; the ids are there so somebody can go and find them. */
const TOO_LATE_IDS_LOGGED = 20;

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
  opts: {
    sms: SmsProvider;
    /** Where sweep passes are counted. Defaults to the process-wide registry. */
    metrics?: AppMetrics;
    sweepIntervalMs?: number;
    reconcileIntervalMs?: number;
    reconcilePageSize?: number;
  },
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
    // Fell due while nothing was sweeping (see `isEscalationTooLate`). Not paged and not
    // re-armed — the claim already removed the entry, and reconcile skips it too — but said at
    // error level, because it is still an alarm nobody has answered.
    if (isEscalationTooLate(due, now, cfg)) {
      deps.logger.error(
        "SOS UNACKNOWLEDGED and too late to page on-call — answer it at the console",
        {
          alertId,
          taskId: alert.taskId,
          step: alert.escalationStep,
          lateMs: now - due,
        },
      );
      return;
    }

    const step = alert.escalationStep + 1;
    const tier = tierForStep(cfg, step);

    const updated = await deps.sos.recordEscalation(alertId, alert.escalationStep, tier, now);
    // Lost the compare-and-set: an operator acknowledged in the gap, or another instance got
    // this step. Either way somebody else owns what happens next.
    if (!updated) return;

    // Re-arm BEFORE paging, so a crash after this point still escalates to the next tier.
    //
    // Best-effort, like `scheduleSosEscalation`. The step is already committed to the row, so
    // the page below is now the only chance this tier gets: a Redis error here used to throw
    // out of the function, leaving the row saying "tier N paged" with nobody paged and no
    // audit row, and the next reconcile arming step N+1 — tier N skipped for good. Reconcile
    // derives the next deadline from the row whether or not this write landed.
    const final = step >= maxEscalationSteps(cfg);
    if (!final) {
      try {
        await redis.zadd(keys.sosEscalationQueue(), now + intervalAfterStepMs(cfg, step), alertId);
      } catch (err) {
        deps.logger.error("sos escalation could not be re-armed (reconcile will re-arm it)", {
          alertId,
          step,
          err: String(err),
        });
      }
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
    // already says what is true for them. Every participant channel strips these fields
    // (`participantSosView`), so a later fan-out does not tell them either.
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
    // One failed alert fails the pass for the metrics, even though the others went out: an
    // escalation that errors is a page that may not have been sent, which is worth an alert.
    let ok = true;
    try {
      const due = await redis.zrangebyscore(keys.sosEscalationQueue(), "-inf", deps.now());
      // Concurrently: one alert's slow carrier (Twilio's timeout is 8 s) must not hold up the
      // page for the next alarm in the list.
      await Promise.all(
        due.map((alertId) =>
          escalate(alertId).catch((err: unknown) => {
            ok = false;
            deps.logger.error("sos escalation failed", { alertId, err: String(err) });
          }),
        ),
      );
    } catch (err) {
      ok = false;
      deps.logger.error("sos escalation sweep failed", { err: String(err) });
    }
    (opts.metrics ?? metrics).recordSweep("sos_escalation", ok, deps.now());
  }

  async function reconcile(): Promise<void> {
    try {
      const max = maxEscalationSteps(cfg);
      if (max === 0) return;
      const pageSize = opts.reconcilePageSize ?? RECONCILE_PAGE_SIZE;
      const now = deps.now();
      const tooLate: string[] = [];
      let tooLateCount = 0;
      let after: { createdAt: number; id: string } | null = null;
      for (;;) {
        const page = await deps.sos.listEscalatable({ belowStep: max, after, limit: pageSize });
        for (const alert of page) {
          const due = nextEscalationDue(alert, cfg);
          if (due == null) continue;
          if (isEscalationTooLate(due, now, cfg)) {
            tooLateCount++;
            if (tooLate.length < TOO_LATE_IDS_LOGGED) tooLate.push(alert.id);
            continue;
          }
          // NX: never move an existing deadline. If an instance is mid-way through this alert's
          // step, the row's compare-and-set makes whatever this adds harmless.
          await redis.zadd(keys.sosEscalationQueue(), "NX", due, alert.id);
        }
        if (page.length < pageSize) break;
        const last = page[page.length - 1]!;
        after = { createdAt: last.createdAt, id: last.id };
      }
      // One line per pass, not one per alert: repeated every reconcile for as long as they sit
      // unanswered, which is the point, but without burying the log in them.
      if (tooLateCount > 0) {
        deps.logger.error("SOS alerts UNACKNOWLEDGED and too late to page on-call", {
          count: tooLateCount,
          alertIds: tooLate,
        });
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
