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
import { authClient, type PublicUser, type Role } from "./authClient.js";

/** ── Auth session state ────────────────────────────────────────────────────
 *  Holds the signed-in user and keeps the short-lived access cookie fresh. The access token
 *  lives ~15 minutes, so without a proactive refresh a user reading a page for a quarter of
 *  an hour would silently lose their socket authorization mid-task. */

type Status = "loading" | "signed-out" | "signed-in";

interface AuthState {
  status: Status;
  user: PublicUser | null;
  signIn: (phone: string, code: string) => Promise<PublicUser>;
  requestCode: (phone: string) => Promise<void>;
  signOut: () => Promise<void>;
  becomeHelper: () => Promise<PublicUser>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Refresh well before the 15-minute access TTL so a slow network or a suspended tab still
 *  has room to recover before the token actually lapses. */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<PublicUser | null>(null);
  /** Guards against a refresh timer firing after unmount and resurrecting state. */
  const aliveRef = useRef(true);

  // Restore an existing session on first load: the cookies may still be valid from a
  // previous visit, in which case the user should never see a login screen at all.
  useEffect(() => {
    aliveRef.current = true;
    void (async () => {
      try {
        const { user: me } = await authClient.me();
        if (!aliveRef.current) return;
        setUser(me);
        setStatus("signed-in");
      } catch {
        // The access cookie may merely have expired while the refresh cookie is still good.
        try {
          const { user: me } = await authClient.refresh();
          if (!aliveRef.current) return;
          setUser(me);
          setStatus("signed-in");
        } catch {
          if (!aliveRef.current) return;
          setStatus("signed-out");
        }
      }
    })();
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Keep the access cookie alive for as long as the user is signed in.
  useEffect(() => {
    if (status !== "signed-in") return;
    const timer = setInterval(() => {
      void authClient.refresh().catch(() => {
        // The refresh token itself has expired or been revoked — this is a real sign-out,
        // not a transient error, so surface it rather than leaving a dead session on screen.
        if (aliveRef.current) {
          setUser(null);
          setStatus("signed-out");
        }
      });
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [status]);

  const requestCode = useCallback(async (phone: string) => {
    await authClient.requestOtp(phone);
  }, []);

  const signIn = useCallback(async (phone: string, code: string) => {
    const { user: me } = await authClient.verifyOtp(phone, code);
    setUser(me);
    setStatus("signed-in");
    return me;
  }, []);

  const signOut = useCallback(async () => {
    // Clear locally even if the network call fails: the user asked to be signed out, and
    // leaving them looking signed-in because a request failed is the wrong failure mode.
    try {
      await authClient.logout();
    } finally {
      setUser(null);
      setStatus("signed-out");
    }
  }, []);

  const becomeHelper = useCallback(async () => {
    const role: Role = user?.role === "requester" ? "both" : "helper";
    const { user: updated } = await authClient.updateMe({ role });
    // The role lives in the access token's claims, so it must be rotated before the new role
    // has any effect on the API or the socket handshake.
    await authClient.refresh().catch(() => undefined);
    setUser(updated);
    return updated;
  }, [user?.role]);

  const refreshUser = useCallback(async () => {
    try {
      const { user: me } = await authClient.me();
      setUser(me);
    } catch {
      /* leave the existing user in place; the refresh timer owns session expiry */
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ status, user, signIn, requestCode, signOut, becomeHelper, refreshUser }),
    [status, user, signIn, requestCode, signOut, becomeHelper, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
