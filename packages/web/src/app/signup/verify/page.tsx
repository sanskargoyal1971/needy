"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Check, FileText, IdCard, Loader2, Lock } from "lucide-react";
import {
  DOCUMENT_LABELS,
  MINIMUM_AGE_YEARS,
  REQUIRED_DOCUMENTS,
  type DocumentKind,
} from "@needy/shared";
import { useAuth } from "@/auth/AuthProvider";
import { authClient, AuthError, type Gender } from "@/lib/authClient";
import { paths } from "@/lib/paths";
import { Button, Field, FormError, SandboxNote, Select, TextInput } from "@/components/ui";
import { CameraCapture } from "@/onboarding/CameraCapture";

/** ── The verification wizard ───────────────────────────────────────────────
 *  Steps: identity → gov ID → live selfie → video testimony → submit.
 *
 *  Which pane shows is computed from the SERVER's view of the account (`onboardingStatus` plus
 *  which documents exist), never from local state that survives a refresh. That is what makes
 *  the wizard resumable on a new device, and what makes it non-skippable: there is no
 *  client-held `step` to edit, and every endpoint re-checks its own preconditions anyway.
 */

type Pane = "identity" | DocumentKind | "review";

export default function VerifyWizard() {
  const router = useRouter();
  const { state, user, setUser, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Send people who don't belong here somewhere that does. Runs as an effect rather than
  // during render because navigating mid-render is a React no-no.
  useEffect(() => {
    if (state.status === "anonymous") router.replace(paths.signup);
    else if (state.status === "authenticated") {
      const s = state.user.onboardingStatus;
      if (s === "under_review" || s === "rejected") router.replace(paths.hold);
      else if (s === "approved") router.replace(paths.requesterHome);
    }
  }, [state, router]);

  const documents = useMemo(() => new Set(user?.documents ?? []), [user]);

  const pane: Pane = useMemo(() => {
    if (!user) return "identity";
    if (user.dateOfBirth == null || user.gender == null) return "identity";
    const next = REQUIRED_DOCUMENTS.find((d) => !documents.has(d));
    return next ?? "review";
  }, [user, documents]);

  if (state.status === "loading" || !user) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="animate-spin text-primary" aria-label="Loading" />
      </div>
    );
  }

  const stepIndex = pane === "identity" ? 0 : pane === "review" ? 4 : REQUIRED_DOCUMENTS.indexOf(pane) + 1;

  async function uploadDocument(kind: DocumentKind, blob: Blob, filename: string) {
    setBusy(true);
    setFormError(null);
    try {
      await authClient.uploadDocument(kind, blob, filename);
      // Re-read from the server rather than optimistically adding to the local set: the server
      // decides what it accepted, and its list is what the next pane is derived from.
      await refresh();
    } catch (err) {
      setFormError(describeUpload(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-background px-4 py-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl">
        <Stepper current={stepIndex} />

        <div className="mt-8 space-y-6 rounded-3xl border border-gray-100 bg-white p-8 shadow-sm">
          <FormError>{formError}</FormError>

          {pane === "identity" && (
            <IdentityPane
              busy={busy}
              onSubmit={async (values) => {
                setBusy(true);
                setFormError(null);
                try {
                  const { user: updated } = await authClient.submitIdentity(values);
                  setUser(updated);
                } catch (err) {
                  setFormError(describeIdentity(err));
                } finally {
                  setBusy(false);
                }
              }}
            />
          )}

          {pane === "gov_id" && (
            <DocumentPane kind="gov_id" busy={busy} onFile={uploadDocument} />
          )}
          {pane === "selfie" && (
            <DocumentPane kind="selfie" busy={busy} onFile={uploadDocument} capture="photo" />
          )}
          {pane === "video_testimony" && (
            <DocumentPane
              kind="video_testimony"
              busy={busy}
              onFile={uploadDocument}
              capture="video"
            />
          )}

          {pane === "review" && (
            <ReviewPane
              busy={busy}
              onSubmit={async () => {
                setBusy(true);
                setFormError(null);
                try {
                  const { user: updated } = await authClient.submitForReview();
                  setUser(updated);
                  router.replace(paths.hold);
                } catch (err) {
                  setFormError(describeIdentity(err));
                  setBusy(false);
                }
              }}
            />
          )}
        </div>

        <p className="mt-6 flex items-center justify-center gap-2 text-center text-xs text-gray-500">
          <Lock size={14} aria-hidden />
          Your documents are stored privately and are only ever seen by our verification team.
          Every access is logged.
        </p>
      </div>
    </div>
  );
}

// ── panes ────────────────────────────────────────────────────────────────────

function IdentityPane({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (v: {
    displayName: string;
    email?: string;
    dateOfBirth: string;
    gender: Gender;
    areaLabel: string;
  }) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [gender, setGender] = useState<Gender | "">("");
  const [areaLabel, setAreaLabel] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (displayName.trim().length < 2) next.displayName = "Enter your full name as it appears on your ID.";
    if (!dateOfBirth) next.dateOfBirth = "Enter your date of birth.";
    if (!gender) next.gender = "Select an option.";
    if (areaLabel.trim().length < 2) next.areaLabel = "Tell us which area you're in.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  // The upper bound stops the picker offering a date that fails the server's age check —
  // a form that lets you choose an answer it will then reject is a bad form.
  const latestAllowedDob = useMemo(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - MINIMUM_AGE_YEARS);
    return d.toISOString().slice(0, 10);
  }, []);

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!validate()) return;
        void onSubmit({
          displayName: displayName.trim(),
          email: email.trim() || undefined,
          dateOfBirth,
          gender: gender as Gender,
          areaLabel: areaLabel.trim(),
        });
      }}
    >
      <header>
        <h2 className="font-display text-2xl font-bold text-gray-900">About you</h2>
        <p className="mt-1 text-sm text-gray-600">
          This must match the ID you upload next. A reviewer compares them.
        </p>
      </header>

      <Field label="Full name" error={errors.displayName} htmlFor="displayName">
        <TextInput
          id="displayName"
          autoComplete="name"
          required
          value={displayName}
          invalid={Boolean(errors.displayName)}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </Field>

      <Field label="Email (optional)" htmlFor="email">
        <TextInput
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>

      <Field
        label="Date of birth"
        hint="Needy is for adults only, and your age group affects who you can be matched with."
        error={errors.dateOfBirth}
        htmlFor="dob"
      >
        <TextInput
          id="dob"
          type="date"
          required
          max={latestAllowedDob}
          value={dateOfBirth}
          invalid={Boolean(errors.dateOfBirth)}
          onChange={(e) => setDateOfBirth(e.target.value)}
        />
      </Field>

      <Field label="Gender" error={errors.gender} htmlFor="gender">
        <Select
          id="gender"
          required
          value={gender}
          invalid={Boolean(errors.gender)}
          onChange={(e) => setGender(e.target.value as Gender)}
        >
          <option value="">Select…</option>
          <option value="female">Female</option>
          <option value="male">Male</option>
          <option value="other">Other</option>
        </Select>
      </Field>

      <Field
        label="Your area"
        hint="The neighbourhood you're usually in. You'll pick an exact location for each request."
        error={errors.areaLabel}
        htmlFor="area"
      >
        <TextInput
          id="area"
          placeholder="e.g. Indiranagar, Bengaluru"
          required
          value={areaLabel}
          invalid={Boolean(errors.areaLabel)}
          onChange={(e) => setAreaLabel(e.target.value)}
        />
      </Field>

      <Button type="submit" loading={busy}>
        Continue
      </Button>
    </form>
  );
}

function DocumentPane({
  kind,
  busy,
  onFile,
  capture,
}: {
  kind: DocumentKind;
  busy: boolean;
  onFile: (kind: DocumentKind, blob: Blob, filename: string) => Promise<void>;
  capture?: "photo" | "video";
}) {
  const { title, instruction } = DOCUMENT_LABELS[kind];
  return (
    <div className="space-y-5">
      <header>
        <h2 className="font-display text-2xl font-bold text-gray-900">{title}</h2>
        <p className="mt-1 text-sm text-gray-600">{instruction}</p>
      </header>

      {capture ? (
        <>
          <CameraCapture
            mode={capture}
            disabled={busy}
            onCapture={(blob, filename) => void onFile(kind, blob, filename)}
          />
          {capture === "video" && (
            <SandboxNote>
              This records a testimony for a human reviewer to watch. Automated liveness
              detection is not implemented — a reviewer, not an algorithm, makes the call.
            </SandboxNote>
          )}
        </>
      ) : (
        <label className="flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-gray-300 p-10 text-center transition-colors hover:border-primary hover:bg-background">
          <IdCard size={32} className="text-primary" aria-hidden />
          <span className="text-sm font-medium text-gray-900">Choose a file to upload</span>
          <span className="text-xs text-gray-500">JPG, PNG, WebP or PDF, up to 10&nbsp;MB</span>
          <input
            type="file"
            className="sr-only"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(kind, file, file.name);
              // Reset so re-picking the same file after a rejection still fires onChange.
              e.target.value = "";
            }}
          />
        </label>
      )}

      {busy && (
        <p className="flex items-center justify-center gap-2 text-sm text-gray-600">
          <Loader2 size={16} className="animate-spin" aria-hidden />
          Uploading…
        </p>
      )}
    </div>
  );
}

function ReviewPane({ busy, onSubmit }: { busy: boolean; onSubmit: () => Promise<void> }) {
  return (
    <div className="space-y-5">
      <header>
        <h2 className="font-display text-2xl font-bold text-gray-900">Ready to submit</h2>
        <p className="mt-1 text-sm text-gray-600">
          We have everything we need. A member of our verification team will review your
          documents — this usually takes up to one working day.
        </p>
      </header>

      <ul className="space-y-2">
        {REQUIRED_DOCUMENTS.map((kind) => (
          <li key={kind} className="flex items-center gap-3 rounded-xl bg-background p-3 text-sm">
            <Check size={16} className="text-primary" aria-hidden />
            {DOCUMENT_LABELS[kind].title}
          </li>
        ))}
      </ul>

      <div className="rounded-xl bg-background p-4 text-sm text-gray-700">
        <p className="flex items-start gap-2">
          <FileText size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
          <span>
            You can browse Needy while you wait, but you won&apos;t be able to book or accept
            help until you&apos;re approved.
          </span>
        </p>
      </div>

      <Button type="button" loading={busy} onClick={() => void onSubmit()}>
        Submit for verification
      </Button>
    </div>
  );
}

// ── chrome ───────────────────────────────────────────────────────────────────

const STEP_LABELS = ["About you", "ID", "Selfie", "Video", "Submit"];

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Verification progress">
      {STEP_LABELS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex flex-1 flex-col gap-2">
            <div
              className={`h-1.5 rounded-full ${done || active ? "bg-primary" : "bg-gray-200"}`}
              aria-hidden
            />
            <span
              className={`text-xs ${active ? "font-semibold text-primary" : "text-gray-500"}`}
              aria-current={active ? "step" : undefined}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ── error copy ───────────────────────────────────────────────────────────────

function describeUpload(err: unknown): string {
  if (err instanceof AuthError) {
    switch (err.code) {
      case "too-large":
        return "That file is too large. Try a smaller one.";
      case "unrecognized-format":
        return "We couldn't read that file. Upload a JPG, PNG, WebP or PDF.";
      case "wrong-format-for-kind":
        return "That file type isn't right for this step.";
      case "network-unreachable":
        return "Upload failed — check your connection and try again.";
      default:
        return "That upload didn't work. Please try again.";
    }
  }
  return "That upload didn't work. Please try again.";
}

function describeIdentity(err: unknown): string {
  if (err instanceof AuthError) {
    switch (err.code) {
      case "under-age":
        return `You must be at least ${MINIMUM_AGE_YEARS} to use Needy.`;
      case "implausible-date-of-birth":
        return "Please check your date of birth.";
      case "invalid-input":
        return "Please check the details above and try again.";
      case "documents-incomplete":
        return "Some documents are still missing. Please complete every step.";
      case "onboarding-rejected":
        return "This account can't be verified.";
      case "network-unreachable":
        return "We can't reach Needy right now. Check your connection and try again.";
      default:
        return "Something went wrong. Please try again.";
    }
  }
  return "Something went wrong. Please try again.";
}
