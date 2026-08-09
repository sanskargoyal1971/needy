import { beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { signAccessToken } from "../../auth/jwt.js";
import { verifyPassword } from "../../auth/password.js";
import {
  createInMemorySessionRepo,
  createInMemoryUserRepo,
  type InMemoryUserRepository,
} from "../../auth/repos.js";
import { makeUser } from "../../auth/types.js";
import { createLoggingAuditLogger, type AuditEntry } from "../../audit/log.js";
import { createStaffRouter } from "../staff.js";

/** ── Staff administration ──────────────────────────────────────────────────
 *  The super admin's surface. These tests are mostly about who may NOT reach it: the whole
 *  reason the role exists is that creating and disabling operators must not be something an
 *  operator can do.
 */

const NOW = 1_700_000_000_000;
const GOOD = "a good staff passphrase";

describe("staff administration", () => {
  let app: Express;
  let users: InMemoryUserRepository;
  let sessions: ReturnType<typeof createInMemorySessionRepo>;
  let recorded: AuditEntry[];

  const token = (sub: string, role: "admin" | "super_admin" | "requester") =>
    signAccessToken({ sub, role, displayName: sub, kyc: "verified" });
  const as = (r: request.Test, sub: string, role: "admin" | "super_admin" | "requester") =>
    r.set("authorization", `Bearer ${token(sub, role)}`);

  beforeEach(async () => {
    users = createInMemoryUserRepo();
    sessions = createInMemorySessionRepo();
    recorded = [];

    await users.create(
      makeUser({
        id: "root",
        phone: "+919000000001",
        username: "needy_admin",
        displayName: "Root",
        role: "super_admin",
        onboardingStatus: "approved",
      }),
    );
    await users.create(
      makeUser({
        id: "ops",
        phone: "+919000000002",
        displayName: "Ops",
        role: "admin",
        onboardingStatus: "approved",
      }),
    );

    const base = createLoggingAuditLogger();
    app = express();
    app.use(express.json());
    app.use(
      createStaffRouter({
        users,
        sessions,
        audit: {
          record: async (e) => {
            recorded.push(e as AuditEntry);
            await base.record(e);
          },
        },
        listStaff: async () =>
          users.all().filter((u) => u.role === "admin" || u.role === "super_admin"),
        now: () => NOW,
      }),
    );
  });

  const create = (body: Record<string, unknown>, who = "root", role: "admin" | "super_admin" = "super_admin") =>
    as(request(app).post("/admin/staff"), who, role).send(body);

  const NEW_STAFF = {
    phone: "+919000000055",
    displayName: "New Operator",
    password: GOOD,
  };

  // ── who may reach this at all ──────────────────────────────────────────────

  /**
   * The load-bearing test. An admin who could create an admin could grant themselves a second
   * account and use it to review their own decisions; an admin who could disable an admin could
   * lock the team out of the console mid-incident.
   */
  it("refuses an ordinary admin", async () => {
    expect((await create(NEW_STAFF, "ops", "admin")).status).toBe(403);
    expect((await as(request(app).get("/admin/staff"), "ops", "admin")).status).toBe(403);
    expect(
      (await as(request(app).post("/admin/staff/ops/deactivate"), "ops", "admin").send({
        reason: "x",
      })).status,
    ).toBe(403);
  });

  it("refuses an ordinary user and an anonymous caller", async () => {
    expect((await as(request(app).get("/admin/staff"), "nobody", "requester")).status).toBe(403);
    expect((await request(app).get("/admin/staff")).status).toBe(401);
  });

  // ── creating an operator ───────────────────────────────────────────────────

  it("creates an admin on an assigned number, with a working password", async () => {
    const res = await create(NEW_STAFF);
    expect(res.status).toBe(201);
    expect(res.body.staff).toMatchObject({
      phone: NEW_STAFF.phone,
      displayName: "New Operator",
      role: "admin",
      active: true,
      hasPassword: true,
    });

    const created = await users.getByPhone(NEW_STAFF.phone);
    expect(created?.role).toBe("admin");
    // Approved on creation — an operator does not go through the queue they are hired to review.
    expect(created?.onboardingStatus).toBe("approved");
    expect(await verifyPassword(GOOD, await users.getPasswordHash(created!.id))).toBe(true);
  });

  /** The number is the whole point: it is where the second factor will be sent, so it is
   *  assigned rather than chosen. Silently adopting an existing account would make an
   *  ordinary user an operator without anyone deciding to. */
  it("refuses a number that already belongs to someone", async () => {
    const res = await create({ ...NEW_STAFF, phone: "+919000000002" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("phone-in-use");
  });

  it("refuses a username that is taken", async () => {
    const res = await create({ ...NEW_STAFF, username: "NEEDY_ADMIN" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("username-in-use");
  });

  it("applies the same password policy as everywhere else", async () => {
    const res = await create({ ...NEW_STAFF, password: "short" });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: "weak-password", problem: "too-short" });
  });

  it("audits the creation without recording the password", async () => {
    await create(NEW_STAFF);
    const entry = recorded.find((e) => e.action === "admin.staff_created");
    expect(entry).toBeDefined();
    expect(entry!.actorId).toBe("root");
    expect(JSON.stringify(entry)).not.toContain(GOOD);
  });

  // ── switching an operator off ──────────────────────────────────────────────

  it("deactivates an admin and kills their sessions immediately", async () => {
    await sessions.create({
      id: "s1",
      userId: "ops",
      refreshTokenHash: "hash",
      userAgent: "test",
      createdAt: NOW,
      expiresAt: NOW + 100_000,
      revokedAt: null,
    });

    const res = await as(request(app).post("/admin/staff/ops/deactivate"), "root", "super_admin")
      .send({ reason: "left the team" });
    expect(res.status).toBe(200);
    expect(res.body.staff.active).toBe(false);

    expect((await users.getById("ops"))?.blockedAt).toBe(NOW);
    // A 15-minute window in which a removed operator can still read the console is not
    // "deactivated".
    expect((await sessions.getByHash("hash"))?.revokedAt).toBe(NOW);
  });

  it("reactivates", async () => {
    await as(request(app).post("/admin/staff/ops/deactivate"), "root", "super_admin").send({
      reason: "temporary",
    });
    const res = await as(request(app).post("/admin/staff/ops/activate"), "root", "super_admin");
    expect(res.status).toBe(200);
    expect(res.body.staff.active).toBe(true);
    expect((await users.getById("ops"))?.blockedAt).toBeNull();
  });

  /** Locking yourself out of the only account that can unlock accounts is unrecoverable
   *  without a database console. */
  it("refuses to deactivate yourself", async () => {
    const res = await as(request(app).post("/admin/staff/root/deactivate"), "root", "super_admin")
      .send({ reason: "oops" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("cannot-deactivate-self");
  });

  it("refuses to deactivate another super admin", async () => {
    await users.create(
      makeUser({
        id: "root2",
        phone: "+919000000009",
        username: "second_root",
        displayName: "Root Two",
        role: "super_admin",
        onboardingStatus: "approved",
      }),
    );
    const res = await as(request(app).post("/admin/staff/root2/deactivate"), "root", "super_admin")
      .send({ reason: "no" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("cannot-deactivate-super-admin");
  });

  it("lists operators and nobody else", async () => {
    await users.create(
      makeUser({ id: "asha", phone: "+919000000077", displayName: "Asha" }),
    );
    const res = await as(request(app).get("/admin/staff"), "root", "super_admin");
    expect(res.status).toBe(200);
    expect(res.body.staff.map((s: { id: string }) => s.id).sort()).toEqual(["ops", "root"]);
    // Never the credential, at any layer.
    expect(JSON.stringify(res.body)).not.toContain("scrypt$");
  });
});
