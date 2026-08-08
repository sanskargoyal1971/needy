import { describe, expect, it } from "vitest";
import { ACCEPTED_MIME, MAX_UPLOAD_BYTES } from "@needy/shared";
import { sniffContentType, validateUpload } from "../fileType.js";

/** Header bytes for each format the onboarding flow accepts. Padded out so the length checks
 *  in the sniffer (which need ≥12 bytes for ISO-BMFF) have something to read. */
const pad = (head: number[], n = 64) =>
  Buffer.concat([Buffer.from(head), Buffer.alloc(n - head.length)]);

const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const PDF = pad([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const WEBM = pad([0x1a, 0x45, 0xdf, 0xa3]);
const MP4 = pad([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const MOV = pad([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);

describe("sniffContentType", () => {
  it.each([
    ["jpeg", JPEG, "image/jpeg", "jpg"],
    ["png", PNG, "image/png", "png"],
    ["webp", WEBP, "image/webp", "webp"],
    ["pdf", PDF, "application/pdf", "pdf"],
    ["webm", WEBM, "video/webm", "webm"],
    ["mp4", MP4, "video/mp4", "mp4"],
    ["quicktime", MOV, "video/quicktime", "mov"],
  ])("recognises %s", (_label, bytes, mime, ext) => {
    expect(sniffContentType(bytes)).toEqual({ mime, extension: ext });
  });

  it("does not recognise formats outside the accepted set", () => {
    // A GIF is a real image and would sail past a naive `startsWith("image/")` check on the
    // declared type. It is not in ACCEPTED_MIME for any kind, so the sniffer must not name it.
    expect(sniffContentType(pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])).mime).toBeNull();
    expect(sniffContentType(Buffer.from("<html><body>hi</body></html>")).mime).toBeNull();
    expect(sniffContentType(Buffer.from("#!/bin/sh\nrm -rf /")).mime).toBeNull();
  });
});

describe("validateUpload", () => {
  it("accepts a JPEG for a gov ID", () => {
    const r = validateUpload(JPEG, ACCEPTED_MIME.gov_id, MAX_UPLOAD_BYTES.gov_id);
    expect(r).toMatchObject({ ok: true, mime: "image/jpeg", extension: "jpg" });
  });

  /** The attack this whole module exists to stop: the bytes are what matter, never the label
   *  the client attached. The route passes only the sniffed type downstream, so an executable
   *  renamed to .jpg and declared as image/jpeg is rejected on content. */
  it("rejects an executable dressed up as an image", () => {
    const elf = pad([0x7f, 0x45, 0x4c, 0x46]);
    expect(validateUpload(elf, ACCEPTED_MIME.gov_id, MAX_UPLOAD_BYTES.gov_id)).toEqual({
      ok: false,
      reason: "unrecognized-format",
    });
  });

  /** Stored XSS against the highest-privilege session on the platform: the admin document
   *  viewer renders these bytes back to a reviewer. */
  it("rejects HTML", () => {
    const html = Buffer.from("<script>fetch('//evil')</script>");
    expect(validateUpload(html, ACCEPTED_MIME.gov_id, MAX_UPLOAD_BYTES.gov_id)).toEqual({
      ok: false,
      reason: "unrecognized-format",
    });
  });

  it("rejects a real format that is wrong for the kind", () => {
    // A video is a legitimate upload — just not as a selfie, where the reviewer needs a still
    // to match against the ID.
    expect(validateUpload(WEBM, ACCEPTED_MIME.selfie, MAX_UPLOAD_BYTES.selfie)).toEqual({
      ok: false,
      reason: "wrong-format-for-kind",
    });
    // And the converse: a still is not a video testimony.
    expect(
      validateUpload(JPEG, ACCEPTED_MIME.video_testimony, MAX_UPLOAD_BYTES.video_testimony),
    ).toEqual({ ok: false, reason: "wrong-format-for-kind" });
  });

  it("rejects empty and oversized uploads", () => {
    expect(validateUpload(Buffer.alloc(0), ACCEPTED_MIME.gov_id, 100)).toEqual({
      ok: false,
      reason: "empty",
    });
    const big = Buffer.concat([JPEG, Buffer.alloc(200)]);
    expect(validateUpload(big, ACCEPTED_MIME.gov_id, 100)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  /** Size is checked before sniffing, so a huge unrecognised blob reports the size problem —
   *  the more actionable message, and the cheaper check. */
  it("reports size before format for a large unrecognised file", () => {
    expect(validateUpload(Buffer.alloc(500), ACCEPTED_MIME.gov_id, 100)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });
});
