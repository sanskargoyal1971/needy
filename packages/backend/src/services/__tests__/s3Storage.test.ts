import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imdsCredentials } from "../awsCredentials.js";
import { signRequest } from "../sigv4.js";
import { S3_PART_BYTES, S3Storage } from "../storage.js";
import { closeServer, fakeImds, fakeS3, type FakeS3Request } from "./fakeAws.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 15, 10);
const MiB = 1024 * 1024;

/** Deterministic bytes, generated lazily so a large "file" is never in memory at once.
 *  `produced` lets a test compare what has been read from the source with what has arrived
 *  at the far end. */
function lazySource(total: number, chunk = 64 * 1024, failAfter?: number) {
  const meter = { produced: 0 };
  const stream = new Readable({
    read() {
      if (failAfter != null && meter.produced >= failAfter) {
        this.destroy(new Error("client went away"));
        return;
      }
      if (meter.produced >= total) return void this.push(null);
      const n = Math.min(chunk, total - meter.produced);
      const buf = Buffer.alloc(n, (meter.produced / chunk) % 251);
      meter.produced += n;
      this.push(buf);
    },
  });
  return { stream, meter };
}

function expectedBytes(total: number, chunk = 64 * 1024): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < total; off += chunk) {
    parts.push(Buffer.alloc(Math.min(chunk, total - off), (off / chunk) % 251));
  }
  return Buffer.concat(parts);
}

/** Recompute the signature S3 would, from what actually arrived on the wire. The secret is
 *  derived from the access key the same way the fake IMDS mints them. */
function signatureValid(r: FakeS3Request): boolean {
  const auth = String(r.headers.authorization ?? "");
  const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(";") ?? [];
  const accessKeyId = /Credential=([^/]+)/.exec(auth)?.[1] ?? "";
  const n = Number(accessKeyId.slice(-5));
  const managed = new Set(["host", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token"]);
  const headers: Record<string, string> = {};
  for (const h of signed) if (!managed.has(h)) headers[h] = String(r.headers[h]);
  const query: Record<string, string> = {};
  for (const [k, v] of r.query) query[k] = v;
  const recomputed = signRequest({
    method: r.method,
    host: String(r.headers.host),
    path: r.path,
    query,
    headers,
    payloadHash: String(r.headers["x-amz-content-sha256"]),
    region: "ap-south-1",
    service: "s3",
    credentials: {
      accessKeyId,
      secretAccessKey: `fake-secret-${n}`,
      sessionToken: r.headers["x-amz-security-token"] as string | undefined,
    },
    nowMs: NOW,
  });
  return recomputed.authorization === auth;
}

describe("S3 adapter on instance-role credentials", () => {
  let imds: Awaited<ReturnType<typeof fakeImds>>;
  let s3: Awaited<ReturnType<typeof fakeS3>>;
  let storage: S3Storage;
  const servers: Server[] = [];

  beforeEach(async () => {
    imds = await fakeImds({ lifetimeMs: HOUR, now: () => NOW });
    s3 = await fakeS3();
    servers.push(imds.server, s3.server);
    storage = new S3Storage(
      {
        bucket: "needy-kyc",
        region: "ap-south-1",
        credentials: imdsCredentials({ now: () => NOW, baseUrl: imds.baseUrl }),
        endpoint: s3.baseUrl,
      },
      () => NOW,
    );
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
  });

  it("signs the session token into a PUT, along with every x-amz header it sends", async () => {
    await storage.put("kyc/u1/selfie-a.jpg", Buffer.from("jpeg bytes"), "image/jpeg");

    const [put] = s3.requests;
    expect(put!.headers["x-amz-security-token"]).toBe("fake-session-token-1");
    expect(String(put!.headers.authorization)).toContain("Credential=ASIAFAKEROLEKEY00001/");
    expect(String(put!.headers.authorization)).toMatch(
      /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token;x-amz-server-side-encryption,/,
    );
    // The payload hash is the real one, so S3 would verify the stored bytes against it.
    expect(put!.headers["x-amz-content-sha256"]).toBe(put!.bodySha256);
    expect(signatureValid(put!)).toBe(true);
    expect(s3.objects.get("kyc/u1/selfie-a.jpg")?.toString()).toBe("jpeg bytes");
  });

  it("puts the session token in presigned document links", async () => {
    const url = new URL(await storage.signedUrl("kyc/u1/selfie-a.jpg", 120));
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("fake-session-token-1");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^ASIAFAKEROLEKEY00001\//);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
  });

  it("refreshes credentials and retries once when S3 answers ExpiredToken", async () => {
    s3.state.expiredTokens.add("fake-session-token-1");
    await storage.put("kyc/u1/gov_id-b.png", Buffer.from("png"), "image/png");

    expect(s3.requests.map((r) => r.headers["x-amz-security-token"])).toEqual([
      "fake-session-token-1",
      "fake-session-token-2",
    ]);
    expect(imds.state.issued).toBe(2);
    expect(s3.objects.has("kyc/u1/gov_id-b.png")).toBe(true);
  });

  it("streams a large body as multipart parts, never holding more than about one part", async () => {
    const total = 40 * MiB;
    const { stream, meter } = lazySource(total);
    let peakAhead = 0;
    stream.on("data", () => {
      peakAhead = Math.max(peakAhead, meter.produced - s3.state.received);
    });

    await storage.putStream("kyc/u1/video_testimony-c.webm", stream, "video/webm");

    const parts = s3.requests.filter((r) => r.method === "PUT" && r.query.has("partNumber"));
    expect(parts.length).toBe(Math.ceil(total / S3_PART_BYTES));
    for (const p of parts) {
      expect(p.headers["x-amz-content-sha256"]).toBe(p.bodySha256);
      expect(signatureValid(p)).toBe(true);
    }
    // Every request in the flow carried the role's session token.
    expect(
      s3.requests.every((r) => r.headers["x-amz-security-token"] === "fake-session-token-1"),
    ).toBe(true);
    // SSE is requested on the upload as a whole.
    const create = s3.requests.find((r) => r.query.has("uploads"))!;
    expect(create.headers["x-amz-server-side-encryption"]).toBe("AES256");

    const stored = s3.objects.get("kyc/u1/video_testimony-c.webm")!;
    expect(createHash("sha256").update(stored).digest("hex")).toBe(
      createHash("sha256").update(expectedBytes(total)).digest("hex"),
    );
    // Bounded by one part plus stream buffers — not by the 40 MiB file.
    expect(peakAhead).toBeLessThan(S3_PART_BYTES + 2 * MiB);
    expect(s3.uploads.size).toBe(0);
  });

  it("sends a body that fits in one part as a single PUT", async () => {
    const { stream } = lazySource(3 * MiB);
    await storage.putStream("kyc/u1/selfie-d.jpg", stream, "image/jpeg");
    expect(s3.requests.map((r) => r.method)).toEqual(["PUT"]);
    expect(s3.objects.get("kyc/u1/selfie-d.jpg")?.length).toBe(3 * MiB);
  });

  it("aborts the multipart upload when the body fails, leaving nothing in the bucket", async () => {
    const { stream } = lazySource(40 * MiB, 64 * 1024, 20 * MiB);
    await expect(
      storage.putStream("kyc/u1/video_testimony-e.webm", stream, "video/webm"),
    ).rejects.toThrow(/client went away/);

    expect(s3.requests.some((r) => r.method === "DELETE" && r.query.has("uploadId"))).toBe(true);
    expect(s3.objects.size).toBe(0);
    expect(s3.uploads.size).toBe(0);
  });

  it("stores nothing when a small body fails before its single PUT", async () => {
    const { stream } = lazySource(4 * MiB, 64 * 1024, 1 * MiB);
    await expect(storage.putStream("kyc/u1/selfie-f.jpg", stream, "image/jpeg")).rejects.toThrow();
    expect(s3.requests).toHaveLength(0);
    expect(s3.objects.size).toBe(0);
  });
});
