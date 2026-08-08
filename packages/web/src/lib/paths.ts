import type { OnboardingStatus, Role } from "./authClient";

/**
 * Every route in the app, in one place.
 *
 * Ported from the Vite app's router. Next's App Router owns the actual file layout, so this
 * is no longer a route *table* — it is the single place a path string is written down, which
 * is what keeps a redirect in middleware and a `<Link>` in a component from drifting apart.
 */
export const paths = {
  // ── public ────────────────────────────────────────────────────────────────
  landing: "/",
  login: "/login",
  signup: "/signup",
  becomeHelper: "/become-a-helper",
  safety: "/safety",
  pricing: "/pricing",
  privacy: "/privacy",
  terms: "/terms",

  // ── onboarding ────────────────────────────────────────────────────────────
  /** The wizard. `?step=` selects the pane; the server's onboardingStatus is authoritative. */
  onboarding: "/signup/verify",
  /** Where a submitted-but-unreviewed user lands, and where a rejected user is trapped. */
  hold: "/hold",

  // ── requester ─────────────────────────────────────────────────────────────
  requesterHome: "/app",
  newRequest: "/app/request",
  task: (id: string) => `/app/task/${id}`,

  // ── helper ────────────────────────────────────────────────────────────────
  helperHome: "/helper",
  helperServices: "/helper/services",

  // ── admin ─────────────────────────────────────────────────────────────────
  /** Deliberately NOT linked from any public navigation. */
  adminHome: "/admin",
  adminQueue: "/admin/queue",
  adminUsers: "/admin/users",
  adminAudit: "/admin/audit",
} as const;

/**
 * Where a signed-in user belongs.
 *
 * Onboarding outranks role: an unapproved admin is still an unapproved user. Ordering these
 * checks the other way round is the classic way a verification gate ends up bypassable by
 * anyone whose role happens to be checked first.
 */
export function homeFor(role: Role, onboarding: OnboardingStatus): string {
  if (onboarding === "rejected" || onboarding === "under_review") return paths.hold;
  if (onboarding !== "approved") return paths.onboarding;

  switch (role) {
    case "admin":
      return paths.adminHome;
    case "helper":
      return paths.helperHome;
    case "requester":
    case "both":
      return paths.requesterHome;
    default: {
      // Exhaustiveness guard: if `Role` gains a member, this stops compiling rather than
      // silently falling through to a blank screen at runtime.
      const _never: never = role;
      void _never;
      return paths.requesterHome;
    }
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
 * treat it as protocol-relative and therefore off-site. `\` is rejected too: some browsers
 * normalise `/\evil.example` to a protocol-relative URL.
 */
export function safeReturnTo(next: string | null, fallback: string): string {
  if (!next) return fallback;
  if (!next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
