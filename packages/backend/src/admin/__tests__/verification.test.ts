import express from "express";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOSPITAL_SERVICE_CODE } from "@needy/shared";
import { signAccessToken } from "../../auth/jwt.js";
import {
  createInMemoryPhoneBlockRepo,
  type PhoneBlockRepository,
} from "../../auth/phoneBlocks.js";
import {
  createInMemorySessionRepo,
  createInMemoryUserRepo,
  type InMemoryUserRepository,
  type SessionRepository,
} from "../../auth/repos.js";
import { AuthService, PhoneBlockedError } from "../../auth/service.js";
import { makeUser } from "../../auth/types.js";
import { createLoggingAuditLogger, type AuditEntry } from "../../audit/log.js";
import {
  createInMemoryKycDocumentRepo,
  type KycDocumentRepository,
} from "../../onboarding/repos.js";
import { LocalDiskStorage } from "../../services/storage.js";
import { createVerificationRouter } from "../verification.js";
import { createInMemoryAdminUserQueries } from "../verificationRepo.js";
import {
  createInMemoryServiceCatalog,
  type ServiceCatalog,
} from "../../services/catalog.js";

const NOW = Date.UTC(2026, 7, 9);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);

describe("admin verification surface", () => {
  let app: express.Express;
  let users: InMemoryUserRepository;
  let sessions: SessionRepository;
  let documents: KycDocumentRepository;
  let phoneBlocks: PhoneBlockRepository;
  let storage: LocalDiskStorage;
  let storageRoot: string;
  let services: ServiceCatalog;
  /** Captured rather than written: the assertions are about WHICH events were recorded, and
   *  the in-memory logger would otherwise swallow them into the app log. */
  let recorded: AuditEntry[];

  const ADMIN = "admin-1";
  const adminToken = signAccessToken({ sub: ADMIN, role: "admin", displayName: "Ops" });
  const userToken = (sub: string) =>
    signAccessToken({ sub, role: "requester", displayName: sub });

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "needy-admin-"));
  });
  afterAll(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  /** A complete, submitted packet — the only state a decision is legal from. */
  async function seedApplicant(id: string, phone: string) {
    await users.create(
      makeUser({
        id,
        phone,
        displayName: `Applicant ${id}`,
        dateOfBirth: "1995-03-14",
        gender: "female",
        onboardingStatus: "under_review",
        submittedAt: NOW - 1000,
        createdAt: NOW - 5000,
      }),
    );
    for (const kind of ["gov_id", "selfie", "video_testimony"] as const) {
      const key = `kyc/${id}/${kind}.jpg`;
      await storage.put(key, JPEG, "image/jpeg");
      await documents.put({
        id: `${id}-${kind}`,
        userId: id,
        kind,
        storageKey: key,
        contentType: "image/jpeg",
        sizeBytes: JPEG.length,
        sha256: `digest-${id}-${kind}`,
        createdAt: NOW - 2000,
      });
    }
  }

  beforeEach(async () => {
    users = createInMemoryUserRepo();
    sessions = createInMemorySessionRepo();
    documents = createInMemoryKycDocumentRepo();
    phoneBlocks = createInMemoryPhoneBlockRepo();
    storage = new LocalDiskStorage(storageRoot, "http://test.local", () => NOW);
    services = createInMemoryServiceCatalog();
    recorded = [];

    const base = createLoggingAuditLogger();
    const audit = {
      async record(entry: AuditEntry) {
        recorded.push(entry);
        await base.record(entry);
      },
    };

    await users.create(
      makeUser({ id: ADMIN, phone: "+919999999999", role: "admin", onboardingStatus: "approved" }),
    );

    app = express();
    app.use(express.json());
    app.use(
      createVerificationRouter({
        users,
        sessions,
        documents,
        phoneBlocks,
        queries: createInMemoryAdminUserQueries(() => users.all()),
        services,
        storage,
        audit,
        auth: new AuthService({ users, sessions, phoneBlocks, now: () => NOW }),
        pool: null,
        now: () => NOW,
      }),
    );
  });

  const asAdmin = (r: request.Test) => r.set("authorization", `Bearer ${adminToken}`);

  // ── access control ─────────────────────────────────────────────────────────

  describe("access control", () => {
    it("refuses anonymous callers", async () => {
      for (const path of ["/admin/verifications", "/admin/users", "/admin/audit"]) {
        expect((await request(app).get(path)).status).toBe(401);
      }
    });

    /** The whole admin surface exposes other people's identity documents. A logged-in
     *  non-admin reaching any of it is the failure that matters most here. */
    it("refuses an authenticated non-admin", async () => {
      await seedApplicant("u1", "+919000000001");
      const t = `Bearer ${userToken("u1")}`;
      const paths = [
        "/admin/verifications",
        "/admin/verifications/u1",
        "/admin/users",
        "/admin/audit",
      ];
      for (const p of paths) {
        expect((await request(app).get(p).set("authorization", t)).status).toBe(403);
      }
      const post = await request(app)
        .post("/admin/verifications/u1/decision")
        .set("authorization", t)
        .send({ decision: "approve" });
      expect(post.status).toBe(403);
    });
  });

  // ── queue ──────────────────────────────────────────────────────────────────

  it("lists pending packets oldest first", async () => {
    await seedApplicant("u1", "+919000000001");
    await seedApplicant("u2", "+919000000002");
    await users.update("u2", { submittedAt: NOW - 9000 }); // submitted earlier

    const res = await asAdmin(request(app).get("/admin/verifications"));
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { id: string }) => e.id)).toEqual(["u2", "u1"]);
  });

  /** The queue is a list view. A full number on every row turns the operator console into a
   *  phone directory of everyone awaiting review. */
  it("masks phone numbers in the queue", async () => {
    await seedApplicant("u1", "+919876543210");
    const res = await asAdmin(request(app).get("/admin/verifications"));
    const entry = res.body.entries[0];
    expect(entry.phoneMasked).toBe("***3210");
    expect(JSON.stringify(entry)).not.toContain("9876543210");
  });

  // ── packet ─────────────────────────────────────────────────────────────────

  it("returns the packet with short-lived signed document URLs", async () => {
    await seedApplicant("u1", "+919000000001");
    const res = await asAdmin(request(app).get("/admin/verifications/u1"));

    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(3);
    expect(res.body.missing).toEqual([]);
    for (const d of res.body.documents) {
      expect(d.url).toContain("/admin/documents/raw");
      expect(d.url).toContain("sig=");
      // The opaque storage key never reaches the client as a durable reference; only a
      // signature that stops working in two minutes.
      expect(d).not.toHaveProperty("storageKey");
    }
  });

  /** Viewing someone's Aadhaar is itself an auditable act — that is the point of the log. */
  it("writes one audit row per document when a packet is opened", async () => {
    await seedApplicant("u1", "+919000000001");
    await asAdmin(request(app).get("/admin/verifications/u1"));

    const views = recorded.filter((e) => e.action === "admin.document_viewed");
    expect(views).toHaveLength(3);
    expect(views.map((v) => v.metadata?.kind).sort()).toEqual([
      "gov_id",
      "selfie",
      "video_testimony",
    ]);
    expect(views.every((v) => v.actorId === ADMIN && v.subjectId === "u1")).toBe(true);
  });

  /** The same ID scan submitted by two accounts is one of the clearest fraud signals
   *  available without any external provider. */
  it("flags a document digest also submitted by another account", async () => {
    await seedApplicant("u1", "+919000000001");
    await seedApplicant("u2", "+919000000002");
    await documents.put({
      id: "u2-gov_id",
      userId: "u2",
      kind: "gov_id",
      storageKey: "kyc/u2/gov_id.jpg",
      contentType: "image/jpeg",
      sizeBytes: JPEG.length,
      sha256: "digest-u1-gov_id", // identical bytes to u1's ID
      createdAt: NOW,
    });

    const res = await asAdmin(request(app).get("/admin/verifications/u2"));
    const govId = res.body.documents.find((d: { kind: string }) => d.kind === "gov_id");
    expect(govId.alsoSubmittedBy).toEqual(["u1"]);
  });

  // ── decisions ──────────────────────────────────────────────────────────────

  describe("approve", () => {
    it("grants transacting access and records who decided", async () => {
      await seedApplicant("u1", "+919000000001");
      const res = await asAdmin(
        request(app).post("/admin/verifications/u1/decision").send({ decision: "approve" }),
      );

      expect(res.status).toBe(200);
      const after = await users.getById("u1");
      expect(after).toMatchObject({
        onboardingStatus: "approved",
        kycStatus: "verified",
        reviewedBy: ADMIN,
        reviewedAt: NOW,
      });
      expect(recorded.some((e) => e.action === "onboarding.approved")).toBe(true);
    });

    it("can onboard the applicant as a helper", async () => {
      await seedApplicant("u1", "+919000000001");
      await asAdmin(
        request(app)
          .post("/admin/verifications/u1/decision")
          .send({ decision: "approve", role: "both" }),
      );
      expect((await users.getById("u1"))?.role).toBe("both");
    });

    /** REGRESSION. Migration 4 backfilled the helpers that already existed, but nothing
     *  enrolled the ones approved afterwards — so every helper onboarded from here on had an
     *  empty service list and was filtered out of every offer, INCLUDING the hospital pool the
     *  platform treats as its emergency path. Found by walking the flow end to end and finding
     *  three freshly-approved helpers enrolled in nothing. */
    it("enrols a newly approved helper in the mandatory services", async () => {
      await seedApplicant("u1", "+919000000001");
      expect(await services.forHelper("u1")).toEqual([]);

      await asAdmin(
        request(app)
          .post("/admin/verifications/u1/decision")
          .send({ decision: "approve", role: "both" }),
      );

      expect(await services.helperOffers("u1", HOSPITAL_SERVICE_CODE)).toBe(true);
    });

    it("does not enrol someone approved as a requester only", async () => {
      await seedApplicant("u2", "+919000000002");
      await asAdmin(
        request(app)
          .post("/admin/verifications/u2/decision")
          .send({ decision: "approve", role: "requester" }),
      );
      expect(await services.forHelper("u2")).toEqual([]);
    });

    /** No admin may mint another admin through the review flow. */
    it("refuses to grant the admin role", async () => {
      await seedApplicant("u1", "+919000000001");
      const res = await asAdmin(
        request(app)
          .post("/admin/verifications/u1/decision")
          .send({ decision: "approve", role: "admin" }),
      );
      expect(res.status).toBe(400);
      expect((await users.getById("u1"))?.role).toBe("requester");
    });

    it("refuses to approve a packet that is missing a document", async () => {
      await seedApplicant("u1", "+919000000001");
      documents = createInMemoryKycDocumentRepo(); // wipe: simulate a vanished document
      app = express();
      app.use(express.json());
      app.use(
        createVerificationRouter({
          users,
          sessions,
          documents,
          phoneBlocks,
          queries: createInMemoryAdminUserQueries(() => users.all()),
        services,
          storage,
          audit: createLoggingAuditLogger(),

          auth: new AuthService({ users, sessions, phoneBlocks, now: () => NOW }),
          pool: null,
          now: () => NOW,
        }),
      );
      const res = await asAdmin(
        request(app).post("/admin/verifications/u1/decision").send({ decision: "approve" }),
      );
      expect(res.status).toBe(422);
      expect((await users.getById("u1"))?.onboardingStatus).toBe("under_review");
    });
  });

  describe("reject", () => {
    it("blocks the phone and revokes every session, not just the status", async () => {
      await seedApplicant("u1", "+919000000001");
      const auth = new AuthService({ users, sessions, phoneBlocks, now: () => NOW });
      const issued = await auth.loginWithPhone("+919000000001", "vitest");

      const res = await asAdmin(
        request(app)
          .post("/admin/verifications/u1/decision")
          .send({ decision: "reject", reason: "ID did not match the selfie" }),
      );
      expect(res.status).toBe(200);

      const after = await users.getById("u1");
      expect(after?.onboardingStatus).toBe("rejected");
      expect(after?.rejectionReason).toBe("ID did not match the selfie");

      // Re-registering must not be a way around the decision.
      await expect(auth.loginWithPhone("+919000000001", "vitest")).rejects.toThrow(
        PhoneBlockedError,
      );
      // And the credential they already hold must stop minting new access tokens.
      await expect(auth.refresh(issued.refreshToken, "vitest")).resolves.toBeNull();
    });

    /** "No" without a reason is not a review, and the applicant is shown this text. */
    it("requires a reason", async () => {
      await seedApplicant("u1", "+919000000001");
      const res = await asAdmin(
        request(app).post("/admin/verifications/u1/decision").send({ decision: "reject" }),
      );
      expect(res.status).toBe(422);
      expect((await users.getById("u1"))?.onboardingStatus).toBe("under_review");
    });
  });

  describe("decision guards", () => {
    it("refuses to re-decide a settled packet", async () => {
      await seedApplicant("u1", "+919000000001");
      await asAdmin(
        request(app).post("/admin/verifications/u1/decision").send({ decision: "approve" }),
      );
      const again = await asAdmin(
        request(app)
          .post("/admin/verifications/u1/decision")
          .send({ decision: "reject", reason: "changed my mind" }),
      );
      expect(again.status).toBe(409);
      expect((await users.getById("u1"))?.onboardingStatus).toBe("approved");
    });

    it("refuses to decide a packet that was never submitted", async () => {
      await users.create(
        makeUser({ id: "u9", phone: "+919000000009", onboardingStatus: "documents" }),
      );
      const res = await asAdmin(
        request(app).post("/admin/verifications/u9/decision").send({ decision: "approve" }),
      );
      expect(res.status).toBe(409);
    });

    /** Self-approval is the one review guaranteed not to be independent. */
    it("refuses to let an admin decide their own packet", async () => {
      await users.update(ADMIN, { onboardingStatus: "under_review", submittedAt: NOW });
      const res = await asAdmin(
        request(app).post(`/admin/verifications/${ADMIN}/decision`).send({ decision: "approve" }),
      );
      expect(res.status).toBe(403);
    });
  });

  // ── block / unblock ────────────────────────────────────────────────────────

  describe("block and unblock", () => {
    it("blocks an account, optionally its phone, and kills its sessions", async () => {
      await seedApplicant("u1", "+919000000001");
      const auth = new AuthService({ users, sessions, phoneBlocks, now: () => NOW });
      const issued = await auth.loginWithPhone("+919000000001", "vitest");

      const res = await asAdmin(
        request(app)
          .post("/admin/users/u1/block")
          .send({ reason: "abuse report upheld", blockPhone: true }),
      );
      expect(res.status).toBe(200);
      expect((await users.getById("u1"))?.blockedAt).toBe(NOW);
      await expect(auth.refresh(issued.refreshToken, "vitest")).resolves.toBeNull();
      expect(await phoneBlocks.isBlocked("+919000000001")).toBe(true);
    });

    /** Leaving the number blocked after an unblock would keep them out at sign-in and look
     *  exactly like the unblock silently failed. */
    it("lifts the phone block when the account is unblocked", async () => {
      await seedApplicant("u1", "+919000000001");
      await asAdmin(
        request(app).post("/admin/users/u1/block").send({ reason: "mistake", blockPhone: true }),
      );
      await asAdmin(request(app).post("/admin/users/u1/unblock"));

      expect((await users.getById("u1"))?.blockedAt).toBeNull();
      expect(await phoneBlocks.isBlocked("+919000000001")).toBe(false);
    });

    it("refuses to let an admin lock themselves out", async () => {
      const res = await asAdmin(
        request(app).post(`/admin/users/${ADMIN}/block`).send({ reason: "oops" }),
      );
      expect(res.status).toBe(403);
    });
  });

  // ── raw document bytes ─────────────────────────────────────────────────────

  describe("document bytes", () => {
    async function signedUrlFor(id: string) {
      const res = await asAdmin(request(app).get(`/admin/verifications/${id}`));
      return new URL(res.body.documents[0].url).search;
    }

    it("serves bytes for a valid signature and admin session", async () => {
      await seedApplicant("u1", "+919000000001");
      const res = await asAdmin(request(app).get(`/admin/documents/raw${await signedUrlFor("u1")}`));

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("image/jpeg");
      // Never inline: an HTML document rendered in the admin origin would be stored XSS
      // against the highest-privilege session on the platform.
      expect(res.headers["content-disposition"]).toBe("attachment");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["cache-control"]).toContain("no-store");
    });

    /** A signed URL is a bearer capability — it leaks through history and screenshots. The
     *  admin session is the second, independent check. */
    it("refuses a valid signature presented without an admin session", async () => {
      await seedApplicant("u1", "+919000000001");
      const qs = await signedUrlFor("u1");
      expect((await request(app).get(`/admin/documents/raw${qs}`)).status).toBe(401);
      const asUser = await request(app)
        .get(`/admin/documents/raw${qs}`)
        .set("authorization", `Bearer ${userToken("u1")}`);
      expect(asUser.status).toBe(403);
    });

    /** Conversely, an admin session must not be a licence to read arbitrary keys. */
    it("refuses a forged or tampered signature", async () => {
      await seedApplicant("u1", "+919000000001");
      const qs = new URLSearchParams(await signedUrlFor("u1"));

      const tampered = new URLSearchParams(qs);
      tampered.set("key", "kyc/u2/gov_id.jpg");
      expect(
        (await asAdmin(request(app).get(`/admin/documents/raw?${tampered}`))).status,
      ).toBe(403);

      const noSig = new URLSearchParams(qs);
      noSig.delete("sig");
      expect((await asAdmin(request(app).get(`/admin/documents/raw?${noSig}`))).status).toBe(403);
    });

    it("refuses an expired signature", async () => {
      await seedApplicant("u1", "+919000000001");
      const qs = new URLSearchParams(await signedUrlFor("u1"));
      // Rebuild the app with a clock far past the signature's expiry.
      const later = express();
      later.use(express.json());
      later.use(
        createVerificationRouter({
          users,
          sessions,
          documents,
          phoneBlocks,
          queries: createInMemoryAdminUserQueries(() => users.all()),
        services,
          storage,
          audit: createLoggingAuditLogger(),

          auth: new AuthService({ users, sessions, phoneBlocks, now: () => NOW }),
          pool: null,
          now: () => NOW + 60 * 60 * 1000,
        }),
      );
      const res = await request(later)
        .get(`/admin/documents/raw?${qs}`)
        .set("authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(403);
    });
  });
});
