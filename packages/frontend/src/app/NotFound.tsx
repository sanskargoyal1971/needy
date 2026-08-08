import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider.js";
import { homeFor, paths } from "./paths.js";

/**
 * A real 404. There was none — the hash router fell through to the task experience for every
 * unrecognised route, so a mistyped or stale link silently rendered the app's main screen and
 * left the user to work out that they hadn't gone where they meant to.
 *
 * Sends signed-in users to their own home rather than the marketing landing page: someone who is
 * mid-task and follows a bad link wants their request back, not the front door.
 */
export function NotFound() {
  const { user } = useAuth();
  const home = user ? homeFor(user.role) : paths.landing;

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 420, display: "grid", gap: 12, justifyItems: "center" }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>We couldn&apos;t find that page</h1>
        <p style={{ margin: 0, fontSize: 17, lineHeight: 1.6, color: "var(--needy-text-soft)" }}>
          The link may be out of date, or it may have a typo in it. Nothing has gone wrong with
          your account.
        </p>
        <Link
          to={home}
          style={{
            marginTop: 6,
            minHeight: 52,
            display: "grid",
            placeItems: "center",
            padding: "0 24px",
            borderRadius: 14,
            background: "var(--needy-warm)",
            color: "#fff",
            fontSize: 17,
            fontWeight: 700,
            textDecoration: "none",
          }}
        >
          {user ? "Back to your home" : "Go to the home page"}
        </Link>
      </div>
    </main>
  );
}
