"use client";

import { useParams } from "next/navigation";
import { TaskExperience } from "@/experience/TaskExperience";

/**
 * The live task screen — `/app/task/[id]`.
 *
 * `paths.task(id)` has pointed here since the Vite app; the request flow has routed here
 * since chunk 2; nothing existed at the other end until now. Creating a request landed on a
 * 404 with a task already open on the server and a search nobody would ever start.
 *
 * A thin client wrapper on purpose. The layout above it (`RequesterShell`) owns the auth gate
 * and the socket driver, and `TaskExperience` owns everything that renders — so this file's
 * entire job is to turn a route param into a prop. Anything else here would be state living
 * outside the driver, which is precisely what the whole realtime layer exists to avoid.
 *
 * The id comes from `useParams` rather than the `params` prop, matching
 * `app/admin/queue/[userId]`. On Next 14 a client component's `params` is a plain object, so
 * the `use(params)` spelling from 15 throws at render — and it TYPECHECKS, because the prop
 * type is whatever the page declares it to be. `next build` was perfectly happy; the screen
 * crashed into the error boundary the first time it was opened in a browser.
 *
 * Now on Next 16 `params` IS a promise and `use(params)` would work. `useParams` is kept
 * anyway: it is correct on both sides of the upgrade and needs no prop type to get wrong.
 */
export default function TaskPage() {
  const { id } = useParams<{ id: string }>();
  return <TaskExperience taskId={id} />;
}
