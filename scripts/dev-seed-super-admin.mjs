/**
 * ── Create the super admin ─────────────────────────────────────────────────
 *
 *  There is deliberately no route that creates one: `POST /admin/staff` is itself super-admin
 *  only, and a self-service "become super admin" endpoint would be the single worst thing in
 *  this codebase. The first one is therefore seeded from the machine that owns the database,
 *  which is the only place that authority can honestly come from.
 *
 *  Usage — from the repo root:
 *
 *      node scripts/dev-seed-super-admin.mjs <username> "<password>" [phone]
 *
 *  Re-running it updates the password on the existing account rather than creating a second.
 */
import pg from "pg";
import { nanoid } from "nanoid";
import { DB, hashPassword, passwordProblem, sealPhone } from "./lib/backend.mjs";

const [username, password, phone] = process.argv.slice(2);

if (!username || !password) {
  console.error('usage: node scripts/dev-seed-super-admin.mjs <username> "<password>" [phone]');
  process.exit(1);
}

// The same policy the routes enforce. A seeding shortcut that accepted a password the app
// would refuse would be seeding an account the app cannot vouch for.
const problem = passwordProblem(password);
if (problem) {
  console.error(`Refused: ${problem}. Use at least 10 characters.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const now = Date.now();
const hash = await hashPassword(password);

const { rows: existing } = await pool.query(
  `SELECT id FROM users WHERE lower(username) = lower($1)`,
  [username],
);

if (existing.length > 0) {
  await pool.query(
    `UPDATE users SET password_hash = $2, password_set_at = $3, updated_at = $3,
                      role = 'super_admin', blocked_at = NULL
      WHERE id = $1`,
    [existing[0].id, hash, now],
  );
  console.log(`Updated the existing super admin "${username}".`);
} else {
  // A phone is still required by the schema — every account has one — but it is never used
  // for this role: a super admin signs in by username and is never sent a code.
  const placeholder = phone ?? `+99${String(now).slice(-11)}`;
  // Sealed exactly as the server seals it (migration 12): the plaintext column stays NULL.
  // The id is chosen first because the ciphertext is bound to it.
  const id = nanoid();
  const sealed = sealPhone(id, placeholder);
  await pool.query(
    `INSERT INTO users (id, phone_enc, phone_hash, phone_last4, display_name, role, kyc_status,
                        created_at, updated_at, onboarding_status, username, password_hash,
                        password_set_at)
     VALUES ($1,$2,$3,$4,$5,'super_admin','verified',$6,$6,'approved',$7,$8,$6)`,
    [
      id,
      sealed.phone_enc,
      sealed.phone_hash,
      sealed.phone_last4,
      "Super Admin",
      now,
      username,
      hash,
    ],
  );
  console.log(`Created super admin "${username}".`);
}

// The password is only the first factor. This script deliberately does NOT generate the
// authenticator secret: printing one to a terminal puts the second factor in shell scrollback
// next to the first. The account enrols its own on first sign-in, before any session exists.
console.log(
  "Sign in at /login → “Staff sign-in”. The first sign-in will ask you to set up an " +
    "authenticator app; do it straight away — until then the account is one password from open.",
);
await pool.end();
