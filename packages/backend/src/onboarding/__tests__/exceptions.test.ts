import express from "express";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXCEPTION_REVIEW_SLA_MS, scheduleProblem } from "@needy/shared";
import { signAccessToken } from "../../auth/jwt.js";
import { createInMemoryUserRepo, type InMemoryUserRepository } from "../../auth/repos.js";
import { makeUser } from "../../auth/types.js";
import { createLoggingAuditLogger, type AuditEntry } from "../../audit/log.js";
import {
  createInMemoryExceptionRepo,
  type ExceptionRepository,
} from "../../domain/exceptions.js";
import { LocalDiskStorage } from "../../services/storage.js";
import { createExceptionRouter } from "../exceptionRouter.js";

const NOW = Date.UTC(2026, 7, 9);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(500)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);

/** Two young adults of different gender — the only pairing the matrix restricts, and so the
 *  only one an exception exists for. */
const YOUNG_M = "exc-young-m";
const YOUNG_F = "exc-young-f";
const ADULT = "exc-adult";
const ADMIN = "exc-admin";
const OUTSIDER = "exc-outsider";

describe("booking exceptions", () => {
  let app: express.Express;
  let users: InMemoryUserRepository;
  let exceptions: ExceptionRepository;
  let storageRoot: string;
  let recorded: AuditEntry[];
  let clock = NOW;

  const token = (sub: string, role: "requester" | "admin" = "requester") =>
    signAccessToken({ sub, role: role === "admin" ? "admin" : "both", displayName: sub });
  const as = (r: request.Test, sub: string, role: "requester" | "admin" = "requester") =>
    r.set("authorization", `Bearer ${token(sub, role)}`);

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "needy-exc-"));
  });
  afterAll(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    clock = NOW;
    users = createInMemoryUserRepo();
    exceptions = createInMemoryExceptionRepo();
    recorded = [];

    const seed = (id: string, dob: string, gender: "male" | "female", role = "both" as const) =>
      users.create(
        makeUser({
          id,
          phone: `+9197${String(Math.abs(hash(id))).slice(0, 8)}`,
          displayName: id,
          role,
          kycStatus: "verified",
          onboardingStatus: "approved",
          dateOfBirth: dob,
          gender,
        }),
      );
    await seed(YOUNG_M, "2001-01-01", "male");
    await seed(YOUNG_F, "2001-01-01", "female");
    await seed(ADULT, "1980-01-01", "female");
    await seed(OUTSIDER, "1980-01-01", "male");
    await users.create(
      makeUser({
        id: ADMIN,
        phone: "+919799999999",
        displayName: "Ops",
        role: "admin",
        onboardingStatus: "approved",
        dateOfBirth: "1980-01-01",
        gender: "other",
      }),
    );

    const base = createLoggingAuditLogger();
    app = express();
    app.use(express.json());
    app.use(
      createExceptionRouter({
        users,
        exceptions,
        storage: new LocalDiskStorage(storageRoot, "http://test.local", () => clock),
        audit: {
          async record(e: AuditEntry) {
            recorded.push(e);
            await base.record(e);
          },
        },
        now: () => clock,
      }),
    );
  });

  const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 11);

  const open = (requester = YOUNG_M, helperId = YOUNG_F) =>
    as(request(app).post("/exceptions"), requester).send({ helperId });

  const upload = (id: string, who: string, bytes = WEBM) =>
    as(request(app).post(`/exceptions/${id}/video`), who).attach("file", bytes, {
      filename: "testimony.webm",
    });

  // ── opening ────────────────────────────────────────────────────────────────

  it("opens a request for a restricted pairing", async () => {
    const res = await open();
    expect(res.status).toBe(201);
    expect(res.body.exception).toMatchObject({
      requesterId: YOUNG_M,
      helperId: YOUNG_F,
      status: "awaiting_videos",
      requesterVideoSubmitted: false,
      helperVideoSubmitted: false,
    });
  });

  /** A review with nothing to decide is worse than no review: it teaches an operator that
   *  these requests are noise. */
  it("refuses to open one for a pairing that does not need it", async () => {
    const res = await open(YOUNG_M, ADULT);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no-exception-needed");
  });

  it("refuses a pairing with oneself", async () => {
    const res = await open(YOUNG_M, YOUNG_M);
    expect(res.status).toBe(422);
  });

  /** Tapping the button twice must not give an admin two packets for one relationship. */
  it("is idempotent while a request is in flight", async () => {
    const first = await open();
    const second = await open();
    expect(second.status).toBe(200);
    expect(second.body.exception.id).toBe(first.body.exception.id);
  });

  // ── the two testimonies ────────────────────────────────────────────────────

  it("queues for review only once BOTH parties have recorded", async () => {
    const { body } = await open();
    const id = body.exception.id as string;

    const afterFirst = await upload(id, YOUNG_M);
    expect(afterFirst.status).toBe(200);
    expect(afterFirst.body.exception.status).toBe("awaiting_videos");
    expect(afterFirst.body.exception.requesterVideoSubmitted).toBe(true);
    expect(afterFirst.body.exception.helperVideoSubmitted).toBe(false);

    const afterSecond = await upload(id, YOUNG_F);
    expect(afterSecond.body.exception.status).toBe("under_review");
    expect(afterSecond.body.exception.submittedAt).toBe(NOW);
    // The UI can promise a date rather than "soon".
    expect(afterSecond.body.exception.reviewDueBy).toBe(NOW + EXCEPTION_REVIEW_SLA_MS);
  });

  /**
   * The route that made the flow completable at all.
   *
   * An exception needs BOTH testimonies, and the helper is not the one who opened it: they
   * hold no id, and `/exceptions/for/:helperId` reads the ordered pair from the requester's
   * side, so a helper calling it learns nothing. There was no route by which the second person
   * could be told anything was waiting on them, so every request sat in `awaiting_videos`
   * until it expired — a gate that worked perfectly and that nothing could ever get through.
   */
  it("tells BOTH parties about a request, with the caller's own side resolved", async () => {
    const { body } = await open();
    const id = body.exception.id as string;

    const forHelper = await as(request(app).get("/me/exceptions"), YOUNG_F);
    expect(forHelper.status).toBe(200);
    expect(forHelper.body.exceptions).toHaveLength(1);
    expect(forHelper.body.exceptions[0]).toMatchObject({
      id,
      // Resolved server-side so a client never compares ids to find out whose turn it is.
      myRole: "helper",
      otherName: YOUNG_M,
      helperVideoSubmitted: false,
    });

    const forRequester = await as(request(app).get("/me/exceptions"), YOUNG_M);
    expect(forRequester.body.exceptions[0]).toMatchObject({ id, myRole: "requester" });

    // A pairing under review is exactly the case where the two are not yet cleared to know
    // more about each other, so the row carries a name and nothing else about them.
    const row = forHelper.body.exceptions[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty("requesterVideoKey");
    expect(row).not.toHaveProperty("helperVideoKey");
    expect(row).not.toHaveProperty("otherPhone");
    expect(row).not.toHaveProperty("otherDob");
  });

  it("keeps a stranger's request out of `/me/exceptions`", async () => {
    await open();
    const stranger = await as(request(app).get("/me/exceptions"), ADULT);
    expect(stranger.status).toBe(200);
    expect(stranger.body.exceptions).toEqual([]);
  });

  it("rejects a still image where a video is required", async () => {
    const { body } = await open();
    const res = await upload(body.exception.id, YOUNG_M, JPEG);
    expect(res.status).toBe(415);
  });

  it("does not let a third party upload into someone else's request", async () => {
    const { body } = await open();
    const res = await upload(body.exception.id, OUTSIDER);
    expect(res.status).toBe(404);
  });

  /** A reviewer must judge a fixed packet. Swapping a video mid-review would mean the
   *  decision was made against something that no longer exists. */
  it("stops accepting videos once the packet is under review", async () => {
    const { body } = await open();
    const id = body.exception.id as string;
    await upload(id, YOUNG_M);
    await upload(id, YOUNG_F);

    const late = await upload(id, YOUNG_M);
    expect(late.status).toBe(409);
  });

  /** Neither party may watch the other's testimony — they are evidence for a reviewer, not
   *  material to share between the two people being assessed. */
  it("never exposes a storage key or the other party's video to a participant", async () => {
    const { body } = await open();
    const id = body.exception.id as string;
    await upload(id, YOUNG_M);
    const res = await as(request(app).get(`/exceptions/for/${YOUNG_F}`), YOUNG_M);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("kyc/");
    expect(json).not.toContain("storageKey");
    expect(res.body.exception).not.toHaveProperty("requesterVideoKey");
  });

  // ── the decision ───────────────────────────────────────────────────────────

  async function readyForReview() {
    const { body } = await open();
    const id = body.exception.id as string;
    await upload(id, YOUNG_M);
    await upload(id, YOUNG_F);
    return id;
  }

  it("approves, and the approval is what unlocks the pair", async () => {
    const id = await readyForReview();
    expect(await exceptions.isApproved(YOUNG_M, YOUNG_F, clock)).toBe(false);

    const res = await as(
      request(app).post(`/admin/exceptions/${id}/decision`),
      ADMIN,
      "admin",
    ).send({ decision: "approve" });

    expect(res.status).toBe(200);
    expect(res.body.exception.status).toBe("approved");
    expect(await exceptions.isApproved(YOUNG_M, YOUNG_F, clock)).toBe(true);
  });

  /** The waiver is scoped to an ordered pair. Consenting to be matched with one person is
   *  not consent to have the rule waived generally, or in the other direction. */
  it("does not leak the approval to the reverse pairing or to anyone else", async () => {
    const id = await readyForReview();
    await as(request(app).post(`/admin/exceptions/${id}/decision`), ADMIN, "admin").send({
      decision: "approve",
    });

    expect(await exceptions.isApproved(YOUNG_M, YOUNG_F, clock)).toBe(true);
    expect(await exceptions.isApproved(YOUNG_F, YOUNG_M, clock)).toBe(false);
    expect(await exceptions.isApproved(YOUNG_M, OUTSIDER, clock)).toBe(false);
  });

  /** An indefinite waiver would still be authorising bookings years later. */
  it("expires an approval", async () => {
    const id = await readyForReview();
    await as(request(app).post(`/admin/exceptions/${id}/decision`), ADMIN, "admin").send({
      decision: "approve",
    });

    const ninetyOneDays = 91 * 24 * 60 * 60 * 1000;
    expect(await exceptions.isApproved(YOUNG_M, YOUNG_F, clock + ninetyOneDays)).toBe(false);
  });

  it("rejects, and the pair stays locked", async () => {
    const id = await readyForReview();
    const res = await as(
      request(app).post(`/admin/exceptions/${id}/decision`),
      ADMIN,
      "admin",
    ).send({ decision: "reject", note: "The two accounts appear to be the same person." });

    expect(res.body.exception.status).toBe("rejected");
    expect(res.body.exception.reviewNote).toContain("same person");
    expect(await exceptions.isApproved(YOUNG_M, YOUNG_F, clock)).toBe(false);
  });

  it("refuses to decide a packet twice", async () => {
    const id = await readyForReview();
    const decide = () =>
      as(request(app).post(`/admin/exceptions/${id}/decision`), ADMIN, "admin").send({
        decision: "approve",
      });
    expect((await decide()).status).toBe(200);
    expect((await decide()).status).toBe(409);
  });

  it("refuses to decide a packet that is still awaiting videos", async () => {
    const { body } = await open();
    const res = await as(
      request(app).post(`/admin/exceptions/${body.exception.id}/decision`),
      ADMIN,
      "admin",
    ).send({ decision: "approve" });
    expect(res.status).toBe(409);
  });

  /** An admin who is one of the two parties is not an independent reviewer of their own
   *  pairing — the same rule as the KYC queue. */
  it("refuses to let an admin decide a pairing they are part of", async () => {
    await users.update(ADMIN, { role: "admin", dateOfBirth: "2001-01-01", gender: "male" });
    const opened = await as(request(app).post("/exceptions"), ADMIN).send({ helperId: YOUNG_F });
    const id = opened.body.exception.id as string;
    await upload(id, ADMIN);
    await upload(id, YOUNG_F);

    const res = await as(
      request(app).post(`/admin/exceptions/${id}/decision`),
      ADMIN,
      "admin",
    ).send({ decision: "approve" });
    expect(res.status).toBe(403);
  });

  // ── access control ─────────────────────────────────────────────────────────

  it("keeps the admin surface admin-only", async () => {
    const id = await readyForReview();
    for (const path of ["/admin/exceptions", `/admin/exceptions/${id}`]) {
      expect((await as(request(app).get(path), YOUNG_M)).status).toBe(403);
      expect((await request(app).get(path)).status).toBe(401);
    }
    const decide = await as(
      request(app).post(`/admin/exceptions/${id}/decision`),
      YOUNG_M,
    ).send({ decision: "approve" });
    expect(decide.status).toBe(403);
  });

  it("audits an admin watching the testimonies", async () => {
    const id = await readyForReview();
    recorded.length = 0;
    await as(request(app).get(`/admin/exceptions/${id}`), ADMIN, "admin");

    const view = recorded.find((e) => e.action === "admin.document_viewed");
    expect(view).toBeTruthy();
    expect(view?.actorId).toBe(ADMIN);
    expect(view?.metadata?.kind).toBe("exception_video");
  });

  // ── the lead time that makes the whole thing work ──────────────────────────

  /** The 24h minimum is not arbitrary friction: it is exactly the review SLA. A booking
   *  sooner than that could not have been reviewed. */
  it("ties the scheduling lead time to the review SLA", () => {
    expect(scheduleProblem(NOW + EXCEPTION_REVIEW_SLA_MS - 1, NOW)).toBe("too-soon");
    expect(scheduleProblem(NOW + EXCEPTION_REVIEW_SLA_MS + 1, NOW)).toBeNull();
  });
});
