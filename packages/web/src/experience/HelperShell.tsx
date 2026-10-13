"use client";

import { useMemo, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { HelperProvider, RealHelperClient } from "@/realtime";
import { MotionPreferencesProvider } from "@/motion/preferences";
import { useAuth } from "@/auth/AuthProvider";
import { AppGate } from "@/auth/AppGate";
import { API_BASE, SUPPORT_PHONE } from "@/lib/apiConfig";

/** ── The helper's live session ─────────────────────────────────────────────
 *  The mirror of {@link RequesterShell}, and separate for the reason `helperTypes.ts` gives at
 *  length: a helper's world is a different shape, not a variant of the requester's. They hold
 *  no task most of the time, they publish idle availability on a timer, and they receive a
 *  *list* of competing offers rather than watching one task.
 *
 *  Memoised on `userId` for the same reason, with an additional one specific to this side: the
 *  driver runs the availability re-publish loop. Rebuilding it drops the helper out of the geo
 *  index until the next publish, and a helper who has silently stopped receiving offers has no
 *  symptom to notice — which is precisely the class of invisible failure the A1/A2 audit
 *  findings were about.
 */
export function HelperShell({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const userId = state.status === "authenticated" ? state.user.id : null;

  const driver = useMemo(
    () => (userId ? new RealHelperClient({ baseUrl: API_BASE, userId }) : null),
    [userId],
  );

  return (
    <AppGate audience="helper">
      {driver ? (
        // `MotionPreferencesProvider` wraps the experience because its context default is
        // `reduced: false` — without a provider the OS's prefers-reduced-motion setting is
        // silently ignored, and every primitive falls back to its animated branch. For an
        // audience that skews elderly, and on screens whose whole job is a moving map and a
        // pulsing alarm, that is not a cosmetic default to leave unmounted.
        <MotionPreferencesProvider>
          <HelperProvider driver={driver} supportPhone={SUPPORT_PHONE}>
            {children}
          </HelperProvider>
        </MotionPreferencesProvider>
      ) : (
        <div className="flex min-h-[60vh] items-center justify-center">
          <Loader2 className="animate-spin text-primary" aria-label="Loading" />
        </div>
      )}
    </AppGate>
  );
}
