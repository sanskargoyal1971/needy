"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { ExceptionWizard } from "@/experience/ExceptionWizard";

/**
 * `/app/exceptions` — pairing reviews, from the requester's side.
 *
 * `?helperId=` is optional and only changes one thing: whether the screen can OPEN a new
 * review. Without it this is the list of what is already in flight, which is what a helper
 * following a link from their own home screen needs.
 *
 * Wrapped in Suspense because `useSearchParams` opts a route into client-side bailout in the
 * App Router; without a boundary the whole page would have to be rendered on demand with no
 * fallback, which shows a blank frame rather than a spinner.
 */
export default function ExceptionsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="animate-spin text-primary" aria-label="Loading" />
        </div>
      }
    >
      <ExceptionsInner />
    </Suspense>
  );
}

function ExceptionsInner() {
  const params = useSearchParams();
  return <ExceptionWizard helperId={params.get("helperId") ?? undefined} />;
}
