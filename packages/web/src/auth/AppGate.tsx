"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { canTransact } from "@needy/shared";
import { useAuth } from "./AuthProvider";
import { homeFor, loginWithReturn, paths } from "@/lib/paths";

/** ── Client route guard ────────────────────────────────────────────────────
 *  Wraps every screen that requires an approved account. Phase 1 ships the guard; the app
 *  routes it protects arrive with the requester and helper surfaces.
 *
 *  This is a REDIRECT, not a security control. The security control is `requireOnboarded` on
 *  the API and the socket handshake gate — both of which read the database on every request
 *  and cannot be talked out of it by a client. Anyone can bypass this component by disabling
 *  JavaScript; they would then reach a page whose every request returns 403, which is the
 *  correct outcome. What this fixes is the experience: without it a rejected user clicking a
 *  bookmark gets a 404 or a broken dashboard instead of being told where they stand.
 *
 *  Deliberately NOT Next middleware. Middleware runs at the edge with only the cookies, and
 *  onboarding status lives in Postgres precisely so a reviewer's decision takes effect
 *  immediately rather than at token expiry. Putting the status in the JWT to make middleware
 *  possible would reintroduce exactly the staleness the server-side gate was designed to
 *  avoid — a user rejected at 10:00 keeping access until their token expired.
 */
export function AppGate({
  children,
  /** Require the admin role as well. Admin screens compose both checks. */
  requireAdmin = false,
}: {
  children: ReactNode;
  requireAdmin?: boolean;
}) {
  const router = useRouter();
  const { state } = useAuth();

  useEffect(() => {
    if (state.status === "loading") return;

    if (state.status === "anonymous") {
      // Remember where they were headed so login can return them there. `safeReturnTo` on the
      // other side refuses anything that isn't a local path.
      const here = typeof window !== "undefined" ? window.location.pathname : paths.landing;
      router.replace(loginWithReturn(here));
      return;
    }

    const { role, onboardingStatus } = state.user;
    if (!canTransact(onboardingStatus)) {
      // `homeFor` decides between the wizard, the waiting screen and the terminal lock — one
      // function owns that mapping so this guard and the login redirect can never disagree.
      router.replace(homeFor(role, onboardingStatus));
      return;
    }
    if (requireAdmin && role !== "admin") {
      router.replace(homeFor(role, onboardingStatus));
    }
  }, [state, router, requireAdmin]);

  const allowed =
    state.status === "authenticated" &&
    canTransact(state.user.onboardingStatus) &&
    (!requireAdmin || state.user.role === "admin");

  if (!allowed) {
    // Render the spinner rather than the children while deciding. Flashing a dashboard for one
    // frame before redirecting is how a rejected user sees a screen they were refused.
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="animate-spin text-primary" aria-label="Loading" />
      </div>
    );
  }

  return <>{children}</>;
}
