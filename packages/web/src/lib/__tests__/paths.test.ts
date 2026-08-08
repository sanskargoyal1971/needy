import { describe, expect, it } from "vitest";
import { homeFor, loginWithReturn, paths, safeReturnTo } from "../paths";
import { normalisePhone, phoneError } from "../phone";

describe("homeFor", () => {
  /** Onboarding outranks role. Getting this ordering backwards is the classic way a
   *  verification gate ends up bypassable by whoever's role is checked first. */
  it("sends an unapproved admin to the hold screen, not the admin console", () => {
    expect(homeFor("admin", "under_review")).toBe(paths.hold);
    expect(homeFor("admin", "rejected")).toBe(paths.hold);
    expect(homeFor("admin", "documents")).toBe(paths.onboarding);
    // …and only an approved admin reaches the console.
    expect(homeFor("admin", "approved")).toBe(paths.adminHome);
  });

  it("routes approved users by role", () => {
    expect(homeFor("requester", "approved")).toBe(paths.requesterHome);
    expect(homeFor("helper", "approved")).toBe(paths.helperHome);
    // A dual-role user opens the side they need something from; the helper side is one tap away.
    expect(homeFor("both", "approved")).toBe(paths.requesterHome);
  });

  it("sends part-way users back into the wizard", () => {
    for (const s of ["draft", "identity", "documents"] as const) {
      expect(homeFor("requester", s)).toBe(paths.onboarding);
    }
  });
});

describe("safeReturnTo", () => {
  it("honours a local path", () => {
    expect(safeReturnTo("/app/task/abc", paths.requesterHome)).toBe("/app/task/abc");
  });

  /** An open redirect here is a real phishing primitive: it bounces a freshly-authenticated
   *  user off-site at the exact moment they trust the app most. */
  it.each([
    ["https://evil.example", "absolute URL"],
    ["//evil.example", "protocol-relative"],
    ["/\\evil.example", "backslash, which some browsers normalise to protocol-relative"],
    ["javascript:alert(1)", "javascript scheme"],
    ["evil.example", "bare host"],
  ])("refuses %s (%s)", (next) => {
    expect(safeReturnTo(next, paths.requesterHome)).toBe(paths.requesterHome);
  });

  it("falls back when there is no next param", () => {
    expect(safeReturnTo(null, paths.requesterHome)).toBe(paths.requesterHome);
  });

  it("round-trips through loginWithReturn", () => {
    const url = loginWithReturn("/app/task/a b");
    const next = new URL(url, "http://localhost").searchParams.get("next");
    expect(safeReturnTo(next, paths.landing)).toBe("/app/task/a b");
  });
});

describe("normalisePhone", () => {
  /** The server keys on E.164 for the phone UNIQUE column, the OTP rate-limit bucket and the
   *  block-list HMAC. Two shapes of the same number means two accounts and a bypassable
   *  limiter, so every one of these must collapse to the same string. */
  it.each([
    "9876543210",
    "+919876543210",
    "+91 98765 43210",
    "098765 43210",
    "+91-98765-43210",
    "(+91) 98765 43210",
    "  9876543210  ",
  ])("normalises %s to +919876543210", (input) => {
    expect(normalisePhone(input)).toBe("+919876543210");
  });

  it("keeps a non-Indian country code as given", () => {
    expect(normalisePhone("+14155550123")).toBe("+14155550123");
  });
});

describe("phoneError", () => {
  it("accepts a plausible number", () => {
    expect(phoneError("9876543210")).toBeNull();
    expect(phoneError("+919876543210")).toBeNull();
  });

  it("rejects empty, too-short, too-long and leading-zero-country numbers", () => {
    expect(phoneError("")).toBeTruthy();
    expect(phoneError("12345")).toBeTruthy();
    expect(phoneError("+9999999999999999999")).toBeTruthy();
    // E.164 country codes never start with 0.
    expect(phoneError("+0123456789")).toBeTruthy();
  });
});
