/** Centralized env config. Read once at boot so misconfiguration fails fast. */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`env ${name} is not a number: ${raw}`);
  return n;
}

/** A comma-separated list of numbers, e.g. `MATCH_RADIUS_WAVES_METERS=1000,5000,10000`.
 *  Validated strictly and sorted ascending: an unsorted or non-numeric list would produce a
 *  search that narrows instead of widening, which is the kind of misconfiguration that looks
 *  like it works until nobody within 1 km is ever reached. */
function numList(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const nums = parts.map((p) => {
    const n = Number(p);
    if (Number.isNaN(n) || n <= 0) throw new Error(`env ${name} has a non-positive entry: ${p}`);
    return n;
  });
  if (nums.length === 0) throw new Error(`env ${name} is empty`);
  return [...nums].sort((a, b) => a - b);
}

/** E.164: a plus, a non-zero country digit, and at most 15 digits in all. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * The on-call ladder for unacknowledged SOS alarms: tiers separated by commas, the phones
 * within a tier by `|`, first tier first — `+9198…|+9197…,+9196…` pages two people, then one.
 *
 * Strict for the same reason `numList` is: a malformed number here does not fail anywhere
 * visible, it simply never rings, and that is discovered during the one emergency in which
 * the tier was needed. So a bad entry is a boot failure in every environment, not only
 * production. Empty is allowed HERE — whether an empty ladder may boot is an environment
 * decision, made in `assertSosEscalationReachable` with the logger to hand.
 *
 * Exported for its own tests; nothing else should parse this variable.
 */
export function parseOncallTiers(name: string, raw: string | undefined): string[][] {
  if (raw == null || raw.trim() === "") return [];
  return raw.split(",").map((tier, i) => {
    const phones = tier
      .split("|")
      .map((p) => p.trim())
      .filter(Boolean);
    if (phones.length === 0) throw new Error(`env ${name}: tier ${i + 1} is empty`);
    for (const p of phones) {
      // The number itself is deliberately NOT echoed: this message lands in boot logs.
      if (!E164.test(p)) throw new Error(`env ${name}: tier ${i + 1} has a non-E.164 number`);
    }
    return phones;
  });
}

/** A zero or negative wait would page on-call the instant an alarm is raised, before any
 *  operator at the console could possibly have answered it — refused rather than honoured. */
function positiveNum(name: string, fallback: number): number {
  const n = num(name, fallback);
  if (n <= 0) throw new Error(`env ${name} must be positive: ${n}`);
  return n;
}

/** Comma-separated seconds, in the order given — NOT sorted, unlike `numList`: these are
 *  successive waits, and reordering them would change the ladder's shape. */
function secondsList(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return raw.split(",").map((s) => {
    const n = Number(s.trim());
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`env ${name} has a non-positive entry: ${s}`);
    return n;
  });
}

/** The web app's public origin, for links that leave the system (an on-call SMS). Defaults to
 *  the first CORS origin, which is the same front end in every deployment so far. */
function webOrigin(): string {
  const raw =
    process.env.PUBLIC_WEB_ORIGIN ||
    (process.env.CORS_ORIGIN ?? "").split(",")[0]?.trim() ||
    "http://localhost:3000";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`env PUBLIC_WEB_ORIGIN is not a URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`env PUBLIC_WEB_ORIGIN must be http(s): ${raw}`);
  }
  return url.origin;
}

/** True when running as a real deployment. Drives the fail-fast secret checks below and the
 *  mounting of dev-only routes (audit A4: `config.env` existed but was read NOWHERE, so
 *  /dev/token — which mints a token for any userId and role — shipped unconditionally). */
/**
 * An UNSET `NODE_ENV` is production.
 *
 * It used to default to "development", which is the dangerous direction: development mounts
 * `/dev/token` (a token for any user id and role) and makes one fixed code open every account.
 * A deploy that simply forgot the variable therefore came up wide open and looked healthy.
 * Development is now something you say out loud — the `dev` script and `.env.example` both
 * do — and forgetting it produces a process that refuses to start for want of real secrets,
 * which is the failure you can see.
 */
const nodeEnv = process.env.NODE_ENV || "production";
const isProduction = nodeEnv !== "development" && nodeEnv !== "test";

const DEV_JWT_SECRET = "dev-only-change-me";

/** Refuse to boot a production process with a placeholder or weak signing key. A default
 *  JWT secret means anyone who has read the repo can mint a valid token for any account, so
 *  this is a hard failure at startup rather than a warning nobody reads. */
function requireSecret(name: string, value: string | undefined, devFallback: string): string {
  if (value == null || value === "") {
    if (isProduction) {
      throw new Error(
        `env ${name} is required in production (refusing to start with the development default)`,
      );
    }
    return devFallback;
  }
  if (isProduction && value === devFallback) {
    throw new Error(`env ${name} must not be the development default in production`);
  }
  if (isProduction && value.length < 32) {
    throw new Error(`env ${name} must be at least 32 characters in production`);
  }
  return value;
}

/**
 * Keys being rotated out of the personal-data envelope: a comma-separated list, accepted for
 * decryption only. Held to the same production rule as the current key, because a weak
 * "previous" key decrypts exactly as much as a weak current one — every row not yet re-sealed.
 */
function previousSecrets(name: string, raw: string | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (isProduction && list.some((s) => s.length < 32)) {
    throw new Error(`env ${name}: every key must be at least 32 characters in production`);
  }
  return list;
}

/** A secret that may be absent — the feature it unlocks is then off — but that, when present in
 *  production, must be as strong as the required ones. */
function optionalSecret(name: string, value: string | undefined): string {
  const v = value ?? "";
  if (v !== "" && isProduction && v.length < 32) {
    throw new Error(`env ${name} must be at least 32 characters in production`);
  }
  return v;
}

const piiEncryptionKey = requireSecret(
  "PII_ENCRYPTION_KEY",
  process.env.PII_ENCRYPTION_KEY,
  "dev-only-pii-encryption-key",
);
const piiIndexKey = requireSecret(
  "PII_INDEX_KEY",
  process.env.PII_INDEX_KEY,
  "dev-only-pii-index-key",
);
// One string doing both jobs would undo the reason they are separate: the encryption key is
// meant to be rotatable and the index key is not, and a leak of one should not be both.
if (isProduction && piiEncryptionKey === piiIndexKey) {
  throw new Error("env PII_INDEX_KEY must differ from PII_ENCRYPTION_KEY");
}

export const config = {
  port: num("PORT", 4000),
  /**
   * Browser origins allowed to call this API — a LIST, and the single source of truth for
   * both the CORS layer and the CSRF origin check.
   *
   * Two things were wrong here and CSRF turned the second into a hard failure:
   *
   *  - The default was `http://localhost:5173`, the port of the Vite app that was
   *    consolidated into Next months ago. `.env.example` has said 3000 since that move, so
   *    anyone running from the example was fine and anyone running without a `.env` — which
   *    the in-memory dev path explicitly supports — silently had every cross-origin read
   *    refused. Survivable while it only affected CORS; with the CSRF origin check in front
   *    of every mutation it becomes "nothing works and the error says bad-origin".
   *  - It was a bare string passed straight to `cors({ origin })`, which treats a
   *    comma-separated value as ONE literal origin that can never match. So a deployment with
   *    two front ends (an apex and a www, say) would have looked configured and matched
   *    neither. Parsing to an array here means `cors` gets the array form it understands and
   *    the CSRF check reads the same list, so the two cannot drift.
   */
  corsOrigins: (process.env.CORS_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  /** Signs access tokens — and, for now, one thing more. Phone blocks written before migration
   *  12 are keyed by an HMAC under this secret (auth/phoneBlocks.ts `legacyPhoneHmac`), and a
   *  block whose number has no account could not be re-keyed, because nothing holds that
   *  number to re-key it from. Rotating JWT_SECRET silently lifts every such block: a refused
   *  number can sign up again. Do not rotate it while the boot log reports unmatched phone
   *  blocks (`phone blocks not matched to any account`); `JWT_SECRET_PREVIOUS` does not help,
   *  it is only consulted for token verification. */
  jwtSecret: requireSecret("JWT_SECRET", process.env.JWT_SECRET, DEV_JWT_SECRET),
  /** The key being rotated OUT. Accepted for verification only, never used to sign; set it to
   *  the old `JWT_SECRET` while deploying a new one, and remove it an access-token lifetime
   *  later. Empty means no rotation is in progress. */
  jwtSecretPrevious: process.env.JWT_SECRET_PREVIOUS ?? "",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  /** The RUNTIME role: every query the server makes while serving traffic. In production it
   *  must be a different role from the one below, and boot refuses one that owns, or may
   *  UPDATE/DELETE/TRUNCATE, the append-only tables (see dbRoles.ts). */
  databaseUrl: process.env.DATABASE_URL ?? "",
  /**
   * The schema OWNER: used only for migrations and the boot-time backfills, then closed before
   * the server listens. Unset means one role does both, which is how development runs and is
   * refused in production — an owner can drop the rules that make audit_log append-only, so
   * the role that writes the log must not be one.
   */
  databaseMigrationUrl: process.env.DATABASE_MIGRATION_URL ?? "",
  /** The runtime role's name, for the owner's grants. Defaults to the user in DATABASE_URL;
   *  set it only if that URL carries no user (a pgpass file, say). */
  databaseRuntimeRole: process.env.DATABASE_RUNTIME_ROLE ?? "",
  match: {
    /**
     * The hard ceiling, not the search radius.
     *
     * A search does not go straight to 10 km — it walks the waves below. This value is the
     * cap `accept` re-checks: a helper further away than this may not take the task even if
     * they somehow received an offer. It must equal the last wave.
     */
    radiusMeters: num("MATCH_RADIUS_METERS", 10_000),
    /**
     * Escalating search rings, in metres, nearest first.
     *
     * Offering to everyone within 10 km immediately would be simpler and worse: the nearest
     * helper is the one who arrives soonest, and a 9 km helper accepting a task a 600 m
     * helper would also have taken is a worse outcome for the requester and a longer trip
     * for the helper. Each ring gets its own offer window; if nobody accepts, the next ring
     * is offered. Progress is stored in Redis so a restart mid-search still escalates.
     */
    radiusWavesMeters: numList("MATCH_RADIUS_WAVES_METERS", [1_000, 5_000, 10_000]),
    offerWindowMs: num("MATCH_OFFER_WINDOW_MS", 50_000),
  },
  directions: {
    /** `google` (Routes API) or empty for the straight-line fallback. */
    provider: process.env.DIRECTIONS_PROVIDER ?? "",
    apiKey: process.env.DIRECTIONS_API_KEY ?? "",
    /** Routes API travel mode. Two-wheeler is how most helpers cross a neighbourhood here;
     *  `WALK` and `DRIVE` are the other sensible values. */
    travelMode: process.env.DIRECTIONS_TRAVEL_MODE ?? "TWO_WHEELER",
  },
  /**
   * Web push (VAPID). All three or none: with any missing, push is simply off and every alert
   * still goes out over the open socket as before. The private key is a secret — Secrets
   * Manager / SSM in a deployed stack, the git-ignored `.env` locally.
   */
  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? "",
    privateKey: process.env.VAPID_PRIVATE_KEY ?? "",
    subject: process.env.VAPID_SUBJECT ?? "",
  },
  /**
   * Private object storage for KYC documents (gov ID, selfie, video testimony).
   *
   * `local` is a development adapter writing to a gitignored directory. `createStorageProvider`
   * refuses to start a production process on it — KYC video on a container filesystem is lost
   * on restart and unencrypted at rest, and both of those are worth failing loudly over rather
   * than discovering during an incident.
   */
  storage: {
    driver: (process.env.STORAGE_DRIVER ?? "local") as "local" | "s3",
    /** Relative to the process CWD. Must stay outside any statically-served path. */
    localRoot: process.env.STORAGE_LOCAL_ROOT ?? "private-uploads",
    /** Origin the local adapter builds signed URLs against — this server's own public URL. */
    publicBase: process.env.PUBLIC_BASE_URL ?? `http://localhost:${num("PORT", 4000)}`,
    bucket: process.env.S3_BUCKET ?? "",
    region: process.env.S3_REGION ?? "ap-south-1",
    /** Static keys: optional, and best left unset. When both are empty the S3 adapter uses
     *  the container credential endpoint or the EC2 instance role — see
     *  services/awsCredentials.ts. Production logs a warning while these are set. */
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    /** Override for S3-compatible stores (MinIO, R2): a bucket host, or a full origin such as
     *  `http://127.0.0.1:9000`. Plain http is refused in production. Empty = real AWS. */
    endpoint: process.env.S3_ENDPOINT ?? "",
    /** How long an admin's document view link stays valid. Deliberately short: the link is
     *  minted on demand when a reviewer opens a packet, so it never needs to outlive that. */
    signedUrlTtlSeconds: num("STORAGE_SIGNED_URL_TTL_SECONDS", 120),
  },
  /**
   * Express `trust proxy` setting, off by default.
   *
   * This governs whether `req.ip` comes from `X-Forwarded-For`, which the per-IP OTP limiter
   * depends on. Both defaults are wrong in one deployment and right in the other, so it has to
   * be explicit:
   *   - unset behind a load balancer → every request appears to come from the proxy, and the
   *     per-IP OTP budget becomes one bucket shared by all users;
   *   - set when NOT behind a proxy → any client can spoof `X-Forwarded-For` and mint itself a
   *     fresh IP per request, which defeats the limiter completely.
   * The insecure-by-default direction is the second one, hence off unless declared. Accepts
   * Express's own syntax: "1" (one hop), a CIDR, or a comma-separated list.
   */
  trustProxy: process.env.TRUST_PROXY ?? "",
  /**
   * Field-level encryption of personal data in `users` (see crypto/pii.ts).
   *
   * `encryptionKey` seals every new value. To rotate it: move the old value into
   * `PII_ENCRYPTION_KEYS_PREVIOUS`, set a new one, and restart — rows sealed under the old key
   * still open, and each is re-sealed under the new one the next time it is written. Remove the
   * old key only once nothing is sealed under it.
   *
   * `indexKey` is NOT rotatable by changing it. It computes the digest every phone lookup
   * matches on, so a new value makes every existing number unfindable and sign-in would create
   * a second account for each of them. Keep both wherever the database backups' keys are
   * kept: a backup restored without them restores nobody's phone number.
   */
  pii: {
    encryptionKey: piiEncryptionKey,
    encryptionKeysPrevious: previousSecrets(
      "PII_ENCRYPTION_KEYS_PREVIOUS",
      process.env.PII_ENCRYPTION_KEYS_PREVIOUS,
    ),
    indexKey: piiIndexKey,
  },
  /**
   * Escalation of SOS alarms nobody acknowledged (socket/sosEscalationSweep.ts).
   *
   * An alarm on the console reaches only whoever happens to be looking at the console. These
   * say who is woken up when nobody is, and how fast.
   */
  sos: {
    /** How long an alarm may sit `raised` before the first on-call tier is paged. A minute:
     *  long enough for an operator at the console to get to it, short enough that a person in
     *  danger is not waiting on an empty room. */
    escalateAfterSeconds: positiveNum("SOS_ESCALATE_AFTER_SECONDS", 60),
    /** The wait after each page before the next one, in order; the last entry repeats. With
     *  the default, tier 2 is paged two minutes after tier 1, and so on up the ladder. */
    escalationStepsSeconds: secondsList("SOS_ESCALATION_STEPS", [120]),
    /** Ordered tiers of on-call numbers. Production refuses to boot with none — see
     *  `assertSosEscalationReachable`. These are staff numbers and are never logged unmasked. */
    oncallTiers: parseOncallTiers("SOS_ONCALL_PHONES", process.env.SOS_ONCALL_PHONES),
    /** How late a page may be and still go out. Measured from when the page fell DUE, not from
     *  the raise, so it never cuts a running ladder short however long the steps are; it only
     *  bites when the sweep was not running (an outage) or the alert predates escalation.
     *  Either way a burst of pages about hour-old alarms teaches on-call staff to ignore the
     *  pager, so those alerts are logged loudly instead. An hour, so a sweep that was down for
     *  a deploy or a short incident still pages about what was raised meanwhile. */
    maxLatenessSeconds: positiveNum("SOS_ESCALATION_MAX_LATENESS_SECONDS", 3600),
    /** Where the page's link points. Origin only; the path is fixed by the sweep. Production
     *  requires https on a non-loopback host — checked in `assertSosEscalationReachable`. */
    consoleOrigin: webOrigin(),
  },
  /**
   * GET /metrics (metrics/router.ts).
   *
   * `token` is the bearer the Prometheus scraper presents. Empty means the endpoint is not
   * mounted at all; that is the default, so a deploy that forgot it exposes nothing rather than
   * an open endpoint. Held to the production secret rule when set: a short token in front of
   * live alarm counts is a token someone can guess.
   *
   * `backupStatusFile` is where the backup sidecar records its last successful upload
   * (deploy/backup/backup.sh). Empty means backups are not reported from this process.
   */
  metrics: {
    token: optionalSecret("METRICS_TOKEN", process.env.METRICS_TOKEN),
    backupStatusFile: process.env.BACKUP_STATUS_FILE ?? "",
  },
  env: nodeEnv,
  isProduction,
  /** Dev-only affordances (POST /dev/token, fixture seeding) mount ONLY when true. */
  allowDevRoutes: nodeEnv === "development" || nodeEnv === "test",
  /**
   * POST /dev/token specifically: signs an access token for ANY user id with no proof. Off
   * with `DISABLE_DEV_TOKEN=1` while the rest of the sandbox stays on — a hosted demo needs
   * the sandbox providers and fixtures, but must not depend on a proxy rule alone to keep a
   * sign-in-as-anyone route off the internet.
   */
  devTokenRoute:
    (nodeEnv === "development" || nodeEnv === "test") && process.env.DISABLE_DEV_TOKEN !== "1",
  auth: {
    /** HMAC secret the KYC provider signs its callbacks with (audit A5: the callback had no
     *  signature verification at all, so anyone could self-verify). Required in production. */
    kycCallbackSecret: requireSecret(
      "KYC_CALLBACK_SECRET",
      process.env.KYC_CALLBACK_SECRET,
      "dev-only-kyc-callback-secret",
    ),
    /**
     * The key the authenticator-app secrets are encrypted under at rest.
     *
     * Required in production for the same reason the JWT secret is: with the development
     * default, anyone who has read this repository can decrypt every staff member's second
     * factor out of a database dump, which is the one thing encrypting them was for.
     *
     * NOT rotatable by simply changing it. Every stored secret is sealed under this value, so
     * a new key makes every enrolled authenticator stop verifying — staff would have to be
     * re-enrolled. Treat it as a long-lived secret and keep a copy wherever the database
     * backups' keys are kept; a backup restored without it restores no second factors.
     */
    totpEncryptionKey: requireSecret(
      "TOTP_ENCRYPTION_KEY",
      process.env.TOTP_ENCRYPTION_KEY,
      "dev-only-totp-encryption-key",
    ),
    /** Short-lived access token; refresh rotates behind it. */
    accessTtlSeconds: num("AUTH_ACCESS_TTL_SECONDS", 900),
    refreshTtlDays: num("AUTH_REFRESH_TTL_DAYS", 30),
    /** Secure cookies require HTTPS; disable for local http dev via env. */
    cookieSecure: (process.env.COOKIE_SECURE ?? "false") === "true",
    /** Cross-site strategy. Strict is safest; the SPA is same-site in prod. */
    cookieSameSite: (process.env.COOKIE_SAMESITE ?? "strict") as "strict" | "lax" | "none",
    otp: {
      length: num("OTP_LENGTH", 6),
      ttlSeconds: num("OTP_TTL_SECONDS", 300),
      maxPerHour: num("OTP_MAX_PER_HOUR", 5),
      maxAttempts: num("OTP_MAX_ATTEMPTS", 5),
      /** Per-source-IP request cap (audit C15: only per-phone existed, so one host could walk
       *  a list of numbers unthrottled). Deliberately a multiple of the per-phone cap rather
       *  than equal to it: carrier NAT, offices and shared wifi legitimately put many distinct
       *  users behind one address, and this must not lock out a household. */
      maxPerHourPerIp: num("OTP_MAX_PER_HOUR_PER_IP", num("OTP_MAX_PER_HOUR", 5) * 4),
    },
    /**
     * A fixed one-time code, for development only.
     *
     * There is no SMS provider wired up yet — delivery is the console stub — so every sign-in
     * currently means reading a random code out of the backend log. This makes it a known
     * constant instead.
     *
     * It is exactly as dangerous as it sounds: with a fixed code, knowing someone's phone
     * number IS their account. That is why it is not merely discouraged in production but
     * refused — `createOtpService` throws at boot rather than starting a server where every
     * account on the platform shares one passcode. Remove `DEV_FIXED_OTP` from the environment
     * the moment a real SMS provider is configured.
     */
    devFixedOtp: process.env.DEV_FIXED_OTP ?? (isProduction ? "" : "123456"),
    /** Which OTP/SMS + KYC providers to use. "console"/"sandbox" are dev stand-ins. */
    smsProvider: process.env.SMS_PROVIDER ?? "console",
    kycProvider: process.env.KYC_PROVIDER ?? "sandbox",
    /** Twilio credentials, read only when SMS_PROVIDER=twilio. Not routed through
     *  `requireSecret` because they are legitimately absent whenever another provider is
     *  selected; `createSmsProvider` validates them at boot for the case that needs them. */
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
      authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
      /** An E.164 sender number, or a Messaging Service SID (starts with "MG"). */
      from: process.env.TWILIO_FROM ?? "",
    },
  },
} as const;

export type Config = typeof config;
