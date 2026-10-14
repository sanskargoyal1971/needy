import { readFile } from "node:fs/promises";
import { z } from "zod";
import { logger } from "../logger.js";

/** ── AWS credentials ───────────────────────────────────────────────────────
 *  Where the S3 adapter's signing keys come from.
 *
 *  The preferred answer is "nowhere we store them": on EC2 the instance role hands out
 *  short-lived credentials through the instance metadata service, and in ECS/EKS the container
 *  credential endpoint does the same. A long-lived access key in an env file is a secret that
 *  never rotates, is copied wherever the env file goes, and keeps working after it leaks —
 *  for a bucket of government IDs and selfies, that is the worst kind of secret to hold.
 *
 *  Static keys still work, for local MinIO and for hosts with no role, but production logs a
 *  warning every boot until they are gone.
 *
 *  Nothing in this file logs a credential, a session token or a metadata response body. The
 *  only things that reach a log line are the source name, the role name and HTTP statuses.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present for temporary credentials; must then be sent (and signed) with every request. */
  sessionToken?: string;
  /** Epoch ms. Absent for static keys, which do not expire on their own. */
  expiresAt?: number;
}

export interface CredentialProvider {
  /** For logs and diagnostics. Never the credentials themselves. */
  readonly source: string;
  get(): Promise<AwsCredentials>;
  /** Drop any cached credentials — called when AWS says the token has expired, which can
   *  happen before our own clock thinks so (clock skew, or a role session revoked early). */
  invalidate(): void;
}

export function staticCredentials(
  accessKeyId: string,
  secretAccessKey: string,
): CredentialProvider {
  const creds = { accessKeyId, secretAccessKey };
  return {
    source: "static",
    get: () => Promise.resolve(creds),
    invalidate: () => undefined,
  };
}

/** The JSON both IMDS and the container endpoint return. Validated, because a metadata
 *  response we misread would otherwise surface as an opaque SignatureDoesNotMatch. */
const temporaryCredentialsSchema = z.object({
  AccessKeyId: z.string().min(16).max(128),
  SecretAccessKey: z.string().min(1).max(256),
  Token: z.string().min(1),
  Expiration: z.string().refine((s) => Number.isFinite(Date.parse(s)), "not a timestamp"),
});

function parseTemporary(body: unknown): AwsCredentials {
  const parsed = temporaryCredentialsSchema.safeParse(body);
  // The zod error would name fields, not values — but say less anyway: this is the one place a
  // credential is in hand as untyped data.
  if (!parsed.success) throw new Error("credential response did not have the expected shape");
  return {
    accessKeyId: parsed.data.AccessKeyId,
    secretAccessKey: parsed.data.SecretAccessKey,
    sessionToken: parsed.data.Token,
    expiresAt: Date.parse(parsed.data.Expiration),
  };
}

/**
 * Cache in front of a fetch that returns expiring credentials.
 *
 *  - Refreshes `refreshMarginMs` BEFORE expiry, not at it. A presigned document link is minted
 *    with the current token and dies with it, so a token with 30 seconds left would hand a
 *    reviewer a link that stops working before the video loads. Five minutes comfortably
 *    exceeds the 120 s signed-URL TTL.
 *  - Single-flight: concurrent uploads at the moment of refresh share one metadata round trip
 *    rather than each hitting IMDS, which throttles.
 *  - If a refresh fails while the cached credentials are still inside their real lifetime,
 *    keep using them and try again shortly. A metadata hiccup should not take uploads down
 *    while perfectly valid credentials are sitting in memory.
 */
export class RefreshingCredentialProvider implements CredentialProvider {
  private cached: AwsCredentials | null = null;
  private inflight: Promise<AwsCredentials> | null = null;
  private retryNotBefore = 0;

  constructor(
    readonly source: string,
    private readonly fetchFresh: () => Promise<AwsCredentials>,
    private readonly now: () => number,
    private readonly refreshMarginMs = 5 * 60 * 1000,
    private readonly retryAfterFailureMs = 10 * 1000,
  ) {}

  private usable(c: AwsCredentials | null): c is AwsCredentials {
    return c != null && (c.expiresAt == null || this.now() < c.expiresAt);
  }

  private fresh(c: AwsCredentials | null): c is AwsCredentials {
    return c != null && (c.expiresAt == null || this.now() < c.expiresAt - this.refreshMarginMs);
  }

  get(): Promise<AwsCredentials> {
    if (this.fresh(this.cached)) return Promise.resolve(this.cached);
    // Inside the margin, a recent refresh failed: serve what we have rather than retrying on
    // every single request.
    if (this.usable(this.cached) && this.now() < this.retryNotBefore) {
      return Promise.resolve(this.cached);
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchFresh()
      .then((c) => {
        this.cached = c;
        return c;
      })
      .catch((err: unknown) => {
        this.retryNotBefore = this.now() + this.retryAfterFailureMs;
        if (this.usable(this.cached)) {
          logger.warn("aws credential refresh failed; using cached credentials until expiry", {
            source: this.source,
            err: err instanceof Error ? err.message : String(err),
          });
          return this.cached;
        }
        throw err;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = null;
    this.retryNotBefore = 0;
  }
}

const DEFAULT_IMDS = "http://169.254.169.254";
/** Six hours, the maximum. The token only ever lives for one credential fetch, but asking
 *  for less buys nothing. */
const IMDS_TOKEN_TTL_SECONDS = 21600;
/** IMDS answers in single-digit milliseconds when it answers at all. A long timeout only
 *  matters off EC2, where it turns a misconfiguration into a hung upload. */
const METADATA_TIMEOUT_MS = 2000;
const ROLE_NAME = /^[\w+=,.@-]{1,128}$/;

/**
 * EC2 instance-role credentials over IMDSv2.
 *
 * v2 only — a session token from a PUT, then GETs that present it. v1 (a bare GET) is what a
 * server-side request forgery can reach, which is why the instance is launched with
 * `HttpTokens=required` and why this never falls back to it.
 *
 * `baseUrl` is injectable so tests can stand up a fake metadata server; in production it is
 * the link-local address (or `AWS_EC2_METADATA_SERVICE_ENDPOINT`, as the AWS SDKs honour).
 */
export function imdsCredentials(opts: {
  now: () => number;
  baseUrl?: string;
  timeoutMs?: number;
  refreshMarginMs?: number;
}): RefreshingCredentialProvider {
  const base = (opts.baseUrl || DEFAULT_IMDS).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? METADATA_TIMEOUT_MS;

  const fetchFresh = async (): Promise<AwsCredentials> => {
    const tokenRes = await fetch(`${base}/latest/api/token`, {
      method: "PUT",
      headers: { "x-aws-ec2-metadata-token-ttl-seconds": String(IMDS_TOKEN_TTL_SECONDS) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // A 401/403/timeout here from inside a container usually means the hop limit is 1: the
    // PUT response is dropped one hop short of the container. See deploy-ec2.sh.
    if (!tokenRes.ok) throw new Error(`instance metadata token request failed: ${tokenRes.status}`);
    const token = (await tokenRes.text()).trim();
    const auth = { "x-aws-ec2-metadata-token": token };

    const roleRes = await fetch(`${base}/latest/meta-data/iam/security-credentials/`, {
      headers: auth,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 404 = no instance profile attached.
    if (!roleRes.ok) throw new Error(`instance has no IAM role (status ${roleRes.status})`);
    const role = (await roleRes.text()).split("\n")[0]?.trim() ?? "";
    if (!ROLE_NAME.test(role)) throw new Error("instance metadata returned an invalid role name");

    const credsRes = await fetch(
      `${base}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`,
      { headers: auth, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!credsRes.ok) throw new Error(`instance role credentials failed: ${credsRes.status}`);
    const body = (await credsRes.json()) as { Code?: string };
    if (body.Code !== undefined && body.Code !== "Success") {
      throw new Error("instance role credentials not available");
    }
    const creds = parseTemporary(body);
    logger.info("aws credentials refreshed", { source: "instance-role", role });
    return creds;
  };

  return new RefreshingCredentialProvider(
    "instance-role",
    fetchFresh,
    opts.now,
    opts.refreshMarginMs,
  );
}

/** Hosts the AWS SDKs will send a container auth token to over plain HTTP: loopback, the ECS
 *  agent, and EKS Pod Identity. Anywhere else must be HTTPS — otherwise an env var pointing at
 *  an attacker's host would have us hand it our authorization token on every refresh. */
const CONTAINER_HTTP_HOSTS = new Set(["169.254.170.2", "169.254.170.23", "[fd00:ec2::23]"]);

function containerUrlAllowed(u: URL): boolean {
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  const h = u.hostname;
  return (
    CONTAINER_HTTP_HOSTS.has(h) ||
    h === "localhost" ||
    h === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/**
 * ECS task-role / EKS Pod Identity credentials from the container credential endpoint —
 * `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` (ECS) or `_FULL_URI` (+ an authorization token,
 * read from `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` on every refresh because EKS rotates it).
 */
export function containerCredentials(opts: {
  url: string;
  now: () => number;
  authToken?: string;
  authTokenFile?: string;
  timeoutMs?: number;
}): RefreshingCredentialProvider {
  const url = new URL(opts.url);
  if (!containerUrlAllowed(url)) {
    throw new Error(
      "AWS_CONTAINER_CREDENTIALS_FULL_URI must be https, or http to loopback / the ECS or EKS agent",
    );
  }
  const timeoutMs = opts.timeoutMs ?? METADATA_TIMEOUT_MS;

  const fetchFresh = async (): Promise<AwsCredentials> => {
    const token = opts.authTokenFile
      ? (await readFile(opts.authTokenFile, "utf8")).trim()
      : opts.authToken;
    const res = await fetch(url, {
      headers: token ? { authorization: token } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`container credentials failed: ${res.status}`);
    const creds = parseTemporary(await res.json());
    logger.info("aws credentials refreshed", { source: "container" });
    return creds;
  };

  return new RefreshingCredentialProvider("container", fetchFresh, opts.now);
}

/**
 * Pick a credential source, in the order the AWS SDKs use: explicit static keys, then the
 * container endpoint, then the instance role.
 *
 * `env` is a parameter rather than a read of `process.env` so tests can choose a path without
 * mutating global state.
 */
export function createCredentialProvider(opts: {
  now: () => number;
  isProduction: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  env?: NodeJS.ProcessEnv;
}): CredentialProvider {
  const env = opts.env ?? process.env;

  if (opts.accessKeyId || opts.secretAccessKey) {
    if (!opts.accessKeyId || !opts.secretAccessKey) {
      // Half a key pair is a typo in an env file, not a request to use the instance role.
      throw new Error("set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither");
    }
    if (opts.isProduction) {
      logger.warn(
        "S3 is using static access keys. Attach an instance profile and unset S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY so credentials rotate automatically.",
      );
    }
    return staticCredentials(opts.accessKeyId, opts.secretAccessKey);
  }

  const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  const relative = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (full || relative) {
    return containerCredentials({
      url: full || `http://169.254.170.2${relative}`,
      now: opts.now,
      authToken: env.AWS_CONTAINER_AUTHORIZATION_TOKEN,
      authTokenFile: env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE,
    });
  }

  if (env.AWS_EC2_METADATA_DISABLED === "true") {
    throw new Error(
      "no S3 credentials: static keys unset, no container endpoint, and AWS_EC2_METADATA_DISABLED=true",
    );
  }
  return imdsCredentials({ now: opts.now, baseUrl: env.AWS_EC2_METADATA_SERVICE_ENDPOINT });
}
