"use client";

import { useEffect, useState } from "react";
import type { HelperDriver } from "@/realtime";

/** What the browser is telling us about where the helper is. */
export type PositionStatus =
  | "idle"
  | "locating"
  | "tracking"
  | "denied"
  | "unavailable";

/** ── The helper's position, fed to the driver ──────────────────────────────
 *  A `watchPosition` subscription that stays open for as long as the helper is either
 *  advertising availability or holding a live task, and is torn down the moment they are
 *  neither.
 *
 *  Two things this exists to get right.
 *
 *  **It watches rather than polls.** `getCurrentPosition` on a timer is the obvious version and
 *  is worse on both counts that matter: it wakes the GPS on a fixed schedule whether or not the
 *  helper is moving, and it reports a walking helper's position in steps rather than as they
 *  move. `watchPosition` lets the platform decide, which is what a phone's location stack is
 *  for.
 *
 *  **It stops when it should.** The subscription is keyed on whether the helper is actually
 *  advertising or working. A location watch left running while someone is signed in but not
 *  available is a battery cost with nothing on the other end of it, and — more to the point —
 *  it is tracking a person who has said they are off duty.
 *
 *  The driver decides where each fix GOES (idle → `/presence` availability, on a live task →
 *  `/tracking`); this hook only decides when to ask for one. That split is deliberate: it is the
 *  audit's A1 rule, and it belongs in one place rather than being re-derived by every caller.
 */
export function usePositionReporting(
  driver: HelperDriver,
  active: boolean,
): PositionStatus {
  const [status, setStatus] = useState<PositionStatus>("idle");

  useEffect(() => {
    if (!active) {
      setStatus("idle");
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("unavailable");
      return;
    }

    setStatus("locating");
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setStatus("tracking");
        driver.reportPosition(
          { lat: pos.coords.latitude, lng: pos.coords.longitude },
          {
            // Passed through only when the device actually measured them. A heading of 0 from
            // a stationary phone would point the requester's marker due north and look like a
            // real bearing; `null` from the platform means "unknown" and must stay unknown.
            ...(pos.coords.heading != null ? { heading: pos.coords.heading } : {}),
            ...(pos.coords.speed != null ? { speedMps: pos.coords.speed } : {}),
          },
        );
      },
      (err) => setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable"),
      {
        enableHighAccuracy: true,
        // A fix up to 15s old is fine to start from; beyond that, wait for a real one rather
        // than advertising a helper at a corner they left ten minutes ago.
        maximumAge: 15_000,
        timeout: 20_000,
      },
    );

    return () => navigator.geolocation.clearWatch(id);
  }, [driver, active]);

  return status;
}
