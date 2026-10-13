import { MANDATORY_SERVICE_CODES, SEED_SERVICES, type ServiceDefinition } from "@needy/shared";
import type { DbPool } from "../db.js";

/** ── Service catalog & helper enrolment ────────────────────────────────────
 *  Which services exist, and which helper offers which.
 *
 *  The one invariant worth stating up front: mandatory services are enforced on WRITE, not
 *  on read. `setHelperServices` unions in `MANDATORY_SERVICE_CODES` on every save, so opting
 *  out of hospital accompaniment is not expressible through the API at all — there is no
 *  request shape that removes it. Filtering it back in at read time would leave the database
 *  holding a state ("this helper does not do hospital runs") that the product says cannot
 *  exist, and something downstream would eventually trust it.
 */

export interface ServiceCatalog {
  list(): Promise<ServiceDefinition[]>;
  get(code: string): Promise<ServiceDefinition | null>;
  /** Codes this helper offers, mandatory ones always included. */
  forHelper(helperId: string): Promise<string[]>;
  /** Replace a helper's optional selections. Mandatory codes are added regardless. */
  setHelperServices(helperId: string, codes: readonly string[], now: number): Promise<string[]>;
  /** Does this helper offer this service? The matching hot path. */
  helperOffers(helperId: string, code: string): Promise<boolean>;
}

interface ServiceRow {
  code: string;
  name: string;
  description: string;
  is_mandatory: boolean;
  is_immediate: boolean;
  base_price: number | string;
}

const rowToService = (r: ServiceRow): ServiceDefinition => ({
  code: r.code,
  name: r.name,
  description: r.description,
  isMandatory: r.is_mandatory,
  isImmediate: r.is_immediate,
  basePrice: Number(r.base_price),
});

/** Union the caller's choices with the mandatory set, drop anything not in the catalog, and
 *  de-duplicate. Shared by both implementations so they cannot disagree about what "the
 *  helper's services" means. */
function normalise(codes: readonly string[], known: ReadonlySet<string>): string[] {
  return [...new Set([...codes, ...MANDATORY_SERVICE_CODES])].filter((c) => known.has(c));
}

export function createPgServiceCatalog(pool: DbPool): ServiceCatalog {
  return {
    async list() {
      const { rows } = await pool.query<ServiceRow>(
        `SELECT * FROM services WHERE active ORDER BY is_mandatory DESC, name ASC`,
      );
      return rows.map(rowToService);
    },
    async get(code) {
      const { rows } = await pool.query<ServiceRow>(
        `SELECT * FROM services WHERE code = $1 AND active`,
        [code],
      );
      return rows[0] ? rowToService(rows[0]) : null;
    },
    async forHelper(helperId) {
      const { rows } = await pool.query<{ service_code: string }>(
        `SELECT service_code FROM helper_services WHERE helper_id = $1`,
        [helperId],
      );
      return rows.map((r) => r.service_code);
    },
    async setHelperServices(helperId, codes, now) {
      const { rows: known } = await pool.query<{ code: string }>(
        `SELECT code FROM services WHERE active`,
      );
      const wanted = normalise(codes, new Set(known.map((k) => k.code)));

      // One transaction: a helper must never be observed mid-save with their old selections
      // deleted and the new ones not yet written — matching reads this table continuously,
      // and that window would drop them out of every pool.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `DELETE FROM helper_services WHERE helper_id = $1 AND service_code <> ALL($2::text[])`,
          [helperId, wanted],
        );
        if (wanted.length > 0) {
          await client.query(
            `INSERT INTO helper_services (helper_id, service_code, created_at)
             SELECT $1, code, $3 FROM unnest($2::text[]) AS code
             ON CONFLICT DO NOTHING`,
            [helperId, wanted, now],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      return wanted;
    },
    async helperOffers(helperId, code) {
      const { rows } = await pool.query<{ one: number }>(
        `SELECT 1 AS one FROM helper_services WHERE helper_id = $1 AND service_code = $2`,
        [helperId, code],
      );
      return rows.length > 0;
    },
  };
}

/** In-memory catalog for tests and the no-database dev boot. Seeded from the same constant
 *  the migration seeds from, so the two cannot describe different services. */
export function createInMemoryServiceCatalog(): ServiceCatalog {
  const services = new Map(SEED_SERVICES.map((s) => [s.code, s]));
  const enrolment = new Map<string, Set<string>>();
  return {
    async list() {
      return [...services.values()].sort(
        (a, b) => Number(b.isMandatory) - Number(a.isMandatory) || a.name.localeCompare(b.name),
      );
    },
    async get(code) {
      return services.get(code) ?? null;
    },
    async forHelper(helperId) {
      return [...(enrolment.get(helperId) ?? [])];
    },
    async setHelperServices(helperId, codes, _now) {
      const wanted = normalise(codes, new Set(services.keys()));
      enrolment.set(helperId, new Set(wanted));
      return wanted;
    },
    async helperOffers(helperId, code) {
      return enrolment.get(helperId)?.has(code) ?? false;
    },
  };
}
