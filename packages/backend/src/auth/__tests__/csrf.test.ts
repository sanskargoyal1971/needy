import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { config } from "../../config.js";
import { ACCESS_COOKIE } from "../cookies.js";
import { CSRF_COOKIE, csrfProtection, issueCsrfToken } from "../csrf.js";

/** ── CSRF ──────────────────────────────────────────────────────────────────
 *  There was none. `grep -ri csrf` over the repo returned nothing at all, so the only thing
 *  between a cross-site POST and a state change was `SameSite=strict` — which one env var
 *  (`COOKIE_SAMESITE=none`, exactly what a cross-site deployment sets) removes.
 *
 *  The suite is written around the two checks being INDEPENDENT: a bad origin is refused even
 *  with a perfect token, and a missing token is refused even from a trusted origin. A single
 *  test that sends a well-formed request and asserts 200 would pass against a middleware that
 *  checks nothing.
 */

const GOOD_ORIGIN = config.corsOrigins[0]!;
const KYC_PATH = "/auth/kyc/callback";

function app() {
  const a = express();
  a.use(express.json());
  a.use(csrfProtection({ exemptPaths: [KYC_PATH] }));
  a.get("/token", (_req, res) => {
    res.json({ token: issueCsrfToken(res) });
  });
  a.get("/read", (_req, res) => res.json({ ok: true }));
  a.post("/write", (_req, res) => res.json({ ok: true }));
  a.post(KYC_PATH, (_req, res) => res.json({ ok: true }));
  return a;
}

/** Mint a token and return it with the cookie header a browser would send back. */
async function mintToken(a: express.Express): Promise<{ token: string; cookie: string }> {
  const res = await request(a).get("/token");
  const setCookie = res.headers["set-cookie"] as unknown as string[];
  const csrf = setCookie.find((c) => c.startsWith(`${CSRF_COOKIE}=`))!;
  return { token: res.body.token as string, cookie: csrf.split(";")[0]! };
}

const session = `${ACCESS_COOKIE}=a.fake.jwt`;

describe("CSRF protection", () => {
  it("lets read-only requests through untouched", async () => {
    const res = await request(app()).get("/read").set("Cookie", session);
    expect(res.status).toBe(200);
  });

  // ── check 1: origin ────────────────────────────────────────────────────────

  describe("origin", () => {
    it("refuses a mutating request from an unrecognised origin", async () => {
      const a = app();
      const { token, cookie } = await mintToken(a);
      const res = await request(a)
        .post("/write")
        .set("Origin", "https://evil.example")
        .set("Cookie", [session, cookie].join("; "))
        // A PERFECT token, deliberately: the origin check has to stand on its own. If an
        // attacker ever did obtain a token, this is the check that still stops them.
        .set("X-CSRF-Token", token)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("bad-origin");
    });

    it("accepts the configured origin", async () => {
      const a = app();
      const { token, cookie } = await mintToken(a);
      const res = await request(a)
        .post("/write")
        .set("Origin", GOOD_ORIGIN)
        .set("Cookie", [session, cookie].join("; "))
        .set("X-CSRF-Token", token)
        .send({});
      expect(res.status).toBe(200);
    });

    /** A form post carries no `Origin` in some older browsers but does carry `Referer`, so the
     *  fallback has to be a real check rather than decoration. */
    it("falls back to Referer when there is no Origin", async () => {
      const a = app();
      const { token, cookie } = await mintToken(a);
      const res = await request(a)
        .post("/write")
        .set("Referer", "https://evil.example/some/page")
        .set("Cookie", [session, cookie].join("; "))
        .set("X-CSRF-Token", token)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("bad-origin");
    });
  });

  // ── check 2: the token ─────────────────────────────────────────────────────

  describe("token", () => {
    it("refuses a cookie-authenticated write with no token", async () => {
      const res = await request(app())
        .post("/write")
        .set("Origin", GOOD_ORIGIN)
        .set("Cookie", session)
        .send({});
      expect(res.status).toBe(403);
      // A distinct code, because the client's correct response is to re-fetch and retry once.
      expect(res.body.error).toBe("csrf-invalid");
    });

    it("refuses a header that does not match the cookie", async () => {
      const a = app();
      const { cookie } = await mintToken(a);
      const res = await request(a)
        .post("/write")
        .set("Origin", GOOD_ORIGIN)
        .set("Cookie", [session, cookie].join("; "))
        .set("X-CSRF-Token", "a-token-i-made-up")
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("csrf-invalid");
    });

    /** The half that makes the double-submit work: a token lifted from one browser is useless
     *  in another, because the cookie it must match is not there. */
    it("refuses a valid token without its matching cookie", async () => {
      const a = app();
      const { token } = await mintToken(a);
      const res = await request(a)
        .post("/write")
        .set("Origin", GOOD_ORIGIN)
        .set("Cookie", session)
        .set("X-CSRF-Token", token)
        .send({});
      expect(res.status).toBe(403);
    });

    /**
     * CSRF is an attack on AMBIENT authority. A caller presenting a bearer token had to obtain
     * it and set a header, neither of which a cross-site form can do — so requiring a CSRF
     * token from them would break every non-browser client for no security gain.
     */
    it("does not demand a token from a request with no session cookie", async () => {
      const res = await request(app())
        .post("/write")
        .set("Authorization", "Bearer some.jwt")
        .send({});
      expect(res.status).toBe(200);
    });
  });

  // ── the one exemption ──────────────────────────────────────────────────────

  /** The KYC callback authenticates by HMAC over raw bytes, carries no cookie, and arrives
   *  from an origin we neither control nor can enumerate. */
  it("exempts the KYC provider callback from both checks", async () => {
    const res = await request(app())
      .post(KYC_PATH)
      .set("Origin", "https://provider.example")
      .send({});
    expect(res.status).toBe(200);
  });

  it("does not exempt a path that merely looks similar", async () => {
    const a = app();
    a.post(`${KYC_PATH}-not-really`, (_req, res) => res.json({ ok: true }));
    const res = await request(a)
      .post(`${KYC_PATH}-not-really`)
      .set("Origin", "https://evil.example")
      .send({});
    expect(res.status).toBe(403);
  });

  // ── the cookie itself ──────────────────────────────────────────────────────

  it("issues a token cookie that JS can read", async () => {
    const res = await request(app()).get("/token");
    const setCookie = (res.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith(`${CSRF_COOKIE}=`),
    )!;
    // NOT httpOnly — unlike the session cookies. That is the point: this value is meant to be
    // paired back into a header, and it is worthless without the session cookie beside it.
    expect(setCookie.toLowerCase()).not.toContain("httponly");
    expect(typeof res.body.token).toBe("string");
    expect((res.body.token as string).length).toBeGreaterThan(20);
  });

  it("mints a different token each time", async () => {
    const a = app();
    const first = await mintToken(a);
    const second = await mintToken(a);
    expect(first.token).not.toBe(second.token);
  });
});
