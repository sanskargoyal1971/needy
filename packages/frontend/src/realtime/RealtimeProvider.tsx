import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
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
}: {
  driver: NeedyDriver;
  children: ReactNode;
}) {
  // Tear the driver down when it's swapped or the tree unmounts.
  useEffect(() => () => driver.dispose(), [driver]);
  return <DriverContext.Provider value={driver}>{children}</DriverContext.Provider>;
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
