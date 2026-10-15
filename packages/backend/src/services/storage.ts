import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { createCredentialProvider, type CredentialProvider } from "./awsCredentials.js";
import { EMPTY_SHA256, presignGet, s3CanonicalPath, signRequest } from "./sigv4.js";

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
  /**
   * Store a stream under `key` without holding it in memory.
   *
   * All-or-nothing: if `body` errors — oversize, a client that hung up, a format rejected
   * after the fact — this rejects and NOTHING is left behind, neither at `key` nor as a
   * partial or temporary object anywhere else. Callers abort an upload by destroying `body`
   * with an error; they never have to clean up after the adapter.
   */
  putStream(key: string, body: Readable, contentType: string): Promise<void>;
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
    await this.putStream(key, Readable.from([bytes]), contentType);
  }

  /**
   * Stream to a temporary file beside the destination, then rename it into place.
   *
   * Beside, not in the OS temp dir: `rename` is only atomic within one filesystem, and the
   * OS temp dir is often a different mount — and a KYC video sitting in a world-listable
   * /tmp, even briefly and mode 600, is a place it should never have been. The `.part-` name
   * is never a key `newStorageKey` could mint, so a half-written file can never be served.
   *
   * Every failure path unlinks the temp file. A reader therefore sees either nothing or the
   * whole object, never a truncated video that a reviewer would judge as though it were real.
   */
  async putStream(key: string, body: Readable, contentType: string): Promise<void> {
    const abs = this.pathFor(key);
    await mkdir(dirname(abs), { recursive: true });
    const suffix = `.part-${randomBytes(8).toString("hex")}`;
    const tmp = `${abs}${suffix}`;
    const metaTmp = `${abs}.meta.json${suffix}`;
    let metaPlaced = false;
    try {
      // `wx`: never follow or clobber something already at the temp path.
      await pipeline(body, createWriteStream(tmp, { mode: 0o600, flags: "wx" }));
      // Content type is not recoverable from disk, so it rides alongside. JSON rather than an
      // xattr because xattrs do not survive a Docker volume copy on every platform. Written
      // before the data is renamed in, so a visible object always has its sidecar.
      await writeFile(metaTmp, JSON.stringify({ contentType }), { mode: 0o600, flag: "wx" });
      await rename(metaTmp, `${abs}.meta.json`);
      metaPlaced = true;
      await rename(tmp, abs);
    } catch (err) {
      body.destroy();
      await unlink(tmp).catch(() => undefined);
      await unlink(metaTmp).catch(() => undefined);
      // A sidecar with no object would be harmless to `get`, but it is still something left
      // behind by an upload that failed.
      if (metaPlaced) await unlink(`${abs}.meta.json`).catch(() => undefined);
      throw err;
    }
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

/** Part size for streamed uploads. S3's floor is 5 MiB for every part but the last; 8 MiB
 *  means a selfie (8 MiB cap) always fits in one buffer and goes up as a single PUT, and a
 *  60 MiB video is eight parts. Each upload holds exactly one buffer of this size, which is
 *  what `MAX_CONCURRENT_UPLOADS` is sized against (services/uploadSlots.ts). */
export const S3_PART_BYTES = 8 * 1024 * 1024;

/** Per S3 request, including sending the body. An 8 MiB part at even 2 Mbit/s of upstream is
 *  ~35 s, so a request still going after a minute is a hung connection, not a slow one — and
 *  without a limit it would hold its upload slot, its client socket and its part buffer for
 *  as long as the TCP connection stays half-open. */
export const S3_REQUEST_TIMEOUT_MS = 60_000;

/** S3 error codes that mean "your session token is no longer good", as opposed to "you are
 *  not allowed". S3 sends ExpiredToken as a 400; the task-level contract treats a 403 the same
 *  way, since a revoked role session can surface as either. */
const REFRESHABLE_CODES = new Set(["ExpiredToken", "TokenRefreshRequired", "RequestExpired"]);

const errorCode = (xml: string): string => /<Code>([^<]{1,64})<\/Code>/.exec(xml)?.[1] ?? "";

/**
 * Presigned GETs and streamed writes against a private bucket.
 *
 * NOT exercised against real AWS in this repo — there is no bucket or role here, and per
 * AGENTS.md a provider integration that has never run must not be presented as working. The
 * signer is pinned against AWS's published SigV4 examples, and the multipart flow, the
 * session token and the expired-token retry are exercised against a fake S3 and a fake
 * metadata server in the tests. That is evidence the requests are well-formed, not that a
 * real bucket accepts them.
 *
 * Streaming: a multipart form gives no Content-Length for the file inside it, and S3 refuses
 * a PUT without one (no chunked transfer encoding; aws-chunked signing still needs the decoded
 * length up front). So rather than a single UNSIGNED-PAYLOAD PUT, the body is cut into
 * `S3_PART_BYTES` buffers: one that ends inside the first buffer goes up as an ordinary PUT,
 * anything longer as a multipart upload. Each part is in hand when it is sent, which buys two
 * things a pass-through stream cannot: the payload hash is real (S3 verifies every byte it
 * stores against what we signed), and a part can be retried after a token refresh.
 *
 * Before relying on this in a real deployment: create the bucket with public access blocked,
 * default SSE-KMS encryption, a lifecycle rule that expires KYC objects on the schedule your
 * retention policy requires, and an AbortIncompleteMultipartUpload rule (1 day) for the
 * uploads a crashed process never got to abort.
 */
export class S3Storage implements StorageProvider {
  private readonly origin: string;
  private readonly hostHeader: string;

  constructor(
    private readonly opts: {
      bucket: string;
      region: string;
      credentials: CredentialProvider;
      /** Bucket host, or a full origin (`http://127.0.0.1:9000`) for tests and S3-compatible
       *  stores. Empty = the bucket's virtual-hosted AWS endpoint over HTTPS. */
      endpoint?: string;
      /** Injectable so a test can exercise the timeout without waiting a minute. */
      requestTimeoutMs?: number;
    },
    private readonly now: () => number,
  ) {
    const raw = opts.endpoint || `${opts.bucket}.s3.${opts.region}.amazonaws.com`;
    const url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
    this.origin = url.origin;
    this.hostHeader = url.host;
  }

  /**
   * One signed request, retried once if S3 says the session token has expired.
   *
   * The retry is why `body` is a Buffer here and never a stream: a stream that has been
   * consumed by the first attempt cannot be sent again.
   *
   * The Buffer goes to `fetch` wrapped in a one-chunk ReadableStream with an explicit
   * Content-Length, never as the body itself. Handed a Buffer or Uint8Array directly, Node's
   * fetch copies it while converting it to a request body — measured on Node 25 at three
   * extra copies, so an 8 MiB part cost 32 MiB in flight. A stream is passed through without
   * copying, and the explicit length keeps it a plain Content-Length request rather than
   * chunked transfer encoding, which S3 refuses. The memory test in s3Storage.test.ts pins
   * this.
   */
  private async send(
    method: string,
    key: string,
    opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: Buffer } = {},
  ): Promise<Response> {
    const path = s3CanonicalPath(key);
    const qs = new URLSearchParams(opts.query ?? {}).toString();
    const url = `${this.origin}${path}${qs ? `?${qs}` : ""}`;
    const payloadHash = opts.body
      ? createHash("sha256").update(opts.body).digest("hex")
      : EMPTY_SHA256;

    for (let attempt = 0; ; attempt++) {
      const credentials = await this.opts.credentials.get();
      const auth = signRequest({
        method,
        host: this.hostHeader,
        path,
        query: opts.query,
        headers: opts.headers,
        payloadHash,
        region: this.opts.region,
        service: "s3",
        credentials,
        nowMs: this.now(),
      });
      const body = opts.body;
      const res = await fetch(url, {
        method,
        headers: {
          ...(opts.headers ?? {}),
          ...auth,
          ...(body ? { "content-length": String(body.length) } : {}),
        },
        body: body
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(body);
                controller.close();
              },
            })
          : undefined,
        // Required by fetch for a stream body; the request is still sent in full before S3
        // answers.
        ...(body ? { duplex: "half" as const } : {}),
        // Covers the response body too, which the callers read straight after.
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? S3_REQUEST_TIMEOUT_MS),
      });
      if ((res.status === 400 || res.status === 403) && attempt === 0) {
        const text = await res
          .clone()
          .text()
          .catch(() => "");
        if (REFRESHABLE_CODES.has(errorCode(text))) {
          logger.warn("s3 rejected the session token; refreshing credentials", {
            source: this.opts.credentials.source,
          });
          this.opts.credentials.invalidate();
          continue;
        }
      }
      return res;
    }
  }

  /** Fail with S3's error code and status only. The body echoes the key and request ids;
   *  none of it helps a reader of the log more than the code does. */
  private async ensureOk(res: Response, what: string): Promise<string> {
    const text = await res.text().catch(() => "");
    // CompleteMultipartUpload can answer 200 with an <Error> body — the one S3 call where a
    // success status is not a success.
    if (!res.ok || /<Error>/.test(text)) {
      throw new Error(`s3 ${what} failed: ${res.status} ${errorCode(text)}`.trim());
    }
    return text;
  }

  private baseHeaders(contentType: string): Record<string, string> {
    return {
      "content-type": contentType,
      // Objects are encrypted at rest by the bucket's default policy; this header makes the
      // requirement explicit so a bucket misconfigured without a default still encrypts.
      "x-amz-server-side-encryption": "AES256",
    };
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const res = await this.send("PUT", key, {
      headers: this.baseHeaders(contentType),
      body: bytes,
    });
    await this.ensureOk(res, "put");
  }

  async putStream(key: string, body: Readable, contentType: string): Promise<void> {
    // One part-sized buffer per upload, filled in place and reused for every part. Collecting
    // the socket's chunks and concatenating them would hold the part twice (the chunks and
    // the copy) at the moment it is sent; this holds it once. Allocated on the first chunk,
    // so a refused or empty upload never takes one.
    let part: Buffer | null = null;
    let filled = 0;
    let uploadId: string | null = null;
    const parts: { n: number; etag: string }[] = [];

    const sendPart = async (): Promise<void> => {
      if (uploadId == null) {
        const created = await this.send("POST", key, {
          query: { uploads: "" },
          headers: this.baseHeaders(contentType),
        });
        const xml = await this.ensureOk(created, "create multipart upload");
        uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1] ?? null;
        if (!uploadId) throw new Error("s3 create multipart upload returned no UploadId");
      }
      const n = parts.length + 1;
      // A view, not a copy. Reusing `part` afterwards is safe because `send` only resolves
      // once S3 has answered, and S3 answers a part only after receiving all of it; a part
      // that fails is never followed by another, since the whole upload is then aborted.
      const res = await this.send("PUT", key, {
        query: { partNumber: String(n), uploadId },
        body: part!.subarray(0, filled),
      });
      await this.ensureOk(res, "upload part");
      const etag = res.headers.get("etag");
      if (!etag) throw new Error("s3 upload part returned no ETag");
      parts.push({ n, etag });
      filled = 0;
    };

    try {
      // Async iteration pulls one chunk at a time, so backpressure reaches the client socket:
      // while a part is in flight to S3 nothing more is read from the upload.
      for await (const chunk of body as AsyncIterable<Buffer>) {
        part ??= Buffer.alloc(S3_PART_BYTES);
        for (let off = 0; off < chunk.length;) {
          // Flush a full buffer only once more bytes arrive, so a body of exactly one part
          // still goes up as a single PUT. Every part but the last is exactly S3_PART_BYTES.
          if (filled === S3_PART_BYTES) await sendPart();
          const n = chunk.copy(part, filled, off);
          filled += n;
          off += n;
        }
      }

      if (uploadId == null) {
        // Fitted in one buffer: an ordinary PUT, one round trip instead of three.
        await this.put(key, (part ?? Buffer.alloc(0)).subarray(0, filled), contentType);
        return;
      }
      if (filled > 0) await sendPart();
      const xml = `<CompleteMultipartUpload>${parts
        .map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag}</ETag></Part>`)
        .join("")}</CompleteMultipartUpload>`;
      const done = await this.send("POST", key, {
        query: { uploadId },
        headers: { "content-type": "application/xml" },
        body: Buffer.from(xml, "utf8"),
      });
      await this.ensureOk(done, "complete multipart upload");
    } catch (err) {
      body.destroy();
      // Abort discards every part already stored. Without it they sit in the bucket — billed,
      // invisible to a listing, and holding pieces of a document the user never finished
      // submitting.
      const id: string | null = uploadId;
      if (id != null) {
        await this.send("DELETE", key, { query: { uploadId: id } })
          .then((r) => this.ensureOk(r, "abort multipart upload"))
          .catch((abortErr: unknown) => {
            logger.error("could not abort s3 multipart upload; the bucket lifecycle rule will", {
              err: abortErr instanceof Error ? abortErr.message : String(abortErr),
            });
          });
      }
      throw err;
    }
  }

  /**
   * Fetch credentials once, now, and fail with the likely cause if that is impossible.
   *
   * Called at boot. With static keys a missing value was a startup error; with the instance
   * role nothing is fetched until the first upload, so a host with no instance profile — or
   * with the IMDS hop limit left at 1 — would otherwise boot, pass its health check, and
   * answer every KYC upload and every reviewer's document link with a 500.
   */
  async checkCredentials(): Promise<void> {
    try {
      await this.opts.credentials.get();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const hint =
        this.opts.credentials.source === "instance-role"
          ? " On EC2 this usually means no instance profile is attached, or the IMDS hop limit is 1 so the token response never reaches the container (see deploy-ec2.sh)."
          : "";
      throw new Error(
        `refusing to start: no S3 credentials from ${this.opts.credentials.source} (${why}).${hint}`,
      );
    }
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return presignGet({
      origin: this.origin,
      host: this.hostHeader,
      path: s3CanonicalPath(key),
      region: this.opts.region,
      service: "s3",
      credentials: await this.opts.credentials.get(),
      nowMs: this.now(),
      expiresSeconds: ttlSeconds,
    });
  }

  async get(): Promise<{ bytes: Buffer; contentType: string } | null> {
    // Not needed: S3 signed URLs are redeemed by the browser directly against the bucket, so
    // nothing ever reads an object back through the application.
    return null;
  }

  async remove(key: string): Promise<void> {
    await this.send("DELETE", key);
  }
}

/** Pick the adapter from config. Local unless S3 is explicitly configured, and — because a
 *  production deployment silently writing KYC video to a container's ephemeral filesystem is
 *  a data-loss and a compliance problem at once — production refuses to start on local disk. */
export function createStorageProvider(now: () => number): StorageProvider {
  const s = config.storage;
  if (s.driver === "s3") {
    if (!s.bucket) throw new Error("STORAGE_DRIVER=s3 requires S3_BUCKET");
    // AGENTS.md: TLS in transit. A plain-http endpoint is for a local MinIO, never production.
    if (config.isProduction && /^http:\/\//i.test(s.endpoint)) {
      throw new Error("refusing to start: S3_ENDPOINT must be https in production");
    }
    return new S3Storage(
      {
        bucket: s.bucket,
        region: s.region,
        // Static keys if both are set; otherwise the container endpoint or the instance role.
        credentials: createCredentialProvider({
          now,
          isProduction: config.isProduction,
          accessKeyId: s.accessKeyId,
          secretAccessKey: s.secretAccessKey,
        }),
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
  // `resolve`, not `join`: join glues an absolute STORAGE_LOCAL_ROOT onto the CWD ("/uploads"
  // became "/repo/uploads", unwritable in the image), where resolve honours it.
  return new LocalDiskStorage(resolve(process.cwd(), s.localRoot), s.publicBase, now);
}
