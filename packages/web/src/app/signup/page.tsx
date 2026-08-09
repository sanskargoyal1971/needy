"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { authClient, AuthError } from "@/lib/authClient";
import { paths } from "@/lib/paths";
import { normalisePhone, phoneError } from "@/lib/phone";
import { AuthCard, Button, Field, FormError, SandboxNote, TextInput } from "@/components/ui";
import { DEV_FIXED_OTP } from "@/lib/apiConfig";

/**
 * Step 1 of signup: prove the phone number.
 *
 * The name field the old mock had is gone from this pane. It reappears in the wizard's
 * identity step, alongside date of birth and gender — collecting it here would mean either
 * asking twice or storing an unverified name against a session that might never complete
 * verification. One place owns identity, and it is the step a reviewer actually checks.
 */
type Stage = { name: "phone" } | { name: "code"; phone: string };

export default function Signup() {
  const router = useRouter();
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
      // Straight into the wizard. `/auth/otp/verify` is find-or-create, so an existing account
      // that never finished verification resumes from wherever the server says it stopped
      // rather than starting over.
      router.replace(paths.onboarding);
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
      <AuthCard title="Create an account" subtitle="Join Needy to request or offer help">
        <form className="space-y-5" onSubmit={requestCode}>
          <FormError>{formError}</FormError>
          <Field
            label="Mobile number"
            hint="We'll text you a code. This becomes your sign-in."
            error={fieldError}
            htmlFor="phone"
          >
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
          <p className="px-4 text-center text-xs text-gray-500">
            By signing up, you agree to our{" "}
            <Link href={paths.terms} className="underline hover:text-gray-700">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href={paths.privacy} className="underline hover:text-gray-700">
              Privacy Policy
            </Link>
            .
          </p>
        </form>
        <p className="text-center text-sm text-gray-600">
          Already have an account?{" "}
          <Link href={paths.login} className="font-semibold text-primary hover:text-primary-dark">
            Log in
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
          No SMS provider is connected yet, so every account accepts the same code:{" "}
          <strong>{DEV_FIXED_OTP}</strong>. This is a development stand-in — the server refuses to
          start with a fixed code in production.
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
