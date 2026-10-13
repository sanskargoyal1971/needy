import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { config } from "../config.js";

/** ── Private object storage ────────────────────────────────────────────────
 *  Government ID scans, live selfies and video testimony are the most sensitive bytes this
 *  app touches. AGENTS.md: "KYC docs/selfies: private S3 only, signed time-limited URLs,
 *  never a public bucket."
 *
 *  One interface, two adapters, chosen by config — the same seam style as `auth/providers.ts`
 *  so swapping to a real bucket is a config change and nothing else in the app knows which
 *  implementation is live.
 */
export interface StorageProvider {
  /** Store bytes under an opaque key. Overwrites: a user retaking a blurry selfie replaces
   *  the old one rather than accumulating versions a reviewer has to choose between. */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** A URL that grants read access for `ttlSeconds` and then stops working. */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  /** Read back — used by the local adapter's redemption route. */
  get(key: string): Promise<{ bytes: Buffer; contentType: string } | null>;
  remove(key: string): Promise<void>;
}

/** Keys are server-generated and random. A key derived from the user's id or filename would
 *  be guessable, and the local adapter's redemption route would then be one enumeration away
 *  from serving other people's documents to anyone holding a valid signature format. */
export function newStorageKey(userId: string, kind: string, extension: string): string {
  const rand = randomBytes(16).toString("hex");
  const safeExt = extension.replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return `kyc/${userId}/${kind}-${rand}${safeExt ? `.${safeExt}` : ""}`;
}

// ── signature helpers (shared by the local adapter and its redemption route) ─────────────

const SIG_DOMAIN = "needy:storage-url:v1";

function sign(key: string, expiresAt: number): string {
  return createHmac("sha256", `${SIG_DOMAIN}:${config.jwtSecret}`)
    .update(`${key}\n${expiresAt}`)
    .digest("hex");
}

/**
 * Verify a local-adapter signature.
 *
 * Constant-time compare, because a byte-by-byte `===` on an HMAC is a timing oracle that lets
 * an attacker recover a valid signature one character at a time.
 */
export function verifyLocalSignature(
  key: string,
  expiresAt: number,
  sig: string,
  now: number,
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
  const expected = Buffer.from(sign(key, expiresAt), "utf8");
  const given = Buffer.from(sig, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ── local disk adapter (development) ─────────────────────────────────────────────────────

/**
 * Writes to a gitignored directory outside any static-serving path, and issues signed URLs
 * that point at the backend's own redemption route rather than at a file the web server would
 * hand out unauthenticated.
 *
 * This is a development adapter. It is not a bucket: no replication, no lifecycle rules, no
 * server-side encryption at rest. Production sets STORAGE_DRIVER=s3.
 */
export class LocalDiskStorage implements StorageProvider {
  constructor(
    private readonly root: string,
    private readonly publicBase: string,
    private readonly now: () => number,
  ) {}

  /**
   * Resolve a key to an absolute path, refusing anything that escapes the root.
   *
   * Keys are server-generated today, so `../../etc/passwd` cannot currently arrive here. The
   * check exists anyway because the redemption route takes a key from the query string: the
   * signature proves the key was minted by us, but this function must not *depend* on that
   * being true forever. Path traversal is the failure that turns a document store into an
   * arbitrary file read.
   */
  private pathFor(key: string): string {
    const rootAbs = resolve(this.root);
    const abs = resolve(rootAbs, normalize(key));
    if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
      throw new Error("storage key escapes root");
    }
    return abs;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const abs = this.pathFor(key);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, bytes, { mode: 0o600 });
    // Content type is not recoverable from disk, so it rides alongside. JSON rather than an
    // xattr because xattrs do not survive a Docker volume copy on every platform.
    await writeFile(`${abs}.meta.json`, JSON.stringify({ contentType }), { mode: 0o600 });
  }

  async get(key: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    const abs = this.pathFor(key);
    try {
      const bytes = await readFile(abs);
      let contentType = "application/octet-stream";
      try {
        contentType =
          (JSON.parse(await readFile(`${abs}.meta.json`, "utf8")) as { contentType?: string })
            .contentType ?? contentType;
      } catch {
        // Missing sidecar: fall back to the generic type rather than failing the read.
      }
      return { bytes, contentType };
    } catch {
      return null;
    }
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    const expiresAt = this.now() + ttlSeconds * 1000;
    const sig = sign(key, expiresAt);
    const q = new URLSearchParams({ key, expires: String(expiresAt), sig });
    return `${this.publicBase}/admin/documents/raw?${q.toString()}`;
  }

  async remove(key: string): Promise<void> {
    const abs = this.pathFor(key);
    await unlink(abs).catch(() => undefined);
    await unlink(`${abs}.meta.json`).catch(() => undefined);
  }
}

// ── S3 adapter (production) ──────────────────────────────────────────────────────────────

/**
 * Presigned GETs against a private bucket.
 *
 * NOT exercised in this repo — there are no AWS credentials here, and per AGENTS.md a
 * provider integration that has never run must not be presented as working. The request
 * signing below is SigV4 as documented, implemented with `node:crypto` rather than pulling in
 * `@aws-sdk/client-s3` (~15 MB and a large transitive tree) for one presigned URL and one PUT.
 *
 * Before relying on this in a real deployment: create the bucket with public access blocked,
 * default SSE-KMS encryption, and a lifecycle rule that expires KYC objects on the schedule
 * your retention policy requires.
 */
export class S3Storage implements StorageProvider {
  constructor(
    private readonly opts: {
      bucket: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      endpoint?: string;
    },
    private readonly now: () => number,
  ) {}

  private host(): string {
    return this.opts.endpoint ?? `${this.opts.bucket}.s3.${this.opts.region}.amazonaws.com`;
  }

  private hmac(key: Buffer | string, data: string): Buffer {
    return createHmac("sha256", key).update(data, "utf8").digest();
  }

  private signingKey(dateStamp: string): Buffer {
    const kDate = this.hmac(`AWS4${this.opts.secretAccessKey}`, dateStamp);
    const kRegion = this.hmac(kDate, this.opts.region);
    const kService = this.hmac(kRegion, "s3");
    return this.hmac(kService, "aws4_request");
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const url = `https://${this.host()}/${encodeURI(key)}`;
    const res = await fetch(url, {
      method: "PUT",
      body: new Uint8Array(bytes),
      headers: {
        "content-type": contentType,
        // Objects are encrypted at rest by the bucket's default policy; this header makes the
        // requirement explicit so a bucket misconfigured without a default still encrypts.
        "x-amz-server-side-encryption": "AES256",
        ...(await this.authHeaders("PUT", key, bytes)),
      },
    });
    if (!res.ok) {
      throw new Error(`s3 put failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  }

  private async authHeaders(
    method: string,
    key: string,
    body: Buffer,
  ): Promise<Record<string, string>> {
    const { createHash } = await import("node:crypto");
    const amzDate = new Date(this.now()).toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash("sha256").update(body).digest("hex");
    const canonicalHeaders = `host:${this.host()}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = `${method}\n/${encodeURI(key)}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${dateStamp}/${this.opts.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256")
      .update(canonicalRequest)
      .digest("hex")}`;
    const signature = this.hmac(this.signingKey(dateStamp), stringToSign).toString("hex");
    return {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    const { createHash } = await import("node:crypto");
    const amzDate = new Date(this.now()).toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.opts.region}/s3/aws4_request`;
    const params = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.opts.accessKeyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(ttlSeconds),
      "X-Amz-SignedHeaders": "host",
    });
    const canonicalRequest = `GET\n/${encodeURI(key)}\n${params.toString()}\nhost:${this.host()}\n\nhost\nUNSIGNED-PAYLOAD`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256")
      .update(canonicalRequest)
      .digest("hex")}`;
    const signature = this.hmac(this.signingKey(dateStamp), stringToSign).toString("hex");
    params.set("X-Amz-Signature", signature);
    return `https://${this.host()}/${encodeURI(key)}?${params.toString()}`;
  }

  async get(): Promise<{ bytes: Buffer; contentType: string } | null> {
    // Not needed: S3 signed URLs are redeemed by the browser directly against the bucket, so
    // nothing ever reads an object back through the application.
    return null;
  }

  async remove(key: string): Promise<void> {
    const url = `https://${this.host()}/${encodeURI(key)}`;
    await fetch(url, {
      method: "DELETE",
      headers: await this.authHeaders("DELETE", key, Buffer.alloc(0)),
    });
  }
}

/** Pick the adapter from config. Local unless S3 is explicitly configured, and — because a
 *  production deployment silently writing KYC video to a container's ephemeral filesystem is
 *  a data-loss and a compliance problem at once — production refuses to start on local disk. */
export function createStorageProvider(now: () => number): StorageProvider {
  const s = config.storage;
  if (s.driver === "s3") {
    if (!s.bucket || !s.accessKeyId || !s.secretAccessKey) {
      throw new Error(
        "STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY",
      );
    }
    return new S3Storage(
      {
        bucket: s.bucket,
        region: s.region,
        accessKeyId: s.accessKeyId,
        secretAccessKey: s.secretAccessKey,
        endpoint: s.endpoint || undefined,
      },
      now,
    );
  }
  if (config.isProduction) {
    throw new Error(
      "refusing to start: STORAGE_DRIVER=local in production would write KYC documents to the container filesystem, where they are lost on restart and unencrypted at rest. Set STORAGE_DRIVER=s3.",
    );
  }
  return new LocalDiskStorage(join(process.cwd(), s.localRoot), s.publicBase, now);
}
