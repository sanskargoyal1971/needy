import { createHash } from "node:crypto";
import busboy from "busboy";
import { Router, type Request, type Response } from "express";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  ACCEPTED_MIME,
  deriveOnboardingStatus,
  isDocumentKind,
  MAX_UPLOAD_BYTES,
  MINIMUM_AGE_YEARS,
  missingDocuments,
  readyToSubmit,
  REQUIRED_DOCUMENTS,
  type DocumentKind,
} from "@needy/shared";
import type { AuditLogger } from "../audit/log.js";
import { requireAuth, type AuthedRequest } from "../auth/middleware.js";
import type { UserRepository } from "../auth/repos.js";
import type { User } from "../auth/types.js";
import { validateBody } from "../auth/validation.js";
import { asyncRoute } from "../http/asyncRoute.js";
import { logger } from "../logger.js";
import { validateUpload } from "../services/fileType.js";
import { newStorageKey, type StorageProvider } from "../services/storage.js";
import type { KycDocumentRepository } from "./repos.js";

/** ── Onboarding router ─────────────────────────────────────────────────────
 *  The three steps between "phone verified" and "a human will look at this":
 *  identity → documents → submit.
 *
 *  The invariant every handler here upholds: **the server derives onboarding status from
 *  stored facts, never from a step the client claims to be on.** A wizard that trusts its own
 *  `step` parameter is a wizard you can skip by editing a fetch call, and the whole point of
 *  this funnel is that it cannot be skipped.
 */

export interface OnboardingDeps {
  users: UserRepository;
  documents: KycDocumentRepository;
  storage: StorageProvider;
  audit: AuditLogger;
  now: () => number;
}

/**
 * Is `YYYY-MM-DD` a day that actually exists?
 *
 * `new Date("2025-02-31")` does not reliably fail — the Date constructor rolls overflow
 * forward, so an impossible day becomes 2025-03-03 and is then treated as a real answer. That
 * is not a cosmetic issue here: the rolled date is what gets stored, and it is what the
 * eligibility matrix later derives an age band from, so a typo silently changes who a user is
 * allowed to be matched with. Round-tripping the components is the only reliable check.
 */
export function isRealCalendarDate(s: string): boolean {
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Whole years elapsed, by calendar — not `(now - dob) / 365.25 days`, which drifts across
 *  leap years and puts people on the wrong side of a birthday boundary. */
export function ageInYears(dobISO: string, nowMs: number): number {
  const dob = new Date(`${dobISO}T00:00:00Z`);
  const now = new Date(nowMs);
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

const identitySchema = z.object({
  displayName: z.string().trim().min(2, "tell us your full name").max(80),
  // Optional, and normalised to null: an empty string in a UNIQUE-ish column is a footgun,
  // and "" is what an untouched optional input actually submits.
  email: z.string().trim().email().max(200).optional().or(z.literal("")),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
    .refine(isRealCalendarDate, "not a real date"),
  gender: z.enum(["male", "female", "other"]),
  areaLabel: z.string().trim().min(2, "which area are you in?").max(160),
  areaLat: z.number().min(-90).max(90).optional(),
  areaLng: z.number().min(-180).max(180).optional(),
});

/** What the client is allowed to know about its own onboarding. Deliberately assembled by
 *  hand rather than spreading the row: the user record carries `reviewedBy`, `blockedAt` and
 *  other reviewer-side fields that are nobody's business but staff's. */
export function publicOnboarding(user: User, documents: DocumentKind[]) {
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    kycStatus: user.kycStatus,
    onboardingStatus: user.onboardingStatus,
    dateOfBirth: user.dateOfBirth,
    gender: user.gender,
    areaLabel: user.areaLabel,
    rejectionReason: user.rejectionReason,
    documents,
  };
}

/**
 * Read one multipart upload into memory, bounded.
 *
 * In memory rather than streamed to disk because the ceiling is 60 MB and the file is going
 * straight back out to object storage — a temp file would add a cleanup path (and a place for
 * an orphaned KYC video to sit on disk) for no benefit at this size.
 *
 * `limits.fileSize` makes busboy stop reading past the cap rather than buffering an unbounded
 * body first and checking afterwards, which is the difference between rejecting a 10 GB upload
 * and being OOM-killed by one.
 */
function readSingleUpload(
  req: Request,
  maxBytes: number,
): Promise<
  | { ok: true; kind: string; bytes: Buffer; declaredType: string }
  | { ok: false; reason: "no-file" | "too-large" | "malformed" }
> {
  return new Promise((resolve) => {
    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes, fields: 4 } });
    } catch {
      resolve({ ok: false, reason: "malformed" });
      return;
    }

    const chunks: Buffer[] = [];
    let kind = "";
    let declaredType = "";
    let sawFile = false;
    let truncated = false;
    let settled = false;
    const settle = (r: Awaited<ReturnType<typeof readSingleUpload>>) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    bb.on("field", (name, value) => {
      if (name === "kind") kind = value;
    });

    bb.on("file", (_name, stream, info) => {
      sawFile = true;
      declaredType = info.mimeType;
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("limit", () => {
        truncated = true;
        // Drain rather than destroy: busboy needs the stream consumed to reach 'close'.
        stream.resume();
      });
    });

    bb.on("close", () => {
      if (truncated) return settle({ ok: false, reason: "too-large" });
      if (!sawFile) return settle({ ok: false, reason: "no-file" });
      settle({ ok: true, kind, bytes: Buffer.concat(chunks), declaredType });
    });

    bb.on("error", () => settle({ ok: false, reason: "malformed" }));
    req.pipe(bb);
  });
}

export function createOnboardingRouter(deps: OnboardingDeps): Router {
  const router = Router();
  const ip = (req: Request) => req.ip ?? req.socket?.remoteAddress ?? null;

  /** Load the caller plus their documents, and refuse anyone already decided. Rejection is
   *  terminal: a rejected user re-POSTing the wizard must not be able to reopen their case,
   *  and an approved user must not be able to swap their ID out after review. */
  async function loadEditable(
    req: AuthedRequest,
    res: Response,
  ): Promise<{ user: User; documents: DocumentKind[] } | null> {
    const user = await deps.users.getById(req.user!.sub);
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return null;
    }
    if (user.onboardingStatus === "rejected") {
      res.status(403).json({ error: "onboarding-rejected", reason: user.rejectionReason });
      return null;
    }
    if (user.onboardingStatus === "approved") {
      res.status(409).json({ error: "already-approved" });
      return null;
    }
    const docs = await deps.documents.listForUser(user.id);
    return { user, documents: docs.map((d) => d.kind) };
  }

  // ── step 2: identity ───────────────────────────────────────────────────────
  router.post(
    "/onboarding/identity",
    requireAuth,
    validateBody(identitySchema),
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const loaded = await loadEditable(req, res);
      if (!loaded) return;
      const body = req.body as z.infer<typeof identitySchema>;

      // Age is a hard floor, not a review question. Under-18 is refused here rather than
      // being queued for a human, because no reviewer decision can make it acceptable.
      const age = ageInYears(body.dateOfBirth, deps.now());
      if (age < MINIMUM_AGE_YEARS) {
        res.status(422).json({ error: "under-age", minimumAge: MINIMUM_AGE_YEARS });
        return;
      }
      // A date of birth in the future, or implying an age no human has reached, is a typo or
      // a probe; either way it should not reach a reviewer as though it were a real answer.
      if (age > 120) {
        res.status(422).json({ error: "implausible-date-of-birth" });
        return;
      }

      const updated = await deps.users.update(loaded.user.id, {
        displayName: body.displayName,
        email: body.email ? body.email : null,
        dateOfBirth: body.dateOfBirth,
        gender: body.gender,
        areaLabel: body.areaLabel,
        areaLat: body.areaLat ?? null,
        areaLng: body.areaLng ?? null,
        onboardingStatus: deriveOnboardingStatus({
          hasIdentity: true,
          documents: loaded.documents,
        }),
        updatedAt: deps.now(),
      });

      // Note what is NOT recorded: the date of birth itself. The audit log answers "did this
      // person complete the step", not "what is their DOB" — that lives on the user row, and
      // duplicating it into an append-only table makes it undeletable on request.
      await deps.audit.record({
        action: "onboarding.identity_submitted",
        actorId: updated.id,
        actorRole: updated.role,
        subjectType: "user",
        subjectId: updated.id,
        ip: ip(req),
      });

      res.json({ user: publicOnboarding(updated, loaded.documents) });
    }),
  );

  // ── steps 3–5: documents ───────────────────────────────────────────────────
  router.post(
    "/onboarding/documents",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const loaded = await loadEditable(req, res);
      if (!loaded) return;

      // Read at the largest ceiling any kind allows, then re-check against the specific kind
      // below — the `kind` field is a multipart field and may arrive after the file part, so
      // it is not reliably known before the body has been read.
      const largest = Math.max(...Object.values(MAX_UPLOAD_BYTES));
      const upload = await readSingleUpload(req, largest);
      if (!upload.ok) {
        res.status(upload.reason === "too-large" ? 413 : 400).json({ error: upload.reason });
        return;
      }
      if (!isDocumentKind(upload.kind)) {
        res.status(400).json({ error: "unknown-document-kind" });
        return;
      }
      const kind: DocumentKind = upload.kind;

      // The declared content-type is attacker-controlled and is used for NOTHING except this
      // log line. What gets stored and served is the sniffed type. See services/fileType.ts.
      const check = validateUpload(upload.bytes, ACCEPTED_MIME[kind], MAX_UPLOAD_BYTES[kind]);
      if (!check.ok) {
        logger.warn("kyc upload rejected", {
          kind,
          reason: check.reason,
          declaredType: upload.declaredType,
        });
        res.status(check.reason === "too-large" ? 413 : 415).json({
          error: check.reason,
          accepted: ACCEPTED_MIME[kind],
        });
        return;
      }

      const sha256 = createHash("sha256").update(upload.bytes).digest("hex");
      const storageKey = newStorageKey(loaded.user.id, kind, check.extension);
      await deps.storage.put(storageKey, upload.bytes, check.mime);

      const { replacedStorageKey } = await deps.documents.put({
        id: nanoid(),
        userId: loaded.user.id,
        kind,
        storageKey,
        contentType: check.mime,
        sizeBytes: upload.bytes.length,
        sha256,
        createdAt: deps.now(),
      });

      // Delete the displaced object AFTER the row is committed. The other order risks a
      // deleted file still referenced by a row if the write then fails — a broken document in
      // the review queue, which is worse than an orphaned blob.
      if (replacedStorageKey) {
        await deps.storage.remove(replacedStorageKey).catch((err: unknown) => {
          logger.warn("could not remove replaced kyc object", {
            err: String(err),
          });
        });
      }

      const documents = [...new Set([...loaded.documents, kind])];
      const hasIdentity = loaded.user.dateOfBirth != null;
      await deps.users.update(loaded.user.id, {
        onboardingStatus: deriveOnboardingStatus({ hasIdentity, documents }),
        updatedAt: deps.now(),
      });

      await deps.audit.record({
        action: "onboarding.document_uploaded",
        actorId: loaded.user.id,
        actorRole: loaded.user.role,
        subjectType: "user",
        subjectId: loaded.user.id,
        metadata: { kind, contentType: check.mime, sizeBytes: upload.bytes.length },
        ip: ip(req),
      });

      res.json({
        documents,
        missing: missingDocuments(documents),
        readyToSubmit: readyToSubmit({ hasIdentity, documents }),
      });
    }),
  );

  // ── submit for human review ────────────────────────────────────────────────
  router.post(
    "/onboarding/submit",
    requireAuth,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const loaded = await loadEditable(req, res);
      if (!loaded) return;

      // Re-checked server-side rather than trusting that the wizard only enables the button
      // when it should. The client's view of completeness is a convenience, not the gate.
      if (loaded.user.dateOfBirth == null || loaded.user.gender == null) {
        res.status(422).json({ error: "identity-incomplete" });
        return;
      }
      const missing = missingDocuments(loaded.documents);
      if (missing.length > 0) {
        res
          .status(422)
          .json({ error: "documents-incomplete", missing, required: REQUIRED_DOCUMENTS });
        return;
      }

      // Idempotent: a double-submit (impatient tap, retried request) must not reset the
      // queue position by overwriting submittedAt with a later timestamp.
      if (loaded.user.onboardingStatus === "under_review") {
        res.json({ user: publicOnboarding(loaded.user, loaded.documents) });
        return;
      }

      const updated = await deps.users.update(loaded.user.id, {
        onboardingStatus: "under_review",
        submittedAt: deps.now(),
        updatedAt: deps.now(),
      });

      await deps.audit.record({
        action: "onboarding.submitted_for_review",
        actorId: updated.id,
        actorRole: updated.role,
        subjectType: "user",
        subjectId: updated.id,
        ip: ip(req),
      });

      res.json({ user: publicOnboarding(updated, loaded.documents) });
    }),
  );

  return router;
}
