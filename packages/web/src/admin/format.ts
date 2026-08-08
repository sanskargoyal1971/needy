import { AuthError } from "@/lib/authClient";

/** Shared presentation helpers for the admin console. */

/** "3 hours ago" — the operator's question about a queue row is how long someone has been
 *  waiting, and an absolute timestamp makes them do that subtraction themselves. */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const seconds = Math.round((now - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Full, unambiguous timestamp for the audit log, where "3 days ago" is not good enough —
 *  the log is evidence and may be read months later. */
export function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Age in whole years from an ISO date, by calendar. Mirrors the server's `ageInYears` — the
 *  reviewer is checking this against the ID, so the two must not disagree by a day. */
export function ageFrom(dobISO: string | null, now: number = Date.now()): number | null {
  if (!dobISO) return null;
  const dob = new Date(`${dobISO}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return null;
  const d = new Date(now);
  let age = d.getUTCFullYear() - dob.getUTCFullYear();
  const m = d.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && d.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

export function describeAdminError(err: unknown): string {
  if (err instanceof AuthError) {
    switch (err.code) {
      case "not-awaiting-review":
        return "This packet has already been decided. Reload to see the current state.";
      case "cannot-review-own-account":
        return "You can't review your own account.";
      case "cannot-block-self":
        return "You can't block your own account.";
      case "reason-required-to-reject":
        return "A reason is required — the applicant is shown this text.";
      case "documents-incomplete":
        return "This packet is missing a document and can't be approved.";
      case "invalid-or-expired-signature":
        return "That document link expired. Reload the packet to view it again.";
      case "forbidden":
        return "Your account doesn't have access to this.";
      case "network-unreachable":
        return "Can't reach the server. Check your connection.";
      default:
        return "Something went wrong. Please try again.";
    }
  }
  return "Something went wrong. Please try again.";
}
