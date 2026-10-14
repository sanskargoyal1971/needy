import type { NextFunction, Request, Response } from "express";
import { logger } from "../logger.js";

/**
 * A ceiling on how many uploads this process serves at once.
 *
 * Uploads used to be read whole into memory, so the cap was 4 and the worst case was
 * 4 × 60 MB = 240 MB. They are now streamed (services/uploadStream.ts): what one upload holds
 * is a few stream buffers on the local adapter and, in production, one part buffer
 * (`S3_PART_BYTES`, 8 MiB) plus a socket chunk and the stream high-water marks. That bound
 * depends on the S3 adapter never copying the part — no concatenation of the socket's
 * chunks, and no Buffer handed to `fetch`, which copies it — and the concurrent-upload
 * memory test in s3Storage.test.ts measures it rather than assuming it. Sixteen at once is
 * therefore ~130 MB worst case: about half the old ceiling, for four times the concurrency,
 * which is what lets a burst of helpers recording testimony at a launch event go through
 * instead of seeing 503s.
 *
 * Why still a cap at all: each slot is also an open socket, an S3 multipart upload and a
 * share of the instance's upstream bandwidth, and a slow client can hold one for minutes.
 * Unbounded, a few dozen deliberately slow uploads would starve the realtime traffic (live
 * tasks, chat, SOS) that shares this process. The memory bound is now `16 × 8 MiB`; the
 * number to revisit if the instance size changes is that product, not the file-size cap.
 *
 * Refused rather than queued. A queue holds the connection open and the caller waits with no
 * idea why; a 503 with `Retry-After` is something a client can act on. Chain AFTER the auth
 * guard, so an anonymous caller can never occupy a slot.
 */
export const MAX_CONCURRENT_UPLOADS = 16;

let inFlight = 0;

export function uploadSlot(req: Request, res: Response, next: NextFunction): void {
  if (inFlight >= MAX_CONCURRENT_UPLOADS) {
    logger.warn("upload refused — all upload slots are busy", { inFlight });
    // Close the connection instead of reading a body we have already decided not to accept.
    res.set("Retry-After", "5").set("Connection", "close");
    res.status(503).json({ error: "uploads-busy", retryAfterSeconds: 5 });
    return;
  }

  inFlight += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    inFlight -= 1;
  };
  // `close` fires whether the response finished or the client went away mid-upload, which is
  // the case that would otherwise leak a slot for good.
  res.once("close", release);
  res.once("finish", release);
  next();
}

/** For tests. */
export function uploadSlotsInUse(): number {
  return inFlight;
}
