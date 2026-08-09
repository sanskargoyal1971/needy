"use client";

import { useMemo, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { RealNeedyClient, RealtimeProvider } from "@/realtime";
import { MotionPreferencesProvider } from "@/motion/preferences";
import { useAuth } from "@/auth/AuthProvider";
import { AppGate } from "@/auth/AppGate";
import { API_BASE, SUPPORT_PHONE } from "@/lib/apiConfig";

/** ── The requester's live session ──────────────────────────────────────────
 *  Mounts `RealNeedyClient` once per signed-in session and puts it behind `RealtimeProvider`.
 *
 *  Until this file existed, NOTHING in the app constructed a driver. Both clients — the
 *  486-line requester one and the 730-line helper one — were complete, tested implementations
 *  of the whole protocol that no screen ever instantiated, because the seven stage components
 *  they were written for were dropped when the two front ends were consolidated into Next.
 *  The transport survived the move; only the screens did not.
 *
 *  The driver is memoised on `userId` alone, and that is deliberate. It owns a Socket.io
 *  Manager across four namespaces, a presence heartbeat and a reconnect→`/snapshot` resync;
 *  rebuilding it on any other render would tear down and re-establish all of that mid-task.
 *  Disposal goes through the shared StrictMode-safe refcount inside the provider.
 *
 *  No `token` is passed. The socket handshake reads the httpOnly access cookie — there is
 *  nothing for a script to forward, which is the entire point of the cookies being unreadable.
 */
export function RequesterShell({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const userId = state.status === "authenticated" ? state.user.id : null;

  const driver = useMemo(
    () => (userId ? new RealNeedyClient({ baseUrl: API_BASE, userId }) : null),
    [userId],
  );

  return (
    <AppGate>
      {driver ? (
        // `MotionPreferencesProvider` wraps the experience because its context default is
        // `reduced: false` — without a provider the OS's prefers-reduced-motion setting is
        // silently ignored, and every primitive falls back to its animated branch. For an
        // audience that skews elderly, and on screens whose whole job is a moving map and a
        // pulsing alarm, that is not a cosmetic default to leave unmounted.
        <MotionPreferencesProvider>
          <RealtimeProvider driver={driver} supportPhone={SUPPORT_PHONE}>
            {children}
          </RealtimeProvider>
        </MotionPreferencesProvider>
      ) : (
        // `AppGate` is already redirecting in this state; the spinner just avoids a frame of
        // nothing while it decides.
        <div className="flex min-h-[60vh] items-center justify-center">
          <Loader2 className="animate-spin text-primary" aria-label="Loading" />
        </div>
      )}
    </AppGate>
  );
}
