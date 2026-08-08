import { useEffect, useMemo } from "react";
import { API_BASE, SUPPORT_PHONE } from "../apiConfig.js";
import { useAuth } from "../auth/AuthProvider.js";
import { TaskExperience } from "../experience/TaskExperience.js";
import { RealNeedyClient, RealtimeProvider } from "../realtime/index.js";
import { useActiveTask } from "./useActiveTask.js";

/**
 * ── The requester's app, on a real session ─────────────────────────────────
 *
 * What this replaces: `ExperienceDemo`, which minted a random `req-xxxxxx` id, POSTed to
 * `/dev/token` for a bearer token, created a hardcoded "Pick up medicine" task in Bangalore, and
 * wired the driver to that. Every part of that is a harness. Here the identity comes from
 * `AuthProvider` (the session is the source of truth, per the audit's B13 fix — the driver is
 * *told* who we are, it never guesses), and the transport authenticates with the httpOnly
 * cookies the browser already holds, so no token is constructed or handled in JS at all.
 */
export function RequesterApp() {
  const { user } = useAuth();
  // Guarded by RequireAuth upstream; this satisfies the type and would be a real bug if hit.
  const userId = user?.id ?? "";

  // One driver per identity. Keyed on userId so signing out and back in as someone else
  // builds a fresh client rather than reusing a socket authenticated as the previous user.
  const driver = useMemo(
    () => new RealNeedyClient({ baseUrl: API_BASE, userId }),
    [userId],
  );

  const active = useActiveTask(Boolean(userId));

  useEffect(() => {
    if (active.status === "ready" && active.taskId) driver.start(active.taskId);
  }, [active, driver]);

  return (
    <RealtimeProvider driver={driver} supportPhone={SUPPORT_PHONE}>
      {active.status === "loading" && <Centered>Checking for anything in progress…</Centered>}
      {active.status === "error" && (
        <Centered>
          We couldn&apos;t check whether you have a request open. Please check your connection and
          reload.
        </Centered>
      )}
      {active.status === "ready" && (active.taskId ? <TaskExperience /> : <NoActiveRequest />)}
    </RealtimeProvider>
  );
}

/**
 * The signed-in requester with nothing in flight.
 *
 * Carries NO "ask for help" button, because there is still no task-creation screen to open —
 * the only thing that has ever created a task is the demo harness's hardcoded POST. Shipping a
 * button here that routed nowhere would repeat the exact defect this pass removed from the SOS
 * control, the rating button and the cancel flow. The empty state says plainly where things
 * stand; the creation flow is the next piece of work, and this is where it will land.
 */
function NoActiveRequest() {
  return (
    <main style={{ maxWidth: 420, margin: "0 auto", padding: "48px 20px" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 10px" }}>You have no request open</h1>
      <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: "var(--needy-text-soft)" }}>
        When you ask for help, this is where you&apos;ll watch someone real make their way to you.
      </p>
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      style={{
        display: "grid",
        placeItems: "center",
        minHeight: 240,
        padding: "0 20px",
        textAlign: "center",
        fontSize: 16,
        lineHeight: 1.55,
        color: "var(--needy-text-soft)",
      }}
    >
      {children}
    </div>
  );
}
