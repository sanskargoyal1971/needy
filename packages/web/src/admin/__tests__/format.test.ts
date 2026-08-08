import { describe, expect, it } from "vitest";
import { AuthError } from "@/lib/authClient";
import { ageFrom, describeAdminError, formatBytes, relativeTime } from "../format";

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0); // 2026-08-09 12:00 UTC

describe("relativeTime", () => {
  it.each([
    [30_000, "just now"],
    [5 * 60_000, "5 min ago"],
    [3 * 3_600_000, "3 hours ago"],
    [1 * 3_600_000, "1 hour ago"],
    [2 * 86_400_000, "2 days ago"],
    [1 * 86_400_000, "1 day ago"],
  ])("renders %ims ago", (delta, expected) => {
    expect(relativeTime(NOW - delta, NOW)).toBe(expected);
  });
});

describe("ageFrom", () => {
  /** Must agree with the server's `ageInYears` to the day — the reviewer is checking this
   *  number against a date on an identity document, and an off-by-one on a birthday would
   *  put the applicant in a different eligibility band than the backend computed. */
  it("counts whole years and does not round up before the birthday", () => {
    expect(ageFrom("1995-03-14", NOW)).toBe(31);
    expect(ageFrom("2008-08-09", NOW)).toBe(18); // birthday today
    expect(ageFrom("2008-08-10", NOW)).toBe(17); // tomorrow
    expect(ageFrom("1966-08-10", NOW)).toBe(59); // day before turning 60
    expect(ageFrom("1966-08-09", NOW)).toBe(60);
  });

  it("returns null for missing or unparseable dates", () => {
    expect(ageFrom(null, NOW)).toBeNull();
    expect(ageFrom("not-a-date", NOW)).toBeNull();
  });
});

describe("formatBytes", () => {
  it.each([
    [512, "512 B"],
    [2048, "2 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
  ])("formats %i", (n, expected) => {
    expect(formatBytes(n)).toBe(expected);
  });
});

describe("describeAdminError", () => {
  /** Each of these is a distinct thing the operator has to do differently, so they must not
   *  collapse into one generic message. */
  it.each([
    ["not-awaiting-review", /already been decided/i],
    ["cannot-review-own-account", /own account/i],
    ["reason-required-to-reject", /reason is required/i],
    ["invalid-or-expired-signature", /expired/i],
    ["documents-incomplete", /missing a document/i],
  ])("explains %s specifically", (code, pattern) => {
    expect(describeAdminError(new AuthError(400, code))).toMatch(pattern);
  });

  it("falls back for anything unrecognised", () => {
    expect(describeAdminError(new Error("boom"))).toMatch(/something went wrong/i);
    expect(describeAdminError(new AuthError(500, "kaboom"))).toMatch(/something went wrong/i);
  });
});
