"use client";

import { ExceptionWizard } from "@/experience/ExceptionWizard";

/**
 * `/helper/reviews` — the second party's way in.
 *
 * The same component as the requester's route, with no `helperId`: a helper never opens a
 * review, they are only ever asked to complete one. Before `GET /me/exceptions` existed there
 * was no route by which they could be told a request was waiting on their testimony at all, so
 * every exception sat unfinished until it expired.
 */
export default function HelperReviews() {
  return <ExceptionWizard />;
}
