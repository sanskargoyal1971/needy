import { createInMemoryAbuseRepo, type AbuseRepository } from "../domain/abuseStore.js";
import { createLoggingAuditLogger, type AuditLogger } from "../audit/log.js";

/** ── The bookkeeping half of `Deps`, for tests ─────────────────────────────
 *  Every suite that registers a namespace builds its own `Deps` literal out of the repos that
 *  suite actually exercises. That is the right shape — a chat test should not have to know
 *  what an exception repository is — but it means each new field on `Deps` breaks all fifteen
 *  of them at once, and the natural fix (paste two more lines into fifteen files) leaves the
 *  same trap armed for the next field.
 *
 *  `audit` and `abuse` are the two that no suite has an opinion about: they are write-only
 *  from the code under test, and no assertion in any existing suite depends on where their
 *  rows land. So they get one spread and one place to change.
 *
 *  A suite that DOES want to assert on them (the SOS console tests do) builds its own
 *  in-memory pair and overrides — the spread is a default, not a lock.
 */
export function safetyDeps(): { audit: AuditLogger; abuse: AbuseRepository } {
  return {
    audit: createLoggingAuditLogger(),
    abuse: createInMemoryAbuseRepo(),
  };
}
