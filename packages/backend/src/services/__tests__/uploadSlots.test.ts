import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { MAX_CONCURRENT_UPLOADS, uploadSlot, uploadSlotsInUse } from "../uploadSlots.js";

describe("upload slots", () => {
  it("refuses an upload past the ceiling and frees slots when requests end", async () => {
    const release: (() => void)[] = [];
    const app = express();
    app.post("/up", uploadSlot, (_req, res) => {
      // Hold the slot until the test lets go, as a slow upload would.
      release.push(() => res.json({ ok: true }));
    });

    const held = Array.from({ length: MAX_CONCURRENT_UPLOADS }, () =>
      request(app)
        .post("/up")
        .then((r) => r.status),
    );
    // Let every held request reach the handler.
    while (release.length < MAX_CONCURRENT_UPLOADS) await new Promise((r) => setTimeout(r, 5));
    expect(uploadSlotsInUse()).toBe(MAX_CONCURRENT_UPLOADS);

    const refused = await request(app).post("/up");
    expect(refused.status).toBe(503);
    expect(refused.body.error).toBe("uploads-busy");
    expect(refused.headers["retry-after"]).toBe("5");

    for (const go of release) go();
    expect(await Promise.all(held)).toEqual(Array(MAX_CONCURRENT_UPLOADS).fill(200));

    // Every slot came back, so the next upload is accepted.
    await new Promise((r) => setTimeout(r, 20));
    expect(uploadSlotsInUse()).toBe(0);
  });
});
