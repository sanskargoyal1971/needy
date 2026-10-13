import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { ABUSE_SIGNAL_WEIGHTS, type AbuseRollup, type AbuseSignal } from "@needy/shared";
import type { AuditEntry, AuditLogger } from "../../audit/log.js";
import { signAccessToken } from "../../auth/jwt.js";
import { createInMemoryUserRepo } from "../../auth/repos.js";
import { makeUser, type Role } from "../../auth/types.js";
import {
  createInMemoryAbuseRepo,
  emitSignal,
  type AbuseRepository,
} from "../../domain/abuseStore.js";
import type { Deps } from "../../domain/deps.js";
import { createAbuseRouter } from "../abuse.js";

/** ── The abuse review queue ────────────────────────────────────────────────
 *  What matters about this surface is as much what it does NOT do: nothing here blocks,
 *  suspends or restricts anybody. It ranks and it records a human's judgement. The tests
 *  below assert that ranking is right, that the queue does not leak a phone directory, and —
 *  the one that would be easy to get wrong later — that reviewing a subject leaves their
 *  signals intact.
 */

const ADMIN = "abuse-admin";
const NOISY = "abuse-noisy";
const CHATTY = "abuse-chatty";
const NOW = 1_700_000_000_000;

function recordingAudit(): AuditLogger & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
  };
}

const auth = (id: string, role: Role) =>
  `Bearer ${signAccessToken({ sub: id, role, displayName: id, kyc: "verified" })}`;

describe("abuse review queue", () => {
  let app: express.Express;
  let abuse: AbuseRepository;
  let audit: ReturnType<typeof recordingAudit>;
  let users: ReturnType<typeof createInMemoryUserRepo>;

  beforeEach(async () => {
    abuse = createInMemoryAbuseRepo();
    audit = recordingAudit();
    users = createInMemoryUserRepo();

    await users.create(
      makeUser({ id: ADMIN, phone: "+919000009001", role: "admin", displayName: "Ops" }),
    );
    await users.create(
      makeUser({ id: NOISY, phone: "+919000009002", role: "both", displayName: "Noisy Helper" }),
    );
    await users.create(
      makeUser({ id: CHATTY, phone: "+919000009003", role: "requester", displayName: "Chatty" }),
    );

    // Two burned codes and a flood against one helper; one flood against someone else.
    await emitSignal(abuse, "handoff.code_burned", NOISY, NOW - 3_000, { taskId: "t1" });
    await emitSignal(abuse, "handoff.code_burned", NOISY, NOW - 2_000, { taskId: "t2" });
    await emitSignal(abuse, "chat.flood", NOISY, NOW - 1_000, { taskId: "t2" });
    await emitSignal(abuse, "chat.flood", CHATTY, NOW - 1_000, { taskId: "t3" });
    // Old enough to fall outside the default window in the test that checks it.
    await emitSignal(abuse, "sos.repeated", CHATTY, NOW - 40 * 24 * 60 * 60 * 1000);

    const deps = {
      users,
      abuse,
      audit,
      now: () => NOW,
    } as unknown as Deps;

    app = express();
    app.use(express.json());
    app.use(createAbuseRouter(deps));
  });

  it("ranks subjects by accumulated weight, heaviest first", async () => {
    const res = await request(app).get("/admin/abuse").set("Authorization", auth(ADMIN, "admin"));
    expect(res.status).toBe(200);

    const entries = res.body.entries as AbuseRollup[];
    expect(entries[0]!.subjectId).toBe(NOISY);
    // 5 + 5 + 2 — the weights are ranking weights, and a burned handoff code deliberately
    // outranks a chat flood by a wide margin.
    expect(entries[0]!.score).toBe(
      ABUSE_SIGNAL_WEIGHTS["handoff.code_burned"] * 2 + ABUSE_SIGNAL_WEIGHTS["chat.flood"],
    );
    expect(entries[0]!.byKind["handoff.code_burned"]).toBe(2);
    expect(entries[0]!.displayName).toBe("Noisy Helper");
  });

  /** The queue is a list of ordinary users. A list of full phone numbers is a directory. */
  it("masks phone numbers in the queue", async () => {
    const res = await request(app).get("/admin/abuse").set("Authorization", auth(ADMIN, "admin"));
    const entries = res.body.entries as AbuseRollup[];
    for (const e of entries) {
      expect(e.phoneMasked).toMatch(/^\*\*\*\d{4}$/);
    }
    expect(JSON.stringify(res.body)).not.toContain("+919000009002");
  });

  it("honours the review window", async () => {
    const res = await request(app)
      .get("/admin/abuse?windowMs=86400000")
      .set("Authorization", auth(ADMIN, "admin"));
    const chatty = (res.body.entries as AbuseRollup[]).find((e) => e.subjectId === CHATTY);
    // The 40-day-old signal is outside a one-day window; the recent flood is not.
    expect(chatty!.total).toBe(1);
  });

  /** One account an operator has deliberately opened in order to act on it — the same
   *  distinction the verification console draws between its queue and a packet. */
  it("shows the full number and the individual observations on one subject", async () => {
    const res = await request(app)
      .get(`/admin/abuse/${NOISY}`)
      .set("Authorization", auth(ADMIN, "admin"));
    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBe("+919000009002");
    const signals = res.body.signals as AbuseSignal[];
    expect(signals).toHaveLength(3);
    // Newest first.
    expect(signals[0]!.kind).toBe("chat.flood");
  });

  describe("recording a judgement", () => {
    it("writes an audit row and leaves the signals untouched", async () => {
      const before = await abuse.listForSubject(NOISY, 0, 100);

      const res = await request(app)
        .post(`/admin/abuse/${NOISY}/review`)
        .set("Authorization", auth(ADMIN, "admin"))
        .send({ outcome: "no-action", note: "spoke to him — wrong building both times" });

      expect(res.status).toBe(200);
      const entry = audit.entries.find((e) => e.action === "abuse.reviewed");
      expect(entry?.subjectId).toBe(NOISY);
      expect(entry?.actorId).toBe(ADMIN);
      expect(entry?.metadata?.outcome).toBe("no-action");

      // "We saw this and concluded it was fine" and "we never saw this" must not look the
      // same in six months.
      expect(await abuse.listForSubject(NOISY, 0, 100)).toHaveLength(before.length);
    });

    it("requires a note", async () => {
      const res = await request(app)
        .post(`/admin/abuse/${NOISY}/review`)
        .set("Authorization", auth(ADMIN, "admin"))
        .send({ outcome: "warned" });
      expect(res.status).toBe(400);
    });

    /** Escalating is a note to other operators, not an action. Blocking is a separate,
     *  deliberate POST with its own reason and its own audit row. */
    it("does not block anyone, even on escalate", async () => {
      await request(app)
        .post(`/admin/abuse/${NOISY}/review`)
        .set("Authorization", auth(ADMIN, "admin"))
        .send({ outcome: "escalated", note: "second incident this week" });

      expect((await users.getById(NOISY))!.blockedAt).toBeNull();
    });

    it("404s on a subject who does not exist", async () => {
      const res = await request(app)
        .post(`/admin/abuse/nobody/review`)
        .set("Authorization", auth(ADMIN, "admin"))
        .send({ outcome: "no-action", note: "n/a" });
      expect(res.status).toBe(404);
    });
  });

  it("is closed to non-admins", async () => {
    for (const path of ["/admin/abuse", `/admin/abuse/${NOISY}`]) {
      const res = await request(app).get(path).set("Authorization", auth(CHATTY, "requester"));
      expect(res.status, path).toBe(403);
    }
  });

  /** Signals outlive the account they describe — there is no FK, on purpose (see migration 5).
   *  Dropping the row would hide behaviour that did happen. */
  it("renders a signal whose subject account is gone", async () => {
    await emitSignal(abuse, "handoff.code_burned", "deleted-user", NOW - 500);
    const res = await request(app).get("/admin/abuse").set("Authorization", auth(ADMIN, "admin"));
    const ghost = (res.body.entries as AbuseRollup[]).find((e) => e.subjectId === "deleted-user");
    expect(ghost).toBeDefined();
    expect(ghost!.displayName).toBe("(deleted account)");
  });
});
