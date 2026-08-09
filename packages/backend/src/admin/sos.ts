import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { NS, type SosAlert, type SosStatus } from "@needy/shared";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import { validateBody } from "../auth/validation.js";
import type { Deps } from "../domain/deps.js";
import { asyncRoute } from "../http/asyncRoute.js";
import { personalRoom, SOS_OPERATOR_ROOM } from "../socket/sos.js";

/** ── SOS operator console ──────────────────────────────────────────────────
 *  The other half of the alarm. Raising an SOS was already durable and already fanned out to
 *  a room called `sos:operators` — but nothing ever joined that room and no surface existed to
 *  read, own, or close an alert. `acknowledged` sat in the status union as a state no code
 *  path could produce. So the alarm was, in the end, still a promise the platform could not
 *  keep: it recorded that somebody was in trouble and gave no one a way to answer.
 *
 *  Two rules shape every handler here:
 *
 *   1. **Acknowledging is a commitment, not a read.** It puts a named operator on the alert
 *      and tells the raiser, over the socket, that a person has it. That claim must never be
 *      made by merely opening a list, which is why acknowledgement is an explicit POST and
 *      never a side effect of `GET /admin/sos`.
 *   2. **Closing requires an account of what happened.** `note` is mandatory on resolve. An
 *      alert closed with no explanation is indistinguishable from an operator clearing their
 *      queue, and the difference is the entire value of the record afterwards.
 */

const resolveSchema = z.object({
  /** Required, and deliberately so — see rule 2 above. */
  note: z.string().trim().min(1).max(1000),
});

/** What an operator sees in the queue: the alert plus enough context to act on it without
 *  opening anything. Names and phone numbers of BOTH parties are included because an operator
 *  answering an alarm is going to call someone, and making them click through to find out who
 *  costs seconds in the one flow where seconds are the point. */
interface AlertView extends SosAlert {
  task: {
    id: string;
    title: string;
    state: string;
    category: string;
    origin: { lat: number; lng: number };
  } | null;
  requester: PartyView | null;
  helper: PartyView | null;
  /** Which party pulled the alarm, resolved for the console so it does not have to compare
   *  ids to work out whether the person in danger is the one who asked for help or the one
   *  who came. */
  raisedByRole: "requester" | "helper" | "unknown";
  /** Display names for the operators on the alert. The raw ids are still in `acknowledgedBy`
   *  and `resolvedBy` — those are the audit-grade values — but "Owned by admin-seed" is not an
   *  answer to the question a colleague is actually asking, which is who to go and talk to. */
  acknowledgedByName: string | null;
  resolvedByName: string | null;
}

interface PartyView {
  id: string;
  displayName: string;
  /** FULL number, not masked. This is the one surface where that is right: an operator
   *  looking at a live emergency needs to be able to phone the person, and this endpoint
   *  returns a handful of alerts rather than a directory. The abuse queue, which IS a list of
   *  ordinary users, masks. */
  phone: string;
}

export function createSosAdminRouter(deps: Deps): Router {
  const router = Router();
  const adminOnly = [requireAuth, requireRole("admin")] as const;
  const ip = (req: Request) => req.ip ?? req.socket?.remoteAddress ?? null;

  /** Hydrate alerts with their task and both participants.
   *
   *  Batched by unique id rather than per alert: several alerts on one task is the normal
   *  shape of a bad incident (both parties press the button), and that would otherwise fetch
   *  the same task and the same two people once per alert. */
  async function hydrate(alerts: SosAlert[]): Promise<AlertView[]> {
    const taskIds = [...new Set(alerts.map((a) => a.taskId))];
    const tasks = new Map(
      (await Promise.all(taskIds.map((id) => deps.tasks.get(id))))
        .filter((t) => t != null)
        .map((t) => [t.id, t]),
    );

    const userIds = [
      ...new Set(
        alerts.flatMap((a) => {
          const task = tasks.get(a.taskId);
          return [
            a.raisedBy,
            task?.requesterId,
            task?.helperId,
            // The operators too — same batched lookup, so naming them costs nothing extra.
            a.acknowledgedBy,
            a.resolvedBy,
          ].filter((v): v is string => typeof v === "string");
        }),
      ),
    ];
    const users = new Map(
      (await Promise.all(userIds.map((id) => deps.users.getById(id))))
        .filter((u) => u != null)
        .map((u) => [u.id, { id: u.id, displayName: u.displayName, phone: u.phone }]),
    );

    return alerts.map((alert) => {
      const task = tasks.get(alert.taskId) ?? null;
      return {
        ...alert,
        task: task
          ? {
              id: task.id,
              title: task.title,
              state: task.state,
              category: task.category,
              origin: task.origin,
            }
          : null,
        requester: task ? (users.get(task.requesterId) ?? null) : null,
        helper: task?.helperId ? (users.get(task.helperId) ?? null) : null,
        acknowledgedByName: alert.acknowledgedBy
          ? (users.get(alert.acknowledgedBy)?.displayName ?? alert.acknowledgedBy)
          : null,
        resolvedByName: alert.resolvedBy
          ? (users.get(alert.resolvedBy)?.displayName ?? alert.resolvedBy)
          : null,
        raisedByRole:
          task == null
            ? "unknown"
            : alert.raisedBy === task.requesterId
              ? "requester"
              : alert.raisedBy === task.helperId
                ? "helper"
                : "unknown",
      };
    });
  }

  /** Tell everyone who has a stake in this alert that it changed: both participants, so the
   *  raiser learns a person has it, and every operator, so two of them do not work the same
   *  alarm in parallel. */
  async function fanOut(alert: SosAlert): Promise<void> {
    const task = await deps.tasks.get(alert.taskId);
    const nsp = deps.io.of(NS.sos);
    nsp
      .to(personalRoom(alert.raisedBy))
      .to(personalRoom(task?.requesterId ?? alert.raisedBy))
      .to(personalRoom(task?.helperId ?? alert.raisedBy))
      .to(SOS_OPERATOR_ROOM)
      .emit("sos-updated", alert);
  }

  // ── the queue ──────────────────────────────────────────────────────────────
  router.get(
    "/admin/sos",
    ...adminOnly,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const scope = String(req.query.scope ?? "open");
      // Bounded low on purpose. This is a triage queue, not an archive: if it is returning
      // hundreds of open alerts the answer is more operators, not a longer page.
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);

      if (scope === "open") {
        res.json({ alerts: await hydrate(await deps.sos.listOpen(limit)), scope });
        return;
      }
      if (scope === "all") {
        res.json({ alerts: await hydrate(await deps.sos.listRecent({ limit })), scope });
        return;
      }
      // A specific status, e.g. ?scope=resolved for a shift review.
      const statuses: SosStatus[] = ["raised", "acknowledged", "resolved", "cancelled"];
      if (!statuses.includes(scope as SosStatus)) {
        res.status(400).json({ error: "unknown-scope" });
        return;
      }
      res.json({
        alerts: await hydrate(
          await deps.sos.listRecent({ statuses: [scope as SosStatus], limit }),
        ),
        scope,
      });
    }),
  );

  // ── one alert, in full ─────────────────────────────────────────────────────
  router.get(
    "/admin/sos/:alertId",
    ...adminOnly,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const alert = await deps.sos.get(req.params.alertId);
      if (!alert) {
        res.status(404).json({ error: "alert-not-found" });
        return;
      }
      const [view] = await hydrate([alert]);
      res.json({ alert: view });
    }),
  );

  // ── take ownership ─────────────────────────────────────────────────────────
  router.post(
    "/admin/sos/:alertId/acknowledge",
    ...adminOnly,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const operatorId = req.user!.sub;
      const alertId = req.params.alertId;
      const now = deps.now();

      const updated = await deps.sos.acknowledge(alertId, operatorId, now);
      if (!updated) {
        // The guarded UPDATE matched nothing. Distinguish the two reasons, because "this
        // alert does not exist" and "your colleague got there first" call for completely
        // different reactions from the person clicking.
        const existing = await deps.sos.get(alertId);
        if (!existing) {
          res.status(404).json({ error: "alert-not-found" });
          return;
        }
        res.status(409).json({
          error: "not-acknowledgeable",
          status: existing.status,
          acknowledgedBy: existing.acknowledgedBy,
        });
        return;
      }

      await fanOut(updated);
      await deps.audit.record({
        action: "sos.acknowledged",
        actorId: operatorId,
        actorRole: "admin",
        subjectType: "sos",
        subjectId: updated.id,
        metadata: { taskId: updated.taskId, waitedMs: now - updated.createdAt },
        ip: ip(req),
      });
      deps.logger.warn("SOS acknowledged by operator", {
        alertId: updated.id,
        taskId: updated.taskId,
        operatorId,
        waitedMs: now - updated.createdAt,
      });

      const [view] = await hydrate([updated]);
      res.json({ alert: view });
    }),
  );

  // ── close it ───────────────────────────────────────────────────────────────
  router.post(
    "/admin/sos/:alertId/resolve",
    ...adminOnly,
    validateBody(resolveSchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const operatorId = req.user!.sub;
      const alertId = req.params.alertId;
      const { note } = req.body as z.infer<typeof resolveSchema>;
      const now = deps.now();

      const updated = await deps.sos.resolve(alertId, operatorId, note, now);
      if (!updated) {
        const existing = await deps.sos.get(alertId);
        if (!existing) {
          res.status(404).json({ error: "alert-not-found" });
          return;
        }
        res.status(409).json({ error: "not-open", status: existing.status });
        return;
      }

      await fanOut(updated);
      await deps.audit.record({
        action: "sos.resolved",
        actorId: operatorId,
        actorRole: "admin",
        subjectType: "sos",
        subjectId: updated.id,
        // The resolution note IS recorded here, unlike the raiser's own note on the raise
        // path. This one is written by a member of staff about their handling of an incident,
        // which is exactly the kind of thing an audit log exists to preserve.
        metadata: {
          taskId: updated.taskId,
          note,
          openForMs: now - updated.createdAt,
          wasAcknowledged: updated.acknowledgedBy != null,
        },
        ip: ip(req),
      });
      deps.logger.warn("SOS resolved by operator", {
        alertId: updated.id,
        taskId: updated.taskId,
        operatorId,
        openForMs: now - updated.createdAt,
      });

      const [view] = await hydrate([updated]);
      res.json({ alert: view });
    }),
  );

  return router;
}
