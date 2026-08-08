import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { ExperienceErrorBoundary } from "../experience/ExperienceErrorBoundary.js";
import { useDriverLifecycle } from "./driverLifecycle.js";
import type { NeedyDriver, TaskExperienceState } from "./types.js";

/**
 * Binds any {@link NeedyDriver} (real socket client or scripted mock) to React. The driver is
 * an external store; components read the consolidated task view via useSyncExternalStore, so
 * there's no prop-drilling of socket state and no re-render storms — only the slices a
 * component reads cause it to update.
 */
const DriverContext = createContext<NeedyDriver | null>(null);

export function RealtimeProvider({
  driver,
  children,
  supportPhone,
}: {
  driver: NeedyDriver;
  children: ReactNode;
  /** Passed to the error-boundary fallback so it can offer a real human to call. */
  supportPhone?: string;
}) {
  // StrictMode-safe disposal (audit C21). The refcount-and-defer rule lives in
  // driverLifecycle.ts so the helper provider enforces exactly the same one.
  useDriverLifecycle(driver);

  // The boundary sits INSIDE the provider (audit C22): every consumer of the driver is behind
  // it, so a throw anywhere in the experience tree is caught, while the provider itself — and
  // therefore the driver and its live socket — survives to be reused by the recovered tree.
  // (The boundary lives under experience/ because its copy is experience copy; it imports
  // nothing from realtime/, so there's no cycle.)
  return (
    <DriverContext.Provider value={driver}>
      <ExperienceErrorBoundary supportPhone={supportPhone}>{children}</ExperienceErrorBoundary>
    </DriverContext.Provider>
  );
}

export function useDriver(): NeedyDriver {
  const driver = useContext(DriverContext);
  if (!driver) throw new Error("useDriver must be used within <RealtimeProvider>");
  return driver;
}

/** The live consolidated task view. Re-renders only when the driver notifies a change. */
export function useTaskExperience(): TaskExperienceState {
  const driver = useDriver();
  return useSyncExternalStore(
    (cb) => driver.subscribe(cb),
    () => driver.getState(),
    () => driver.getState(),
  );
}
