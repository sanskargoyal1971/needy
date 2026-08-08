"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { authClient, AuthError } from "@/lib/authClient";
import { homeFor, paths, safeReturnTo } from "@/lib/paths";
import { AuthCard, Button, Field, FormError, SandboxNote, TextInput } from "@/components/ui";
import { normalisePhone, phoneError } from "@/lib/phone";

/** Two panes on one route: ask for the number, then ask for the code. A separate `/login/otp`
 *  route would lose the phone number on refresh and let someone deep-link to a code prompt for
 *  a number no code was ever sent to. */
type Stage = { name: "phone" } | { name: "code"; phone: string };

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { setUser } = useAuth();

  const [stage, setStage] = useState<Stage>({ name: "phone" });
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
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

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (stage.name !== "code") return;
    setFieldError(null);
    setFormError(null);
    setBusy(true);
    try {
      const { user } = await authClient.verifyOtp(stage.phone, code);
      setUser(user);
      // Where the user belongs depends on how far through onboarding they are, not only on
      // their role — an unapproved admin is still an unapproved user. `homeFor` owns that
      // ordering. A `?next=` is honoured only if it is a local path (open-redirect guard).
      const fallback = homeFor(user.role, user.onboardingStatus);
      router.replace(safeReturnTo(params.get("next"), fallback));
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
          <div className="flex items-center justify-center gap-2 text-xs text-gray-500">
            <ShieldCheck size={16} className="text-primary" aria-hidden />
            <span>Secure, passwordless login</span>
          </div>
        </form>
        <p className="text-center text-sm text-gray-600">
          Don&apos;t have an account?{" "}
          <Link href={paths.signup} className="font-semibold text-primary hover:text-primary-dark">
            Sign up
          </Link>
        </p>
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
        <SandboxNote>
          SMS delivery uses the console adapter unless Twilio credentials are configured. In
          development the code is printed in the backend logs.
        </SandboxNote>
      </form>
    </AuthCard>
  );
}

function describe(err: unknown): string {
  if (err instanceof AuthError) {
    switch (err.code) {
      case "too-many-requests":
        return "Too many attempts. Please wait a while before trying again.";
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
