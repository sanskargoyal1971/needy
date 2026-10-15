"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { authClient, AuthError, type PublicUser } from "@/lib/authClient";
import { AuthenticatorSecret, RecoveryCodes } from "@/components/Authenticator";
import { homeFor, paths, safeReturnTo } from "@/lib/paths";
import { AuthCard, Button, Field, FormError, TextInput } from "@/components/ui";
import { normalisePhone, phoneError } from "@/lib/phone";
import { DevCodeNote } from "@/components/DevCodeNote";

/** Panes on one route: ask for the number, then for a code or a password. Separate routes
 *  would lose the phone number on refresh and let someone deep-link to a code prompt for a
 *  number no code was ever sent to.
 *
 *  `mfa` is the admin's second step: they have already entered a correct password and still owe
 *  the one-time code. It carries the pending token from the password step, because that token
 *  is the only thing distinguishing this from an ordinary code login — without it, anyone able
 *  to receive the code could sign in as staff having never known the password. */
type Stage =
  | { name: "phone" }
  | { name: "code"; phone: string }
  | { name: "password"; phone: string }
  | { name: "mfa"; phone: string; pendingToken: string }
  /** The super admin's door: a username and a password. That account administers the
   *  operators rather than participating, so it has no verified number to send a code to —
   *  its second factor is an authenticator app instead. */
  | { name: "staff" }
  /** Staff who have an authenticator: the password was accepted and a code from the app (or
   *  one recovery code) is still owed. Not signed in yet. */
  | { name: "totp"; pendingToken: string; useRecovery: boolean }
  /** A super admin's first sign-in. There is no authenticator to ask for a code from, so they
   *  set one up here — still NOT signed in; the session arrives when the code confirms it. */
  | { name: "enrol"; pendingToken: string; secret: string; otpauthUri: string }
  /** Signed in, but held on this screen until they say the recovery codes are saved: these
   *  are shown once, and landing on the dashboard would take them away for good. */
  | { name: "recovery"; codes: string[]; user: PublicUser };

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { setUser } = useAuth();

  const [stage, setStage] = useState<Stage>({ name: "phone" });
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    const problem = phoneError(phone);
    if (problem) {
      setFieldError(problem);
      return;
    }
    setFieldError(null);
    setFormError(null);
    setBusy(true);
    try {
      const e164 = normalisePhone(phone);
      await authClient.requestOtp(e164);
      setStage({ name: "code", phone: e164 });
    } catch (err) {
      setFormError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  /** Land wherever this person belongs. Onboarding outranks role — `homeFor` owns that — and
   *  a `?next=` is honoured only when it is a local path (open-redirect guard). */
  function land(user: Parameters<typeof setUser>[0]) {
    setUser(user);
    const fallback = homeFor(user!.role, user!.onboardingStatus);
    router.replace(safeReturnTo(params.get("next"), fallback));
  }

  async function signInWithPassword(e: React.FormEvent) {
    e.preventDefault();
    if (stage.name !== "password") return;
    setFieldError(null);
    setFormError(null);
    setBusy(true);
    try {
      const res = await authClient.passwordLogin({ phone: stage.phone }, password);
      // An admin is NOT signed in yet, however successful this looks. Sending them onward here
      // would drop them into a logged-out app.
      if (res.mfaRequired) {
        setStage(
          res.method === "totp"
            ? { name: "totp", pendingToken: res.pendingToken, useRecovery: false }
            : { name: "mfa", phone: stage.phone, pendingToken: res.pendingToken },
        );
        setPassword("");
        setCode("");
        setBusy(false);
        return;
      }
      if (res.enrolmentRequired) {
        // Only a super admin is ever asked to enrol mid-sign-in, and they use the staff door.
        setFormError("This account signs in under “Staff sign-in”.");
        setBusy(false);
        return;
      }
      land(res.user);
    } catch (err) {
      if (err instanceof AuthError && err.status === 401) {
        // Deliberately vague, matching the server: it does not say whether the number is known
        // or whether that account even uses a password, and neither may this.
        setFieldError("That didn't work. Check your password, or sign in with a code instead.");
      } else {
        setFormError(describe(err));
      }
      setBusy(false);
    }
  }

  async function signInAsStaff(e: React.FormEvent) {
    e.preventDefault();
    setFieldError(null);
    setFormError(null);
    setBusy(true);
    try {
      const res = await authClient.passwordLogin({ username }, password);
      // The password is only ever the first factor here. Neither branch below is signed in.
      if (res.enrolmentRequired) {
        // First sign-in: no authenticator on the account yet. Ask the server for a setup key
        // straight away so the next screen has something to show.
        const setup = await authClient.totpEnrolStart({ pendingToken: res.pendingToken });
        setStage({ name: "enrol", pendingToken: res.pendingToken, ...setup });
        setPassword("");
        setCode("");
        setBusy(false);
        return;
      }
      if (res.mfaRequired) {
        if (res.method !== "totp") {
          // A text-message code belongs to the phone-number door. If the server ever asked for
          // one here, the honest thing is to say so rather than pretend we are in.
          setFormError("This account needs a code by text. Sign in with your number instead.");
          setBusy(false);
          return;
        }
        setStage({ name: "totp", pendingToken: res.pendingToken, useRecovery: false });
        setPassword("");
        setCode("");
        setBusy(false);
        return;
      }
      land(res.user);
    } catch (err) {
      if (err instanceof AuthError && err.status === 401) {
        setFieldError("That username and password don't match.");
      } else {
        setFormError(describe(err));
      }
      setBusy(false);
    }
  }

  async function verifyMfa(e: React.FormEvent) {
    e.preventDefault();
    if (stage.name !== "mfa") return;
    setFieldError(null);
    setFormError(null);
    setBusy(true);
    try {
      const { user } = await authClient.passwordMfa(stage.phone, code, stage.pendingToken);
      land(user);
    } catch (err) {
      if (err instanceof AuthError && err.code === "mfa-expired") {
        setStage({ name: "password", phone: stage.phone });
        setCode("");
        setFormError("That took too long. Please enter your password again.");
      } else if (err instanceof AuthError && err.status === 401) {
        setFieldError("That code isn't right. Check it and try again.");
      } else {
        setFormError(describe(err));
      }
      setBusy(false);
    }
  }

  /** Back to the very start, with nothing typed left behind. */
  function startOver(message: string | null) {
    setStage({ name: "phone" });
    setCode("");
    setRecoveryCode("");
    setPassword("");
    setFieldError(null);
    setFormError(message);
  }

  async function verifyTotp(e: React.FormEvent) {
    e.preventDefault();
    if (stage.name !== "totp") return;
    setFieldError(null);
    setFormError(null);
    setBusy(true);
    try {
      const { user } = await authClient.totpLogin(
        stage.pendingToken,
        stage.useRecovery ? { recoveryCode: recoveryCode.trim() } : { code },
      );
      land(user);
    } catch (err) {
      if (err instanceof AuthError && err.code === "mfa-expired") {
        startOver("That took too long. Please sign in again.");
      } else if (err instanceof AuthError && (err.status === 401 || err.status === 400)) {
        // One message for a wrong code and a used one, matching the server.
        setFieldError(
          stage.useRecovery
            ? "That recovery code isn't right, or has already been used."
            : "That code isn't right. Wait for the next one in your app and try again.",
        );
      } else {
        setFormError(describe(err));
      }
      setBusy(false);
    }
  }

  async function confirmEnrolment(e: React.FormEvent) {
    e.preventDefault();
    if (stage.name !== "enrol") return;
    setFieldError(null);
    setFormError(null);
    setBusy(true);
    try {
      const res = await authClient.totpEnrolConfirm(code, stage.pendingToken);
      if (!res.user) {
        // The first-sign-in door always returns the session with the codes. If it did not,
        // do not pretend: send them round again rather than into a logged-out app.
        startOver("Your authenticator is set up. Please sign in again.");
        setBusy(false);
        return;
      }
      setCode("");
      // Not `land()` yet — the codes on the next screen are shown exactly once.
      setStage({ name: "recovery", codes: res.recoveryCodes, user: res.user });
      setBusy(false);
    } catch (err) {
      if (err instanceof AuthError && err.code === "enrolment-expired") {
        startOver("That took too long. Please sign in again to set up your authenticator.");
      } else if (err instanceof AuthError && err.code === "totp-invalid") {
        setFieldError("That code isn't right. Check the key was typed exactly, then try again.");
      } else {
        setFormError(describe(err));
      }
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (stage.name !== "code") return;
    setFieldError(null);
    setFormError(null);
    setBusy(true);
    try {
      const { user } = await authClient.verifyOtp(stage.phone, code);
      land(user);
    } catch (err) {
      if (err instanceof AuthError && err.status === 401) {
        setFieldError("That code isn't right. Check it and try again.");
      } else {
        setFormError(describe(err));
      }
      setBusy(false);
    }
  }

  if (stage.name === "phone") {
    return (
      <AuthCard title="Welcome back" subtitle="Sign in to your Needy account">
        <form className="space-y-5" onSubmit={requestCode}>
          <FormError>{formError}</FormError>
          <Field label="Mobile number" error={fieldError} htmlFor="phone">
            <TextInput
              id="phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              required
              autoFocus
              placeholder="+91 98765 43210"
              value={phone}
              invalid={Boolean(fieldError)}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
          <Button type="submit" loading={busy}>
            Get OTP
          </Button>
          {/* A code is still the primary route and stays the big button: it needs nothing
              remembered, which for this audience is the kinder default. The password is for
              the person who cannot receive an SMS right now — a lost handset, a number that
              has moved on, an operator on a laptop at 3am. */}
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              const problem = phoneError(phone);
              if (problem) {
                setFieldError(problem);
                return;
              }
              setFieldError(null);
              setFormError(null);
              setStage({ name: "password", phone: normalisePhone(phone) });
            }}
          >
            Use my password instead
          </Button>
          <div className="flex items-center justify-center gap-2 text-xs text-gray-500">
            <ShieldCheck size={16} className="text-primary" aria-hidden />
            <span>A code by text, or your password</span>
          </div>
        </form>
        <p className="text-center text-sm text-gray-600">
          Don&apos;t have an account?{" "}
          <Link href={paths.signup} className="font-semibold text-primary hover:text-primary-dark">
            Sign up
          </Link>
        </p>
        {/* Quiet, and last. Almost nobody who reaches this page is staff, and a prominent
            "staff login" is an invitation to try guessing one. */}
        <button
          type="button"
          onClick={() => {
            setFieldError(null);
            setFormError(null);
            setStage({ name: "staff" });
          }}
          className="mx-auto block text-xs text-gray-400 hover:text-gray-600"
        >
          Staff sign-in
        </button>
      </AuthCard>
    );
  }

  if (stage.name === "staff") {
    return (
      <AuthCard title="Staff sign-in" subtitle="For Needy operators">
        <form className="space-y-5" onSubmit={signInAsStaff}>
          <FormError>{formError}</FormError>
          <Field label="Username" error={fieldError} htmlFor="username">
            <TextInput
              id="username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
              value={username}
              invalid={Boolean(fieldError)}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label="Password" htmlFor="staff-password">
            <TextInput
              id="staff-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" loading={busy}>
            Sign in
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setUsername("");
              setPassword("");
              setFieldError(null);
              setFormError(null);
              setStage({ name: "phone" });
            }}
          >
            Back
          </Button>
        </form>
      </AuthCard>
    );
  }

  if (stage.name === "totp") {
    return (
      <AuthCard
        title="One more step"
        subtitle={
          stage.useRecovery
            ? "Enter one of the recovery codes you saved."
            : "Enter the 6-digit code from your authenticator app."
        }
      >
        <form className="space-y-5" onSubmit={verifyTotp}>
          <FormError>{formError}</FormError>
          {stage.useRecovery ? (
            <Field label="Recovery code" error={fieldError} htmlFor="recovery-code">
              <TextInput
                id="recovery-code"
                name="recoveryCode"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                autoFocus
                placeholder="abcd-efgh-jkmn"
                value={recoveryCode}
                invalid={Boolean(fieldError)}
                onChange={(e) => setRecoveryCode(e.target.value)}
              />
            </Field>
          ) : (
            <Field label="Authenticator code" error={fieldError} htmlFor="totp-code">
              <TextInput
                id="totp-code"
                name="code"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                required
                autoFocus
                value={code}
                invalid={Boolean(fieldError)}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
            </Field>
          )}
          <Button type="submit" loading={busy}>
            Sign in
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setFieldError(null);
              setFormError(null);
              setStage({ ...stage, useRecovery: !stage.useRecovery });
            }}
          >
            {stage.useRecovery
              ? "Use my authenticator app instead"
              : "I've lost my phone — use a recovery code"}
          </Button>
          <p className="text-center text-xs text-gray-500">
            Your password was accepted. Because this account can see people&apos;s emergencies, it
            needs both.
          </p>
        </form>
      </AuthCard>
    );
  }

  if (stage.name === "enrol") {
    return (
      <AuthCard
        title="Set up your authenticator"
        subtitle="This account needs a second step to sign in. It takes about a minute."
      >
        <form className="space-y-5" onSubmit={confirmEnrolment}>
          <FormError>{formError}</FormError>
          <AuthenticatorSecret secret={stage.secret} otpauthUri={stage.otpauthUri} />
          <Field
            label="Code from the app"
            hint="Once the account is added, the app shows a 6-digit code. Enter it to finish."
            error={fieldError}
            htmlFor="enrol-code"
          >
            <TextInput
              id="enrol-code"
              name="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              required
              value={code}
              invalid={Boolean(fieldError)}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Button type="submit" loading={busy}>
            Confirm and sign in
          </Button>
          {/* Says plainly that nothing has happened yet, so nobody closes the tab believing
              the account is protected when it is still one password from open. */}
          <p className="text-center text-xs text-gray-500">
            You are not signed in yet, and the authenticator isn&apos;t active until you confirm a
            code.
          </p>
        </form>
      </AuthCard>
    );
  }

  if (stage.name === "recovery") {
    return (
      <AuthCard title="You're set up" subtitle="One last thing before you go in.">
        <div className="space-y-5">
          <RecoveryCodes codes={stage.codes} />
          <Button type="button" onClick={() => land(stage.user)}>
            I&apos;ve saved these — continue
          </Button>
        </div>
      </AuthCard>
    );
  }

  if (stage.name === "password") {
    return (
      <AuthCard title="Enter your password" subtitle={stage.phone}>
        <form className="space-y-5" onSubmit={signInWithPassword}>
          <FormError>{formError}</FormError>
          <Field label="Password" error={fieldError} htmlFor="password">
            <TextInput
              id="password"
              name="password"
              type="password"
              // Lets a password manager fill and, more importantly, OFFER TO SAVE it. Without
              // it the browser treats this as an anonymous field and never prompts.
              autoComplete="current-password"
              required
              autoFocus
              value={password}
              invalid={Boolean(fieldError)}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" loading={busy}>
            Sign in
          </Button>
          {/* The way back for someone who has forgotten it. There is no reset email in this
              product, so the one-time code IS the reset route — and it is the honest one,
              because the phone is already the verified identity behind the account. */}
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setPassword("");
              setFieldError(null);
              setFormError(null);
              setStage({ name: "phone" });
            }}
          >
            I&apos;ve forgotten it — send me a code
          </Button>
        </form>
      </AuthCard>
    );
  }

  if (stage.name === "mfa") {
    return (
      <AuthCard
        title="One more step"
        subtitle="Staff accounts also need a code. We've sent one to your phone."
      >
        <form className="space-y-5" onSubmit={verifyMfa}>
          <FormError>{formError}</FormError>
          <Field label="Verification code" error={fieldError} htmlFor="mfa-code">
            <TextInput
              id="mfa-code"
              name="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              required
              autoFocus
              placeholder="123456"
              value={code}
              invalid={Boolean(fieldError)}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Button type="submit" loading={busy}>
            Sign in
          </Button>
          {/* Says why, rather than making an operator wonder whether something went wrong.
              This account can see every live emergency; a password alone is not enough. */}
          <p className="text-center text-xs text-gray-500">
            Your password was accepted. Because this account can see people&apos;s emergencies, it
            needs both.
          </p>
          <DevCodeNote />
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Enter your code" subtitle={`We sent a 6-digit code to ${stage.phone}`}>
      <form className="space-y-5" onSubmit={verify}>
        <FormError>{formError}</FormError>
        <Field label="Verification code" error={fieldError} htmlFor="code">
          <TextInput
            id="code"
            name="code"
            // `one-time-code` is what lets iOS and Android offer the SMS code above the
            // keyboard. Without it the user retypes a code their phone already read.
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={8}
            required
            autoFocus
            placeholder="123456"
            value={code}
            invalid={Boolean(fieldError)}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
        </Field>
        <Button type="submit" loading={busy}>
          Verify and continue
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setStage({ name: "phone" });
            setCode("");
            setFieldError(null);
          }}
        >
          Use a different number
        </Button>
        <DevCodeNote />
      </form>
    </AuthCard>
  );
}

function describe(err: unknown): string {
  if (err instanceof AuthError) {
    switch (err.code) {
      case "too-many-requests":
        return "Too many attempts. Please wait a while before trying again.";
      case "too-many-attempts":
        return "Too many attempts. Please wait a while before trying again.";
      case "password-required":
        // Staff accounts need a password as well as a code. Said only after the code was
        // correct, so it reveals nothing to someone who is merely guessing numbers.
        return "This account signs in with a password. Choose “Use my password instead”, or “Staff sign-in” below.";
      case "phone-blocked":
        return "This number can no longer be used on Needy. Contact support if you believe this is a mistake.";
      case "network-unreachable":
        return "We can't reach Needy right now. Check your connection and try again.";
      default:
        return "Something went wrong. Please try again.";
    }
  }
  return "Something went wrong. Please try again.";
}

export default function Login() {
  // useSearchParams needs a Suspense boundary or the whole route opts out of static
  // rendering and Next fails the build.
  return (
    <Suspense fallback={<AuthCard title="Welcome back">{null}</AuthCard>}>
      <LoginForm />
    </Suspense>
  );
}
