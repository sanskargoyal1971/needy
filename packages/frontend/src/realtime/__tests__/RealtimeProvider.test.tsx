import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RealtimeProvider, useTaskExperience } from "../RealtimeProvider.js";
import { initialTaskState } from "../types.js";
import { stubNeedyDriver } from "../../test/stubDriver.js";

/**
 * C21 proof. The provider used to do `useEffect(() => () => driver.dispose(), [driver])`.
 * React 18 StrictMode mounts → unmounts → remounts every effect, so the very first driver was
 * disposed before first paint — timers cleared, socket listeners dropped — and the app only
 * looked healthy because "Request help" re-armed the mock. These tests pin down all three
 * behaviours that matter: survive a double-mount, still tear down on a REAL unmount, and still
 * tear down the outgoing driver on a real swap.
 */

function stubDriver() {
  const dispose = vi.fn<() => void>();
  const driver = stubNeedyDriver(initialTaskState("req-abc123"), { dispose });
  return { driver, dispose };
}

/** Reads the store, so a disposed driver (which clears its listeners) would be visible here. */
function Probe() {
  const { userId } = useTaskExperience();
  return <span data-testid="probe">{userId}</span>;
}

/** Let the microtask the provider defers teardown onto actually run. */
const flushMicrotasks = () => Promise.resolve().then(() => {});

describe("RealtimeProvider driver lifecycle (audit C21)", () => {
  it("leaves the driver ALIVE through a StrictMode double-mount", async () => {
    const { driver, dispose } = stubDriver();
    const { getByTestId } = render(
      <StrictMode>
        <RealtimeProvider driver={driver}>
          <Probe />
        </RealtimeProvider>
      </StrictMode>,
    );

    // StrictMode has already run mount → unmount → remount by now.
    await flushMicrotasks();
    expect(dispose).not.toHaveBeenCalled();
    expect(getByTestId("probe")).toHaveTextContent("req-abc123");
  });

  it("disposes the driver on a real unmount", async () => {
    const { driver, dispose } = stubDriver();
    const { unmount } = render(
      <StrictMode>
        <RealtimeProvider driver={driver}>
          <Probe />
        </RealtimeProvider>
      </StrictMode>,
    );
    await flushMicrotasks();
    expect(dispose).not.toHaveBeenCalled();

    unmount();
    await flushMicrotasks();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes only the OUTGOING driver when the driver is swapped", async () => {
    const { driver: firstDriver, dispose: firstDispose } = stubDriver();
    const { driver: secondDriver, dispose: secondDispose } = stubDriver();
    const { rerender } = render(
      <StrictMode>
        <RealtimeProvider driver={firstDriver}>
          <Probe />
        </RealtimeProvider>
      </StrictMode>,
    );
    await flushMicrotasks();

    rerender(
      <StrictMode>
        <RealtimeProvider driver={secondDriver}>
          <Probe />
        </RealtimeProvider>
      </StrictMode>,
    );
    await flushMicrotasks();

    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).not.toHaveBeenCalled();
  });

  it("disposes once per real mount/unmount cycle, never more", async () => {
    const { driver, dispose } = stubDriver();
    const first = render(
      <RealtimeProvider driver={driver}>
        <Probe />
      </RealtimeProvider>,
    );
    await flushMicrotasks();
    first.unmount();
    await flushMicrotasks();
    expect(dispose).toHaveBeenCalledTimes(1);

    // Remounting a driver we've already torn down is a caller bug, but it must not compound
    // into repeated dispose() calls.
    const second = render(
      <RealtimeProvider driver={driver}>
        <Probe />
      </RealtimeProvider>,
    );
    await flushMicrotasks();
    second.unmount();
    await flushMicrotasks();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
