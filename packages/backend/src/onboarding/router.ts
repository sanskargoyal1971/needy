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
import { newStorageKey, type StorageProvider } from "../services/storage.js";
import { uploadSlot } from "../services/uploadSlots.js";
import { receiveSingleUpload, uploadFailureStatus } from "../services/uploadStream.js";
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
    uploadSlot,
    asyncRoute(async (req: AuthedRequest, res: Response) => {
      const loaded = await loadEditable(req, res);
      if (!loaded) return;

      // Streamed straight to storage — see services/uploadStream.ts. The kind has to be
      // known before the first file byte, because it decides the size cap and the formats
      // accepted while the bytes are still arriving; a form that sends the file first is
      // refused rather than stored under a guess.
      const largest = Math.max(...Object.values(MAX_UPLOAD_BYTES));
      // Captured when the file part begins — the kind the bytes were checked against, which
      // is therefore the only kind they may be recorded as.
      // (A holder object rather than a `let`: TypeScript does not see assignments made inside
      // the callback and would narrow a `let` to its initial null.)
      const picked: { kind?: DocumentKind } = {};
      const upload = await receiveSingleUpload(req, {
        storage: deps.storage,
        maxBytes: largest,
        maxFields: 4,
        policyFor: (fields) => {
          if (fields.kind === undefined) return "kind-must-precede-file";
          if (!isDocumentKind(fields.kind)) return "unknown-document-kind";
          const k: DocumentKind = fields.kind;
          picked.kind = k;
          return {
            accepted: ACCEPTED_MIME[k],
            maxBytes: MAX_UPLOAD_BYTES[k],
            keyFor: (ext) => newStorageKey(loaded.user.id, k, ext),
          };
        },
      });
      if (!upload.ok) {
        // The declared content-type is not consulted at all: what gets stored and served is
        // the sniffed type. See services/fileType.ts.
        logger.warn("kyc upload rejected", { kind: picked.kind, reason: upload.reason });
        const status = uploadFailureStatus(upload.reason);
        res.status(status).json({
          error: upload.reason,
          ...(status === 415 && picked.kind ? { accepted: ACCEPTED_MIME[picked.kind] } : {}),
        });
        return;
      }
      const { stored } = upload;
      // Set whenever an upload succeeded: storing requires a policy, which requires a kind.
      const docKind = picked.kind!;

      // If the row cannot be written, the object it would have pointed at must not outlive
      // it: an unreferenced ID scan in the bucket is exactly the kind of leftover nobody
      // notices until a breach inventory does.
      const placed = await deps.documents
        .put({
          id: nanoid(),
          userId: loaded.user.id,
          kind: docKind,
          storageKey: stored.key,
          contentType: stored.mime,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          createdAt: deps.now(),
        })
        .catch(async (err: unknown) => {
          await deps.storage.remove(stored.key).catch(() => undefined);
          throw err;
        });
      const { replacedStorageKey } = placed;

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

      const documents = [...new Set([...loaded.documents, docKind])];
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
        metadata: { kind: docKind, contentType: stored.mime, sizeBytes: stored.sizeBytes },
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
