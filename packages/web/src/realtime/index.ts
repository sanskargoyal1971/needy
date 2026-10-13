export * from "./types.js";
export { RealNeedyClient, type RealClientOptions } from "./socketClient.js";
export { MockNeedyClient } from "./mockDriver.js";
export { RealtimeProvider, useDriver, useTaskExperience } from "./RealtimeProvider.js";
export { nextMilestone } from "./milestones.js";

// ── helper side (C2: the helper UI had no client at all) ─────────────────────
export {
  initialHelperState,
  type HelperDriver,
  type HelperExperienceState,
} from "./helperTypes.js";
export { RealHelperClient, type HelperClientOptions } from "./helperClient.js";
export { HelperProvider, useHelperDriver, useHelperExperience } from "./HelperProvider.js";
export { useDriverLifecycle, type Disposable } from "./driverLifecycle.js";
