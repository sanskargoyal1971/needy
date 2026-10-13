"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { AppGate } from "@/auth/AppGate";
import { authClient, AuthError, type TotpStatus } from "@/lib/authClient";
import { AuthenticatorSecret, RecoveryCodes } from "@/components/Authenticator";
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

      <AuthenticatorSection />
    </div>
  );
}

/** ── Authenticator app (staff only) ────────────────────────────────────────
 *  Renders nothing for a participant: the server says whether this account is offered an
 *  authenticator at all, and for everyone who is not staff the answer is no. They sign in
 *  with a code by text, and a second screen of security settings they cannot use would only
 *  make this page harder to read.
 *
 *  For an admin, an authenticator REPLACES the text-message code as the second step. For a
 *  super admin it is the only second step there is, so it can be replaced but the account
 *  never goes back to a password alone — the copy below says so before they turn it off.
 */
function AuthenticatorSection() {
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await authClient.totpStatus());
    } catch {
      // Unknown is treated as "not offered": better to show nothing than a setup form that
      // may not apply to this account.
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status?.available) return null;

  async function run(action: () => Promise<void>) {
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(describeAuthenticator(err));
    } finally {
      setBusy(false);
    }
  }

  const start = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      setSetup(await authClient.totpEnrolStart({ password }));
      setPassword("");
      setCode("");
    });
  };

  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await authClient.totpEnrolConfirm(code);
      setCodes(res.recoveryCodes);
      setSetup(null);
      setCode("");
      await load();
    });
  };

  const disable = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await authClient.totpDisable(code);
      setCode("");
      setCodes(null);
      setDone(
        status.required
          ? "Your authenticator has been removed. You'll be asked to set one up the next time you sign in."
          : "Your authenticator has been removed. We'll text you a code when you sign in, as before.",
      );
      await load();
    });
  };

  const codeField = (id: string, label: string) => (
    <Field label={label} htmlFor={id}>
      <TextInput
        id={id}
        autoComplete="one-time-code"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={6}
        required
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
      />
    </Field>
  );

  return (
    <section className="mt-10 border-t border-gray-100 pt-8">
      <h2 className="font-display text-xl font-bold text-gray-900">Authenticator app</h2>
      <p className="mt-2 text-sm text-gray-600">
        Staff accounts need a second step after the password. An authenticator app on your phone
        gives you that step without relying on a text message arriving.
      </p>

      <div
        className={`mt-4 flex items-start gap-3 rounded-2xl p-4 ${
          status.enabled ? "bg-emerald-50 text-emerald-900" : "bg-gray-50 text-gray-700"
        }`}
      >
        {status.enabled ? (
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-700" aria-hidden />
        ) : (
          <KeyRound size={18} className="mt-0.5 shrink-0 text-gray-500" aria-hidden />
        )}
        <p className="text-sm">
          {status.enabled
            ? `An authenticator app is set up. You have ${status.recoveryCodesRemaining} recovery ${
                status.recoveryCodesRemaining === 1 ? "code" : "codes"
              } left.`
            : "No authenticator app is set up. Your second step is a code by text."}
        </p>
      </div>

      <div className="mt-5 space-y-5">
        <FormError>{error}</FormError>

        {codes && <RecoveryCodes codes={codes} />}

        {!status.enabled && !setup && (
          <form className="space-y-5" onSubmit={start}>
            {/* Asked for again on purpose: this attaches a new way of proving who you are, and
                a browser left signed in should not be enough to do that. */}
            <Field
              label="Your password"
              hint="We ask again before adding a new sign-in step to your account."
              htmlFor="totp-password"
            >
              <TextInput
                id="totp-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" loading={busy}>
              Set up an authenticator app
            </Button>
          </form>
        )}

        {!status.enabled && setup && (
          <form className="space-y-5" onSubmit={confirm}>
            <AuthenticatorSecret secret={setup.secret} otpauthUri={setup.otpauthUri} />
            {codeField("totp-confirm", "Code from the app")}
            <Button type="submit" loading={busy}>
              Confirm and turn on
            </Button>
            <p className="text-center text-xs text-gray-500">
              Nothing changes until you confirm a code — until then you still sign in as before.
            </p>
          </form>
        )}

        {status.enabled && (
          <form className="space-y-5" onSubmit={disable}>
            <p className="text-sm text-gray-600">
              {status.required
                ? "To move to a new phone, remove this authenticator and set one up again. Your account always needs one, so you'll be asked to set it up the next time you sign in."
                : "You can remove it and go back to a code by text. Removing it needs a current code from the app."}
            </p>
            {codeField("totp-disable", "Current code from the app")}
            <Button type="submit" variant="secondary" loading={busy}>
              Remove my authenticator
            </Button>
          </form>
        )}

        {done && (
          <p role="status" className="text-center text-sm font-medium text-emerald-700">
            {done}
          </p>
        )}
      </div>
    </section>
  );
}

function describeAuthenticator(err: unknown): string {
  if (err instanceof AuthError) {
    switch (err.code) {
      case "current-password-invalid":
        return "That password isn't right.";
      case "totp-invalid":
        return "That code isn't right. Wait for the next one in your app and try again.";
      case "totp-already-enabled":
        return "An authenticator is already set up. Remove it first to set up a new one.";
      case "totp-not-pending":
        return "That setup has expired. Please start again.";
      case "too-many-attempts":
        return "Too many attempts. Please wait a few minutes before trying again.";
      case "network-unreachable":
        return "We can't reach Needy right now. Check your connection and try again.";
      default:
        return "Something went wrong. Please try again.";
    }
  }
  return "Something went wrong. Please try again.";
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
