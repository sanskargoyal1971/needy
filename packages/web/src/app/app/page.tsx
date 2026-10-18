"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Footprints,
  HeartHandshake,
  Loader2,
  MapPin,
  Navigation,
  Package,
  Search,
  ShieldCheck,
  ShoppingBasket,
  Siren,
  Sparkles,
  Stethoscope,
  type LucideIcon,
} from "lucide-react";
import type { LatLng, ServiceDefinition, Task, TaskSnapshot } from "@needy/shared";
import { useAuth } from "@/auth/AuthProvider";
import { FormError } from "@/components/ui";
import { MapPin3D } from "@/motion/depth";
import { LiveMap } from "@/lib/LiveMap";
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

/** One icon per seeded catalog code; anything an admin adds later gets the generic one. */
const SERVICE_ICON: Record<string, LucideIcon> = {
  hospital: Stethoscope,
  groceries: ShoppingBasket,
  "pick-deliver": Package,
  "companion-walk": Footprints,
  "social-service": HeartHandshake,
};

/**
 * Where to centre the home map, without ever prompting for it.
 *
 * The saved home area first — onboarding asked for it. Failing that, the device position, but
 * ONLY if location permission was already granted: a permission prompt on a screen that is
 * just saying hello is a question with no visible reason behind it. The request form is where
 * location is asked for, because that is where it is needed.
 */
function useHomeArea(saved: LatLng | null): LatLng | null {
  const [device, setDevice] = useState<LatLng | null>(null);
  useEffect(() => {
    if (saved || typeof navigator === "undefined" || !navigator.geolocation) return;
    let cancelled = false;
    void (async () => {
      try {
        const status = await navigator.permissions?.query({ name: "geolocation" });
        if (status?.state !== "granted" || cancelled) return;
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            if (!cancelled) setDevice({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          },
          () => {},
          { maximumAge: 5 * 60_000, timeout: 10_000 },
        );
      } catch {
        // No Permissions API: no map, and no prompt either.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [saved]);
  return saved ?? device;
}

export default function RequesterHome() {
  const { state: auth } = useAuth();
  const [active, setActive] = useState<TaskSnapshot[] | null>(null);
  const [past, setPast] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceDefinition[]>([]);

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
    void Promise.resolve().then(load);
  }, [load]);

  useEffect(() => {
    void taskClient
      .services()
      .then(({ services: list }) => setServices(list))
      .catch(() => setServices([]));
  }, []);

  const user = auth.status === "authenticated" ? auth.user : null;
  const firstName = user ? user.displayName.split(" ")[0] : "there";
  const savedLat = user?.areaLat ?? null;
  const savedLng = user?.areaLng ?? null;
  const area = useHomeArea(
    savedLat != null && savedLng != null ? { lat: savedLat, lng: savedLng } : null,
  );

  return (
    <div className="mx-auto max-w-2xl">
      {/* Your neighbourhood first, the way a ride app opens on the street you are standing in.
          No helper positions here: those are only ever shown, coarsened, to a live search. */}
      <div className="relative overflow-hidden sm:mt-6 sm:rounded-[28px]">
        {area ? (
          <LiveMap bleed origin={area} helper={null} height="min(38vh, 320px)" />
        ) : (
          <div className="flex h-[min(30vh,240px)] items-center justify-center bg-gradient-to-b from-primary/15 to-background">
            <MapPin3D size={150} />
          </div>
        )}
        {user?.areaLabel && (
          <span className="absolute left-3 top-3 z-10 inline-flex max-w-[70%] items-center gap-1.5 truncate rounded-full bg-white/95 px-3 py-2 text-sm font-medium text-gray-800 shadow-[0_6px_18px_rgba(15,92,92,0.18)]">
            <MapPin size={14} className="shrink-0 text-primary" aria-hidden />
            <span className="truncate">{user.areaLabel}</span>
          </span>
        )}
      </div>

      <div className="relative z-10 -mt-7 rounded-t-[28px] bg-background px-4 pb-10 pt-5 shadow-[0_-12px_30px_rgba(15,92,92,0.10)] sm:mt-4 sm:rounded-[28px] sm:px-6 sm:shadow-none">
        <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-gray-300 sm:hidden" aria-hidden />
        <header className="mb-5">
          <h1 className="font-display text-3xl font-black text-gray-900">Hello, {firstName}</h1>
          <p className="mt-1 text-gray-600">Verified people near you, ready to help in person.</p>
        </header>

        {/* The one big entry point, shaped like the "Where to?" box everyone already knows. */}
        <Link
          href={paths.newRequest}
          className="mb-6 flex items-center gap-3 rounded-2xl bg-white px-4 py-4 shadow-[0_10px_30px_rgba(15,92,92,0.10)] ring-1 ring-gray-100 transition-shadow hover:shadow-[0_14px_36px_rgba(15,92,92,0.16)]"
        >
          <Search size={20} className="shrink-0 text-primary" aria-hidden />
          <span className="flex-1 text-lg font-medium text-gray-500">
            What do you need help with?
          </span>
          <span className="rounded-full bg-primary px-3 py-1.5 text-sm font-semibold text-white">
            Now
          </span>
        </Link>

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
                      {task.state === "searching" && task.helperId != null
                        ? task.scheduledFor != null
                          ? "Booked"
                          : "Waiting for them to answer"
                        : (STATE_COPY[task.state] ?? task.state)}
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
        ) : null}

        {services.length > 0 && (
          <section className="mt-6" aria-label="Services">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
              Ask for
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {services.map((svc) => {
                const Icon = SERVICE_ICON[svc.code] ?? Sparkles;
                return (
                  <Link
                    key={svc.code}
                    href={`${paths.newRequest}?service=${encodeURIComponent(svc.code)}`}
                    className="group flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-[0_6px_20px_rgba(15,92,92,0.07)] ring-1 ring-gray-100 transition-all hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(15,92,92,0.14)]"
                  >
                    <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-white">
                      <Icon size={22} aria-hidden />
                    </span>
                    <span>
                      <span className="block font-semibold text-gray-900">{svc.name}</span>
                      <span className="mt-0.5 line-clamp-2 text-xs text-gray-500">
                        {svc.description}
                      </span>
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {/* What makes this different from a gig app, said in three lines rather than a page. */}
        <section className="mt-6 grid gap-2 rounded-2xl bg-primary/5 p-4 text-sm text-gray-700">
          <p className="flex items-start gap-2.5">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
            Every helper is ID-verified and reviewed by a person.
          </p>
          <p className="flex items-start gap-2.5">
            <Navigation size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
            You see them on the map from the moment they set off — and only until the visit ends.
          </p>
          <p className="flex items-start gap-2.5">
            <Siren size={16} className="mt-0.5 shrink-0 text-red-600" aria-hidden />
            The red button alerts our safety team at any point during a visit.
          </p>
        </section>

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
                      · {relativeTime(t.updatedAt)}
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
    </div>
  );
}
