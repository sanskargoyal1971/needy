import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** ── Password hashing ──────────────────────────────────────────────────────
 *  scrypt from `node:crypto`, not a dependency.
 *
 *  That is the same call this codebase has made twice before — the handoff code is hashed with
 *  built-in SHA-256, and the Twilio client speaks the REST API by hand rather than pulling the
 *  SDK. argon2id is the stronger primitive and would be the choice in a greenfield service, but
 *  it is a native addon: a compiler on every build host, a rebuild on every Node upgrade, and a
 *  supply-chain edge on the one module that guards every account. scrypt is memory-hard, is in
 *  the standard library, and is explicitly sanctioned for password storage; the difference
 *  between it and argon2id at these parameters is not what will decide whether this platform is
 *  broken into.
 *
 *  IMPORTANT: nothing here ever touches the `User` type. The hash lives in its own column,
 *  reached by its own repository methods, and is never a field on the object that flows to a
 *  client. Today's lesson from `handoffOtpHash` — which rode a shared type all the way out to
 *  the browser — is that a secret on a widely-serialised object leaks eventually, no matter
 *  what the sanitiser at the boundary is supposed to do.
 */

/**
 * Cost parameters. N is the work factor and dominates: 2^16 costs roughly 100 ms and ~64 MB per
 * hash on a modern server, which is a meaningful wall for an offline attacker and invisible to
 * someone logging in.
 *
 * `maxmem` must be raised alongside N — Node's default ceiling is 32 MB and scrypt throws
 * rather than silently degrading, which is the right failure but an easy one to hit.
 */
const PARAMS = { N: 1 << 16, r: 8, p: 1, maxmem: 192 * 1024 * 1024 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** Stored as a self-describing string so the parameters travel WITH the hash. Raising N later
 *  must not invalidate every existing password: an old hash still verifies against the cost it
 *  was written with, and can be re-hashed on the next successful login. */
const FORMAT = "scrypt";

export const PASSWORD_MIN_LENGTH = 10;
/** Bounded because scrypt hashes whatever it is given: an unbounded field is a CPU-exhaustion
 *  primitive that costs an attacker one request. */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * The handful of passwords that are tried first in every credential-stuffing run.
 *
 * Deliberately short. A long deny-list or a complexity rule ("one capital, one symbol") mostly
 * teaches people to write `Password1!` and to reuse it — and this platform's users skew
 * elderly, for whom a fiddly rule is a genuine barrier to getting in at all. Length is the
 * property that actually resists guessing, so the minimum is 10 and the rest of the advice is
 * "use a few words you'll remember".
 */
const TOO_COMMON = new Set([
  "password",
  "password1",
  "password123",
  "123456789",
  "1234567890",
  "qwertyuiop",
  "iloveyou",
  "letmein123",
  "welcome123",
  "admin12345",
]);

export type PasswordProblem = "too-short" | "too-long" | "too-common" | "contains-phone";

/**
 * Why a password is unacceptable, or null if it is fine.
 *
 * `contains-phone` is here because the phone number is this platform's username: a password
 * built from it is one an attacker already holds most of.
 */
export function passwordProblem(password: string, phone?: string): PasswordProblem | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "too-short";
  if (password.length > PASSWORD_MAX_LENGTH) return "too-long";
  if (TOO_COMMON.has(password.toLowerCase())) return "too-common";
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    // The last eight are the part a person actually knows by heart and would reach for.
    const tail = digits.slice(-8);
    if (tail.length >= 6 && password.replace(/\D/g, "").includes(tail)) return "contains-phone";
  }
  return null;
}

/** Hash a password for storage. Returns `scrypt$N$r$p$salt$key`, all base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, PARAMS);
  return [
    FORMAT,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

/**
 * Check a password against a stored hash.
 *
 * Never throws on a malformed or absent hash — it returns false. A parse error here would
 * otherwise become a 500 on the login route, which tells an attacker that this account is
 * different from the others.
 *
 * `password.normalize("NFKC")` on both sides matters more than it looks: the same accented
 * character can be typed as one code point or two, and a person whose keyboard changes between
 * setting a password and using it would otherwise be locked out by a difference they cannot
 * see.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== FORMAT) return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  // A hash claiming an absurd cost would be a memory-exhaustion vector if we honoured it.
  if (N > PARAMS.N || r > 32 || p > 16) return false;

  try {
    const salt = Buffer.from(parts[4], "base64url");
    const expected = Buffer.from(parts[5], "base64url");
    const actual = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: PARAMS.maxmem,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * A dummy verification, for the case where the account does not exist or has no password.
 *
 * Without it, a wrong password on a real account costs ~100 ms of scrypt while an unknown phone
 * number returns immediately — and that difference is a reliable oracle for enumerating which
 * numbers hold accounts on a platform whose users are chosen for being vulnerable. This burns
 * the same work so both answers take the same time.
 */
export async function burnVerification(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH);
}

/** A fixed hash of a value nothing can match, generated once at module load. */
const DUMMY_HASH = await hashPassword(randomBytes(32).toString("hex"));
