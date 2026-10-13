import { uploadSlot } from "../services/uploadSlots.js";
import busboy from "busboy";
import { Router, type Request, type Response } from "express";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  ACCEPTED_MIME,
  EXCEPTION_REVIEW_SLA_MS,
  MAX_UPLOAD_BYTES,
  pairingDecision,
} from "@needy/shared";
import type { AuditLogger } from "../audit/log.js";
import { requireAuth, requireStaff, type AuthedRequest } from "../auth/middleware.js";
import { requireOnboarded } from "../auth/onboardingGate.js";
import type { UserRepository } from "../auth/repos.js";
import { validateBody } from "../auth/validation.js";
import { config } from "../config.js";
import type { BookingException, ExceptionRepository } from "../domain/exceptions.js";
import { asyncRoute } from "../http/asyncRoute.js";
import { logger } from "../logger.js";
import { validateUpload } from "../services/fileType.js";
import { newStorageKey, type StorageProvider } from "../services/storage.js";

/** ── Booking exceptions ────────────────────────────────────────────────────
 *  The route around a restricted pairing, and deliberately a slow one.
 *
 *  Both parties record a short video saying who they are and that they consent to this
 *  specific booking; an admin watches both and decides within a working day. That delay is
 *  not friction to be optimised away — it is the entire mechanism. A same-minute "I consent"
 *  checkbox would be indistinguishable from the pressure it exists to detect, which is why
 *  the exception route is asynchronous and the resulting booking must be scheduled in
 *  advance rather than dispatched live.
 */

export interface ExceptionRouterDeps {
  users: UserRepository;
  exceptions: ExceptionRepository;
  storage: StorageProvider;
  audit: AuditLogger;
  now: () => number;
}

const openSchema = z.object({
  helperId: z.string().trim().min(1).max(128),
});

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).optional(),
});

/** How long an approval lasts. Not indefinite: a waiver granted in 2026 must not still be
 *  authorising a booking in 2029, long after either party could be said to have consented
 *  to it. Ninety days is long enough for a repeat booking, short enough to expire. */
const APPROVAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** What either party may see about their own request. No storage keys, no other party's
 *  video — a participant may know the request exists and where it stands, not watch the
 *  other person's testimony. */
function participantView(e: BookingException) {
  return {
    id: e.id,
    requesterId: e.requesterId,
    helperId: e.helperId,
    status: e.status,
    requesterVideoSubmitted: e.requesterVideoKey != null,
    helperVideoSubmitted: e.helperVideoKey != null,
    createdAt: e.createdAt,
    submittedAt: e.submittedAt,
    decidedAt: e.decidedAt,
    expiresAt: e.expiresAt,
    reviewNote: e.status === "rejected" ? e.reviewNote : null,
    /** So the UI can say "by tomorrow" rather than "soon". */
    reviewDueBy: e.submittedAt != null ? e.submittedAt + EXCEPTION_REVIEW_SLA_MS : null,
  };
}

/** Read one bounded multipart video. Same shape as the onboarding upload reader; kept local
 *  rather than shared because that one is coupled to the document-kind field and this one
 *  takes no fields at all. */
function readVideo(
  req: Request,
  maxBytes: number,
): Promise<
  { ok: true; bytes: Buffer } | { ok: false; reason: "no-file" | "too-large" | "malformed" }
> {
  return new Promise((resolve) => {
    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes, fields: 2 } });
    } catch {
      resolve({ ok: false, reason: "malformed" });
      return;
    }
    const chunks: Buffer[] = [];
    let sawFile = false;
    let truncated = false;
    let settled = false;
    const settle = (r: Awaited<ReturnType<typeof readVideo>>) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    bb.on("file", (_n, stream) => {
      sawFile = true;
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("limit", () => {
        truncated = true;
        stream.resume();
      });
    });
    bb.on("close", () => {
      if (truncated) return settle({ ok: false, reason: "too-large" });
      if (!sawFile) return settle({ ok: false, reason: "no-file" });
      settle({ ok: true, bytes: Buffer.concat(chunks) });
    });
    bb.on("error", () => settle({ ok: false, reason: "malformed" }));
    req.pipe(bb);
  });
}

export function createExceptionRouter(deps: ExceptionRouterDeps): Router {
  const router = Router();
  const gate = requireOnboarded({ users: deps.users });
  const adminOnly = [requireAuth, requireStaff(deps.users, "admin")] as const;
  const ip = (req: Request) => req.ip ?? req.socket?.remoteAddress ?? null;

  // ── open a request ─────────────────────────────────────────────────────────
  router.post(
    "/exceptions",
    requireAuth,
    gate,
    validateBody(openSchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const requesterId = req.user!.sub;
      const { helperId } = req.body as z.infer<typeof openSchema>;
      if (helperId === requesterId) {
        res.status(422).json({ error: "cannot-pair-with-self" });
        return;
      }

      const [requester, helper] = await Promise.all([
        deps.users.getById(requesterId),
        deps.users.getById(helperId),
      ]);
      if (!helper) {
        res.status(404).json({ error: "helper-not-found" });
        return;
      }

      // Only open a request for a pairing that actually needs one. An `allowed` pair asking
      // for an exception would create a review with nothing to decide; a `denied` pair asking
      // would create the impression that a decision could unlock it, which it cannot.
      const decision = pairingDecision(
        requester ?? { dateOfBirth: null, gender: null },
        helper,
        deps.now(),
      );
      if (decision.kind === "allowed") {
        res.status(409).json({ error: "no-exception-needed" });
        return;
      }
      if (decision.kind === "denied") {
        res.status(403).json({ error: "pairing-denied", reason: decision.reason });
        return;
      }

      const existing = await deps.exceptions.findForPair(requesterId, helperId);
      if (
        existing &&
        ["awaiting_videos", "under_review", "approved"].includes(existing.status) &&
        (existing.expiresAt == null || existing.expiresAt > deps.now())
      ) {
        // Idempotent: tapping "request an exception" twice returns the request in flight
        // rather than creating a second one for an admin to disambiguate.
        res.json({ exception: participantView(existing) });
        return;
      }

      const created = await deps.exceptions.create({
        id: nanoid(),
        requesterId,
        helperId,
        status: "awaiting_videos",
        requesterVideoKey: null,
        helperVideoKey: null,
        reviewedBy: null,
        reviewNote: null,
        createdAt: deps.now(),
        submittedAt: null,
        decidedAt: null,
        expiresAt: null,
      });
      res.status(201).json({ exception: participantView(created) });
    }),
  );

  // ── either party uploads their testimony ───────────────────────────────────
  router.post(
    "/exceptions/:id/video",
    requireAuth,
    gate,
    uploadSlot,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const userId = req.user!.sub;
      const exception = await deps.exceptions.getById(req.params.id);
      if (!exception) {
        res.status(404).json({ error: "exception-not-found" });
        return;
      }
      const side =
        exception.requesterId === userId
          ? "requester"
          : exception.helperId === userId
            ? "helper"
            : null;
      if (!side) {
        res.status(404).json({ error: "exception-not-found" });
        return;
      }
      // Once submitted, the packet is a reviewer's to judge. Letting a party swap their video
      // mid-review would mean the decision was made against something that no longer exists.
      if (exception.status !== "awaiting_videos") {
        res.status(409).json({ error: "not-accepting-videos", status: exception.status });
        return;
      }

      const upload = await readVideo(req, MAX_UPLOAD_BYTES.video_testimony);
      if (!upload.ok) {
        res.status(upload.reason === "too-large" ? 413 : 400).json({ error: upload.reason });
        return;
      }
      const check = validateUpload(
        upload.bytes,
        ACCEPTED_MIME.video_testimony,
        MAX_UPLOAD_BYTES.video_testimony,
      );
      if (!check.ok) {
        res.status(415).json({ error: check.reason, accepted: ACCEPTED_MIME.video_testimony });
        return;
      }

      const key = newStorageKey(userId, `exception-${side}`, check.extension);
      await deps.storage.put(key, upload.bytes, check.mime);

      const patch = side === "requester" ? { requesterVideoKey: key } : { helperVideoKey: key };
      let updated = await deps.exceptions.update(exception.id, patch);

      // Both present → the packet enters the queue and the SLA clock starts.
      if (updated.requesterVideoKey && updated.helperVideoKey) {
        updated = await deps.exceptions.update(exception.id, {
          status: "under_review",
          submittedAt: deps.now(),
        });
      }

      await deps.audit.record({
        action: "onboarding.document_uploaded",
        actorId: userId,
        subjectType: "user",
        subjectId: userId,
        metadata: { kind: "exception_video", exceptionId: exception.id, side },
        ip: ip(req),
      });

      res.json({ exception: participantView(updated) });
    }),
  );

  // ── where does my request stand ────────────────────────────────────────────
  router.get(
    "/exceptions/for/:helperId",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const found = await deps.exceptions.findForPair(req.user!.sub, req.params.helperId);
      res.json({ exception: found ? participantView(found) : null });
    }),
  );

  // ── everything waiting on me ───────────────────────────────────────────────
  //
  // The route that made the flow completable. An exception needs both testimonies, and the
  // HELPER did not open it: they have no id to look up, and `/exceptions/for/:helperId` reads
  // the ordered pair from the requester's side, so a helper calling it learns nothing. There
  // was no way to tell the second person that anything was waiting on them, so every request
  // sat in `awaiting_videos` until it expired.
  router.get(
    "/me/exceptions",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const userId = req.user!.sub;
      const mine = await deps.exceptions.forParticipant(userId, 20);
      const withNames = await Promise.all(
        mine.map(async (e) => {
          // The OTHER party's display name only. A pairing under review is precisely the
          // situation in which the two people are not yet cleared to know more about each
          // other, so this carries no phone number, no age and no gender — just enough for
          // "Priya has asked to be paired with you" to be a sentence about a person.
          const otherId = e.requesterId === userId ? e.helperId : e.requesterId;
          const other = await deps.users.getById(otherId);
          return {
            ...participantView(e),
            /** Which side the CALLER is on, so a client never has to compare ids to find out
             *  whose testimony is outstanding. */
            myRole: e.requesterId === userId ? ("requester" as const) : ("helper" as const),
            otherName: other?.displayName ?? "someone",
          };
        }),
      );
      res.json({ exceptions: withNames });
    }),
  );

  // ── admin: the queue ───────────────────────────────────────────────────────
  router.get(
    "/admin/exceptions",
    ...adminOnly,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
      const entries = await deps.exceptions.queue(limit);
      // Names, so a reviewer is not decoding opaque ids. Two lookups per row is fine at a
      // queue's scale and beats a join the in-memory implementation could not express.
      const withNames = await Promise.all(
        entries.map(async (e) => {
          const [r, h] = await Promise.all([
            deps.users.getById(e.requesterId),
            deps.users.getById(e.helperId),
          ]);
          return {
            ...participantView(e),
            requesterName: r?.displayName ?? e.requesterId,
            helperName: h?.displayName ?? e.helperId,
            requesterDob: r?.dateOfBirth ?? null,
            requesterGender: r?.gender ?? null,
            helperDob: h?.dateOfBirth ?? null,
            helperGender: h?.gender ?? null,
          };
        }),
      );
      res.json({ entries: withNames });
    }),
  );

  // ── admin: watch both testimonies ──────────────────────────────────────────
  router.get(
    "/admin/exceptions/:id",
    ...adminOnly,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const e = await deps.exceptions.getById(req.params.id);
      if (!e) {
        res.status(404).json({ error: "exception-not-found" });
        return;
      }
      const ttl = config.storage.signedUrlTtlSeconds;
      const videos = {
        requester: e.requesterVideoKey
          ? await deps.storage.signedUrl(e.requesterVideoKey, ttl)
          : null,
        helper: e.helperVideoKey ? await deps.storage.signedUrl(e.helperVideoKey, ttl) : null,
      };
      // Same rule as the KYC packet: being handed the bytes is an auditable act.
      await deps.audit.record({
        action: "admin.document_viewed",
        actorId: req.user!.sub,
        actorRole: "admin",
        subjectType: "user",
        subjectId: e.requesterId,
        metadata: { kind: "exception_video", exceptionId: e.id },
        ip: ip(req),
      });
      res.json({ exception: participantView(e), videos });
    }),
  );

  // ── admin: decide ──────────────────────────────────────────────────────────
  router.post(
    "/admin/exceptions/:id/decision",
    ...adminOnly,
    validateBody(decisionSchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const adminId = req.user!.sub;
      const body = req.body as z.infer<typeof decisionSchema>;
      const e = await deps.exceptions.getById(req.params.id);
      if (!e) {
        res.status(404).json({ error: "exception-not-found" });
        return;
      }
      if (e.status !== "under_review") {
        res.status(409).json({ error: "not-awaiting-review", status: e.status });
        return;
      }
      // An admin who is one of the two parties is not an independent reviewer of their own
      // pairing — the same rule as the KYC queue, for the same reason.
      if (adminId === e.requesterId || adminId === e.helperId) {
        res.status(403).json({ error: "cannot-review-own-pairing" });
        return;
      }

      const now = deps.now();
      const updated = await deps.exceptions.update(e.id, {
        status: body.decision === "approve" ? "approved" : "rejected",
        reviewedBy: adminId,
        reviewNote: body.note ?? null,
        decidedAt: now,
        expiresAt: body.decision === "approve" ? now + APPROVAL_TTL_MS : null,
      });

      await deps.audit.record({
        action: body.decision === "approve" ? "onboarding.approved" : "onboarding.rejected",
        actorId: adminId,
        actorRole: "admin",
        subjectType: "user",
        subjectId: e.requesterId,
        metadata: {
          kind: "booking_exception",
          exceptionId: e.id,
          helperId: e.helperId,
          note: body.note ?? null,
        },
        ip: ip(req),
      });

      logger.info("booking exception decided", {
        exceptionId: e.id,
        decision: body.decision,
        adminId,
      });
      res.json({ exception: participantView(updated) });
    }),
  );

  return router;
}
