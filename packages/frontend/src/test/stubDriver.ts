import { vi } from "vitest";
import type { NeedyDriver, TaskExperienceState } from "../realtime/types.js";

/**
 * One stub factory for {@link NeedyDriver}, shared by every test that needs a fake driver.
 *
 * There were three hand-rolled copies of this object across the suite. When `raiseSos` was added
 * to the interface all three broke at once — which is the good outcome, but it is also a small
 * echo of the bug this whole change is about: duplicated definitions of the same contract drift,
 * and the copy nobody is looking at is the one that goes wrong.
 *
 * `raiseSos` deliberately defaults to resolving `null` — the FAILURE case. A stub that defaulted
 * to success would let a component that never awaits the ack, or that renders "help is coming"
 * regardless of the result, pass silently. That is precisely the defect being fixed, so the
 * default must not paper over it; a test asserting the success path has to opt into it.
 */
export function stubNeedyDriver(
  state: TaskExperienceState,
  overrides: Partial<NeedyDriver> = {},
): NeedyDriver {
  return {
    getState: () => state,
    subscribe: () => () => {},
    start: vi.fn(),
    requestHelp: vi.fn(),
    advanceTo: vi.fn(),
    sendMessage: vi.fn(),
    setTyping: vi.fn(),
    markRead: vi.fn(),
    raiseSos: vi.fn(async () => null),
    cancelSos: vi.fn(async () => false),
    dispose: vi.fn(),
    ...overrides,
  };
}
