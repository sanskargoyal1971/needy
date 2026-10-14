// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy, config } from "../proxy";

/**
 * The CSP is assembled in one function and nothing else checks it: a build is green with a
 * policy that blocks every script, and green with one that blocks none. These pin the parts
 * that an upgrade or a well-meant "fix" is most likely to loosen — and the request-header
 * handoff, which is the only way the nonce reaches the scripts Next itself emits.
 */
function run(path = "/") {
  return proxy(new NextRequest(new URL(path, "http://localhost:3000")));
}

function directive(policy: string, name: string): string {
  const found = policy.split("; ").find((d) => d.startsWith(`${name} `));
  if (!found) throw new Error(`no ${name} directive in: ${policy}`);
  return found;
}

describe("proxy — Content-Security-Policy", () => {
  it("allows scripts by per-request nonce and strict-dynamic, never by 'unsafe-inline'", () => {
    const scriptSrc = directive(run().headers.get("Content-Security-Policy") ?? "", "script-src");
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]{16,}'/);
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // vitest runs with NODE_ENV=test, i.e. not development: eval must be off, as in production.
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("mints a different nonce for every request", () => {
    const nonce = () =>
      /'nonce-([^']+)'/.exec(run().headers.get("Content-Security-Policy") ?? "")?.[1];
    expect(nonce()).toBeTruthy();
    expect(nonce()).not.toBe(nonce());
  });

  it("forwards the same policy on the request, which is where Next reads the nonce from", () => {
    const res = run();
    const policy = res.headers.get("Content-Security-Policy");
    // `NextResponse.next({ request: { headers } })` encodes the overridden request headers as
    // `x-middleware-request-*` on the response. If the policy is only on the response, the
    // browser enforces a nonce that no framework script carries and the page is blank.
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
    const nonce = /'nonce-([^']+)'/.exec(policy ?? "")?.[1];
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
  });

  it("keeps the framing, base and form restrictions", () => {
    const policy = run().headers.get("Content-Security-Policy") ?? "";
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
  });
});

describe("proxy — companion headers", () => {
  it("sets no-referrer, nosniff and HSTS outside development", () => {
    const res = run("/app/task/some-id");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("makes no access decision: a protected path passes through with or without a cookie", () => {
    // AppGate's comment explains why the route gate is NOT here: a proxy sees only the
    // request, not the live onboarding status in Postgres. This pins that the proxy really
    // does stay out of it, so the comment and the code cannot quietly disagree — a cookie- or
    // JWT-based redirect added here would be the token-lifetime gate that design rules out.
    const anonymous = run("/admin/queue");
    const withCookie = proxy(
      new NextRequest(new URL("/admin/queue", "http://localhost:3000"), {
        headers: { cookie: "session=not-a-real-token" },
      }),
    );
    for (const res of [anonymous, withCookie]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    }
  });

  it("matches documents but not Next's hashed build output", () => {
    const pattern = new RegExp(`^${config.matcher[0].source}$`);
    expect(pattern.test("/")).toBe(true);
    expect(pattern.test("/app/task/abc")).toBe(true);
    expect(pattern.test("/_next/static/chunks/main.js")).toBe(false);
    expect(pattern.test("/_next/image")).toBe(false);
  });
});
