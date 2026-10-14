import { createHash, createHmac } from "node:crypto";
import type { AwsCredentials } from "./awsCredentials.js";

/** ── AWS Signature Version 4 ───────────────────────────────────────────────
 *  The two shapes this app needs — a header-signed request and a presigned GET — implemented
 *  with `node:crypto` rather than `@aws-sdk/client-s3` (~15 MB and a large transitive tree for
 *  a handful of S3 calls).
 *
 *  Pulled out of the S3 adapter so it can be pinned against AWS's own published examples: a
 *  signer that is wrong by one newline fails with SignatureDoesNotMatch in production and
 *  nowhere else, and this repo has no bucket to find that out against.
 */

export const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** RFC 3986 encoding as SigV4 defines it. `encodeURIComponent` leaves `!'()*` alone and
 *  `URLSearchParams` turns spaces into `+` and escapes `~` — either one produces a canonical
 *  request that differs from the one AWS computes, and so a signature that never matches. */
export function awsUriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch) || (!encodeSlash && ch === "/")) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** S3 canonical URI: every segment encoded once, slashes kept. (Other services double-encode;
 *  S3 explicitly does not.) The same string must go on the wire, or what was signed is not
 *  what was sent. */
export function s3CanonicalPath(key: string): string {
  return `/${key
    .split("/")
    .map((seg) => awsUriEncode(seg))
    .join("/")}`;
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${awsUriEncode(k)}=${awsUriEncode(query[k]!)}`)
    .join("&");
}

export function amzTimestamps(nowMs: number): { amzDate: string; dateStamp: string } {
  const amzDate = new Date(nowMs).toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), "aws4_request");
}

function signatureFor(
  canonicalRequest: string,
  amzDate: string,
  scope: string,
  credentials: AwsCredentials,
  dateStamp: string,
  region: string,
  service: string,
): string {
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256")
    .update(canonicalRequest)
    .digest("hex")}`;
  return hmac(
    signingKey(credentials.secretAccessKey, dateStamp, region, service),
    stringToSign,
  ).toString("hex");
}

export interface SignRequestInput {
  method: string;
  /** `host` header value, including a port if the endpoint has one. */
  host: string;
  /** Already-canonical path — see `s3CanonicalPath`. */
  path: string;
  query?: Record<string, string>;
  /** Every header that will be sent, other than host and the ones this function adds. All of
   *  them are signed: S3 refuses a request carrying an unsigned `x-amz-*` header. */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body, or UNSIGNED_PAYLOAD. */
  payloadHash: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  nowMs: number;
}

/**
 * Headers to add to a request so AWS accepts it: `x-amz-date`, `x-amz-content-sha256`,
 * `authorization`, and — for temporary credentials — `x-amz-security-token`.
 *
 * The session token is signed, not merely attached. Instance-role and container credentials
 * are worthless without it, and AWS rejects a token header that is not in SignedHeaders.
 */
export function signRequest(input: SignRequestInput): Record<string, string> {
  const { amzDate, dateStamp } = amzTimestamps(input.nowMs);
  const added: Record<string, string> = {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": input.payloadHash,
  };
  if (input.credentials.sessionToken) {
    added["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const all: Record<string, string> = { host: input.host };
  for (const [k, v] of Object.entries({ ...(input.headers ?? {}), ...added })) {
    all[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  }
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQuery(input.query ?? {}),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const signature = signatureFor(
    canonicalRequest,
    amzDate,
    scope,
    input.credentials,
    dateStamp,
    input.region,
    input.service,
  );

  return {
    ...added,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * A presigned GET: the query string carries the signature, so a browser can redeem it with no
 * credentials of its own, and it stops working after `expiresSeconds`.
 *
 * With temporary credentials the URL also stops working when the session token does,
 * whichever comes first — which is why the credential provider refreshes well ahead of expiry
 * rather than at it.
 */
export function presignGet(input: {
  origin: string;
  host: string;
  path: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  nowMs: number;
  expiresSeconds: number;
}): string {
  const { amzDate, dateStamp } = amzTimestamps(input.nowMs);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  if (input.credentials.sessionToken) {
    query["X-Amz-Security-Token"] = input.credentials.sessionToken;
  }
  const qs = canonicalQuery(query);
  const canonicalRequest = `GET\n${input.path}\n${qs}\nhost:${input.host}\n\nhost\n${UNSIGNED_PAYLOAD}`;
  const signature = signatureFor(
    canonicalRequest,
    amzDate,
    scope,
    input.credentials,
    dateStamp,
    input.region,
    input.service,
  );
  return `${input.origin}${input.path}?${qs}&X-Amz-Signature=${signature}`;
}
