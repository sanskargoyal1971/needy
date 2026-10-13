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
  jwtSecret: requireSecret("JWT_SECRET", process.env.JWT_SECRET, DEV_JWT_SECRET),
  /** The key being rotated OUT. Accepted for verification only, never used to sign; set it to
   *  the old `JWT_SECRET` while deploying a new one, and remove it an access-token lifetime
   *  later. Empty means no rotation is in progress. */
  jwtSecretPrevious: process.env.JWT_SECRET_PREVIOUS ?? "",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  databaseUrl: process.env.DATABASE_URL ?? "",
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
    provider: process.env.DIRECTIONS_PROVIDER ?? "",
    apiKey: process.env.DIRECTIONS_API_KEY ?? "",
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
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    /** Override for S3-compatible stores (MinIO, R2). Empty = real AWS. */
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
  env: nodeEnv,
  isProduction,
  /** Dev-only affordances (POST /dev/token, fixture seeding) mount ONLY when true. */
  allowDevRoutes: nodeEnv === "development" || nodeEnv === "test",
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
