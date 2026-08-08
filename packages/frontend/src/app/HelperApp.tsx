import { useMemo } from "react";
import { API_BASE, SUPPORT_PHONE } from "../apiConfig.js";
import { useAuth } from "../auth/AuthProvider.js";
import { HelperShell } from "../helper/HelperShell.js";
import { HelperProvider, RealHelperClient } from "../realtime/index.js";

/**
 * ── The helper's app, on a real session ────────────────────────────────────
 *
 * `HelperShell` and its ~1,200 lines of panels were fully written, reviewed and reasoned about
 * — and mounted by nothing. There was no route to it and no client construction anywhere, so no
 * helper could ever open the half of the protocol that actually produces a match:
 * `publish-availability` had no caller and `offer`/`offer-closed` had no listener in any running
 * app. This is the twelve lines that were missing.
 *
 * Reached only through `RequireKyc`, so by the time this renders the helper is verified and the
 * server will genuinely consider them for offers.
 */
export function HelperApp() {
  const { user } = useAuth();
  const userId = user?.id ?? "";

  const driver = useMemo(
    () => new RealHelperClient({ baseUrl: API_BASE, userId }),
    [userId],
  );

  return (
    <HelperProvider driver={driver} supportPhone={SUPPORT_PHONE}>
      <HelperShell />
    </HelperProvider>
  );
}
