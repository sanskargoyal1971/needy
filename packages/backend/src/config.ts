/** Centralized env config. Read once at boot so misconfiguration fails fast. */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`env ${name} is not a number: ${raw}`);
  return n;
}

export const config = {
  port: num("PORT", 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-change-me",
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
  env: process.env.NODE_ENV ?? "development",
  auth: {
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
    },
    /** Which OTP/SMS + KYC providers to use. "console"/"sandbox" are dev stand-ins. */
    smsProvider: process.env.SMS_PROVIDER ?? "console",
    kycProvider: process.env.KYC_PROVIDER ?? "sandbox",
  },
} as const;

export type Config = typeof config;
