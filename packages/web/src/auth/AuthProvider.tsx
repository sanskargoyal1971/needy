"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { authClient, AuthError, type PublicUser } from "@/lib/authClient";

/** ── Session state ─────────────────────────────────────────────────────────
 *  There is deliberately no token in here, and nothing in localStorage.
 *
 *  Access and refresh tokens are httpOnly cookies set by the backend, so JS cannot read them
 *  and an XSS payload has nothing to exfiltrate. The consequence for this component is that
 *  "am I logged in" is not a value we hold — it is a question only the server can answer, via
 *  `/auth/me`. Hence the explicit `loading` state: on first paint we genuinely do not know,
 *  and rendering a signed-out header before the answer arrives is the flicker that makes an
 *  app feel broken.
 */
export type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: PublicUser };

interface AuthContextValue {
  state: AuthState;
  /** Convenience accessor — null unless authenticated. */
  user: PublicUser | null;
  /** Re-read the session from the server. Call after any mutation that changes the user. */
  refresh: () => Promise<void>;
  /** Replace the cached user without a round trip, when a mutation already returned one. */
  setUser: (user: PublicUser) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * How often to rotate the session while the tab is open.
 *
 * The access cookie lives 15 minutes (AUTH_ACCESS_TTL_SECONDS). Refreshing at 10 keeps a
 * long-lived tab signed in without waiting for a request to fail first — which matters here
 * because the request that would fail is often a socket handshake, and a dropped realtime
 * connection mid-task is exactly the moment a user needs the app to work.
 */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  // Guards against a state update after unmount (React 18 StrictMode double-invokes effects
  // in dev, and the two bootstrap requests can land in either order).
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const { user } = await authClient.me();
      if (alive.current) setState({ status: "authenticated", user });
    } catch (err) {
      // A 401 here is the ordinary signed-out case, not an error worth surfacing. Anything
      // else (network down, 500) also lands as anonymous: the app must still render, and the
      // gated routes will fail closed on their own when the user tries to act.
      if (!(err instanceof AuthError) || err.status !== 401) {
        console.warn("session bootstrap failed", err);
      }
      if (alive.current) setState({ status: "anonymous" });
    }
  }, []);

  // Bootstrap. `/auth/me` alone is not enough: the access cookie may have expired while the
  // tab was closed, in which case only the refresh cookie survives. Try a rotation before
  // concluding the user is signed out — otherwise every return visit lands on the login page
  // despite a perfectly valid 30-day session.
  useEffect(() => {
    void (async () => {
      try {
        const { user } = await authClient.me();
        if (alive.current) setState({ status: "authenticated", user });
        return;
      } catch (err) {
        if (!(err instanceof AuthError) || err.status !== 401) {
          if (alive.current) setState({ status: "anonymous" });
          return;
        }
      }
      try {
        const { user } = await authClient.refresh();
        if (alive.current) setState({ status: "authenticated", user });
      } catch {
        if (alive.current) setState({ status: "anonymous" });
      }
    })();
  }, []);

  // Keep the session warm while the tab lives. Only while authenticated: rotating on an
  // anonymous tab is a pointless request every ten minutes.
  useEffect(() => {
    if (state.status !== "authenticated") return;
    const id = setInterval(() => {
      void authClient.refresh().catch(() => {
        // A failed rotation means the session is genuinely gone (revoked, expired, or the
        // account was blocked). Drop to anonymous so the UI stops pretending otherwise.
        if (alive.current) setState({ status: "anonymous" });
      });
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [state.status]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      user: state.status === "authenticated" ? state.user : null,
      refresh: load,
      setUser: (user) => setState({ status: "authenticated", user }),
      logout: async () => {
        // Optimistically anonymous: if the network call fails the cookies may survive, but
        // leaving the UI in a signed-in state after the user asked to leave is worse — on a
        // shared device that is the whole point of the button.
        setState({ status: "anonymous" });
        await authClient.logout().catch(() => undefined);
      },
    }),
    [state, load],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
