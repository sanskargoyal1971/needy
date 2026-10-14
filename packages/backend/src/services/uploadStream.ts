import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import busboy from "busboy";
import type { Request } from "express";
import { SNIFF_BYTES, validateHead, type UploadRejection } from "./fileType.js";
import type { StorageProvider } from "./storage.js";

/** ── Streamed uploads ──────────────────────────────────────────────────────
 *  A KYC video is up to 60 MB. Reading it into memory before deciding anything made the
 *  process's memory a function of how many people were uploading; streaming makes it a
 *  constant per upload (a socket buffer or two locally, one S3 part in production).
 *
 *  What streaming must not cost is any of the guarantees the buffered path had:
 *
 *   - The bytes decide the type, not the label. The first `SNIFF_BYTES` are held back and
 *     sniffed BEFORE anything is written to storage; the declared Content-Type is never read.
 *   - The per-kind size cap is enforced as the bytes arrive. The byte that crosses it aborts
 *     the write, and the storage adapter's all-or-nothing contract removes whatever was
 *     written so far.
 *   - The SHA-256 a reviewer relies on is of exactly the bytes stored — computed on the same
 *     chunks as they pass through, not by reading the object back.
 *   - A rejected, oversize or abandoned upload leaves nothing in storage.
 */

/** What an upload of one particular kind may be. */
export interface UploadPolicy {
  accepted: readonly string[];
  maxBytes: number;
  /** Mint the storage key once the sniffed extension is known. */
  keyFor(extension: string): string;
}

export interface StoredUpload {
  key: string;
  mime: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
}

/** Why a streamed upload did not land. `aborted` = the client went away; `malformed` = the
 *  multipart body was broken. Neither is a statement about the file. */
export type StreamRejection = UploadRejection | "aborted" | "malformed";

export type StreamOutcome =
  { ok: true; stored: StoredUpload } | { ok: false; reason: StreamRejection };

class UploadStopped extends Error {
  constructor(readonly reason: StreamRejection) {
    super(`upload stopped: ${reason}`);
  }
}

/**
 * Feed one file stream into storage under `policy`.
 *
 * The source is read with `data` events and paused/resumed by hand rather than piped, because
 * the source here is busboy's file stream: destroying it (which `pipeline` does on error)
 * leaves busboy unable to finish parsing the form, and the request would hang instead of
 * getting its 413. On rejection the source is instead drained — read and discarded — so the
 * form completes and a response can be sent.
 *
 * `done` rejects only for a storage failure (S3 down, disk full) — a server problem, a 500.
 * Everything the client caused resolves to `{ ok: false, reason }`.
 */
export function streamToStorage(
  source: Readable & { truncated?: boolean },
  policy: UploadPolicy,
  storage: StorageProvider,
): { done: Promise<StreamOutcome>; stop(reason: StreamRejection): void } {
  const hash = createHash("sha256");
  const head: Buffer[] = [];
  let headBytes = 0;
  let size = 0;
  let body: Readable | null = null;
  let stopped: StreamRejection | null = null;
  let resolveDone!: (o: StreamOutcome) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<StreamOutcome>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const drain = (): void => {
    source.removeListener("data", onData);
    source.on("data", () => undefined);
    source.resume();
  };

  const stop = (reason: StreamRejection): void => {
    if (stopped) return;
    stopped = reason;
    drain();
    // Before storage has been touched there is nothing to clean up; after, destroying the
    // body is how the adapter learns to remove what it has written. Its rejection then
    // settles `done`, so `done` never resolves before the cleanup has happened.
    if (body) body.destroy(new UploadStopped(reason));
    else resolveDone({ ok: false, reason });
  };

  const begin = (): void => {
    const first = Buffer.concat(head);
    const check = validateHead(first, policy.accepted);
    if (!check.ok) return stop(check.reason);

    const key = policy.keyFor(check.extension);
    body = new Readable({ read: () => void source.resume() });
    body.push(first);
    storage.putStream(key, body, check.mime).then(
      () =>
        resolveDone({
          ok: true,
          stored: {
            key,
            mime: check.mime,
            extension: check.extension,
            sizeBytes: size,
            sha256: hash.digest("hex"),
          },
        }),
      (err: unknown) => {
        if (stopped) return resolveDone({ ok: false, reason: stopped });
        // Storage failed on its own. Drain so the form can still finish, then surface it.
        stopped = "aborted";
        drain();
        rejectDone(err);
      },
    );
  };

  function onData(chunk: Buffer): void {
    size += chunk.length;
    if (size > policy.maxBytes) return stop("too-large");
    hash.update(chunk);
    if (body) {
      if (!body.push(chunk)) source.pause();
      return;
    }
    head.push(chunk);
    headBytes += chunk.length;
    if (headBytes >= SNIFF_BYTES) begin();
  }

  source.on("data", onData);
  source.on("end", () => {
    if (stopped) return;
    // busboy truncates at its own `fileSize` limit and then ENDS the stream normally — an
    // end that must not be mistaken for a complete file.
    if (source.truncated) return stop("too-large");
    if (!body) {
      if (size === 0) return stop("empty");
      begin(); // shorter than SNIFF_BYTES: judge what there is
    }
    // `begin` may have rejected the head; `stopped` would then be set.
    if (!stopped && body) (body as Readable).push(null);
  });
  source.on("error", () => stop("aborted"));

  return { done, stop };
}

export type SingleUploadResult =
  | { ok: true; fields: Record<string, string>; stored: StoredUpload }
  | { ok: false; reason: StreamRejection | "no-file" | string };

/**
 * Parse one multipart request whose single file part is streamed straight to storage.
 *
 * `policyFor` is consulted when the file part BEGINS, with only the fields that arrived
 * before it. That is the price of not buffering: the size cap and accepted formats depend on
 * the document kind, and the bytes are on their way to storage before any later field could
 * be read. So a form must put `kind` first — which is what the web client does, and what
 * every browser preserves, since FormData keeps append order. A file that arrives before its
 * kind is refused (drained, nothing stored) with an error that says so, rather than guessed
 * at: storing under the largest cap and re-checking afterwards would mean a 60 MB "selfie"
 * briefly existing in the bucket. Fields after the file are ignored.
 *
 * `policyFor` returns a string to refuse — a reason code the route maps to a 400.
 */
export function receiveSingleUpload(
  req: Request,
  opts: {
    storage: StorageProvider;
    /** The largest cap any policy could return — a backstop for busboy's own limit. */
    maxBytes: number;
    maxFields: number;
    policyFor(fields: Record<string, string>): UploadPolicy | string;
  },
): Promise<SingleUploadResult> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof busboy>;
    try {
      // +1 so that busboy's truncation can only ever happen to a file our own counter has
      // already refused; the counter, not busboy, is what enforces the per-kind cap.
      bb = busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: opts.maxBytes + 1, fields: opts.maxFields },
      });
    } catch {
      resolve({ ok: false, reason: "malformed" });
      return;
    }

    const fields: Record<string, string> = {};
    let upload: ReturnType<typeof streamToStorage> | null = null;
    let refused: string | null = null;
    let settled = false;

    const finish = (failure: StreamRejection | null): void => {
      if (settled) return;
      settled = true;
      req.unpipe(bb);
      if (failure) upload?.stop(failure);
      if (!upload) {
        resolve({ ok: false, reason: failure ?? refused ?? "no-file" });
        return;
      }
      upload.done.then(
        (o) =>
          resolve(o.ok ? { ok: true, fields, stored: o.stored } : { ok: false, reason: o.reason }),
        reject,
      );
    };

    bb.on("field", (name, value) => {
      if (!upload && !refused) fields[name] = value;
    });

    bb.on("file", (_name, stream) => {
      const policy = opts.policyFor({ ...fields });
      if (typeof policy === "string") {
        refused = policy;
        stream.resume();
        return;
      }
      upload = streamToStorage(stream, policy, opts.storage);
    });

    bb.on("close", () => finish(null));
    bb.on("error", () => finish("malformed"));

    // The client hanging up mid-upload: the request never ends, so busboy never errors on
    // its own and the file stream would wait forever for bytes that are not coming. Stop the
    // write here, which is what removes the partial object.
    req.on("error", () => finish("aborted"));
    req.on("close", () => {
      if (!req.complete) finish("aborted");
    });

    req.pipe(bb);
  });
}

/** Map a streamed-upload failure onto an HTTP status the client can act on. */
export function uploadFailureStatus(reason: string): number {
  if (reason === "too-large") return 413;
  if (
    reason === "empty" ||
    reason === "unrecognized-format" ||
    reason === "wrong-format-for-kind"
  ) {
    return 415;
  }
  return 400;
}
