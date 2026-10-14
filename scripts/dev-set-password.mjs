/**
 * ── Give a dev account a password ──────────────────────────────────────────
 *
 *  Manual dev tool. Passwords are opt-in and every seeded account starts without one, so there
 *  is nothing to sign in with until someone sets it — and the ordinary way to set one requires
 *  already being signed in, which is the chicken and egg this exists to break.
 *
 *  It writes through the same `hashPassword` the server uses, so the stored value is
 *  indistinguishable from one set through the app. Nothing here weakens the policy: a password
 *  that would be refused by `passwordProblem` is refused here too.
 *
 *  Usage — from the repo root:
 *
 *      node scripts/dev-set-password.mjs +919999999999 "some good passphrase"
 *      node scripts/dev-set-password.mjs --all "some good passphrase"   # every seeded account
 *
 *  The number is found the way the server finds it — by its keyed index, since the column
 *  holds only ciphertext (migration 12) — and printed masked.
 */
import pg from "pg";
import {
  DB,
  hashPassword,
  masked,
  openPhone,
  passwordProblem,
  phoneIndex,
} from "./lib/backend.mjs";

const [target, password] = process.argv.slice(2);

if (!target || !password) {
  console.error('usage: node scripts/dev-set-password.mjs <phone|--all> "<password>"');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });

const COLUMNS = `id, phone, phone_enc, display_name, role`;
const { rows: found } =
  target === "--all"
    ? await pool.query(`SELECT ${COLUMNS} FROM users ORDER BY role, id`)
    : // The plaintext arm only matches a row the server has not sealed yet.
      await pool.query(
        `SELECT ${COLUMNS} FROM users
          WHERE phone_hash = $1 OR (phone_hash IS NULL AND phone = $2)`,
        [phoneIndex(target), target.trim()],
      );
const rows = found.map((r) => ({ ...r, phone: openPhone(r) }));

if (rows.length === 0) {
  console.error(`No account with phone ${masked(target)}.`);
  await pool.end();
  process.exit(1);
}

for (const user of rows) {
  // The same check the route runs. A dev shortcut that quietly accepted a password the app
  // would refuse would be testing something the product does not actually do.
  const problem = passwordProblem(password, user.phone);
  if (problem) {
    console.log(`  ✗ ${user.display_name} (${masked(user.phone)}) — refused: ${problem}`);
    continue;
  }
  const hash = await hashPassword(password);
  await pool.query(
    `UPDATE users SET password_hash = $2, password_set_at = $3, password_set_by = NULL,
                      updated_at = $3
      WHERE id = $1`,
    [user.id, hash, Date.now()],
  );
  const note = user.role === "admin" ? " (admin — will also be asked for a code)" : "";
  console.log(`  ✓ ${user.display_name} (${masked(user.phone)})${note}`);
}

await pool.end();
