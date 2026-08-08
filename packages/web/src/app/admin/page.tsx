"use client";

import { redirect } from "next/navigation";
import { paths } from "@/lib/paths";

/** The console has no separate dashboard: the review queue IS the job. A landing page of
 *  counts would be one more click between an operator and the people waiting on them. */
export default function AdminIndex() {
  redirect(paths.adminQueue);
}
