/** Tiny structured logger. Swap for pino in production; the call sites stay identical. */
type Level = "debug" | "info" | "warn" | "error";

/** Keys whose values must never reach a log sink in the clear. OTP codes, tokens and
 *  signatures are credentials; phone numbers are personal data. Several call sites pass
 *  whole payload objects, so redaction happens here rather than trusting each one. */
const REDACT_KEYS = new Set([
  "code",
  "otp",
  "token",
  "accessToken",
  "refreshToken",
  "password",
  "secret",
  "signature",
  "authorization",
  "cookie",
  "refreshTokenHash",
]);

/** Partially mask a phone number: keep the country prefix and last two digits, which is
 *  enough to correlate a support report without logging the full identifier. */
function maskPhone(v: string): string {
  if (v.length <= 4) return "***";
  return `${v.slice(0, 3)}***${v.slice(-2)}`;
}

/**
 * `JSON.stringify` renders an `Error` as `{}` — its message and stack live on
 * non-enumerable properties. Handlers across this codebase log `{ err }` directly, so
 * before this every one of those logs recorded literally nothing about the failure.
 * Normalise Errors (including a `cause` chain) and redact credentials.
 */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause != null ? { cause: sanitize(value.cause, depth + 1) } : {}),
    };
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.has(k)) {
        out[k] = "[redacted]";
      } else if (k === "phone" && typeof v === "string") {
        out[k] = maskPhone(v);
      } else {
        out[k] = sanitize(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  const line = { level, msg, ...(meta ? (sanitize(meta) as object) : {}) };
  const out = level === "error" || level === "warn" ? console.error : console.log;
  // A circular structure would otherwise throw *inside the error path*, masking the
  // original failure — fall back to a best-effort line instead.
  try {
    out(JSON.stringify(line));
  } catch {
    out(JSON.stringify({ level, msg, meta: "[unserializable]" }));
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};

export type Logger = typeof logger;
