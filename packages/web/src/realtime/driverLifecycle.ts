import { useEffect } from "react";

/** Anything that owns sockets/timers and must be torn down exactly once. */
export interface Disposable {
  dispose(): void;
}

/**
 * How many mounted providers currently hold each driver, plus whether a teardown is already
 * queued for it. A WeakMap so a discarded driver never pins this entry alive.
 *
 * WHY the refcount + deferral (audit C21): the original code was
 * `useEffect(() => () => driver.dispose(), [driver])`. React 18 StrictMode deliberately
 * mounts → unmounts → remounts every effect to smoke out exactly this class of bug, so the
 * initial driver was DISPOSED before first paint — timers cleared, socket listeners dropped,
 * subscriber set emptied — and the app only *looked* fine because the next user action re-armed
 * the mock's timers. A live socket client would have sat there dead.
 *
 * The fix has to distinguish a StrictMode remount from a genuine unmount, and React gives no
 * flag for that. What it does give is ordering: the double-invoke runs cleanup and the
 * re-setup back-to-back, synchronously, inside one commit. So we count holders and, when the
 * count reaches zero, only *schedule* disposal on the microtask queue. A StrictMode remount
 * bumps the count back to 1 before that microtask can run, and the queued teardown sees a live
 * holder and stands down. A real unmount — or a real driver swap, where the outgoing driver's
 * cleanup runs before the incoming driver's setup — leaves the count at zero, so the driver is
 * still torn down promptly and nothing leaks.
 *
 * Extracted here so the requester and helper providers share ONE implementation: this is a
 * subtle, test-covered rule about React's lifecycle, and two copies of it would drift the
 * moment either was touched.
 */
const holders = new WeakMap<Disposable, { count: number; teardownQueued: boolean }>();

/** Hold `driver` for as long as the calling component is mounted, disposing it once the last
 *  holder really goes away. See the note above for why disposal is deferred by a microtask. */
export function useDriverLifecycle(driver: Disposable): void {
  useEffect(() => {
    let entry = holders.get(driver);
    if (!entry) {
      entry = { count: 0, teardownQueued: false };
      holders.set(driver, entry);
    }
    const held = entry;
    held.count += 1;

    return () => {
      held.count -= 1;
      if (held.count > 0 || held.teardownQueued) return;
      held.teardownQueued = true;
      // Deferred by exactly one microtask — long enough for a StrictMode remount to re-claim
      // the driver, short enough that a real unmount tears down effectively immediately.
      void Promise.resolve().then(() => {
        held.teardownQueued = false;
        if (held.count === 0) driver.dispose();
      });
    };
  }, [driver]);
}
