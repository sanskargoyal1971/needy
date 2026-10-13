import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { RedisClient } from "../redis.js";
import type { SmsProvider } from "./providers.js";

/** One-time-passcode flow over Redis. Codes are stored only as SHA-256 hashes; requests are
 *  rate-limited per phone AND per source IP, and verification attempts are capped per hour, to
 *  blunt brute-force and SMS bombing. The code generator is injectable so tests are
 *  deterministic. */

export interface OtpConfig {
  length: number;
  ttlSeconds: number;
  maxPerHour: number;
  maxAttempts: number;
  /** Hourly OTP-request ceiling per source IP (audit C15). Deliberately looser than the
   *  per-phone cap because carrier NAT and shared offices legitimately put many distinct
   *  numbers behind one address; the point is to bound a bomber, not to break a household.
   *  Defaults to 4× the per-phone cap when unset so existing config objects stay valid. */
  maxPerHourPerIp?: number;
}

export type RequestResult =
  | { ok: true }
  /** `scope` is for logging/metrics only — the API surfaces one undifferentiated 429 so a
   *  caller can't probe which limiter it tripped. */
  | { ok: false; reason: "rate-limited"; scope: "phone" | "ip" };
export type VerifyResult =
  { ok: true } | { ok: false; reason: "expired" | "invalid" | "too-many-attempts" };

/** Both the request cap and the attempt cap are counted over the same one-hour window, so the
 *  total number of guesses reachable per phone per hour is `maxAttempts` — full stop. */
const WINDOW_SECONDS = 3600;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const codeKey = (phone: string) => `otp:code:${phone}`;
const attemptsKey = (phone: string) => `otp:attempts:${phone}`;
const requestsKey = (phone: string) => `otp:req:${phone}`;
/** IP is hashed rather than embedded: the key space is attacker-influenced (a raw IPv6 address
 *  with a colon-heavy shape is awkward in a key) and this keeps a Redis dump from being a list
 *  of who tried to log in from where. */
const ipRequestsKey = (ip: string) => `otp:req:ip:${hash(ip).slice(0, 32)}`;

export class OtpService {
  constructor(
    private readonly redis: RedisClient,
    private readonly sms: SmsProvider,
    private readonly config: OtpConfig,
    private readonly generateCode: () => string = () =>
      randomInt(0, 10 ** config.length)
        .toString()
        .padStart(config.length, "0"),
  ) {}

  private get maxPerHourPerIp(): number {
    return this.config.maxPerHourPerIp ?? this.config.maxPerHour * 4;
  }

  /**
   * `ip` is REQUIRED (audit C15): only per-phone limiting existed, so an attacker could burn
   * SMS budget — and money — indefinitely by walking a list of phone numbers, since each new
   * number brought a fresh per-phone allowance. The caller supplies the address (see
   * auth/router.ts, which reads it from `req.ip`) rather than this service reaching for a
   * request object, so the limiter stays a pure function of its inputs and is testable.
   */
  async request(phone: string, ip: string): Promise<RequestResult> {
    // Per-IP hourly cap, charged FIRST and charged even when the phone cap also trips: a
    // bomber cycling numbers must not get free IP budget for the attempts a phone limiter
    // happened to absorb.
    const ipKey = ipRequestsKey(ip || "unknown");
    const ipReqs = await this.redis.incr(ipKey);
    if (ipReqs === 1) await this.redis.expire(ipKey, WINDOW_SECONDS);
    // Return BEFORE touching the per-phone counter. Charging the phone's budget for a request
    // we are about to refuse would let one blocked host burn every user's hourly OTP allowance
    // (the phone counter kept climbing while the caller got a 429), i.e. deny logins to
    // arbitrary victims for free — a guard must not run after the side effect it prevents.
    if (ipReqs > this.maxPerHourPerIp) return { ok: false, reason: "rate-limited", scope: "ip" };

    // Per-phone hourly request cap.
    const reqs = await this.redis.incr(requestsKey(phone));
    if (reqs === 1) await this.redis.expire(requestsKey(phone), WINDOW_SECONDS);
    if (reqs > this.config.maxPerHour) return { ok: false, reason: "rate-limited", scope: "phone" };

    const code = this.generateCode();
    await this.redis.set(codeKey(phone), hash(code), "EX", this.config.ttlSeconds);
    // Audit C15 — a `del(attemptsKey)` used to live here, which handed the attacker their
    // attempt budget back for the price of one more OTP request: 5 codes/hour × 5 attempts = 25
    // guesses against a 6-digit code instead of the 5 the cap advertises. The attempt counter is
    // now window-scoped and survives a re-request, so `maxAttempts` is a real hourly ceiling.
    // (The cost to a legitimate user who has burned their attempts is having to wait out the
    // window, which is exactly what a lockout is for.)
    await this.sms.send(
      phone,
      `Your Needy verification code is ${code}. It expires in ${Math.round(this.config.ttlSeconds / 60)} minutes.`,
    );
    return { ok: true };
  }

  async verify(phone: string, code: string): Promise<VerifyResult> {
    // Audit C15 — the attempt charge used to come AFTER an early `expired` return on a missing
    // code, so probing a phone that had no live code was free: an attacker could hammer verify
    // forever, learn from the `expired`/`invalid` split exactly when a real code existed for
    // that number, and only then start spending their (also resettable) attempt budget. The
    // charge is now unconditional and happens first, so every call costs.
    const attempts = await this.redis.incr(attemptsKey(phone));
    if (attempts === 1) await this.redis.expire(attemptsKey(phone), WINDOW_SECONDS);
    if (attempts > this.config.maxAttempts) {
      // Burn any live code, but NEVER the attempts counter — deleting it here was the other
      // half of the reset bug, since hitting the cap silently restored a full budget.
      await this.redis.del(codeKey(phone));
      return { ok: false, reason: "too-many-attempts" };
    }

    const stored = await this.redis.get(codeKey(phone));
    if (!stored) return { ok: false, reason: "expired" };

    const a = Buffer.from(hash(code));
    const b = Buffer.from(stored);
    const match = a.length === b.length && timingSafeEqual(a, b);
    if (!match) return { ok: false, reason: "invalid" };

    // Consume the code so it can't be replayed. Clearing attempts here is safe (unlike doing it
    // on request): presenting a valid code proves possession of the number, so there is no
    // attacker-reachable path that resets the budget without already having won.
    await this.redis.del(codeKey(phone), attemptsKey(phone));
    return { ok: true };
  }
}
