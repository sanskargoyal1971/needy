import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCEPTED_MIME, MAX_UPLOAD_BYTES } from "@needy/shared";
import { LocalDiskStorage, type StorageProvider } from "../storage.js";
import { streamToStorage, type UploadPolicy } from "../uploadStream.js";

const MiB = 1024 * 1024;
const WEBM_HEAD = [0x1a, 0x45, 0xdf, 0xa3];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];

/** A lazily generated upload: `head` then deterministic filler, in 64 KiB chunks. Nothing
 *  larger than one chunk is ever allocated, so the test itself does not mask buffering. */
function upload(total: number, head: number[]) {
  const meter = { produced: 0 };
  const hash = createHash("sha256");
  const stream = new Readable({
    read() {
      if (meter.produced >= total) return void this.push(null);
      const n = Math.min(64 * 1024, total - meter.produced);
      const buf = Buffer.alloc(n, meter.produced % 251);
      if (meter.produced === 0) Buffer.from(head).copy(buf);
      meter.produced += n;
      hash.update(buf);
      this.push(buf);
    },
  });
  return { stream, meter, sha256: () => hash.digest("hex") };
}

/** A storage sink that consumes slowly and counts what it has taken, so the gap between the
 *  source and the sink is exactly what the pipeline is holding. */
function slowSink() {
  const meter = { consumed: 0, puts: 0 };
  const storage: StorageProvider = {
    async putStream(_key, body) {
      meter.puts += 1;
      for await (const chunk of body as AsyncIterable<Buffer>) {
        meter.consumed += chunk.length;
        await new Promise((r) => setImmediate(r));
      }
    },
    put: () => Promise.reject(new Error("unused")),
    signedUrl: () => Promise.reject(new Error("unused")),
    get: () => Promise.resolve(null),
    remove: () => Promise.resolve(),
  };
  return { storage, meter };
}

const videoPolicy = (keys: string[] = []): UploadPolicy => ({
  accepted: ACCEPTED_MIME.video_testimony,
  maxBytes: MAX_UPLOAD_BYTES.video_testimony,
  keyFor: (ext) => {
    const k = `kyc/u1/video_testimony-x.${ext}`;
    keys.push(k);
    return k;
  },
});

describe("streamToStorage", () => {
  /** The reason this module exists. Against the old read-it-all-into-memory path, the gap
   *  between bytes read and bytes stored reaches the whole file. */
  it("holds a small, constant amount of a 60 MB upload regardless of its size", async () => {
    const total = MAX_UPLOAD_BYTES.video_testimony; // exactly at the cap: accepted
    const src = upload(total, WEBM_HEAD);
    const sink = slowSink();
    let peak = 0;
    src.stream.on("data", () => {
      peak = Math.max(peak, src.meter.produced - sink.meter.consumed);
    });

    const { done } = streamToStorage(src.stream, videoPolicy(), sink.storage);
    const outcome = await done;

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.stored.sizeBytes).toBe(total);
    expect(outcome.stored.mime).toBe("video/webm");
    expect(sink.meter.consumed).toBe(total);
    // The hash was computed on the way through and is of exactly the bytes sent.
    expect(outcome.stored.sha256).toBe(src.sha256());
    // ~a few stream high-water marks. The file is 60 MB.
    expect(peak).toBeLessThan(1 * MiB);
  });

  it("never calls storage for a file whose bytes are the wrong format", async () => {
    const src = upload(2 * MiB, JPEG_HEAD); // a photo, sent as testimony
    const sink = slowSink();
    const outcome = await streamToStorage(src.stream, videoPolicy(), sink.storage).done;
    expect(outcome).toEqual({ ok: false, reason: "wrong-format-for-kind" });
    expect(sink.meter.puts).toBe(0);
  });

  it("rejects an empty file without touching storage", async () => {
    const sink = slowSink();
    const outcome = await streamToStorage(Readable.from([]), videoPolicy(), sink.storage).done;
    expect(outcome).toEqual({ ok: false, reason: "empty" });
    expect(sink.meter.puts).toBe(0);
  });
});

describe("streamToStorage → local disk", () => {
  let root: string;
  let storage: LocalDiskStorage;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "needy-stream-"));
    storage = new LocalDiskStorage(root, "http://test.local", () => 0);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const everything = async () =>
    (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter((d) => d.isFile())
      .map((d) => d.name);

  it("writes the file and its sidecar, and nothing else", async () => {
    const src = upload(5 * MiB + 17, WEBM_HEAD);
    const outcome = await streamToStorage(src.stream, videoPolicy(), storage).done;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const onDisk = await readFile(join(root, outcome.stored.key));
    expect(createHash("sha256").update(onDisk).digest("hex")).toBe(outcome.stored.sha256);
    expect((await everything()).sort()).toEqual([
      "video_testimony-x.webm",
      "video_testimony-x.webm.meta.json",
    ]);
  });

  it("aborts at the byte past the cap and leaves no file, temp or otherwise", async () => {
    const src = upload(MAX_UPLOAD_BYTES.video_testimony + 1, WEBM_HEAD);
    const outcome = await streamToStorage(src.stream, videoPolicy(), storage).done;
    expect(outcome).toEqual({ ok: false, reason: "too-large" });
    expect(await everything()).toEqual([]);
  });
});
