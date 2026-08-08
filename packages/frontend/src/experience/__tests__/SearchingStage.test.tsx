import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LatLng } from "@needy/shared";
import { MotionPreferencesProvider } from "../../motion/preferences.js";
import { RealtimeProvider } from "../../realtime/RealtimeProvider.js";
import {
  initialTaskState,
  type NeedyDriver,
  type TaskExperienceState,
} from "../../realtime/types.js";
import { stubNeedyDriver } from "../../test/stubDriver.js";
import { SearchingStage } from "../SearchingStage.js";
import { EnRouteStage } from "../EnRouteStage.js";

// LiveMap drives real Leaflet, which needs layout jsdom doesn't provide. The map itself isn't
// what's under test here — whether we render it AT ALL is.
vi.mock("../LiveMap.js", () => ({
  LiveMap: ({ origin }: { origin: LatLng }) => (
    <div data-testid="live-map" data-origin={`${origin.lat},${origin.lng}`} />
  ),
}));

const ORIGIN: LatLng = { lat: 12.9716, lng: 77.5946 };

function stubDriver(overrides: Partial<TaskExperienceState>): NeedyDriver {
  return stubNeedyDriver({ ...initialTaskState("req-abc123"), ...overrides });
}

function renderWith(driver: NeedyDriver, node: React.ReactNode) {
  return render(
    // Reduced motion so RadarSweep renders plain divs with the final left/top, which is exactly
    // the projected geometry we want to assert on.
    <MotionPreferencesProvider defaultOverride="reduce">
      <RealtimeProvider driver={driver}>{node}</RealtimeProvider>
    </MotionPreferencesProvider>,
  );
}

/** The radar's blips are the absolutely-positioned dots inside the 260px dish. */
function blipCentres(container: HTMLElement): { x: number; y: number }[] {
  const radius = 130; // RadarSweep size={260}
  return Array.from(container.querySelectorAll<HTMLElement>("div[style*='position: absolute']"))
    .filter((el) => el.style.left !== "" && el.style.top !== "")
    .map((el) => ({
      // Back out of the pixel placement into the [-1,1] radar space RadarSweep applies:
      // left = radius + x * radius * 0.82.
      x: (parseFloat(el.style.left) - radius) / (radius * 0.82),
      y: (parseFloat(el.style.top) - radius) / (radius * 0.82),
    }));
}

const task = (origin: LatLng | null) =>
  origin
    ? {
        id: "task-1",
        requesterId: "req-abc123",
        helperId: null,
        category: "errand" as const,
        state: "searching" as const,
        origin,
        title: "Pick up medicine",
        description: "test", price: 100, createdAt: 0,
        updatedAt: 0,
      }
    : null;

describe("SearchingStage radar projection", () => {
  it("places real Bangalore coordinates at their true bearing, not all at the centre", () => {
    // ~1 km due north and ~1 km due east of the origin. The old `(v % 1) * 2 - 1` fold
    // collapsed both of these to roughly (-0.06, 0.18) — i.e. on top of each other, at centre.
    const north: LatLng = { lat: ORIGIN.lat + 0.009, lng: ORIGIN.lng };
    const east: LatLng = { lat: ORIGIN.lat, lng: ORIGIN.lng + 0.0092 };
    const driver = stubDriver({
      task: task(ORIGIN),
      helpersNearby: { count: 2, approxPoints: [north, east] },
    });

    const { container } = renderWith(driver, <SearchingStage />);
    const [n, e] = blipCentres(container);

    // Due north: on the vertical axis, ABOVE centre (screen y is inverted).
    expect(Math.abs(n.x)).toBeLessThan(0.02);
    expect(n.y).toBeLessThan(-0.3);
    // Due east: on the horizontal axis, RIGHT of centre.
    expect(Math.abs(e.y)).toBeLessThan(0.02);
    expect(e.x).toBeGreaterThan(0.3);
    // And crucially they are nowhere near each other.
    expect(Math.hypot(n.x - e.x, n.y - e.y)).toBeGreaterThan(0.8);
  });

  it("clamps a helper far outside the radar's range to the rim, keeping their bearing", () => {
    // ~5.5 km due south — well past MIN_RANGE and inside MAX_RANGE, so it defines the range
    // and lands exactly on the rim.
    const south: LatLng = { lat: ORIGIN.lat - 0.05, lng: ORIGIN.lng };
    const driver = stubDriver({
      task: task(ORIGIN),
      helpersNearby: { count: 1, approxPoints: [south] },
    });

    const { container } = renderWith(driver, <SearchingStage />);
    const [s] = blipCentres(container);
    expect(Math.abs(s.x)).toBeLessThan(0.02);
    expect(s.y).toBeCloseTo(1, 1); // below centre = south, at the rim
    expect(Math.hypot(s.x, s.y)).toBeLessThanOrEqual(1.001);
  });

  it("keeps every blip inside the radar and never NaN, for a spread of real coordinates", () => {
    const points: LatLng[] = [
      { lat: 12.9716, lng: 77.5946 }, // exactly on the origin
      { lat: 13.05, lng: 77.65 },
      { lat: 12.9, lng: 77.5 },
      { lat: 12.9716, lng: 77.6 },
    ];
    const driver = stubDriver({
      task: task(ORIGIN),
      helpersNearby: { count: points.length, approxPoints: points },
    });

    const { container } = renderWith(driver, <SearchingStage />);
    const centres = blipCentres(container);
    expect(centres).toHaveLength(points.length);
    for (const c of centres) {
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Number.isFinite(c.y)).toBe(true);
      expect(Math.hypot(c.x, c.y)).toBeLessThanOrEqual(1.001);
    }
  });

  it("parks blips at the centre when the task origin isn't known yet", () => {
    const driver = stubDriver({
      task: null,
      helpersNearby: { count: 1, approxPoints: [{ lat: 13.05, lng: 77.65 }] },
    });
    const { container } = renderWith(driver, <SearchingStage />);
    const [c] = blipCentres(container);
    expect(c.x).toBeCloseTo(0, 5);
    expect(c.y).toBeCloseTo(0, 5);
  });
});

describe("EnRouteStage missing-origin fallback", () => {
  it("renders the live map when the task has a real origin", () => {
    const driver = stubDriver({ task: { ...task(ORIGIN)!, state: "en-route" } });
    renderWith(driver, <EnRouteStage />);
    expect(screen.getByTestId("live-map")).toHaveAttribute("data-origin", "12.9716,77.5946");
  });

  it("shows an explicit 'location unavailable' state instead of a map of Null Island", () => {
    // The old code fell back to { lat: 0, lng: 0 } — the Atlantic — and presented it as the
    // user's own street.
    const driver = stubDriver({ task: null, helper: null });
    renderWith(driver, <EnRouteStage />);

    expect(screen.queryByTestId("live-map")).not.toBeInTheDocument();
    expect(screen.getByText(/the map isn't available just now/i)).toBeInTheDocument();
    // The reassurance must still be there: the helper is coming regardless.
    expect(screen.getByText(/still on\s+their way/i)).toBeInTheDocument();
  });
});
