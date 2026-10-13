import type { NextFunction, Request, Response } from "express";
import { logger } from "../logger.js";

/**
 * A ceiling on how many uploads this process holds in memory at once.
 *
 * Uploads are read into memory before they go to object storage, and a video may be 60 MB.
 * Each request was bounded; the number of them was not — so a handful of signed-in clients
 * uploading at once could take the process past its memory limit, and with it every live
 * task, chat and alarm on the instance. This makes the worst case a number that can be
 * reasoned about: `MAX_CONCURRENT_UPLOADS × 60 MB`.
 *
 * Refused rather than queued. A queue holds the connection open and the caller waits with no
 * idea why; a 503 with `Retry-After` is something a client can act on. Chain AFTER the auth
 * guard, so an anonymous caller can never occupy a slot.
 */
export const MAX_CONCURRENT_UPLOADS = 4;

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
