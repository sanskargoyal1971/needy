"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { canTransact } from "@needy/shared";
import { useAuth } from "./AuthProvider";
import { homeFor, loginWithReturn, paths } from "@/lib/paths";
import type { Role } from "@/lib/authClient";

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
/** Roles allowed on an admin surface. Kept next to the gate so the two checks below cannot
 *  drift apart. */
const isStaff = (role: Role): boolean => role === "admin" || role === "super_admin";

/** Which participant a surface is for. Mirrors `REQUESTER_ROLES` / `HELPER_ROLES` on the API,
 *  which is where this is actually enforced — the gate only saves someone a screen whose
 *  every action would be refused. */
export type Audience = "requester" | "helper";
const inAudience = (role: Role, audience: Audience | undefined): boolean =>
  audience === undefined || role === "both" || role === audience;

export function AppGate({
  children,
  /** Require the admin role as well. Admin screens compose both checks. */
  requireAdmin = false,
  /** Require an account of this kind. A helper-only account has no requester home, and the
   *  other way round; each is sent to its own. */
  audience,
}: {
  children: ReactNode;
  requireAdmin?: boolean;
  audience?: Audience;
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
    // `super_admin` is strictly above `admin` and must reach every admin screen — the API
    // says the same thing in `satisfiesRole`. Comparing to the single string "admin" is how
    // a new role silently loses access to surfaces it outranks.
    if (requireAdmin && !isStaff(role)) {
      router.replace(homeFor(role, onboardingStatus));
      return;
    }
    if (!inAudience(role, audience)) {
      router.replace(homeFor(role, onboardingStatus));
    }
  }, [state, router, requireAdmin, audience]);

  const allowed =
    state.status === "authenticated" &&
    canTransact(state.user.onboardingStatus) &&
    (!requireAdmin || isStaff(state.user.role)) &&
    inAudience(state.user.role, audience);

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
