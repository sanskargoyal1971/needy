"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, HeartHandshake, Loader2, ShieldCheck } from "lucide-react";
import type { Task, TaskSnapshot } from "@needy/shared";
import { useAuth } from "@/auth/AuthProvider";
import { FormError } from "@/components/ui";
import { relativeTime } from "@/admin/format";
import { paths } from "@/lib/paths";
import { taskClient } from "@/lib/taskClient";

/** ── Requester home ────────────────────────────────────────────────────────
 *  The first screen an approved requester has ever had. Until now `homeFor()` sent them here
 *  and the route did not exist, so signing in as an ordinary user ended at a 404 — the app
 *  was usable only by staff.
 *
 *  The screen answers one question before anything else: is something already running? A
 *  person who closed the tab while a helper was on their way is the single most important
 *  reader of this page, and they need the way back in, not a fresh "Get help" button. The
 *  answer comes from `/snapshot` rather than from anything remembered locally, because the
 *  server is the only party that actually knows.
 */

const STATE_COPY: Record<string, string> = {
  searching: "Looking for someone nearby",
  matched: "Someone has accepted",
  verifying: "Checking each other",
  "en-route": "On the way to you",
  arrived: "At your door",
  "in-progress": "Helping you now",
};

export default function RequesterHome() {
  const { state: auth } = useAuth();
  const [active, setActive] = useState<TaskSnapshot[] | null>(null);
  const [past, setPast] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Both at once: the answer to "is something running" and "what have I asked for
      // before" are independent, and serialising them would make the page twice as slow to
      // tell someone their helper is outside.
      const [snap, history] = await Promise.all([
        taskClient.snapshot(),
        taskClient.history().catch(() => ({ tasks: [] as Task[] })),
      ]);
      setActive(snap.activeTasks);
      setPast(history.tasks);
      setError(null);
    } catch {
      setActive([]);
      setError("Could not load your requests. Check your connection and try again.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const firstName =
    auth.status === "authenticated" ? auth.user.displayName.split(" ")[0] : "there";

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <h1 className="font-display text-3xl font-black text-gray-900">Hello, {firstName}</h1>
        <p className="mt-1 text-gray-600">
          Verified people near you, ready to help in person.
        </p>
      </header>

      <FormError>{error}</FormError>

      {active == null ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-primary" aria-label="Loading" />
        </div>
      ) : active.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Happening now
          </h2>
          {active.map(({ task, helper }) => (
            <Link
              key={task.id}
              href={paths.task(task.id)}
              className="block rounded-3xl border-2 border-primary/30 bg-white p-5 transition-colors hover:border-primary/60"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  {/* The STATE leads, not the title. Someone returning to this screen wants
                      "on the way to you" before they want to be reminded what they asked
                      for — they know what they asked for. */}
                  <p className="font-display text-lg font-bold text-primary">
                    {STATE_COPY[task.state] ?? task.state}
                  </p>
                  <p className="mt-0.5 truncate text-gray-900">{task.title}</p>
                  {helper && (
                    <p className="mt-1 text-sm text-gray-600">
                      {helper.displayName}
                      {helper.etaSeconds != null && (
                        <> · about {Math.max(1, Math.round(helper.etaSeconds / 60))} min away</>
                      )}
                    </p>
                  )}
                </div>
                <ArrowRight className="shrink-0 text-primary" aria-hidden />
              </div>
            </Link>
          ))}
        </section>
      ) : (
        <section className="rounded-3xl border border-gray-100 bg-white p-8 text-center">
          <HeartHandshake size={32} className="mx-auto mb-3 text-primary" aria-hidden />
          <h2 className="font-display text-xl font-bold text-gray-900">
            Need a hand with something?
          </h2>
          <p className="mx-auto mt-2 max-w-md text-gray-600">
            Tell us what you need and we&apos;ll find a verified helper close by. You&apos;ll
            see who they are before they set off.
          </p>
          <Link
            href={paths.newRequest}
            className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
          >
            Get help now
          </Link>
          <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-gray-500">
            <ShieldCheck size={13} aria-hidden />
            Every helper is ID-verified and reviewed by a person
          </p>
        </section>
      )}

      {past.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Earlier
          </h2>
          <ul className="divide-y divide-gray-100 overflow-hidden rounded-3xl border border-gray-100 bg-white">
            {past.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="truncate text-gray-900">{t.title}</p>
                  <p className="mt-0.5 text-sm text-gray-500">
                    {/* Cancelled is named rather than dressed up. A list where every row says
                        "completed" regardless of what happened is not a history. */}
                    {t.state === "cancelled"
                      ? "Cancelled"
                      : t.state === "unmatched"
                        ? "Nobody was available"
                        : "Completed"}{" "}
                    ·{" "}
                    {relativeTime(t.updatedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {/* Asking for the same person again is the ONLY way a requester names a
                      specific helper, and therefore the only route into the pairing review —
                      an open request is matched by the server and never refused for a pairing
                      reason. Offered only on a completed task: repeating a cancelled one is
                      asking again of someone who did not turn up. */}
                  {t.state === "completed" && t.helperId && (
                    <Link
                      href={paths.newRequest + `?helperId=${encodeURIComponent(t.helperId)}`}
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      Ask again
                    </Link>
                  )}
                  <span className="text-sm text-gray-500">
                    {t.price > 0 ? `₹${t.price}` : "Free"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* A second request while one is running is allowed — the server does not restrict it —
          so this offers rather than forbids. Saying "you can only have one" would have been
          easy copy and simply untrue. */}
      {active != null && active.length > 0 && (
        <div className="mt-8 text-center">
          <Link
            href={paths.newRequest}
            className="text-sm font-medium text-primary hover:underline"
          >
            Ask for something else
          </Link>
        </div>
      )}
    </div>
  );
}
