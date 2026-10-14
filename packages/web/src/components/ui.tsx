"use client";

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Float, VerifiedShield3D } from "@/motion/depth";

/** ── Form primitives ───────────────────────────────────────────────────────
 *  The marketing pages spell their Tailwind out inline, which is fine for a page rendered
 *  once. The signup wizard has six panes with the same field, button and error treatment, so
 *  the same approach there means six chances for them to drift — and the wizard is the screen
 *  where a user is deciding whether to trust this platform with their Aadhaar.
 *
 *  Tokens come from tailwind.config.ts (primary #0F5C5C, accent #FF7A59, cream background) so
 *  these match the pages in the screenshots rather than re-deriving a palette.
 */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-900 mb-1.5">
        {label}
      </label>
      {hint && <p className="text-sm text-gray-500 mb-2">{hint}</p>}
      {children}
      {/* role="alert" so a screen reader announces the failure rather than leaving the user
          tabbing back through a form that silently refused. */}
      {error && (
        <p role="alert" className="mt-1.5 flex items-center gap-1.5 text-sm text-red-600">
          <AlertCircle size={14} aria-hidden />
          {error}
        </p>
      )}
    </div>
  );
}

const inputBase =
  "block w-full rounded-xl border-0 py-3 px-4 text-gray-900 ring-1 ring-inset ring-gray-300 " +
  "placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-primary sm:text-sm " +
  "disabled:bg-gray-50 disabled:text-gray-500";

export function TextInput({
  invalid,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...props}
      aria-invalid={invalid || undefined}
      className={`${inputBase} ${invalid ? "ring-red-400 focus:ring-red-500" : ""}`}
    />
  );
}

export function Select({
  invalid,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      {...props}
      aria-invalid={invalid || undefined}
      className={`${inputBase} ${invalid ? "ring-red-400 focus:ring-red-500" : ""}`}
    >
      {children}
    </select>
  );
}

export function Button({
  children,
  loading,
  variant = "primary",
  ...props
}: InputHTMLAttributes<HTMLButtonElement> & {
  loading?: boolean;
  variant?: "primary" | "secondary";
  type?: "button" | "submit";
}) {
  const styles =
    variant === "primary"
      ? "bg-primary text-white hover:bg-primary-dark disabled:bg-gray-300"
      : "bg-white text-gray-900 ring-1 ring-inset ring-gray-200 hover:bg-gray-50 disabled:text-gray-400";
  return (
    <button
      {...props}
      // `loading` disables as well as `disabled`: without this a double-tap on a slow
      // connection submits the form twice, which for an OTP request means two SMS charges and
      // a user holding two valid codes.
      disabled={props.disabled || loading}
      className={`inline-flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-black transition-all transform hover:translate-y-1 active:translate-y-2 active:shadow-none disabled:cursor-not-allowed ${variant === "primary" ? "shadow-3d-button hover:shadow-3d-button-hover" : "shadow-sm hover:shadow-md"} ${styles}`}
    >
      {loading && <Loader2 size={16} className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/** A form-level failure — distinct from a per-field error, which `Field` renders inline. */
export function FormError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-800 ring-1 ring-inset ring-red-100"
    >
      <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/**
 * A standing marker for anything not backed by a real integration.
 *
 * AGENTS.md: "Anything mocked or stubbed is called out explicitly — never allowed to look
 * finished if it isn't." The SMS console adapter and the absent eKYC provider both surface
 * through this, so a reviewer walking the flow can tell what is real.
 */
export function SandboxNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border-l-4 border-yellow-400 bg-yellow-50 p-3 text-sm text-yellow-800">
      <strong className="font-semibold">Sandbox:</strong> {children}
    </div>
  );
}

/** The card every auth/onboarding pane sits in, matching the signup screen's treatment. */
export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[calc(100vh-16rem)] items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8 relative overflow-hidden">
      {/* Backdrop only: decorative, and never in the way of the form. */}
      <Float decorative className="pointer-events-none absolute top-20 -left-20" amplitude={12}>
        <div className="w-64 h-64 bg-primary-100 rounded-full mix-blend-multiply filter blur-3xl opacity-50" />
      </Float>
      <Float
        decorative
        className="pointer-events-none absolute bottom-20 -right-20"
        amplitude={12}
        delay={5}
      >
        <div className="w-72 h-72 bg-accent-light/20 rounded-full mix-blend-multiply filter blur-3xl opacity-50" />
      </Float>
      <VerifiedShield3D
        size={120}
        interactive={false}
        className="absolute right-[6%] top-10 hidden opacity-80 lg:block"
      />
      <div className="w-full max-w-md space-y-6 rounded-3xl border border-white/40 bg-white/60 backdrop-blur-xl p-8 shadow-3d-card relative z-10 transform perspective-1000 transition-all hover:shadow-3d-card-hover hover:-translate-y-1">
        <div className="text-center">
          <h1 className="font-display text-3xl font-black tracking-tight text-gray-900">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-gray-600">{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}
