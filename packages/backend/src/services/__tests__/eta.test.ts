import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config.js";
import { clearRouteCache, computeEta, haversineMeters } from "../eta.js";

const DOOR = { lat: 17.4632, lng: 78.3673 };
const FAR = { lat: 17.4752, lng: 78.3733 }; // ~1.5 km north

function routesResponse(durationS: number, meters: number) {
  return new Response(
    JSON.stringify({
      routes: [
        { duration: `${durationS}s`, distanceMeters: meters, polyline: { encodedPolyline: "abc" } },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("computeEta", () => {
  const saved = { ...config.directions };
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    clearRouteCache();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    Object.assign(config.directions, saved);
    vi.unstubAllGlobals();
  });

  it("falls back to a flagged straight-line estimate with no provider", async () => {
    Object.assign(config.directions, { provider: "" });
    const eta = await computeEta(FAR, DOOR);
    expect(eta.approximate).toBe(true);
    expect(eta.polyline).toBeUndefined();
    expect(eta.distanceMeters).toBeCloseTo(haversineMeters(FAR, DOOR));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the Routes API, with the key in a header and never the URL", async () => {
    Object.assign(config.directions, {
      provider: "google",
      apiKey: "test-key",
      travelMode: "WALK",
    });
    fetchMock.mockResolvedValue(routesResponse(600, 1900));

    const eta = await computeEta(FAR, DOOR);

    expect(eta).toEqual({
      etaSeconds: 600,
      distanceMeters: 1900,
      approximate: false,
      polyline: "abc",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("test-key");
    // Walking is not traffic-aware; asking for it is a 400 from the API.
    expect(JSON.parse(String(init.body)).routingPreference).toBeUndefined();
  });

  it("reuses a recent route for the same task instead of calling again on every tick", async () => {
    Object.assign(config.directions, {
      provider: "google",
      apiKey: "k",
      travelMode: "TWO_WHEELER",
    });
    fetchMock.mockResolvedValue(routesResponse(600, 1900));

    await computeEta(FAR, DOOR, { cacheKey: "t1", now: 1_000 });
    const closer = { lat: FAR.lat - 0.001, lng: FAR.lng }; // ~110 m nearer
    const again = await computeEta(closer, DOOR, { cacheKey: "t1", now: 6_000 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Scaled down by the distance already covered, and still carrying the route.
    expect(again.etaSeconds).toBeLessThan(600);
    expect(again.polyline).toBe("abc");
  });

  it("asks again once the cached route is stale", async () => {
    Object.assign(config.directions, {
      provider: "google",
      apiKey: "k",
      travelMode: "TWO_WHEELER",
    });
    fetchMock.mockImplementation(() => Promise.resolve(routesResponse(600, 1900)));

    await computeEta(FAR, DOOR, { cacheKey: "t2", now: 0 });
    await computeEta(FAR, DOOR, { cacheKey: "t2", now: 60_000 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back honestly when the provider fails", async () => {
    Object.assign(config.directions, {
      provider: "google",
      apiKey: "k",
      travelMode: "TWO_WHEELER",
    });
    fetchMock.mockResolvedValue(new Response("{}", { status: 403 }));

    const eta = await computeEta(FAR, DOOR);
    expect(eta.approximate).toBe(true);
  });

  it("does not ask for a route from the doorstep", async () => {
    Object.assign(config.directions, {
      provider: "google",
      apiKey: "k",
      travelMode: "TWO_WHEELER",
    });
    const eta = await computeEta({ lat: DOOR.lat + 0.0001, lng: DOOR.lng }, DOOR);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(eta.approximate).toBe(false);
    expect(eta.etaSeconds).toBeLessThan(30);
  });
});
