"use client";

import { use } from "react";
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
 * `params` is a promise in Next 15 and is unwrapped with `use()` rather than awaited, because
 * this must be a client component: the screen is a live socket subscription, not a render of
 * data fetched once on the server.
 */
export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <TaskExperience taskId={id} />;
}
