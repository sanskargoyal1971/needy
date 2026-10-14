import { SEED_SERVICES } from "@needy/shared";
import type { DbPool } from "./db.js";
import { CONSTRAINTS_SQL, SCHEMA_SQL } from "./db.js";

/** ── Migrations ────────────────────────────────────────────────────────────
 *  A real versioned migration runner, replacing "execute the whole DDL file on every boot".
 *
 *  What was wrong with the previous approach, concretely:
 *   - No record of what had been applied, so there was no way to write a migration that isn't
 *     idempotent — no `ALTER TABLE … RENAME`, no backfill, no data correction. Every future
 *     schema change would have had to be expressible as `CREATE … IF NOT EXISTS`, which is a
 *     constraint that gets abandoned the first time someone needs to rename a column, usually
 *     by editing the DDL in place and leaving every existing database behind.
 *   - No mutual exclusion. Two instances booting simultaneously (a rolling deploy, or just
 *     `npm run dev` twice) both ran the DDL concurrently; `CREATE TABLE IF NOT EXISTS` is not
 *     atomic against a competing creator and raises a duplicate-table error in the loser.
 *   - No ordering guarantee between the tables and the constraints that reference them.
 *
 *  Design choices, and why:
 *   - Hand-rolled rather than node-pg-migrate/knex. The whole runner is ~80 lines, it needs no
 *     CLI, no config file, and no separate build step, and it keeps `pg` as the only database
 *     dependency. A migration library earns its place when you need generated down-migrations
 *     and a plugin ecosystem; here it would be more moving parts than the thing it runs.
 *   - Migrations are SQL strings in an ordered array in *this file*, not files on disk. The
 *     backend ships as a compiled `dist/` (and inside a container that copies only `dist/`), so
 *     reading `.sql` files at runtime means shipping them too and resolving paths relative to
 *     an ESM module. In-code migrations cannot go missing from a build.
 *   - **No down-migrations.** Deliberate. A rollback that drops a column destroys production
 *     data, and the honest recovery path for a bad migration is a forward fix plus a restore
 *     from backup. Offering `down()` mostly encourages running it.
 */

export interface Migration {
  /** Monotonic. Never renumber or reorder a released migration: the number is the identity. */
  readonly id: number;
  readonly name: string;
  /** Statements applied in order, all inside ONE transaction with the rest of the migration. */
  readonly statements: readonly string[];
  /**
   * Statements whose failure is tolerated, applied after `statements` and OUTSIDE the
   * transaction. This exists for exactly one case: adding a CHECK/FK to a table that may
   * already hold violating rows. Such a constraint legitimately cannot be validated, and the
   * right response is a loud warning for an operator, not a service that refuses to boot.
   */
  readonly tolerant?: readonly string[];
}

/**
 * Migration 1 is the *baseline*. Its statements are the original `CREATE TABLE IF NOT EXISTS`
 * DDL, which is what makes adopting this runner safe on the databases that already exist: on a
 * fresh database it creates everything, and on a database that was booted under the old
 * always-run-the-DDL scheme every statement is a no-op and the row simply records that the
 * baseline is present. No manual `INSERT INTO schema_migrations` step, no divergence between
 * "new deploy" and "existing deploy".
 *
 * Everything from here on must be a NEW numbered entry. Editing a released migration's SQL is
 * the one genuinely unrecoverable mistake available here: databases that already ran it will
 * never see the change, and the two will drift silently.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "baseline-schema",
    statements: [SCHEMA_SQL],
    // Constraints are tolerant rather than transactional: see CONSTRAINTS_SQL's own note. On a
    // database with pre-existing dirty rows these are precisely the statements we want to warn
    // about and continue past.
    tolerant: CONSTRAINTS_SQL,
  },
  {
    id: 2,
    name: "pricing-applications-admin",
    statements: [
      // Tasks: add description + price
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 0`,
      // Helpers: add bio + earnings
      `ALTER TABLE helpers ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE helpers ADD COLUMN IF NOT EXISTS total_earnings INTEGER NOT NULL DEFAULT 0`,
      // Helper applications table
      `CREATE TABLE IF NOT EXISTS helper_applications (
         id            TEXT PRIMARY KEY,
         user_id       TEXT NOT NULL,
         display_name  TEXT NOT NULL,
         phone         TEXT NOT NULL,
         aadhaar_last4 TEXT NOT NULL,
         experience    TEXT NOT NULL DEFAULT '',
         status        TEXT NOT NULL DEFAULT 'pending',
         reviewed_by   TEXT,
         review_note   TEXT,
         created_at    BIGINT NOT NULL,
         updated_at    BIGINT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_applications_user ON helper_applications (user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_applications_status ON helper_applications (status)`,
      // Seed an admin user for the demo (phone +919999999999). ON CONFLICT so it's idempotent.
      `INSERT INTO users (id, phone, email, display_name, role, kyc_status, created_at, updated_at)
       VALUES ('admin-seed', '+919999999999', NULL, 'Admin', 'admin', 'verified', ${Date.now()}, ${Date.now()})
       ON CONFLICT (id) DO NOTHING`,
    ],
    tolerant: [
      `ALTER TABLE helper_applications ADD CONSTRAINT fk_applications_user
         FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`,
      `ALTER TABLE helper_applications ADD CONSTRAINT chk_applications_status CHECK (status IN
         ('pending','approved','rejected'))`,
    ],
  },
  {
    id: 3,
    name: "identity-kyc-documents-audit",
    statements: [
      // ── users: the identity facts the eligibility matrix and the review queue need ──────
      //
      // date_of_birth is a DATE, not a stored age: an age integer is wrong the day after it
      // is written, and "was this person 18 when they signed up" is not the question the
      // matrix asks — it asks how old they are *now*, at match time.
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'draft'`,
      // Home area. Coarse by design — this is "which part of town do you live in", used to
      // seed the map, NOT a live position. Live positions belong in Redis with a TTL.
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS area_label TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS area_lat DOUBLE PRECISION`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS area_lng DOUBLE PRECISION`,
      // Rejection / suspension. Kept on the user row (not only in the audit log) because
      // every request has to check it, and that check must not be a join.
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS rejection_reason TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at BIGINT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS reviewed_by TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS reviewed_at BIGINT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS submitted_at BIGINT`,
      // The review queue's only query: pending packets, oldest first. Partial, because the
      // approved rows are the overwhelming majority and are never selected by it.
      `CREATE INDEX IF NOT EXISTS idx_users_review_queue ON users (submitted_at)
         WHERE onboarding_status = 'under_review'`,

      // Existing accounts predate this pipeline. Leaving them at the 'draft' default would
      // lock out every user the moment the gate ships, so they are graded by what they have:
      // an already-verified helper keeps their access, everyone else re-verifies.
      `UPDATE users SET onboarding_status = 'approved'
         WHERE onboarding_status = 'draft' AND (role = 'admin' OR kyc_status = 'verified')`,
      `UPDATE users SET onboarding_status = 'identity'
         WHERE onboarding_status = 'draft'`,

      // ── phone_blocks ────────────────────────────────────────────────────────────────────
      //
      // A rejected number must not be able to re-register. The number is stored as an HMAC,
      // never plaintext: this table is a list of people refused by the platform, which is
      // exactly the sort of thing that must not become a readable directory in a dump.
      // HMAC rather than a bare hash so a stolen table cannot be brute-forced offline —
      // the E.164 keyspace for one country is small enough to enumerate in minutes.
      `CREATE TABLE IF NOT EXISTS phone_blocks (
         phone_hmac  TEXT PRIMARY KEY,
         reason      TEXT NOT NULL,
         blocked_by  TEXT,
         blocked_at  BIGINT NOT NULL
       )`,

      // ── kyc_documents ───────────────────────────────────────────────────────────────────
      //
      // Only a storage KEY, never a URL: a URL in a database row outlives the signature that
      // was supposed to time-limit it, and tends to get logged. Access is always a fresh,
      // short-lived, admin-authenticated signature minted at read time.
      `CREATE TABLE IF NOT EXISTS kyc_documents (
         id           TEXT PRIMARY KEY,
         user_id      TEXT NOT NULL,
         kind         TEXT NOT NULL,
         storage_key  TEXT NOT NULL,
         content_type TEXT NOT NULL,
         size_bytes   INTEGER NOT NULL,
         sha256       TEXT NOT NULL,
         created_at   BIGINT NOT NULL
       )`,
      // One current document per kind per user. A re-upload REPLACES (the wizard lets people
      // retake a blurry selfie), so the uniqueness is what makes that an UPSERT rather than
      // an ever-growing pile a reviewer has to pick the newest from.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_kyc_docs_user_kind ON kyc_documents (user_id, kind)`,

      // ── audit_log ───────────────────────────────────────────────────────────────────────
      //
      // Append-only, per AGENTS.md: every SOS trigger, KYC review action and admin override.
      // Viewing a document is itself an audited act — "who looked at this person's Aadhaar,
      // and when" is a question this table must be able to answer.
      `CREATE TABLE IF NOT EXISTS audit_log (
         id           BIGSERIAL PRIMARY KEY,
         actor_id     TEXT,
         actor_role   TEXT,
         action       TEXT NOT NULL,
         subject_type TEXT,
         subject_id   TEXT,
         metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
         ip           TEXT,
         at           BIGINT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_log (subject_type, subject_id, at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_id, at DESC)`,
    ],
    tolerant: [
      `ALTER TABLE users ADD CONSTRAINT chk_users_onboarding_status CHECK (onboarding_status IN
         ('draft','identity','documents','under_review','approved','rejected'))`,
      `ALTER TABLE users ADD CONSTRAINT chk_users_gender CHECK (gender IS NULL OR gender IN
         ('male','female','other'))`,
      `ALTER TABLE kyc_documents ADD CONSTRAINT fk_kyc_docs_user
         FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`,
      `ALTER TABLE kyc_documents ADD CONSTRAINT chk_kyc_docs_kind CHECK (kind IN
         ('gov_id','selfie','video_testimony'))`,

      // Append-only enforced by the DATABASE, not by convention. A log the application can
      // rewrite is not evidence of anything: the first thing a compromised admin session or a
      // careless "clean up the test rows" script does is UPDATE or DELETE. Postgres has no
      // per-table immutability flag, so this is a rule that rewrites the offending statement
      // into nothing and raises.
      //
      // Tolerant because the app's DB role may lack rule-creation rights on a managed
      // instance; the log still works, it just loses the hard guarantee, and the operator
      // gets a warning saying so rather than a service that refuses to boot.
      `CREATE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING`,
      `CREATE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING`,
    ],
  },
  {
    id: 4,
    name: "services-exceptions-scheduling",
    statements: [
      // ── the catalog ─────────────────────────────────────────────────────────────────────
      `CREATE TABLE IF NOT EXISTS services (
         code         TEXT PRIMARY KEY,
         name         TEXT NOT NULL,
         description  TEXT NOT NULL DEFAULT '',
         is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,
         is_immediate BOOLEAN NOT NULL DEFAULT TRUE,
         base_price   INTEGER NOT NULL DEFAULT 0,
         active       BOOLEAN NOT NULL DEFAULT TRUE
       )`,
      // Seeded from SEED_SERVICES so a fresh database and a long-running one agree on what
      // these codes mean. DO UPDATE on name/description/flags but NOT on price: re-running a
      // migration must not silently re-price services an operator has since adjusted.
      ...SEED_SERVICES.map(
        (s) =>
          `INSERT INTO services (code, name, description, is_mandatory, is_immediate, base_price)
           VALUES (${lit(s.code)}, ${lit(s.name)}, ${lit(s.description)}, ${s.isMandatory}, ${s.isImmediate}, ${s.basePrice})
           ON CONFLICT (code) DO UPDATE
             SET name = EXCLUDED.name,
                 description = EXCLUDED.description,
                 is_mandatory = EXCLUDED.is_mandatory,
                 is_immediate = EXCLUDED.is_immediate`,
      ),

      // ── which helper offers what ────────────────────────────────────────────────────────
      `CREATE TABLE IF NOT EXISTS helper_services (
         helper_id    TEXT NOT NULL,
         service_code TEXT NOT NULL,
         created_at   BIGINT NOT NULL,
         PRIMARY KEY (helper_id, service_code)
       )`,
      // The matching filter's query is "who offers X", so the index leads with service_code.
      // The primary key already covers the other direction.
      `CREATE INDEX IF NOT EXISTS idx_helper_services_code ON helper_services (service_code)`,

      // Backfill: every existing helper is enrolled in the mandatory services. Without this,
      // shipping the service filter would empty the hospital pool on deploy — the emergency
      // path would silently have zero helpers, which is the worst possible regression here.
      `INSERT INTO helper_services (helper_id, service_code, created_at)
       SELECT u.id, s.code, 0
         FROM users u CROSS JOIN services s
        WHERE u.role IN ('helper','both') AND s.is_mandatory
       ON CONFLICT DO NOTHING`,

      // ── exceptions ──────────────────────────────────────────────────────────────────────
      //
      // A restricted pairing (two young adults of different gender) is unlocked by an
      // approved exception. Both parties record a video testimony; an admin decides within
      // one working day. Scoped to a PAIR, not to a person: consenting to be matched with one
      // specific individual is not consent to have the rule waived generally.
      `CREATE TABLE IF NOT EXISTS booking_exceptions (
         id                   TEXT PRIMARY KEY,
         requester_id         TEXT NOT NULL,
         helper_id            TEXT NOT NULL,
         status               TEXT NOT NULL DEFAULT 'awaiting_videos',
         requester_video_key  TEXT,
         helper_video_key     TEXT,
         reviewed_by          TEXT,
         review_note          TEXT,
         created_at           BIGINT NOT NULL,
         submitted_at         BIGINT,
         decided_at           BIGINT,
         -- Approvals lapse. An indefinite waiver would mean one review in 2026 still
         -- authorising a booking in 2029, long after either party could reasonably be said
         -- to have consented to it.
         expires_at           BIGINT
       )`,
      // One live exception per ordered pair. Partial, so a settled request does not block the
      // pair from ever applying again — only a request already in flight does.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_exception_live_pair
         ON booking_exceptions (requester_id, helper_id)
         WHERE status IN ('awaiting_videos','under_review')`,
      `CREATE INDEX IF NOT EXISTS idx_exception_queue ON booking_exceptions (submitted_at)
         WHERE status = 'under_review'`,
      `CREATE INDEX IF NOT EXISTS idx_exception_approved
         ON booking_exceptions (requester_id, helper_id, expires_at)
         WHERE status = 'approved'`,

      // ── tasks: service, schedule, handoff ───────────────────────────────────────────────
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS service_code TEXT`,
      // NULL = dispatch now. Set only for exception-gated bookings, which need the lead time
      // because the review they depend on takes up to a working day.
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scheduled_for BIGINT`,
      // Only ever a hash. The code is shown to the requester and typed by the helper; storing
      // it in the clear would let anyone with database access complete a handoff.
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS handoff_otp_hash TEXT`,
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS handoff_otp_expires_at BIGINT`,
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS handoff_verified_at BIGINT`,
      // The brief the helper sends before the handoff: what they will and will not do.
      `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS service_brief TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_scheduled ON tasks (scheduled_for)
         WHERE scheduled_for IS NOT NULL AND state = 'searching'`,

      // Existing rows predate the catalog. Map the old free-text category onto a code so the
      // service filter does not exclude every task created before this migration.
      `UPDATE tasks SET service_code = CASE category
         WHEN 'urgent' THEN 'hospital'
         WHEN 'errand' THEN 'groceries'
         WHEN 'companionship' THEN 'companion-walk'
         WHEN 'social-service' THEN 'social-service'
         ELSE 'groceries' END
       WHERE service_code IS NULL`,
    ],
    tolerant: [
      `ALTER TABLE helper_services ADD CONSTRAINT fk_helper_services_user
         FOREIGN KEY (helper_id) REFERENCES users (id) ON DELETE CASCADE`,
      `ALTER TABLE helper_services ADD CONSTRAINT fk_helper_services_code
         FOREIGN KEY (service_code) REFERENCES services (code) ON DELETE CASCADE`,
      `ALTER TABLE booking_exceptions ADD CONSTRAINT fk_exception_requester
         FOREIGN KEY (requester_id) REFERENCES users (id) ON DELETE CASCADE`,
      `ALTER TABLE booking_exceptions ADD CONSTRAINT fk_exception_helper
         FOREIGN KEY (helper_id) REFERENCES users (id) ON DELETE CASCADE`,
      `ALTER TABLE booking_exceptions ADD CONSTRAINT chk_exception_status CHECK (status IN
         ('awaiting_videos','under_review','approved','rejected','expired'))`,
      // A pair cannot vouch for itself.
      `ALTER TABLE booking_exceptions ADD CONSTRAINT chk_exception_distinct
         CHECK (requester_id <> helper_id)`,
      `ALTER TABLE tasks ADD CONSTRAINT fk_tasks_service
         FOREIGN KEY (service_code) REFERENCES services (code)`,
    ],
  },
  {
    id: 5,
    name: "sos-operator-lifecycle-and-abuse-signals",
    statements: [
      // ── sos_alerts: who answered, and what they found ───────────────────────────────────
      //
      // `acknowledged` was already in the SosStatus union and was UNREACHABLE: nothing could
      // set it, because there was no operator surface and no columns to record one. An alert
      // could only go from raised to cancelled-by-the-raiser. These four columns are what make
      // "somebody is dealing with this" a fact the system holds rather than a hope.
      `ALTER TABLE sos_alerts ADD COLUMN IF NOT EXISTS acknowledged_by TEXT`,
      `ALTER TABLE sos_alerts ADD COLUMN IF NOT EXISTS acknowledged_at BIGINT`,
      `ALTER TABLE sos_alerts ADD COLUMN IF NOT EXISTS resolved_by TEXT`,
      `ALTER TABLE sos_alerts ADD COLUMN IF NOT EXISTS resolution_note TEXT`,

      // The console's queue query. ASCENDING on created_at, unlike every other queue index
      // here: the alert waiting longest is the one to answer next, and an operator surface
      // sorted newest-first buries the person who has been waiting the longest under each
      // fresh arrival — the opposite of triage.
      `CREATE INDEX IF NOT EXISTS idx_sos_open_queue ON sos_alerts (created_at)
         WHERE status IN ('raised','acknowledged')`,

      // ── abuse_signals ───────────────────────────────────────────────────────────────────
      //
      // Append-only, like audit_log and for the same reason: this is evidence a human decides
      // on, and evidence the application can rewrite is not evidence. A signal is never
      // "dismissed" by deleting it — an operator's decision is a row in audit_log, so the
      // original observation and the judgement about it both survive independently.
      `CREATE TABLE IF NOT EXISTS abuse_signals (
         id          BIGSERIAL PRIMARY KEY,
         kind        TEXT NOT NULL,
         subject_id  TEXT NOT NULL,
         task_id     TEXT,
         weight      INTEGER NOT NULL DEFAULT 1,
         metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
         at          BIGINT NOT NULL
       )`,
      // The rollup query is "this user's signals within the window", so the index leads with
      // the subject and carries time as the range.
      `CREATE INDEX IF NOT EXISTS idx_abuse_subject ON abuse_signals (subject_id, at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_abuse_at ON abuse_signals (at DESC)`,
    ],
    tolerant: [
      // Both of these were missing entirely: `status` and `kind` are written straight from a
      // client-supplied union with only zod between them and the row, so the database had no
      // opinion at all about what an SOS row could say.
      `ALTER TABLE sos_alerts ADD CONSTRAINT chk_sos_status CHECK (status IN
         ('raised','acknowledged','resolved','cancelled'))`,
      `ALTER TABLE sos_alerts ADD CONSTRAINT chk_sos_kind CHECK (kind IN
         ('panic','medical','unsafe','other'))`,

      // NOTE: deliberately NO foreign key from abuse_signals.subject_id to users.id, matching
      // audit_log. An ON DELETE CASCADE would collide with the append-only rules below — the
      // rule rewrites the cascaded DELETE into nothing, and the parent delete then fails on a
      // constraint that believes it cleaned up. The two mechanisms cannot both be right, and
      // between "signals survive a deleted account" and "accounts can be deleted", the
      // append-only guarantee is the one worth keeping.
      `CREATE RULE abuse_signals_no_update AS ON UPDATE TO abuse_signals DO INSTEAD NOTHING`,
      `CREATE RULE abuse_signals_no_delete AS ON DELETE TO abuse_signals DO INSTEAD NOTHING`,
    ],
  },
  {
    id: 6,
    name: "password-credentials",
    statements: [
      // ── a second way in ─────────────────────────────────────────────────────────────────
      //
      // Until now `loginWithPhone` was the ONLY way a session came into existence: one factor,
      // a one-time code, and no route back in for someone who cannot receive SMS — a lost
      // phone, a number that has moved on, an operator who needs the console at 3am from a
      // laptop. This adds a password as an alternative, not a replacement: the OTP path stays
      // exactly as it was and remains the recovery route.
      //
      // NULL means "no password set", which is every existing account. That is not a
      // half-migrated state to clean up later — it is the correct steady state for anyone who
      // never wants one, and the login route treats it as "this account does not use
      // passwords" rather than as an error.
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`,
      // When it was last set. Surfaced to the account screen so a person can see that they
      // have one, and useful evidence if an account is later disputed.
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at BIGINT`,
      // Who set it. NULL for the account holder themselves; an admin id when staff issued a
      // temporary one through the override, which is the case that most needs to be visible
      // after the fact. The audit log records the act; this makes the current state legible
      // without a log search.
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_by TEXT`,
    ],
  },
  {
    id: 7,
    name: "super-admin-and-usernames",
    statements: [
      // ── a name to sign in with ──────────────────────────────────────────────────────────
      //
      // Every account so far is keyed on a phone number, because a verified number is what
      // this platform's identity rests on. Staff are the exception: a super admin
      // administers the people who administer the platform and is not a participant, so
      // there is no meaningful phone to verify and no SMS to wait on. They sign in with a
      // username.
      //
      // Nullable and UNIQUE together, which Postgres allows — every existing account keeps a
      // NULL and remains phone-only. A partial unique index rather than a plain constraint
      // so a table of NULLs does not collide with itself.
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
         ON users (lower(username)) WHERE username IS NOT NULL`,
    ],
    tolerant: [
      // The role CHECK predates `super_admin` and would refuse the row outright. Replaced
      // rather than dropped: a column that accepts any string is how "admin" ends up in a
      // database because someone typo'd a migration.
      `ALTER TABLE users DROP CONSTRAINT chk_users_role`,
      `ALTER TABLE users ADD CONSTRAINT chk_users_role CHECK (role IN
         ('requester','helper','both','admin','super_admin'))`,
      // Staff sign in by name; everyone else by number. Neither may be absent for the role
      // that depends on it.
      `ALTER TABLE users ADD CONSTRAINT chk_users_super_admin_has_username CHECK
         (role <> 'super_admin' OR username IS NOT NULL)`,
    ],
  },
  {
    id: 8,
    name: "unmatched-task-state",
    statements: [
      // ── a search that ends ──────────────────────────────────────────────────────────────
      //
      // When the outermost ring lapsed with no acceptor, the offer was closed for the helpers
      // and nothing at all happened to the task: it stayed `searching` for ever, and the
      // requester's screen kept saying "we'll keep looking" over a search that had stopped.
      // `unmatched` is the terminal state the sweep now moves it to.
      //
      // IF EXISTS because migration 1 adds this constraint tolerantly — a database that had
      // dirty rows at the time never got it, and must not fail here for lacking it.
      `ALTER TABLE tasks DROP CONSTRAINT IF EXISTS chk_tasks_state`,
      `ALTER TABLE tasks ADD CONSTRAINT chk_tasks_state CHECK (state IN
         ('searching','matched','verifying','en-route','arrived','in-progress','completed',
          'cancelled','unmatched'))`,
      // Close the searches the old behaviour orphaned. A day is far beyond the whole ladder
      // (three rings of under a minute each), so nothing live is touched. Bookings held for a
      // named helper are `searching` with a helper assigned and are deliberately left alone.
      `UPDATE tasks
          SET state = 'unmatched',
              updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
        WHERE state = 'searching'
          AND helper_id IS NULL
          AND created_at < (EXTRACT(EPOCH FROM now()) * 1000)::bigint - 86400000`,
    ],
  },
  {
    id: 9,
    name: "staff-totp-second-factor",
    statements: [
      // ── a second factor that is not a phone number ──────────────────────────────────────
      //
      // An admin's second factor was an SMS code, and a super admin had none at all: that
      // account signs in by username, has no real number to text, and so reached the staff
      // console — the account that can mint operators — on a password alone. This is where an
      // authenticator-app credential lives.
      //
      // A table of its own rather than columns on `users`, so that no query about users can
      // return it. `secret_enc` is AES-256-GCM ciphertext under a key that is not in this
      // database (TOTP_ENCRYPTION_KEY); the secret cannot be hashed, because the server has to
      // compute the same code the phone does.
      //
      // `status` is 'pending' from the moment a secret is generated until a first code proves
      // the app holds it. `last_step` is the newest 30-second step already accepted — the
      // replay floor — and is only ever moved forward by a conditional UPDATE.
      //
      // The foreign keys are inline, not `tolerant`: both tables are new, so there are no
      // existing rows that could violate them.
      `CREATE TABLE IF NOT EXISTS user_totp (
         user_id      TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
         secret_enc   TEXT NOT NULL,
         status       TEXT NOT NULL CHECK (status IN ('pending','active')),
         last_step    BIGINT,
         created_at   BIGINT NOT NULL,
         activated_at BIGINT
       )`,
      // Recovery codes, as SHA-256 digests. Shown to the holder once at activation and never
      // retrievable afterwards. `used_at` rather than a DELETE so a spent code stays on record
      // beside the audit entry that says when it was spent. Cascades from `user_totp`, so
      // disabling the credential cannot leave working codes behind.
      `CREATE TABLE IF NOT EXISTS user_totp_recovery_codes (
         user_id    TEXT NOT NULL REFERENCES user_totp (user_id) ON DELETE CASCADE,
         code_hash  TEXT NOT NULL,
         created_at BIGINT NOT NULL,
         used_at    BIGINT,
         PRIMARY KEY (user_id, code_hash)
       )`,
    ],
  },
  {
    id: 10,
    name: "revoke-pre-totp-staff-sessions",
    statements: [
      // ── end the sessions a password alone obtained ──────────────────────────────────────
      //
      // Migration 9 stops a super admin getting a session on a password alone, but it did
      // nothing about the sessions already handed out that way. A refresh rotation resets the
      // expiry each time, so such a session could outlive the change indefinitely — and while
      // it lived, its holder could enrol THEIR authenticator on the account and lock the real
      // owner out of enrolling at all.
      //
      // Every live staff session ends here, so every member of staff comes back through the
      // two-factor sign-in once. Ordinary admins are included although theirs were already
      // two-factor (password and a text message): one extra sign-in is a small price for not
      // having to reason about which rules a given session was minted under. Participants are
      // untouched — nothing about how they sign in changed.
      `UPDATE sessions
          SET revoked_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
        WHERE revoked_at IS NULL
          AND user_id IN (SELECT id FROM users WHERE role IN ('admin','super_admin'))`,
    ],
  },
  {
    id: 11,
    name: "users-session-epoch",
    statements: [
      // ── end the access tokens, not only the sessions ────────────────────────────────────
      //
      // Revoking an account's sessions stops their refresh tokens, but an access token is
      // checked by its signature alone and kept working for the rest of its lifetime. So a
      // member of staff who switched off an authenticator because the phone was stolen left
      // that phone on the console for up to fifteen minutes. Every access token now carries
      // the epoch it was minted under, and the staff guards refuse one older than this.
      //
      // Starts at 0, which is also what a token minted before this deploy is read as carrying,
      // so nobody is signed out by the deploy itself.
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    id: 12,
    name: "users-pii-field-encryption",
    statements: [
      // ── phone number and date of birth, sealed ──────────────────────────────────────────
      //
      // Both sat in the clear, so any dump of `users` was a directory of who is on the
      // platform, how to reach them, and how old they are — on a platform whose users are
      // selected for being vulnerable. They are now AES-256-GCM ciphertext under a key this
      // database does not hold (see crypto/pii.ts).
      //
      // SQL cannot do the encrypting: the key is not in the database, and must not be. So this
      // migration only makes room, and the boot step `backfillUserPii` (auth/userPii.ts) seals
      // the existing rows and empties the plaintext columns. Until it has run, readers fall back
      // to the plaintext column, so there is no window in which an account is unreadable.
      //
      //  - phone_enc   the number, sealed. Bound to the row id, so it cannot be moved.
      //  - phone_hash  a keyed HMAC of the number — the blind index every lookup matches on,
      //                and now the column that carries the uniqueness.
      //  - phone_last4 the last four digits, in the clear on purpose: it is what the admin
      //                screens show and search by, and four digits identify nobody.
      //  - date_of_birth_enc  the date, sealed. A separate column because `date_of_birth` is
      //                a DATE and cannot hold ciphertext; the eligibility matrix only ever
      //                needs it in memory, so nothing queries it in SQL.
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_enc TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_hash TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_last4 TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth_enc TEXT`,
      // A plain unique index allows any number of NULLs, which is what a row the backfill has
      // not reached yet holds.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_hash ON users (phone_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_users_phone_last4 ON users (phone_last4)`,
      // ── retiring the plaintext column ───────────────────────────────────────────────────
      //
      // `phone` was NOT NULL UNIQUE. NOT NULL has to go, or the backfill could never empty it.
      // It is replaced by a CHECK that says what NOT NULL used to mean — every account has a
      // number, in one form or the other — so a row with no phone at all is still refused.
      //
      // The UNIQUE constraint is kept: it compares only non-NULL values, so once the column is
      // empty it constrains nothing, and while a not-yet-sealed row still holds a number it
      // still stops a duplicate. Dropping it would buy nothing and lose that. The column itself
      // is left in place, empty, rather than dropped here: dropping it is the step that cannot
      // be undone, and it belongs in a later migration once every database has been backfilled.
      `ALTER TABLE users ALTER COLUMN phone DROP NOT NULL`,
      `ALTER TABLE users ADD CONSTRAINT chk_users_has_phone
         CHECK (phone IS NOT NULL OR phone_enc IS NOT NULL)`,
      // The ciphertext and its index are written together or not at all. A sealed number with
      // no index is an account no lookup can find, and the login path would create a second.
      `ALTER TABLE users ADD CONSTRAINT chk_users_phone_sealed_together
         CHECK ((phone_enc IS NULL) = (phone_hash IS NULL))`,
    ],
  },
];

/** Single-quote a string for inline SQL.
 *
 *  These are compile-time constants from SEED_SERVICES, not user input, so this is about
 *  correctness (an apostrophe in a description would break the statement) rather than
 *  injection. Migration statements cannot be parameterised — the runner executes them as
 *  plain text — so the escaping has to happen here. */
function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Arbitrary but FIXED key. Postgres advisory locks are global per-database and keyed only by
 *  this number, so it must never change and must not collide with another subsystem's lock. */
const MIGRATION_LOCK_KEY = 0x6e656564; // "need"

const LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  BIGINT NOT NULL
)`;

export interface MigrationLog {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Apply every migration not yet recorded, in id order.
 *
 * Concurrency: takes a session-level advisory lock first, so a rolling deploy in which five
 * instances boot at once results in one migrator and four waiters that then find nothing to do.
 * The lock is released in a `finally`, and even if the process is killed mid-migration Postgres
 * drops it when the connection dies — a crashed migrator cannot wedge the next boot.
 *
 * Atomicity: each migration's `statements` run in a single transaction *together with* the
 * ledger insert. A migration therefore cannot be recorded as applied unless it actually
 * committed, and cannot half-apply. (Postgres has transactional DDL, which is what makes this
 * work at all — the same pattern is unsafe on MySQL.)
 */
export async function migrate(
  pool: DbPool,
  log: MigrationLog,
  /** Overridable so tests can drive the real runner with a synthetic migration — notably a
   *  deliberately failing one, which cannot be expressed as a released migration. Production
   *  callers always take the default. */
  list: readonly Migration[] = MIGRATIONS,
): Promise<number[]> {
  const client = await pool.connect();
  const applied: number[] = [];
  try {
    // The lock comes FIRST — before even creating the ledger.
    //
    // `CREATE TABLE IF NOT EXISTS` is not atomic against a competing creator: the existence
    // check and the creation are separate steps, so two concurrent callers can both see "absent"
    // and both try to create, and the loser fails with a duplicate-key violation on
    // `pg_type_typname_nsp_index` rather than the friendlier `duplicate_table`. Creating the
    // ledger before taking the lock therefore reintroduced, in the runner's own first statement,
    // precisely the race the runner exists to eliminate. (Found by the concurrency test below,
    // not by reasoning — which is the argument for testing this against real Postgres.)
    //
    // Advisory locks need no table of their own, so there is nothing to bootstrap: the lock is
    // available on an empty database.
    //
    // Blocks until acquired. Waiting is the correct behaviour: the alternative
    // (pg_try_advisory_lock, give up) would let an instance start serving against a schema
    // that is still being changed underneath it.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await client.query(LEDGER_SQL);
      const { rows } = await client.query<{ id: number }>("SELECT id FROM schema_migrations");
      const done = new Set(rows.map((r) => Number(r.id)));

      for (const m of [...list].sort((a, b) => a.id - b.id)) {
        if (done.has(m.id)) continue;

        await client.query("BEGIN");
        try {
          for (const sql of m.statements) await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations (id, name, applied_at) VALUES ($1, $2, $3)",
            [m.id, m.name, Date.now()],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          // Rethrow: an unapplied migration means the schema is not what the code expects, and
          // serving traffic against it produces corrupt data rather than a clean failure.
          throw new Error(`migration ${m.id} (${m.name}) failed: ${(err as Error).message}`, {
            cause: err,
          });
        }

        // Tolerant statements run after the commit, each on its own, so one unvalidatable
        // constraint neither rolls back the tables nor blocks the constraints after it.
        for (const sql of m.tolerant ?? []) {
          try {
            await client.query(sql);
          } catch (err) {
            const code = (err as { code?: string }).code;
            // 42710 duplicate_object / 42P07 duplicate_table — already present, expected on
            // any database that has booted before.
            if (code === "42710" || code === "42P07") continue;
            log.warn("constraint not applied; existing data may violate it", {
              migration: m.id,
              code,
              detail: (err as Error).message,
            });
          }
        }

        applied.push(m.id);
        log.info("migration applied", { id: m.id, name: m.name });
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }

  if (applied.length === 0) log.info("schema up to date", { migrations: list.length });
  return applied;
}

/**
 * Report pending migrations without applying any. Intended for a deploy pre-check or a
 * readiness probe on a replica that must not itself migrate.
 */
export async function pendingMigrations(pool: DbPool): Promise<Migration[]> {
  // Unlocked `CREATE TABLE IF NOT EXISTS` can race a concurrent creator (see the note in
  // `migrate`). Tolerated here rather than taking the lock: this is an advisory read, and
  // blocking a readiness probe behind an in-progress migration would report the instance as
  // unhealthy for the duration of the deploy. A duplicate-object error just means someone else
  // created the ledger a millisecond earlier — in which case it exists, which is all we wanted.
  await pool.query(LEDGER_SQL).catch((err: { code?: string }) => {
    if (err.code !== "42710" && err.code !== "42P07" && err.code !== "23505") throw err;
  });
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM schema_migrations");
  const done = new Set(rows.map((r) => Number(r.id)));
  return MIGRATIONS.filter((m) => !done.has(m.id)).sort((a, b) => a.id - b.id);
}
