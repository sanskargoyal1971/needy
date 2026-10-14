import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { config } from "../config.js";

/** ── Field-level encryption for personal data ──────────────────────────────
 *  AGENTS.md: "All PII encrypted at rest (AES-256)". Disk or volume encryption does not answer
 *  that on its own: it protects a stolen drive, not a `pg_dump`, a leaked backup, a read
 *  replica handed to an analyst, or a SQL injection that reads `users`. Those all see the
 *  rows as the database sees them. The phone number and the date of birth are therefore sealed
 *  before they reach a query, under keys the database does not hold.
 *
 *  Two primitives, deliberately with separate keys:
 *
 *   - **An envelope** (AES-256-GCM) for values the app must read back. Each ciphertext names
 *     the key it was sealed under, so keys can rotate: decrypt with any key still configured,
 *     always encrypt with the current one.
 *   - **A blind index** (HMAC-SHA256) for values the app must look up by equality — "which
 *     account has this number". GCM ciphertexts are randomised and cannot be compared, so the
 *     lookup needs a deterministic digest beside them. An HMAC under a server-held key rather
 *     than a bare hash because a country's mobile numbers are under 10^10 candidates, which a
 *     laptop enumerates against a plain SHA-256 in minutes.
 *
 *  The index key is NOT rotatable by changing it: every stored digest was computed under it,
 *  and a new key makes every lookup miss (sign-in would create a second account for every
 *  existing number). It is kept separate from the encryption keys so that the encryption keys
 *  CAN rotate without touching it, and so a leak of one is not a leak of both.
 */

/** Format tag. A future change of cipher or layout gets `v2`, and `v1` rows stay readable. */
const FORMAT = "v1";

/** The only nonce and tag lengths `v1` is ever written with. Fixed by the format, and checked
 *  on the way in: see `decrypt`. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface PiiKeyConfig {
  /** Seals every new value. */
  currentKey: string;
  /** Still accepted for decryption only, while rows sealed under them are re-encrypted. */
  previousKeys: readonly string[];
  /** The blind-index key. Long-lived; see the module note. */
  indexKey: string;
}

export interface PiiCipher {
  /** Seal `plaintext`. `context` is bound in as associated data (see `encrypt` below). */
  encrypt(plaintext: string, context: string): string;
  /** Open a value from `encrypt`. Throws on anything that does not authenticate. */
  decrypt(stored: string, context: string): string;
  /** The key id a stored value was sealed under, or null if it is not an envelope at all. */
  keyIdOf(stored: string): string | null;
  /** The key id new values are sealed under. */
  readonly currentKeyId: string;
  /** Deterministic, keyed digest for equality lookup. `purpose` separates one field's index
   *  from another's, so a phone digest can never be matched against some other field's. */
  blindIndex(purpose: string, value: string): string;
}

interface DerivedKey {
  id: string;
  key: Buffer;
}

/**
 * The env value is any long random string; the AES key is derived from it with HKDF so the
 * operator does not have to produce exactly 32 bytes of base64, and so this purpose has its own
 * key even if the same string were ever (wrongly) reused for another secret.
 *
 * The key id is a separate HKDF output, not a hash of the AES key: it is stored beside every
 * ciphertext, and an identifier derived independently says nothing about the key itself. Eight
 * hex characters is plenty to tell a handful of configured keys apart.
 */
function deriveKey(secret: string): DerivedKey {
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "needy/pii-aes/v1", 32));
  const id = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "needy/pii-kid/v1", 4));
  return { id: id.toString("hex"), key };
}

export class PiiDecryptError extends Error {
  constructor(reason: string) {
    // Never the value, never the context: the context names a user id and the message of an
    // error tends to end up in a log line.
    super(`personal data could not be decrypted: ${reason}`);
    this.name = "PiiDecryptError";
  }
}

export function createPiiCipher(cfg: PiiKeyConfig): PiiCipher {
  const current = deriveKey(cfg.currentKey);
  const byId = new Map<string, Buffer>([[current.id, current.key]]);
  for (const prev of cfg.previousKeys) {
    const d = deriveKey(prev);
    if (!byId.has(d.id)) byId.set(d.id, d.key);
  }
  const indexKey = Buffer.from(
    hkdfSync("sha256", cfg.indexKey, Buffer.alloc(0), "needy/pii-index/v1", 32),
  );

  return {
    currentKeyId: current.id,

    /**
     * A fresh 96-bit nonce per value, and `context` as associated data.
     *
     * The associated data is what stops a ciphertext being moved. Without it, anyone able to
     * write to `users` could copy their own `phone_enc` onto someone else's row and have that
     * account's one-time codes texted to their phone. Bound to the row id and the column, a
     * ciphertext lifted to another row — or to another column of the same row — fails to
     * authenticate instead of decrypting to something plausible.
     */
    encrypt(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", current.key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(context, "utf8"));
      const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [
        FORMAT,
        current.id,
        iv.toString("base64url"),
        sealed.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
      ].join(".");
    },

    /**
     * Throws rather than returning null, unlike the TOTP secret's decrypt. A second factor
     * that fails to open is "that code is not right"; a phone number that fails to open is an
     * account the app cannot text, look up or show, and quietly treating it as absent would
     * let the login path create a duplicate account for the same number. Failing loudly is
     * the only safe answer to a missing key or a tampered row.
     *
     * The tag length is pinned, twice. GCM lets the verifier accept a truncated tag, and Node
     * does by default — a 4-byte tag passes `setAuthTag` with only a deprecation warning. The
     * stored value carries its own tag, so without the pin whoever writes the row chooses how
     * many bits of integrity it gets: a forged or moved `phone_enc` (the threat the associated
     * data exists for) would need ~2^32 guesses rather than 2^128, and short tags leak the GCM
     * authentication key besides. So anything that is not exactly a 12-byte nonce and a
     * 16-byte tag is refused before it reaches the cipher, and the decipher is told the length
     * as well, so the guarantee does not rest on the length check alone.
     */
    decrypt(stored, context) {
      const parts = stored.split(".");
      if (parts.length !== 5 || parts[0] !== FORMAT) throw new PiiDecryptError("unknown format");
      const iv = Buffer.from(parts[2], "base64url");
      const tag = Buffer.from(parts[4], "base64url");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new PiiDecryptError("unknown format");
      }
      const key = byId.get(parts[1]);
      if (!key) throw new PiiDecryptError(`no configured key has id ${parts[1]}`);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(Buffer.from(parts[3], "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new PiiDecryptError("authentication failed");
      }
    },

    keyIdOf(stored) {
      const parts = stored.split(".");
      return parts.length === 5 && parts[0] === FORMAT ? parts[1] : null;
    },

    blindIndex(purpose, value) {
      return createHmac("sha256", indexKey).update(`${purpose}\u0000${value}`).digest("hex");
    },
  };
}

/** The process-wide cipher, built from config once at import. Repositories take a cipher as an
 *  optional argument so tests can exercise rotation with keys of their own. */
export const pii: PiiCipher = createPiiCipher({
  currentKey: config.pii.encryptionKey,
  previousKeys: config.pii.encryptionKeysPrevious,
  indexKey: config.pii.indexKey,
});

/**
 * The lookup digest for a phone number — the one function every place that keys on a number
 * goes through: the users table's `phone_hash`, the phone blocklist, and the Redis keys of the
 * OTP and second-factor flows. One function so they cannot drift into normalising differently,
 * which would show up as a blocked number that is somehow not blocked.
 *
 * Normalised by trimming only, which is exactly what `phoneSchema` does before any of these
 * see the value. In particular `+91…` and `91…` stay different numbers, as they always were.
 */
export function phoneIndex(phone: string, cipher: PiiCipher = pii): string {
  return cipher.blindIndex("phone", phone.trim());
}
