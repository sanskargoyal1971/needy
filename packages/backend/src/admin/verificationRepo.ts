import type { OnboardingStatus } from "@needy/shared";
import type { DbPool } from "../db.js";
import type { User } from "../auth/types.js";
import { phoneSchema } from "../auth/validation.js";
import { phoneIndex } from "../crypto/pii.js";

/** ── Admin-side user queries ───────────────────────────────────────────────
 *  `UserRepository` is deliberately keyed-lookup only (by id, by phone) because that is all
 *  the request path needs, and a `list()` on it would be an invitation to scan the users
 *  table from a route handler. The admin surface genuinely needs to enumerate, so it gets its
 *  own narrow interface with the pagination and caps built in rather than bolted on.
 */

/** A queue row. Deliberately NOT the full `User`: the queue renders a list, and shipping
 *  every column of every pending applicant to the browser is more PII on the wire than the
 *  screen actually shows. The packet detail endpoint returns the rest. */
export interface QueueEntry {
  id: string;
  displayName: string;
  /** Masked — the queue is a list view, and a full number here would make it a directory. */
  phoneMasked: string;
  onboardingStatus: OnboardingStatus;
  submittedAt: number | null;
  createdAt: number;
  role: User["role"];
  blockedAt: number | null;
}

export interface AdminUserQueries {
  /** Pending packets, oldest first — the fairness ordering, and the one the partial index
   *  in migration 3 is built for. */
  queue(status: OnboardingStatus, limit: number): Promise<QueueEntry[]>;
  /** Everyone, newest first, optionally filtered — see `matchSearch` for what a search matches. */
  listUsers(opts: { search?: string; limit: number }): Promise<QueueEntry[]>;
  /** Headline counts for the dashboard. One round trip, not five. */
  counts(): Promise<Record<string, number>>;
}

/** Show only the last 4 digits. Enough to correlate a support call, not enough for the list
 *  to become a phone directory. Mirrors `maskPhone` in auth/providers.ts. */
export function maskPhone(phone: string): string {
  const tail = phone.slice(-4);
  return tail.length === 0 ? "***" : `***${tail}`;
}

/**
 * What an admin search can match on now that the number is sealed.
 *
 * It used to be any fragment of the number (`phone ILIKE '%…%'`). A sealed column cannot be
 * searched that way — that is the point of sealing it — so a search matches:
 *   - a name fragment, as before;
 *   - a whole number, through its blind index;
 *   - exactly four digits, as the last four of the number, which is what a support call quotes
 *     and what the masked list already shows.
 * Anything else that looks like part of a number simply finds nobody.
 */
function matchSearch(search: string) {
  const s = search.trim();
  return {
    exactPhoneHash: phoneSchema.safeParse(s).success ? phoneIndex(s) : null,
    last4: /^\d{4}$/.test(s) ? s : null,
  };
}

const rowToEntry = (r: {
  id: string;
  display_name: string;
  /** Legacy plaintext; only a row the backfill has not sealed yet still has it. */
  phone: string | null;
  phone_last4: string | null;
  onboarding_status: string;
  submitted_at: string | number | null;
  created_at: string | number;
  role: string;
  blocked_at: string | number | null;
}): QueueEntry => ({
  id: r.id,
  displayName: r.display_name,
  // The masked form needs only the last four, which is why the list never has to decrypt.
  phoneMasked: r.phone_last4 ? `***${r.phone_last4}` : maskPhone(r.phone ?? ""),
  onboardingStatus: r.onboarding_status as OnboardingStatus,
  submittedAt: r.submitted_at == null ? null : Number(r.submitted_at),
  createdAt: Number(r.created_at),
  role: r.role as User["role"],
  blockedAt: r.blocked_at == null ? null : Number(r.blocked_at),
});

const COLUMNS = `id, display_name, phone, phone_last4, onboarding_status, submitted_at, created_at, role, blocked_at`;

export function createPgAdminUserQueries(pool: DbPool): AdminUserQueries {
  return {
    async queue(status, limit) {
      const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM users
          WHERE onboarding_status = $1
          -- NULLS LAST so a row that somehow reached the queue without a submitted_at sorts
          -- to the end rather than jumping the queue as a NULL would under ASC.
          ORDER BY submitted_at ASC NULLS LAST
          LIMIT $2`,
        [status, limit],
      );
      return rows.map(rowToEntry);
    },
    async listUsers({ search, limit }) {
      // ILIKE on a parameterised pattern — the wildcards are added here, not taken from the
      // caller, so a search for "%" matches a literal percent rather than everything.
      const pattern = search ? `%${search.replace(/[%_\\]/g, "\\$&")}%` : null;
      const { exactPhoneHash, last4 } = search
        ? matchSearch(search)
        : { exactPhoneHash: null, last4: null };
      const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM users
          WHERE $1::text IS NULL OR display_name ILIKE $1
             OR phone_hash = $3::text OR phone_last4 = $4::text
          ORDER BY created_at DESC
          LIMIT $2`,
        [pattern, limit, exactPhoneHash, last4],
      );
      return rows.map(rowToEntry);
    },
    async counts() {
      const { rows } = await pool.query<{ onboarding_status: string; n: string }>(
        `SELECT onboarding_status, COUNT(*) AS n FROM users GROUP BY onboarding_status`,
      );
      return Object.fromEntries(rows.map((r) => [r.onboarding_status, Number(r.n)]));
    },
  };
}

/** In-memory equivalent, backed by whatever the in-memory UserRepository holds. Exists so the
 *  admin routes are testable without Postgres and so the no-database dev boot still renders a
 *  queue rather than throwing. */
export function createInMemoryAdminUserQueries(all: () => User[]): AdminUserQueries {
  const toEntry = (u: User): QueueEntry => ({
    id: u.id,
    displayName: u.displayName,
    phoneMasked: maskPhone(u.phone),
    onboardingStatus: u.onboardingStatus,
    submittedAt: u.submittedAt,
    createdAt: u.createdAt,
    role: u.role,
    blockedAt: u.blockedAt,
  });
  return {
    async queue(status, limit) {
      return all()
        .filter((u) => u.onboardingStatus === status)
        .sort((a, b) => (a.submittedAt ?? Infinity) - (b.submittedAt ?? Infinity))
        .slice(0, limit)
        .map(toEntry);
    },
    async listUsers({ search, limit }) {
      const q = search?.toLowerCase();
      const { exactPhoneHash, last4 } = search
        ? matchSearch(search)
        : { exactPhoneHash: null, last4: null };
      // The same three arms as the Postgres twin, so a search that finds someone in one finds
      // them in the other.
      return all()
        .filter(
          (u) =>
            !q ||
            u.displayName.toLowerCase().includes(q) ||
            (exactPhoneHash != null && phoneIndex(u.phone) === exactPhoneHash) ||
            (last4 != null && u.phone.replace(/\D/g, "").slice(-4) === last4),
        )
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map(toEntry);
    },
    async counts() {
      const out: Record<string, number> = {};
      for (const u of all()) out[u.onboardingStatus] = (out[u.onboardingStatus] ?? 0) + 1;
      return out;
    },
  };
}
