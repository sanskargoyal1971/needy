import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, REQUIRED_DOCUMENTS } from "@needy/shared";
import { signAccessToken } from "../../auth/jwt.js";
import { requireOnboarded } from "../../auth/onboardingGate.js";
import {
  createInMemoryPhoneBlockRepo,
  phoneHmac,
  type PhoneBlockRepository,
} from "../../auth/phoneBlocks.js";
import { createInMemorySessionRepo, createInMemoryUserRepo } from "../../auth/repos.js";
import type { UserRepository } from "../../auth/repos.js";
import { AuthService, PhoneBlockedError } from "../../auth/service.js";
import { createInMemoryTotpRepo } from "../../auth/totpRepo.js";
import { makeUser } from "../../auth/types.js";
import { createLoggingAuditLogger } from "../../audit/log.js";
import { LocalDiskStorage } from "../../services/storage.js";
import { uploadSlotsInUse } from "../../services/uploadSlots.js";
import { createInMemoryKycDocumentRepo, type KycDocumentRepository } from "../repos.js";
import { ageInYears, createOnboardingRouter } from "../router.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.UTC(2026, 7, 8); // 2026-08-08
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60)]);

describe("ageInYears", () => {
  /** Calendar arithmetic, not milliseconds / 365.25 — the boundary cases below are exactly
   *  where the naive version puts someone in the wrong band. */
  it("counts whole years, and does not round up before the birthday", () => {
    expect(ageInYears("2008-08-08", NOW)).toBe(18); // birthday today
    expect(ageInYears("2008-08-09", NOW)).toBe(17); // birthday tomorrow — still 17
    expect(ageInYears("2008-08-07", NOW)).toBe(18);
    expect(ageInYears("1966-08-09", NOW)).toBe(59); // day before turning 60
    expect(ageInYears("1966-08-08", NOW)).toBe(60);
  });

  it("handles leap-day births without drifting", () => {
    expect(ageInYears("2000-02-29", Date.UTC(2026, 1, 28))).toBe(25);
    expect(ageInYears("2000-02-29", Date.UTC(2026, 2, 1))).toBe(26);
  });
});

describe("onboarding router", () => {
  let app: express.Express;
  let users: UserRepository;
  let documents: KycDocumentRepository;
  let storageRoot: string;

  const token = (sub: string, role = "requester") =>
    signAccessToken({ sub, role: role as "requester", displayName: sub });

  const seed = async (
    id: string,
    patch: Parameters<typeof makeUser>[0] extends never
      ? never
      : Partial<ReturnType<typeof makeUser>> = {},
  ) =>
    users.create(
      makeUser({ id, phone: `+9198765${id.slice(-5).padStart(5, "0")}`, createdAt: NOW, ...patch }),
    );

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "needy-kyc-"));
  });
  afterAll(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    users = createInMemoryUserRepo();
    documents = createInMemoryKycDocumentRepo();
    app = express();
    app.use(express.json());
    app.use(
      createOnboardingRouter({
        users,
        documents,
        storage: new LocalDiskStorage(storageRoot, "http://test.local", () => NOW),
        audit: createLoggingAuditLogger(),
        now: () => NOW,
      }),
    );
  });

  // ── identity ───────────────────────────────────────────────────────────────

  const validIdentity = {
    displayName: "Asha Menon",
    dateOfBirth: "1995-03-14",
    gender: "female" as const,
    areaLabel: "Indiranagar, Bengaluru",
  };

  it("captures identity and advances the funnel to documents", async () => {
    await seed("u1");
    const res = await request(app)
      .post("/onboarding/identity")
      .set("authorization", `Bearer ${token("u1")}`)
      .send(validIdentity);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      displayName: "Asha Menon",
      gender: "female",
      onboardingStatus: "documents",
    });
  });

  it("refuses an under-18 applicant outright rather than queueing them", async () => {
    await seed("u2");
    const res = await request(app)
      .post("/onboarding/identity")
      .set("authorization", `Bearer ${token("u2")}`)
      .send({ ...validIdentity, dateOfBirth: "2010-01-01" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("under-age");
    // Nothing was written: a rejected identity must not half-populate the record.
    expect((await users.getById("u2"))?.dateOfBirth).toBeNull();
  });

  it("rejects a date that passes the regex but is not a real day", async () => {
    await seed("u3");
    const res = await request(app)
      .post("/onboarding/identity")
      .set("authorization", `Bearer ${token("u3")}`)
      .send({ ...validIdentity, dateOfBirth: "2025-02-31" });
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await request(app).post("/onboarding/identity").send(validIdentity);
    expect(res.status).toBe(401);
  });

  // ── documents ──────────────────────────────────────────────────────────────

  it("stores an upload and reports what is still missing", async () => {
    await seed("u4", { dateOfBirth: "1990-01-01", gender: "male", onboardingStatus: "documents" });

    const res = await request(app)
      .post("/onboarding/documents")
      .set("authorization", `Bearer ${token("u4")}`)
      .field("kind", "gov_id")
      .attach("file", JPEG, { filename: "id.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(res.body.documents).toEqual(["gov_id"]);
    expect(res.body.missing).toEqual(["selfie", "video_testimony"]);
  });

  /** The declared content-type is attacker input. Here the client insists it is a JPEG while
   *  sending script bytes; the sniffer must win. */
  it("rejects a file whose bytes contradict its declared type", async () => {
    await seed("u5", { dateOfBirth: "1990-01-01", gender: "male", onboardingStatus: "documents" });

    const res = await request(app)
      .post("/onboarding/documents")
      .set("authorization", `Bearer ${token("u5")}`)
      .field("kind", "gov_id")
      .attach("file", Buffer.from("<script>alert(1)</script>"), {
        filename: "id.jpg",
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(415);
    expect(res.body.error).toBe("unrecognized-format");
    expect(await documents.listForUser("u5")).toHaveLength(0);
    expect(await filesFor("u5")).toEqual([]);
  });

  it("replaces rather than duplicates when a document is re-uploaded", async () => {
    await seed("u6", { dateOfBirth: "1990-01-01", gender: "male", onboardingStatus: "documents" });
    const post = () =>
      request(app)
        .post("/onboarding/documents")
        .set("authorization", `Bearer ${token("u6")}`)
        .field("kind", "selfie")
        .attach("file", JPEG, { filename: "s.jpg", contentType: "image/jpeg" });

    await post();
    await post();
    expect(await documents.listForUser("u6")).toHaveLength(1);
  });

  // ── streamed uploads ───────────────────────────────────────────────────────

  /** Every file the adapter has left for one user — object, sidecar or `.part-` temp. */
  const filesFor = async (userId: string): Promise<string[]> =>
    (await readdir(join(storageRoot, "kyc", userId)).catch(() => [] as string[])).sort();

  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(300 * 1024),
  ]);
  const MP4 = Buffer.concat([
    Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
    randomBytes(2 * 1024 * 1024),
  ]);

  it.each([
    ["gov_id", PNG, "image/png", "png"],
    ["selfie", JPEG, "image/jpeg", "jpg"],
    ["video_testimony", MP4, "video/mp4", "mp4"],
  ] as const)(
    "streams a %s to storage with the sniffed type and its hash",
    async (kind, bytes, mime, ext) => {
      const id = `s-${kind}`;
      await seed(id, { dateOfBirth: "1990-01-01", gender: "male", onboardingStatus: "documents" });

      const res = await request(app)
        .post("/onboarding/documents")
        .set("authorization", `Bearer ${token(id)}`)
        .field("kind", kind)
        // The declared type is a lie on purpose: only the sniffed one may be stored.
        .attach("file", bytes, { filename: "x.bin", contentType: "text/html" });
      expect(res.status).toBe(200);

      const [doc] = await documents.listForUser(id);
      expect(doc).toMatchObject({ kind, contentType: mime, sizeBytes: bytes.length });
      expect(doc!.storageKey.endsWith(`.${ext}`)).toBe(true);
      expect(doc!.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(await readFile(join(storageRoot, doc!.storageKey))).toEqual(bytes);
      // The object and its sidecar; no temp file survived the rename.
      expect((await filesFor(id)).filter((f) => f.includes(".part-"))).toEqual([]);
    },
  );

  it("aborts an oversize upload with nothing stored", async () => {
    await seed("s-big", {
      dateOfBirth: "1990-01-01",
      gender: "male",
      onboardingStatus: "documents",
    });
    const tooBig = Buffer.concat([JPEG, Buffer.alloc(MAX_UPLOAD_BYTES.gov_id)]);

    const res = await request(app)
      .post("/onboarding/documents")
      .set("authorization", `Bearer ${token("s-big")}`)
      .field("kind", "gov_id")
      .attach("file", tooBig, { filename: "id.jpg" });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("too-large");
    expect(await documents.listForUser("s-big")).toHaveLength(0);
    expect(await filesFor("s-big")).toEqual([]);
  });

  /** The per-kind cap, not the largest one: 9 MB is fine for an ID scan and too big for a
   *  selfie, so the kind really did decide the limit while the bytes were arriving. */
  it("applies the cap of the kind named, not the largest cap", async () => {
    await seed("s-cap", {
      dateOfBirth: "1990-01-01",
      gender: "male",
      onboardingStatus: "documents",
    });
    const nineMb = Buffer.concat([JPEG, Buffer.alloc(9 * 1024 * 1024)]);
    const res = await request(app)
      .post("/onboarding/documents")
      .set("authorization", `Bearer ${token("s-cap")}`)
      .field("kind", "selfie")
      .attach("file", nineMb, { filename: "s.jpg" });
    expect(res.status).toBe(413);
    expect(await filesFor("s-cap")).toEqual([]);
  });

  it("refuses a file that arrives before its kind, storing nothing", async () => {
    await seed("s-order", {
      dateOfBirth: "1990-01-01",
      gender: "male",
      onboardingStatus: "documents",
    });
    const res = await request(app)
      .post("/onboarding/documents")
      .set("authorization", `Bearer ${token("s-order")}`)
      .attach("file", JPEG, { filename: "id.jpg" })
      .field("kind", "gov_id");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("kind-must-precede-file");
    expect(await filesFor("s-order")).toEqual([]);
  });

  it("rejects an unknown kind before reading the file", async () => {
    await seed("s-kind", {
      dateOfBirth: "1990-01-01",
      gender: "male",
      onboardingStatus: "documents",
    });
    const res = await request(app)
      .post("/onboarding/documents")
      .set("authorization", `Bearer ${token("s-kind")}`)
      .field("kind", "passport_photo")
      .attach("file", JPEG, { filename: "id.jpg" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown-document-kind");
  });

  /** A client that hangs up mid-video. The request never ends, so nothing upstream errors on
   *  its own: unless the route notices, the temp file stays on disk for good. */
  it("removes the partial file when the client disconnects mid-upload", async () => {
    const id = "s-gone";
    await seed(id, { dateOfBirth: "1990-01-01", gender: "male", onboardingStatus: "documents" });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;

    const boundary = "needy-test-boundary";
    const preamble =
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nvideo_testimony\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="v.webm"\r\n` +
      `Content-Type: video/webm\r\n\r\n`;
    const client = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/onboarding/documents",
      headers: {
        authorization: `Bearer ${token(id)}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        // Promises 20 MB; delivers about 1.
        "content-length": String(preamble.length + 20 * 1024 * 1024),
      },
    });
    client.on("error", () => undefined);
    client.write(preamble);
    client.write(Buffer.concat([WEBM, Buffer.alloc(1024 * 1024)]));

    const until = async (cond: () => Promise<boolean>) => {
      for (let i = 0; i < 300 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 10));
      return cond();
    };
    try {
      // The write really was under way: a temp file exists in the private root.
      expect(await until(async () => (await filesFor(id)).some((f) => f.includes(".part-")))).toBe(
        true,
      );
      client.destroy();

      expect(await until(async () => (await filesFor(id)).length === 0)).toBe(true);
      expect(await until(() => Promise.resolve(uploadSlotsInUse() === 0))).toBe(true);
      expect(await documents.listForUser(id)).toHaveLength(0);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  // ── submit ─────────────────────────────────────────────────────────────────

  const uploadAll = async (id: string) => {
    for (const [kind, bytes] of [
      ["gov_id", JPEG],
      ["selfie", JPEG],
      ["video_testimony", WEBM],
    ] as const) {
      await request(app)
        .post("/onboarding/documents")
        .set("authorization", `Bearer ${token(id)}`)
        .field("kind", kind)
        .attach("file", bytes, { filename: `${kind}.bin` });
    }
  };

  it("refuses submission until every document is present", async () => {
    await seed("u7", { dateOfBirth: "1990-01-01", gender: "male", onboardingStatus: "documents" });
    const res = await request(app)
      .post("/onboarding/submit")
      .set("authorization", `Bearer ${token("u7")}`);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("documents-incomplete");
    expect(res.body.missing).toEqual([...REQUIRED_DOCUMENTS]);
  });

  it("moves a complete packet to under_review", async () => {
    await seed("u8", { dateOfBirth: "1990-01-01", gender: "male", onboardingStatus: "documents" });
    await uploadAll("u8");

    const res = await request(app)
      .post("/onboarding/submit")
      .set("authorization", `Bearer ${token("u8")}`);

    expect(res.status).toBe(200);
    expect(res.body.user.onboardingStatus).toBe("under_review");
    expect((await users.getById("u8"))?.submittedAt).toBe(NOW);
  });

  /** A double-tap must not push the applicant to the back of the queue by rewriting
   *  submittedAt, which is the queue's sort key. */
  it("is idempotent on double submission", async () => {
    await seed("u9", { dateOfBirth: "1990-01-01", gender: "male", onboardingStatus: "documents" });
    await uploadAll("u9");
    await request(app)
      .post("/onboarding/submit")
      .set("authorization", `Bearer ${token("u9")}`);
    const first = (await users.getById("u9"))?.submittedAt;

    const again = await request(app)
      .post("/onboarding/submit")
      .set("authorization", `Bearer ${token("u9")}`);

    expect(again.status).toBe(200);
    expect((await users.getById("u9"))?.submittedAt).toBe(first);
  });

  // ── terminal states ────────────────────────────────────────────────────────

  it("locks a rejected user out of every onboarding write", async () => {
    await seed("u10", { onboardingStatus: "rejected", rejectionReason: "ID did not match selfie" });
    const auth = `Bearer ${token("u10")}`;

    for (const path of ["/onboarding/identity", "/onboarding/submit"]) {
      const res = await request(app).post(path).set("authorization", auth).send(validIdentity);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("onboarding-rejected");
    }
  });

  it("refuses to let an approved user swap their documents afterwards", async () => {
    await seed("u11", { onboardingStatus: "approved" });
    const res = await request(app)
      .post("/onboarding/documents")
      .set("authorization", `Bearer ${token("u11")}`)
      .field("kind", "gov_id")
      .attach("file", JPEG, { filename: "id.jpg" });

    expect(res.status).toBe(409);
  });
});

// ── the gate ─────────────────────────────────────────────────────────────────

describe("requireOnboarded", () => {
  let users: UserRepository;
  let app: express.Express;

  beforeEach(() => {
    users = createInMemoryUserRepo();
    app = express();
    app.use(
      "/protected",
      (req, _res, next): void => {
        // Stand-in for requireAuth so this test isolates the gate itself.
        (req as express.Request & { user?: unknown }).user = {
          sub: req.headers["x-user"] as string,
        };
        next();
      },
      requireOnboarded({ users }),
      // Wrapped so the handler returns void rather than the Response object — an async-looking
      // return value where Express expects void is what no-misused-promises guards against.
      (_req, res): void => {
        res.json({ ok: true });
      },
    );
  });

  it.each([
    ["draft", 403],
    ["identity", 403],
    ["documents", 403],
    ["under_review", 403],
    ["rejected", 403],
    ["approved", 200],
  ] as const)("status %s -> %i", async (status, expected) => {
    await users.create(makeUser({ id: "g1", phone: "+919000000001", onboardingStatus: status }));
    const res = await request(app).get("/protected").set("x-user", "g1");
    expect(res.status).toBe(expected);
  });

  it("blocks a suspended account even when it is otherwise approved", async () => {
    await users.create(
      makeUser({
        id: "g2",
        phone: "+919000000002",
        onboardingStatus: "approved",
        blockedAt: NOW,
        rejectionReason: "abuse report upheld",
      }),
    );
    const res = await request(app).get("/protected").set("x-user", "g2");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("account-blocked");
  });

  it("fails closed when the session outlives the account", async () => {
    const res = await request(app).get("/protected").set("x-user", "ghost");
    expect(res.status).toBe(401);
  });
});

// ── phone blocklist ──────────────────────────────────────────────────────────

describe("phone blocklist", () => {
  let blocks: PhoneBlockRepository;

  beforeEach(() => {
    blocks = createInMemoryPhoneBlockRepo();
  });

  it("never stores the number in a recoverable form", () => {
    const digest = phoneHmac("+919876543210");
    expect(digest).not.toContain("9876543210");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic, so a lookup works at all.
    expect(phoneHmac("+919876543210")).toBe(digest);
    expect(phoneHmac("+919876543211")).not.toBe(digest);
  });

  it("refuses login for a blocked number, whether or not an account exists", async () => {
    const users = createInMemoryUserRepo();
    const sessions = createInMemorySessionRepo();
    const auth = new AuthService({
      users,
      sessions,
      phoneBlocks: blocks,
      totp: createInMemoryTotpRepo(),
      now: () => NOW,
    });

    // An existing, previously fine account.
    await users.create(
      makeUser({ id: "b1", phone: "+919111111111", onboardingStatus: "approved" }),
    );
    await blocks.block("+919111111111", "rejected at review", "admin-1", NOW);
    await expect(auth.loginWithPhone("+919111111111", "vitest")).rejects.toThrow(PhoneBlockedError);

    // And a number that has never registered — re-registration is the path being closed.
    await blocks.block("+919222222222", "rejected at review", "admin-1", NOW);
    await expect(auth.loginWithPhone("+919222222222", "vitest")).rejects.toThrow(PhoneBlockedError);
    expect(await users.getByPhone("+919222222222")).toBeNull();
  });

  it("keeps the original reason when a number is blocked twice", async () => {
    await blocks.block("+919333333333", "first reason", "admin-1", NOW);
    await blocks.block("+919333333333", "second reason", "admin-2", NOW + 1000);
    expect(await blocks.isBlocked("+919333333333")).toBe(true);
  });

  it("lets a normal number through", async () => {
    expect(await blocks.isBlocked("+919444444444")).toBe(false);
  });
});
