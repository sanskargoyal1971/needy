import { useEffect, useState } from "react";
import type { SessionSnapshot } from "@needy/shared";
import { API_BASE } from "../apiConfig.js";

/**
 * Which task, if any, this user is currently in.
 *
 * The drivers resync from `GET /snapshot` on every (re)connect, but only once they have been
 * told a task id via `start()`. Something has to discover that id in the first place, and the
 * demo harness "solved" it by creating a brand-new hardcoded task on every load. A real session
 * has to ask the server what is already in flight — otherwise reopening the app mid-task shows
 * an empty home while a helper is physically on their way.
 */
type State =
  | { status: "loading" }
  | { status: "ready"; taskId: string | null }
  | { status: "error" };

export function useActiveTask(enabled: boolean): State {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/snapshot`, { credentials: "include" });
        if (!res.ok) throw new Error(`snapshot ${res.status}`);
        const snap = (await res.json()) as SessionSnapshot;
        if (!alive) return;
        // `activeTasks` excludes terminal states server-side, so the first entry is a genuinely
        // live task. A user with several is out of scope for this pass — the product is
        // one-request-at-a-time — but taking [0] rather than assuming exactly one keeps that
        // from becoming a crash if the invariant ever changes.
        setState({ status: "ready", taskId: snap.activeTasks[0]?.task.id ?? null });
      } catch {
        if (alive) setState({ status: "error" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled]);

  return state;
}
