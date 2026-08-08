import { useMemo } from "react";
import {
  useDriver,
  useHelperDriver,
  useHelperExperience,
  useTaskExperience,
} from "../realtime/index.js";
import type { SosPort } from "./sosPort.js";

/**
 * Adapters from each side's view-model to the shared {@link SosPort}.
 *
 * These are the ONLY role-aware part of the SOS feature. Everything a user actually sees and
 * taps — the sheet, the sending state, the failure notice, the live banner, the stand-down —
 * lives in one implementation behind this seam, so the two sides cannot drift apart again.
 */

export function useRequesterSosPort(): SosPort {
  const { sos, userId, task } = useTaskExperience();
  const driver = useDriver();
  return useMemo(
    () => ({
      sos,
      userId,
      // A task in a terminal state can no longer be escalated — the server refuses it, and
      // offering a button that will be rejected is exactly the false promise this feature is
      // about. `searching` is deliberately INCLUDED: a requester waiting alone for a match may
      // well be the one who needs help, and there is a real task row to attach the alert to.
      hasTask: task != null && task.state !== "completed" && task.state !== "cancelled",
      raiseSos: driver.raiseSos.bind(driver),
      cancelSos: driver.cancelSos.bind(driver),
    }),
    [sos, userId, task, driver],
  );
}

export function useHelperSosPort(): SosPort {
  const { sos, userId, task } = useHelperExperience();
  const driver = useHelperDriver();
  return useMemo(
    () => ({
      sos,
      userId,
      hasTask: task != null && task.state !== "completed" && task.state !== "cancelled",
      raiseSos: driver.raiseSos.bind(driver),
      cancelSos: driver.cancelSos.bind(driver),
    }),
    [sos, userId, task, driver],
  );
}
