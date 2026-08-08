import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { authClient, AuthError } from "../auth/authClient.js";
import { useAuth } from "../auth/AuthProvider.js";
import { paths } from "./paths.js";

/**
 * ── The helper's KYC gate ──────────────────────────────────────────────────
 *
 * The backend has exposed `/auth/kyc/start` and `/auth/kyc/status` all along, and the matching
 * engine already filters candidates on `kycStatus === "verified"`. There were zero frontend
 * screens for any of it — so no helper could ever actually become verified, which meant no
 * helper could ever receive an offer, which meant the "KYC-verified helper" promise the entire
 * match-reveal UI is built around had nothing behind it.
 *
 * This is the screen that closes that loop. It is deliberately the ONLY thing an unverified
 * helper can reach (see `RequireKyc`), because a dashboard that silently never receives work is
 * indistinguishable from a broken app.
 */

/** How often we re-check a pending verification. The provider callback is server-to-server, so
 *  the client has no push signal — it has to ask. Slow enough not to hammer the endpoint, fast
 *  enough that someone who has just finished the provider flow isn't left staring. */
const POLL_MS = 5_000;

export function HelperVerify() {
  const { user, refreshUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const status = user?.kycStatus ?? "unverified";

  // While verification is pending, poll until the provider's callback lands. `refreshUser` is
  // what actually updates the session — `kycStatus` is a claim in the access token, so the
  // guard upstream only opens once the user record has been re-read.
  useEffect(() => {
    if (status !== "pending") return;
    pollRef.current = setInterval(() => {
      void authClient
        .kycStatus()
        .then((res) => {
          if (res.kycStatus !== "pending") void refreshUser();
        })
        .catch(() => {
          /* transient — the next tick tries again rather than surfacing a scary error */
        });
    }, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status, refreshUser]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { verificationUrl } = await authClient.startKyc();
      await refreshUser();
      // Hand off to the provider. A full navigation rather than a popup: popups are blocked on
      // mobile far more often than not, and losing the handoff silently here would strand the
      // helper on a screen that says "we're waiting" while nothing was ever started.
      window.location.href = verificationUrl;
    } catch (err) {
      setError(
        err instanceof AuthError && err.code === "network-unreachable"
          ? "We can't reach Needy right now. Please check your internet connection and try again."
          : "We couldn't start your verification just now. Please try again in a moment.",
      );
      setBusy(false);
    }
  }, [refreshUser]);

  if (status === "verified") return <Navigate to={paths.helperHome} replace />;

  return (
    <main style={S.page}>
      <div style={S.card}>
        <h1 style={S.title}>Let&apos;s verify who you are</h1>

        <div aria-live="polite">
          {error && (
            <p role="alert" style={S.error}>
              {error}
            </p>
          )}
        </div>

        {status === "pending" ? (
          <>
            <p style={S.body}>
              We&apos;re checking your documents now. This usually takes a few minutes. You can
              leave this page — we&apos;ll have it done when you come back.
            </p>
            <p style={S.hint} role="status">
              Checking for an update…
            </p>
          </>
        ) : (
          <>
            <p style={S.body}>
              {status === "rejected"
                ? "We weren't able to verify your documents last time. This is usually a blurry photo or a document that had expired — you can try again below."
                : "Before you can help someone, we check that you are who you say you are. It takes a couple of minutes: a photo of your ID, and a short selfie so we know the ID is yours."}
            </p>
            <p style={S.hint}>
              We do this for every single helper. It&apos;s the reason someone can open their door
              to you.
            </p>
            <button onClick={() => void start()} disabled={busy} style={S.primary}>
              {busy ? "Starting…" : status === "rejected" ? "Try verification again" : "Start verification"}
            </button>
          </>
        )}
      </div>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100dvh",
    display: "grid",
    placeItems: "center",
    padding: 20,
    background: "var(--needy-bg)",
  },
  card: {
    width: "100%",
    maxWidth: 460,
    background: "var(--needy-surface)",
    border: "1px solid var(--needy-border)",
    borderRadius: 20,
    padding: "32px 28px",
  },
  title: { margin: "0 0 14px", fontSize: 28, letterSpacing: "-0.02em" },
  body: { margin: "0 0 12px", fontSize: 17, lineHeight: 1.6, color: "var(--needy-text)" },
  hint: { margin: "0 0 20px", fontSize: 16, lineHeight: 1.55, color: "var(--needy-text-soft)" },
  primary: {
    width: "100%",
    minHeight: 56,
    fontSize: 18,
    fontWeight: 700,
    borderRadius: 14,
    border: "none",
    background: "var(--needy-warm)",
    color: "#fff",
    cursor: "pointer",
  },
  error: {
    fontSize: 16,
    lineHeight: 1.5,
    color: "#8c2f22",
    margin: "0 0 12px",
    fontWeight: 600,
  },
};
