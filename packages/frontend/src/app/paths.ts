import type { Role } from "../auth/authClient.js";

/**
 * Every route in the app, in one place.
 *
 * Path-based, not hash-based. The old router was eight lines of `window.location.hash` with no
 * params, which cannot express a shareable task URL, a return-to after login, a password-reset
 * link, or an admin deep link — all of which this app needs.
 */
export const paths = {
  // ── public ────────────────────────────────────────────────────────────────
  landing: "/",
  login: "/login",
  helperSignup: "/join",
  privacy: "/legal/privacy",
  terms: "/legal/terms",
  safety: "/legal/safety",
  dataHandling: "/legal/data",

  // ── requester ─────────────────────────────────────────────────────────────
  requesterHome: "/app",

  // ── helper ────────────────────────────────────────────────────────────────
  helperHome: "/helper",
  /** Where an unverified helper is sent — the KYC gate, not a blank dashboard. */
  helperVerify: "/helper/verify",

  // ── admin ─────────────────────────────────────────────────────────────────
  /** Deliberately NOT linked from any public navigation. See guards.tsx. */
  adminLogin: "/admin/login",
  adminHome: "/admin",
} as const;

/**
 * Where a signed-in user belongs.
 *
 * Used by the role guard so a wrong-role visitor is sent to their OWN home rather than to a
 * blank screen or a redirect loop. `both` resolves to the requester side because that is the
 * side a dual-role user opens when they need something; the helper side is one tap away.
 */
export function homeFor(role: Role): string {
  switch (role) {
    case "admin":
      return paths.adminHome;
    case "helper":
      return paths.helperHome;
    case "requester":
    case "both":
      return paths.requesterHome;
  }
}

/** Build a login URL that remembers where the user was trying to go. */
export function loginWithReturn(to: string, loginPath: string = paths.login): string {
  return `${loginPath}?next=${encodeURIComponent(to)}`;
}

/**
 * Read a `next` param back, refusing anything that isn't a local path.
 *
 * An open redirect here would be a real phishing primitive: `/login?next=https://evil.example`
 * would bounce a freshly-authenticated user off-site at the exact moment they trust the app
 * most. Only same-origin absolute paths are honoured, and `//host` is rejected because browsers
 * treat it as protocol-relative and therefore off-site.
 */
export function safeReturnTo(next: string | null, fallback: string): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  return next;
}
