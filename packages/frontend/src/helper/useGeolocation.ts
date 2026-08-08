import { useEffect, useRef, useState } from "react";
import type { LatLng } from "@needy/shared";

export interface GeolocationExtras {
  heading?: number;
  speedMps?: number;
}

export interface UseGeolocationResult {
  /** Human-readable, actionable reason there is no position, or null while things are fine. */
  error: string | null;
  /** Whether a watch is currently open. Exposed mainly so tests and the UI can assert the
   *  battery-relevant claim that we are NOT watching while unavailable. */
  watching: boolean;
}

/**
 * A `watchPosition` subscription, opened only while `enabled`.
 *
 * WHY A WATCH AND NOT A POLL: the browser coalesces a watch onto the platform's own location
 * updates, so it delivers a fix when the device actually moves rather than waking the GPS on a
 * timer. For a helper walking a few hundred metres that is the difference between a plausible
 * battery cost and an app they uninstall.
 *
 * WHY IT IS GATED: a watch held while the helper is neither available nor on a task costs
 * battery and collects location data for no purpose. Consent for "find helpers near me" does not
 * extend to "track me while I'm not offering to help", so the subscription's lifetime is tied to
 * the availability toggle (see AvailabilityPanel) and torn down the moment it goes off.
 *
 * The callback is held in a ref so a re-render with a fresh closure does NOT tear down and
 * re-open the watch — restarting a GPS watch on every render would produce a permission-prompt
 * flicker on some browsers and drop the platform's accumulated fix quality on all of them.
 */
export function useGeolocation({
  enabled,
  onPosition,
}: {
  enabled: boolean;
  onPosition: (point: LatLng, extras: GeolocationExtras) => void;
}): UseGeolocationResult {
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;

  useEffect(() => {
    if (!enabled) {
      setWatching(false);
      setError(null);
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      // Not a failure to apologise for, but the helper does need to know why no requests come.
      setError("This device can't share its location, so we can't send you nearby requests.");
      return;
    }

    setError(null);
    setWatching(true);
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setError(null);
        const { latitude, longitude, heading, speed } = pos.coords;
        // Guard the numbers before they leave the client: the server validates too (audit B7),
        // but a NaN here would be refused with an error banner that says nothing useful, and
        // some browsers report heading/speed as NaN when stationary rather than null.
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
        onPositionRef.current(
          { lat: latitude, lng: longitude },
          {
            ...(heading != null && Number.isFinite(heading) ? { heading } : {}),
            ...(speed != null && Number.isFinite(speed) && speed >= 0 ? { speedMps: speed } : {}),
          },
        );
      },
      (err) => {
        setError(geolocationMessage(err));
      },
      {
        // Worth the extra power: matching ranks candidates by distance, and a 1km-accurate fix
        // would put a helper in the wrong queue position or outside the radius entirely.
        enableHighAccuracy: true,
        // A fix up to 15s old is fine for "roughly where am I" and avoids a cold GPS start.
        maximumAge: 15_000,
        timeout: 20_000,
      },
    );

    return () => {
      navigator.geolocation.clearWatch(id);
      setWatching(false);
    };
  }, [enabled]);

  return { error, watching };
}

/** Map the browser's numeric codes onto what the helper can actually do about each. */
function geolocationMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Location is switched off for this site, so we can't send you nearby requests. You can turn it on in your browser's settings for this page.";
    case err.POSITION_UNAVAILABLE:
      return "We can't work out where you are just now. Moving somewhere with a clearer view of the sky usually fixes it.";
    case err.TIMEOUT:
      return "Finding your location is taking a while. We'll keep trying.";
    default:
      return "We couldn't get your location. We'll keep trying.";
  }
}
