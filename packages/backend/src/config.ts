/** Centralized env config. Read once at boot so misconfiguration fails fast. */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`env ${name} is not a number: ${raw}`);
  return n;
}

/** True when running as a real deployment. Drives the fail-fast secret checks below and the
 *  mounting of dev-only routes (audit A4: `config.env` existed but was read NOWHERE, so
 *  /dev/token — which mints a token for any userId and role — shipped unconditionally). */
const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";

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
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  jwtSecret: requireSecret("JWT_SECRET", process.env.JWT_SECRET, DEV_JWT_SECRET),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  databaseUrl: process.env.DATABASE_URL ?? "",
  match: {
    radiusMeters: num("MATCH_RADIUS_METERS", 10_000),
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
    /** Short-lived access token; refresh rotates behind it. */
    accessTtlSeconds: num("AUTH_ACCESS_TTL_SECONDS", 900),
    refreshTtlDays: num("AUTH_REFRESH_TTL_DAYS", 30),
    /** Secure cookies require HTTPS; disable for local http dev via env. */
    cookieSecure: (process.env.COOKIE_SECURE ?? "false") === "true",
    /** Cross-site strategy. Strict is safest; the SPA is same-site in prod. */
    cookieSameSite: (process.env.COOKIE_SAMESITE ?? "strict") as
      | "strict"
      | "lax"
      | "none",
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
