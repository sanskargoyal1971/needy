import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import type { Role } from "../auth/authClient.js";
import { useAuth } from "../auth/AuthProvider.js";
import { homeFor, loginWithReturn, paths } from "./paths.js";

/**
 * ── Route guards ───────────────────────────────────────────────────────────
 *
 * `AuthProvider` existed and was never consumed by anything. Nothing in the app knew whether a
 * user was signed in, what role they held, or whether their KYC had passed — so there was no
 * gate to place. These are that gate.
 *
 * Three rules, all of which the app previously broke by having no router at all:
 *   1. An unauthenticated visitor is sent to login WITH their destination remembered, so signing
 *      in returns them to where they were going instead of dumping them on a generic home.
 *   2. A wrong-role visitor is sent to their own home, never to a blank or broken screen.
 *   3. Nothing renders while the session is still resolving — a flash of the login screen for a
 *      user who is in fact signed in is both wrong and alarming.
 */

/** Shown while `AuthProvider` is restoring a session from cookies on first load. */
function SessionLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        color: "var(--needy-text-soft)",
        fontSize: 16,
      }}
    >
      One moment…
    </div>
  );
}

/**
 * Requires a signed-in user. Renders nested routes via `<Outlet>`.
 *
 * `loginPath` is a parameter because the admin tree sends its visitors to a DIFFERENT login at
 * an unlinked path — see the note in `AppRouter`. Bouncing an admin to the public phone-OTP
 * screen would quietly merge the two trust boundaries back into one.
 */
export function RequireAuth({ loginPath = paths.login }: { loginPath?: string }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") return <SessionLoading />;
  if (status === "signed-out") {
    return (
      <Navigate to={loginWithReturn(location.pathname + location.search, loginPath)} replace />
    );
  }
  return <Outlet />;
}

/**
 * Requires one of `allow`. Assumes `RequireAuth` ran first.
 *
 * `both` is expanded by the caller rather than special-cased here, so each route states exactly
 * which roles it serves and there is no hidden rule about which roles imply which others.
 */
export function RequireRole({ allow }: { allow: readonly Role[] }) {
  const { status, user } = useAuth();

  if (status === "loading") return <SessionLoading />;
  // Not signed in at all — let RequireAuth own that redirect rather than duplicating it.
  if (!user) return <Navigate to={paths.login} replace />;
  if (!allow.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <Outlet />;
}

/**
 * Requires a verified helper.
 *
 * The backend already refuses to offer tasks to an unverified helper — `findEligibleHelpers`
 * filters on KYC. Without this gate that correct server behaviour surfaces on the client as a
 * dashboard that simply never receives work, with nothing on screen explaining why. So an
 * unverified helper is routed to the verification screen instead, which is the one thing they
 * can actually act on.
 */
export function RequireKyc() {
  const { status, user } = useAuth();

  if (status === "loading") return <SessionLoading />;
  if (!user) return <Navigate to={paths.login} replace />;
  if (user.kycStatus !== "verified") return <Navigate to={paths.helperVerify} replace />;
  return <Outlet />;
}

/**
 * For the login routes: a user who is already signed in should not see a login form.
 *
 * Honours `?next=` so that arriving at `/login?next=/helper` with a live session lands on
 * `/helper` rather than bouncing to a generic home and losing the destination.
 */
export function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === "loading") return <SessionLoading />;
  if (status === "signed-in" && user) {
    const next = new URLSearchParams(location.search).get("next");
    // `safeReturnTo` is applied at the login screen itself, where the sign-in actually
    // completes; here we only need the already-authed shortcut.
    return <Navigate to={next && next.startsWith("/") && !next.startsWith("//") ? next : homeFor(user.role)} replace />;
  }
  return <>{children}</>;
}
