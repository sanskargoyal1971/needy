/** ── Content-type sniffing ─────────────────────────────────────────────────
 *  The browser's declared `Content-Type` on a multipart part is attacker-controlled input. A
 *  client that says `image/jpeg` while sending a PHP script, an HTML page or an ELF binary is
 *  the oldest upload attack there is, and the two consequences here are real:
 *
 *   - The admin document viewer renders these bytes back to a reviewer. HTML sniffed and
 *     executed in the admin's origin is stored XSS against the highest-privilege session on
 *     the platform.
 *   - "Verified" is a human judgement made against what the reviewer sees. A file that
 *     renders differently depending on who opens it undermines the judgement itself.
 *
 *  So the bytes decide, not the label. This is a small, deliberately conservative sniffer
 *  covering exactly the formats the onboarding flow accepts — not a general-purpose one.
 *  Anything it does not positively recognise is rejected.
 */

export interface SniffResult {
  /** The MIME type the bytes actually are, or null if unrecognised. */
  mime: string | null;
  /** Canonical extension for the storage key. */
  extension: string;
}

const startsWith = (b: Buffer, sig: readonly number[], offset = 0): boolean =>
  b.length >= offset + sig.length && sig.every((byte, i) => b[offset + i] === byte);

/** ISO base media format (MP4 / QuickTime): a `ftyp` box at offset 4, whose brand tells the
 *  two apart. Both are accepted for video testimony, so the brand only picks the label. */
function sniffIsoBmff(b: Buffer): SniffResult | null {
  if (b.length < 12) return null;
  if (!(b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)) return null; // "ftyp"
  const brand = b.subarray(8, 12).toString("ascii");
  if (brand.startsWith("qt")) return { mime: "video/quicktime", extension: "mov" };
  return { mime: "video/mp4", extension: "mp4" };
}

export function sniffContentType(bytes: Buffer): SniffResult {
  // JPEG — FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", extension: "jpg" };

  // PNG — 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", extension: "png" };
  }

  // WebP — "RIFF" .... "WEBP"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { mime: "image/webp", extension: "webp" };
  }

  // PDF — "%PDF-"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { mime: "application/pdf", extension: "pdf" };
  }

  // Matroska / WebM — EBML header 1A 45 DF A3. MediaRecorder in Chrome and Firefox produces
  // WebM, so this is the common path for the in-browser selfie and testimony capture.
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { mime: "video/webm", extension: "webm" };
  }

  const iso = sniffIsoBmff(bytes);
  if (iso) return iso;

  return { mime: null, extension: "" };
}

/**
 * Validate an upload against what the flow accepts for this document kind.
 *
 * Returns a machine-readable reason rather than throwing, so the route can map it onto a
 * specific 400 the UI can explain — "that looks like a video, not a photo" is actionable;
 * "invalid file" is not.
 */
export type UploadRejection =
  "empty" | "too-large" | "unrecognized-format" | "wrong-format-for-kind";

export function validateUpload(
  bytes: Buffer,
  accepted: readonly string[],
  maxBytes: number,
): { ok: true; mime: string; extension: string } | { ok: false; reason: UploadRejection } {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > maxBytes) return { ok: false, reason: "too-large" };

  const sniffed = sniffContentType(bytes);
  if (sniffed.mime == null) return { ok: false, reason: "unrecognized-format" };
  if (!accepted.includes(sniffed.mime)) return { ok: false, reason: "wrong-format-for-kind" };

  return { ok: true, mime: sniffed.mime, extension: sniffed.extension };
}
