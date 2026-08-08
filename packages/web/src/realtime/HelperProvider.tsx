"use client";

import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { ExperienceErrorBoundary } from "../lib/ExperienceErrorBoundary";
import { useDriverLifecycle } from "./driverLifecycle.js";
import type { HelperDriver, HelperExperienceState } from "./helperTypes.js";

/**
 * Binds a {@link HelperDriver} to React, exactly as {@link RealtimeProvider} does for the
 * requester side: the driver is an external store read through useSyncExternalStore, and its
 * disposal goes through the shared StrictMode-safe refcount (audit C21) rather than a second
 * copy of that rule.
 *
 * A separate context, not a second value on the requester's, because the two states have
 * nothing in common structurally — see the note at the top of helperTypes.ts.
 */
const HelperContext = createContext<HelperDriver | null>(null);

export function HelperProvider({
  driver,
  children,
  supportPhone,
}: {
  driver: HelperDriver;
  children: ReactNode;
  /** Passed to the error-boundary fallback so it can offer a real human to call. */
  supportPhone?: string;
}) {
  useDriverLifecycle(driver);

  // The boundary sits INSIDE the provider (audit C22) so a throw in the helper tree is caught
  // while the provider — and therefore the live socket, the availability publish loop and any
  // accepted task — survives to be reused by the recovered tree. A helper mid-task is standing
  // in someone's doorway; losing their session to a render error is not an acceptable outcome.
  return (
    <HelperContext.Provider value={driver}>
      <ExperienceErrorBoundary supportPhone={supportPhone}>{children}</ExperienceErrorBoundary>
    </HelperContext.Provider>
  );
}

export function useHelperDriver(): HelperDriver {
  const driver = useContext(HelperContext);
  if (!driver) throw new Error("useHelperDriver must be used within <HelperProvider>");
  return driver;
}

export function useHelperExperience(): HelperExperienceState {
  const driver = useHelperDriver();
  return useSyncExternalStore(
    (cb) => driver.subscribe(cb),
    () => driver.getState(),
    () => driver.getState(),
  );
}
