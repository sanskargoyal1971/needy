"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Clock, Loader2, ShieldX } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { paths } from "@/lib/paths";
import { SUPPORT_PHONE } from "@/lib/apiConfig";
import { Button } from "@/components/ui";

/** ── The hold screen ───────────────────────────────────────────────────────
 *  Two states share this route because they share a shape — "you cannot proceed, here is why"
 *  — but they are meaningfully different, and the difference is the point:
 *
 *   - `under_review` is a WAIT. There is a way forward; it just isn't today. The user may
 *     still browse the marketing pages, and a poll picks up the decision without a refresh.
 *   - `rejected` is TERMINAL. No navigation out, no retry, no "start again" button. Their
 *     number is blocked, so signing up again is not a path either. Offering an action here
 *     that cannot work would be worse than offering none.
 */

/** The review SLA is up to one working day, so a slow poll is plenty. Frequent polling would
 *  buy nothing and cost a request per user per few seconds across everyone waiting. */
const POLL_INTERVAL_MS = 60_000;

export default function Hold() {
  const router = useRouter();
  const { state, refresh } = useAuth();

  useEffect(() => {
    if (state.status === "anonymous") router.replace(paths.login);
  }, [state.status, router]);

  const status = state.status === "authenticated" ? state.user.onboardingStatus : null;

  // Poll only while genuinely waiting. A rejected user's status will never change on its own,
  // so polling there is a request loop that can only ever return the same answer.
  useEffect(() => {
    if (status !== "under_review") return;
    const id = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [status, refresh]);

  // Approved while the tab was open — move them along without making them find the way.
  useEffect(() => {
    if (state.status === "authenticated" && state.user.onboardingStatus === "approved") {
      router.replace(paths.requesterHome);
    }
  }, [state, router]);

  if (state.status !== "authenticated") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="animate-spin text-primary" aria-label="Loading" />
      </div>
    );
  }

  const user = state.user;

  if (user.onboardingStatus === "rejected") {
    return (
      <main className="flex min-h-[calc(100vh-16rem)] items-center justify-center bg-background px-4 py-12">
        <div className="w-full max-w-lg space-y-6 rounded-3xl border border-red-100 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-50">
            <ShieldX size={28} className="text-red-600" aria-hidden />
          </div>
          <div>
            <h1 className="font-display text-3xl font-black text-gray-900">
              We couldn&apos;t verify your account
            </h1>
            <p className="mt-3 text-gray-600">
              Our verification team reviewed your documents and wasn&apos;t able to approve this
              account for use on Needy.
            </p>
          </div>

          {user.rejectionReason && (
            <div className="rounded-xl bg-background p-4 text-left text-sm text-gray-700">
              <span className="font-semibold text-gray-900">Reason given: </span>
              {user.rejectionReason}
            </div>
          )}

          <p className="text-sm text-gray-600">
            This decision applies to this mobile number and cannot be appealed through the app.
            {SUPPORT_PHONE ? (
              <>
                {" "}
                If you believe this is a mistake, call us on{" "}
                <a href={`tel:${SUPPORT_PHONE}`} className="font-semibold text-primary">
                  {SUPPORT_PHONE}
                </a>
                .
              </>
            ) : (
              " If you believe this is a mistake, please contact our support team."
            )}
          </p>

          {/* Deliberately no navigation. No "try again", no link home: the account cannot
              proceed, and every other route rejects it anyway. A button that leads nowhere is
              a crueller answer than a plain one. */}
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-[calc(100vh-16rem)] items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-lg space-y-6 rounded-3xl border border-gray-100 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-background">
          <Clock size={28} className="text-primary" aria-hidden />
        </div>
        <div>
          <h1 className="font-display text-3xl font-black text-gray-900">
            Verification in progress
          </h1>
          <p className="mt-3 text-gray-600">
            Thanks, {user.displayName}. A member of our verification team is reviewing your ID,
            selfie and video introduction. This usually takes up to one working day.
          </p>
        </div>

        <div className="rounded-xl bg-background p-4 text-left text-sm text-gray-700">
          <p className="font-semibold text-gray-900">While you wait</p>
          <p className="mt-1">
            You can look around Needy, but you won&apos;t be able to book help or accept
            requests until you&apos;re approved. We&apos;ll update this page automatically.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Link href={paths.safety} className="flex-1">
            <Button type="button" variant="secondary">
              Read about Trust &amp; Safety
            </Button>
          </Link>
          <div className="flex-1">
            <Button type="button" variant="secondary" onClick={() => void refresh()}>
              Check now
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}
