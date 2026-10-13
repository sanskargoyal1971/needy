"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { AppGate } from "@/auth/AppGate";
import { authClient, AuthError } from "@/lib/authClient";
import { homeFor } from "@/lib/paths";
import { Button, Field, FormError, TextInput } from "@/components/ui";

/** ── Your password ─────────────────────────────────────────────────────────
 *  Where a password is set, changed, or given up.
 *
 *  Framed throughout as something OPTIONAL that you add. A one-time code needs nothing
 *  remembered, which for this platform's audience is genuinely the kinder default, and a screen
 *  that nagged people into inventing a password they will forget would make signing in harder
 *  rather than easier. So this explains what a password is for — getting in when the phone
 *  cannot receive a text — and leaves the choice alone.
 */

const MIN_LENGTH = 10;

export default function SecurityPage() {
  return (
    <AppGate>
      <Security />
    </AppGate>
  );
}

function Security() {
  const { state } = useAuth();
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  /**
   * Whether a password exists is read from the server, not remembered locally.
   *
   * `/auth/me` reports the fact and never the credential — the hash is not on the user object
   * at all, it lives behind its own repository method precisely so it cannot ride out to a
   * browser by being forgotten about.
   */
  const load = useCallback(async () => {
    try {
      const { user } = await authClient.me();
      setHasPassword(Boolean((user as { passwordSetAt?: number | null }).passwordSetAt));
    } catch {
      setHasPassword(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const home =
    state.status === "authenticated" ? homeFor(state.user.role, state.user.onboardingStatus) : "/";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);

    // Checked here as well as on the server, because a mismatch is the one mistake worth
    // catching before it costs a round trip and a wiped form.
    if (next !== confirm) {
      setError("Those two passwords don't match.");
      return;
    }
    if (next.length < MIN_LENGTH) {
      setError(
        `Please use at least ${MIN_LENGTH} characters. A few words you'll remember is ideal.`,
      );
      return;
    }

    setBusy(true);
    try {
      await authClient.setPassword(next, hasPassword ? current : undefined);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(
        hasPassword
          ? "Your password has been changed. Anywhere else you were signed in has been signed out."
          : "Your password is set. You can now sign in with it instead of a code.",
      );
      await load();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      await authClient.removePassword();
      setDone("Your password has been removed. Sign in with a code from now on.");
      await load();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-10 sm:px-6">
      <Link
        href={home}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft size={14} aria-hidden />
        Back
      </Link>

      <h1 className="mt-4 font-display text-3xl font-bold text-gray-900">
        Signing in to your account
      </h1>
      <p className="mt-2 text-gray-600">
        We&apos;ll always text you a code if you want one. A password is an extra way in — handy if
        you don&apos;t have your phone with you, or if texts aren&apos;t arriving.
      </p>

      {hasPassword == null ? (
        <div className="flex justify-center py-12">
          <Loader2 className="animate-spin text-primary" aria-label="Loading" />
        </div>
      ) : (
        <>
          <div
            className={`mt-6 flex items-start gap-3 rounded-2xl p-4 ${
              hasPassword ? "bg-emerald-50 text-emerald-900" : "bg-gray-50 text-gray-700"
            }`}
          >
            {hasPassword ? (
              <ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-700" aria-hidden />
            ) : (
              <KeyRound size={18} className="mt-0.5 shrink-0 text-gray-500" aria-hidden />
            )}
            <p className="text-sm">
              {hasPassword
                ? "You have a password on this account."
                : "You don't have a password yet. You sign in with a code by text."}
            </p>
          </div>

          <form className="mt-6 space-y-5" onSubmit={save}>
            <FormError>{error}</FormError>

            {hasPassword && (
              <Field label="Your current password" htmlFor="current">
                <TextInput
                  id="current"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                />
              </Field>
            )}

            <Field
              label={hasPassword ? "New password" : "Choose a password"}
              hint={`At least ${MIN_LENGTH} characters. Three or four words you'll remember beats
                     something short and complicated.`}
              htmlFor="next"
            >
              <TextInput
                id="next"
                type="password"
                autoComplete="new-password"
                required
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>

            <Field label="Type it again" htmlFor="confirm">
              <TextInput
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>

            <Button type="submit" loading={busy}>
              {hasPassword ? "Change my password" : "Set my password"}
            </Button>

            {done && (
              <p role="status" className="text-center text-sm font-medium text-emerald-700">
                {done}
              </p>
            )}
          </form>

          {hasPassword && (
            <div className="mt-8 border-t border-gray-100 pt-6">
              <p className="text-sm text-gray-600">
                You can go back to codes only. You&apos;ll still be able to sign in — we&apos;ll
                text you a code as before.
              </p>
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="mt-3 text-sm text-gray-500 underline hover:text-gray-800 disabled:opacity-50"
              >
                Remove my password
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function describe(err: unknown): string {
  if (err instanceof AuthError) {
    switch (err.code) {
      case "current-password-invalid":
        return "That current password isn't right.";
      case "weak-password":
        // The server names the specific problem; each of these is something the person can act
        // on, so none of them collapse into "invalid password".
        switch (err.details?.problem) {
          case "too-short":
            return `Please use at least ${MIN_LENGTH} characters.`;
          case "too-common":
            return "That password is one of the first anyone would guess. Please pick another.";
          case "contains-phone":
            return "Please don't use your phone number — it's the part anyone already knows.";
          default:
            return "Please choose a stronger password.";
        }
      case "network-unreachable":
        return "We can't reach Needy right now. Check your connection and try again.";
      default:
        return "Something went wrong. Please try again.";
    }
  }
  return "Something went wrong. Please try again.";
}
