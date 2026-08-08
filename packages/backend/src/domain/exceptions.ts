import type { DbPool } from "../db.js";

/** ── Booking exceptions ────────────────────────────────────────────────────
 *  Unlocks a pairing the eligibility matrix restricts (two young adults of different
 *  gender). Both parties record a video testimony; an admin watches both and decides.
 *
 *  Scoped to an ordered PAIR, not to a person. Agreeing to be matched with one specific
 *  individual is not agreeing to have the rule waived generally, and a per-person waiver
 *  would quietly turn one review into a standing exemption.
 */

export type ExceptionStatus =
  | "awaiting_videos" //  opened; one or both testimonies still missing
  | "under_review" //     both present, waiting on an admin
  | "approved"
  | "rejected"
  | "expired"; //         approved once, but the window has since lapsed

export interface BookingException {
  id: string;
  requesterId: string;
  helperId: string;
  status: ExceptionStatus;
  requesterVideoKey: string | null;
  helperVideoKey: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  createdAt: number;
  submittedAt: number | null;
  decidedAt: number | null;
  expiresAt: number | null;
}

export interface ExceptionRepository {
  getById(id: string): Promise<BookingException | null>;
  /** The one in flight or approved for this ordered pair, if any. */
  findForPair(requesterId: string, helperId: string): Promise<BookingException | null>;
  /** True iff an approved, unexpired exception covers this pair — the matching gate. */
  isApproved(requesterId: string, helperId: string, now: number): Promise<boolean>;
  create(e: BookingException): Promise<BookingException>;
  update(id: string, patch: Partial<BookingException>): Promise<BookingException>;
  /** Admin queue: submitted packets, oldest first. */
  queue(limit: number): Promise<BookingException[]>;
}

interface Row {
  id: string;
  requester_id: string;
  helper_id: string;
  status: string;
  requester_video_key: string | null;
  helper_video_key: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  created_at: string | number;
  submitted_at: string | number | null;
  decided_at: string | number | null;
  expires_at: string | number | null;
}

const n = (v: string | number | null): number | null => (v == null ? null : Number(v));

const toException = (r: Row): BookingException => ({
  id: r.id,
  requesterId: r.requester_id,
  helperId: r.helper_id,
  status: r.status as ExceptionStatus,
  requesterVideoKey: r.requester_video_key,
  helperVideoKey: r.helper_video_key,
  reviewedBy: r.reviewed_by,
  reviewNote: r.review_note,
  createdAt: Number(r.created_at),
  submittedAt: n(r.submitted_at),
  decidedAt: n(r.decided_at),
  expiresAt: n(r.expires_at),
});

export function createPgExceptionRepo(pool: DbPool): ExceptionRepository {
  return {
    async getById(id) {
      const { rows } = await pool.query<Row>(`SELECT * FROM booking_exceptions WHERE id = $1`, [id]);
      return rows[0] ? toException(rows[0]) : null;
    },
    async findForPair(requesterId, helperId) {
      // Prefer a live request over a settled one, then most recent. A pair that was rejected
      // last month and has since opened a new request should see the new one.
      const { rows } = await pool.query<Row>(
        `SELECT * FROM booking_exceptions
          WHERE requester_id = $1 AND helper_id = $2
          ORDER BY (status IN ('awaiting_videos','under_review','approved')) DESC, created_at DESC
          LIMIT 1`,
        [requesterId, helperId],
      );
      return rows[0] ? toException(rows[0]) : null;
    },
    async isApproved(requesterId, helperId, now) {
      // Expiry is checked in the QUERY, not by reading the row and comparing afterwards: this
      // is the authorization check, and a lapsed approval must not be able to authorise
      // anything even if a caller forgets to look at `expiresAt`.
      const { rows } = await pool.query<{ one: number }>(
        `SELECT 1 AS one FROM booking_exceptions
          WHERE requester_id = $1 AND helper_id = $2 AND status = 'approved'
            AND (expires_at IS NULL OR expires_at > $3)`,
        [requesterId, helperId, now],
      );
      return rows.length > 0;
    },
    async create(e) {
      await pool.query(
        `INSERT INTO booking_exceptions
           (id, requester_id, helper_id, status, requester_video_key, helper_video_key,
            reviewed_by, review_note, created_at, submitted_at, decided_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          e.id, e.requesterId, e.helperId, e.status, e.requesterVideoKey, e.helperVideoKey,
          e.reviewedBy, e.reviewNote, e.createdAt, e.submittedAt, e.decidedAt, e.expiresAt,
        ],
      );
      return e;
    },
    async update(id, patch) {
      const existing = await this.getById(id);
      if (!existing) throw new Error(`exception not found: ${id}`);
      const next = { ...existing, ...patch, id: existing.id };
      await pool.query(
        `UPDATE booking_exceptions
            SET status=$2, requester_video_key=$3, helper_video_key=$4, reviewed_by=$5,
                review_note=$6, submitted_at=$7, decided_at=$8, expires_at=$9
          WHERE id=$1`,
        [
          next.id, next.status, next.requesterVideoKey, next.helperVideoKey, next.reviewedBy,
          next.reviewNote, next.submittedAt, next.decidedAt, next.expiresAt,
        ],
      );
      return next;
    },
    async queue(limit) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM booking_exceptions
          WHERE status = 'under_review'
          ORDER BY submitted_at ASC NULLS LAST
          LIMIT $1`,
        [limit],
      );
      return rows.map(toException);
    },
  };
}

export function createInMemoryExceptionRepo(): ExceptionRepository {
  const byId = new Map<string, BookingException>();
  const live = (e: BookingException) =>
    e.status === "awaiting_videos" || e.status === "under_review" || e.status === "approved";
  return {
    async getById(id) {
      return byId.get(id) ?? null;
    },
    async findForPair(requesterId, helperId) {
      return (
        [...byId.values()]
          .filter((e) => e.requesterId === requesterId && e.helperId === helperId)
          .sort((a, b) => Number(live(b)) - Number(live(a)) || b.createdAt - a.createdAt)[0] ?? null
      );
    },
    async isApproved(requesterId, helperId, now) {
      return [...byId.values()].some(
        (e) =>
          e.requesterId === requesterId &&
          e.helperId === helperId &&
          e.status === "approved" &&
          (e.expiresAt == null || e.expiresAt > now),
      );
    },
    async create(e) {
      byId.set(e.id, e);
      return e;
    },
    async update(id, patch) {
      const existing = byId.get(id);
      if (!existing) throw new Error(`exception not found: ${id}`);
      const next = { ...existing, ...patch, id: existing.id };
      byId.set(id, next);
      return next;
    },
    async queue(limit) {
      return [...byId.values()]
        .filter((e) => e.status === "under_review")
        .sort((a, b) => (a.submittedAt ?? Infinity) - (b.submittedAt ?? Infinity))
        .slice(0, limit);
    },
  };
}
