import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** ── Fake AWS endpoints for tests ──────────────────────────────────────────
 *  Real HTTP servers on loopback, so the code under test goes through `fetch` exactly as it
 *  would against IMDS or S3. They implement only what the app calls, and they are NOT a
 *  statement that real AWS behaves identically — see the S3 adapter's header comment.
 */

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((r) => server.close(() => r()));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** IMDSv2: a token from PUT /latest/api/token, required on every metadata GET. Each credential
 *  fetch issues a fresh numbered key and token so tests can tell refreshes apart. */
export async function fakeImds(opts: { role?: string; lifetimeMs: number; now: () => number }) {
  const state = {
    issued: 0,
    tokenRequests: 0,
    /** GETs that arrived without a valid IMDSv2 token — must stay 0. */
    unauthenticated: 0,
    fail: false,
  };
  const role = opts.role ?? "needy-app-role";
  const tokens = new Set<string>();

  const server = createServer((req, res) => {
    void (async () => {
      await readBody(req);
      if (state.fail) {
        res.writeHead(500).end();
        return;
      }
      if (req.method === "PUT" && req.url === "/latest/api/token") {
        if (!req.headers["x-aws-ec2-metadata-token-ttl-seconds"]) {
          res.writeHead(400).end();
          return;
        }
        state.tokenRequests += 1;
        const t = `imds-token-${state.tokenRequests}`;
        tokens.add(t);
        res.writeHead(200).end(t);
        return;
      }
      if (!tokens.has(String(req.headers["x-aws-ec2-metadata-token"] ?? ""))) {
        state.unauthenticated += 1;
        res.writeHead(401).end();
        return;
      }
      if (req.url === "/latest/meta-data/iam/security-credentials/") {
        res.writeHead(200).end(`${role}\n`);
        return;
      }
      if (req.url === `/latest/meta-data/iam/security-credentials/${role}`) {
        state.issued += 1;
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            Code: "Success",
            Type: "AWS-HMAC",
            AccessKeyId: `ASIAFAKEROLEKEY${String(state.issued).padStart(5, "0")}`,
            SecretAccessKey: `fake-secret-${state.issued}`,
            Token: `fake-session-token-${state.issued}`,
            Expiration: new Date(opts.now() + opts.lifetimeMs).toISOString(),
          }),
        );
        return;
      }
      res.writeHead(404).end();
    })();
  });
  return { server, baseUrl: await listen(server), state };
}

export interface FakeS3Request {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  bodyBytes: number;
  bodySha256: string;
}

/**
 * Just enough S3 for the adapter: PUT, multipart create/part/complete/abort, DELETE. It does
 * not verify signatures itself; tests inspect `requests` (and recompute signatures) instead.
 *
 * `discardBodies` hashes bodies as they arrive and keeps none of them, so a test measuring
 * the process's buffer memory sees the adapter's allocations and not the fake's.
 */
export async function fakeS3(opts: { discardBodies?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  const requests: FakeS3Request[] = [];
  const state = {
    /** Session tokens S3 will answer `ExpiredToken` to. */
    expiredTokens: new Set<string>(),
    /** Bytes received across all request bodies, as they arrive. */
    received: 0,
    /** Called once a request's whole body has arrived, before it is answered. */
    onBody: null as (() => void) | null,
    /** Requests this returns true for are read in full and then never answered. */
    hang: null as ((method: string, query: URLSearchParams) => boolean) | null,
  };
  let nextId = 0;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const chunks: Buffer[] = [];
      const hash = createHash("sha256");
      let bodyBytes = 0;
      for await (const c of req) {
        if (!opts.discardBodies) chunks.push(c as Buffer);
        hash.update(c as Buffer);
        bodyBytes += (c as Buffer).length;
        state.received += (c as Buffer).length;
      }
      const body = Buffer.concat(chunks);
      const key = decodeURIComponent(url.pathname.slice(1));
      requests.push({
        method: req.method ?? "",
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        bodyBytes,
        bodySha256: hash.digest("hex"),
      });
      state.onBody?.();
      if (state.hang?.(req.method ?? "", url.searchParams)) return;

      const token = req.headers["x-amz-security-token"];
      if (typeof token === "string" && state.expiredTokens.has(token)) {
        res
          .writeHead(400)
          .end("<Error><Code>ExpiredToken</Code><Message>expired</Message></Error>");
        return;
      }

      const q = url.searchParams;
      if (req.method === "POST" && q.has("uploads")) {
        const id = `up-${++nextId}`;
        uploads.set(id, { key, parts: new Map() });
        res
          .writeHead(200)
          .end(
            `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
          );
        return;
      }
      if (req.method === "PUT" && q.has("uploadId")) {
        const up = uploads.get(q.get("uploadId")!);
        if (!up) return void res.writeHead(404).end("<Error><Code>NoSuchUpload</Code></Error>");
        up.parts.set(Number(q.get("partNumber")), body);
        res.writeHead(200, { etag: `"etag-${q.get("partNumber")}"` }).end();
        return;
      }
      if (req.method === "POST" && q.has("uploadId")) {
        const up = uploads.get(q.get("uploadId")!);
        if (!up) return void res.writeHead(404).end("<Error><Code>NoSuchUpload</Code></Error>");
        const ordered = [...up.parts.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
        objects.set(up.key, Buffer.concat(ordered));
        uploads.delete(q.get("uploadId")!);
        res.writeHead(200).end("<CompleteMultipartUploadResult/>");
        return;
      }
      if (req.method === "DELETE" && q.has("uploadId")) {
        uploads.delete(q.get("uploadId")!);
        res.writeHead(204).end();
        return;
      }
      if (req.method === "PUT") {
        objects.set(key, body);
        res.writeHead(200, { etag: '"single"' }).end();
        return;
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(400).end();
    })();
  });
  return { server, baseUrl: await listen(server), objects, uploads, requests, state };
}
