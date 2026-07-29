import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { RedisClient } from "../redis.js";
import type { SmsProvider } from "./providers.js";

/** One-time-passcode flow over Redis. Codes are stored only as SHA-256 hashes; requests are
 *  rate-limited per phone and verification attempts are capped, to blunt brute-force and SMS
 *  bombing. The code generator is injectable so tests are deterministic. */

export interface OtpConfig {
  length: number;
  ttlSeconds: number;
  maxPerHour: number;
  maxAttempts: number;
}

export type RequestResult = { ok: true } | { ok: false; reason: "rate-limited" };
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "invalid" | "too-many-attempts" };

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const codeKey = (phone: string) => `otp:code:${phone}`;
const attemptsKey = (phone: string) => `otp:attempts:${phone}`;
const requestsKey = (phone: string) => `otp:req:${phone}`;

export class OtpService {
  constructor(
    private readonly redis: RedisClient,
    private readonly sms: SmsProvider,
    private readonly config: OtpConfig,
    private readonly generateCode: () => string = () =>
      randomInt(0, 10 ** config.length).toString().padStart(config.length, "0"),
  ) {}

  async request(phone: string): Promise<RequestResult> {
    // Per-phone hourly request cap.
    const reqs = await this.redis.incr(requestsKey(phone));
    if (reqs === 1) await this.redis.expire(requestsKey(phone), 3600);
    if (reqs > this.config.maxPerHour) return { ok: false, reason: "rate-limited" };

    const code = this.generateCode();
    await this.redis.set(codeKey(phone), hash(code), "EX", this.config.ttlSeconds);
    await this.redis.del(attemptsKey(phone));
    await this.sms.send(phone, `Your Needy verification code is ${code}. It expires in ${Math.round(this.config.ttlSeconds / 60)} minutes.`);
    return { ok: true };
  }

  async verify(phone: string, code: string): Promise<VerifyResult> {
    const stored = await this.redis.get(codeKey(phone));
    if (!stored) return { ok: false, reason: "expired" };

    const attempts = await this.redis.incr(attemptsKey(phone));
    if (attempts === 1) await this.redis.expire(attemptsKey(phone), this.config.ttlSeconds);
    if (attempts > this.config.maxAttempts) {
      await this.redis.del(codeKey(phone), attemptsKey(phone));
      return { ok: false, reason: "too-many-attempts" };
    }

    const a = Buffer.from(hash(code));
    const b = Buffer.from(stored);
    const match = a.length === b.length && timingSafeEqual(a, b);
    if (!match) return { ok: false, reason: "invalid" };

    // Consume the code so it can't be replayed.
    await this.redis.del(codeKey(phone), attemptsKey(phone));
    return { ok: true };
  }
}
