"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import {
  CATEGORY_PRICING,
  EXCEPTION_REVIEW_SLA_MS,
  HOSPITAL_SERVICE_CODE,
  type ServiceDefinition,
  type TaskCategory,
} from "@needy/shared";
import { AuthError } from "@/lib/authClient";
import { Button, Field, FormError, TextInput } from "@/components/ui";
import { paths } from "@/lib/paths";
import { taskClient } from "@/lib/taskClient";
import { OriginPicker } from "@/experience/OriginPicker";

/** ── Asking for help ───────────────────────────────────────────────────────
 *  One screen, three questions: what do you need, where are you, and what should we call it.
 *
 *  The service list is fetched from the catalog rather than hard-coded, because the catalog is
 *  also what the matching filter reads — a picker with its own private list of services would
 *  let someone request something no helper is enrolled in, and the search would then simply
 *  find nobody with no explanation available to anyone.
 *
 *  The refusal path matters more than the happy path here. Naming a specific helper can come
 *  back `pairing-denied` or `exception-required`, which is the eligibility matrix speaking:
 *  the platform is telling a real person it will not connect them to another real person. That
 *  deserves the actual reason and a route forward, not a red toast.
 */

/** Catalog codes carry the service; the task's `category` still drives pricing and matching
 *  weights, so the two are mapped here rather than guessed server-side. */
const CATEGORY_FOR_SERVICE: Record<string, TaskCategory> = {
  [HOSPITAL_SERVICE_CODE]: "urgent",
  groceries: "errand",
  "companion-walk": "companionship",
  "pick-deliver": "errand",
  "social-service": "social-service",
};

export default function NewRequestPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="animate-spin text-primary" aria-label="Loading" />
        </div>
      }
    >
      <NewRequest />
    </Suspense>
  );
}

function NewRequest() {
  const router = useRouter();
  /**
   * Booking one specific person, rather than opening a search.
   *
   * This is the only way `exception-required` can ever be reached — the eligibility matrix is
   * applied per candidate INSIDE matching for an open request, so an open request is never
   * refused for a pairing reason. Until this parameter existed the refusal branch below was
   * unreachable, and with it the whole exception flow: the wizard had no entrance.
   */
  const namedHelper = useSearchParams().get("helperId");
  const [scheduledFor, setScheduledFor] = useState("");
  const [services, setServices] = useState<ServiceDefinition[] | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [origin, setOrigin] = useState<{ lat: number; lng: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ code: string; helperId?: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { services: list } = await taskClient.services();
        setServices(list);
      } catch {
        setServices([]);
        setError("Could not load the list of services. Please try again.");
      }
    })();
  }, []);

  const selected = useMemo(() => services?.find((s) => s.code === code) ?? null, [services, code]);
  const category = code ? (CATEGORY_FOR_SERVICE[code] ?? "errand") : "errand";
  const price = CATEGORY_PRICING[category];

  const submit = useCallback(async () => {
    if (!code || !origin) return;
    setSubmitting(true);
    setError(null);
    setRefusal(null);
    try {
      const task = await taskClient.create({
        category,
        origin,
        title: title.trim(),
        description: description.trim(),
        serviceCode: code,
        ...(namedHelper ? { helperId: namedHelper } : {}),
        // `datetime-local` has no zone, so it parses in the browser's — which is the one the
        // person picking a time is actually in. Sent as epoch ms so the server never has to
        // guess whose afternoon "3pm" meant.
        ...(scheduledFor ? { scheduledFor: new Date(scheduledFor).getTime() } : {}),
      });
      // Straight to the live screen. The SEARCH is opened there over the socket, not here —
      // the task exists durably first, so a refresh mid-search resumes rather than losing it.
      router.replace(paths.task(task.id));
    } catch (err) {
      if (err instanceof AuthError) {
        if (err.code === "pairing-denied" || err.code === "exception-required") {
          setRefusal({ code: err.code, helperId: namedHelper ?? undefined });
        } else if (err.code === "schedule-required") {
          setError(
            "This booking has to be arranged for a set time rather than asked for on the spot. Pick a day and time below.",
          );
        } else if (err.code === "invalid-schedule") {
          // The server's own minimum lead time, echoed back rather than hard-coded here, so
          // the two cannot drift apart.
          const lead = err.details?.minimumLeadMs;
          const hours = typeof lead === "number" ? Math.round(lead / (60 * 60 * 1000)) : 24;
          setError(
            `That time doesn't work. A booking like this needs at least ${hours} hours' notice.`,
          );
        } else if (err.code === "too-many-requests") {
          setError("You've opened several requests very quickly. Please wait a moment.");
        } else if (err.code === "too-many-open-requests") {
          const max = err.details?.maxOpen;
          setError(
            `You already have ${typeof max === "number" ? max : "several"} requests open. Finish or cancel one from your requests before asking for another.`,
          );
        } else if (err.code === "not-approved") {
          setError("Your account is still being reviewed, so you can't book yet.");
        } else {
          setError("We couldn't open your request. Please try again.");
        }
      } else {
        setError("We couldn't open your request. Please try again.");
      }
      setSubmitting(false);
    }
  }, [category, code, description, namedHelper, origin, router, scheduledFor, title]);

  // A named booking is not submittable without a time: the server refuses one outright, and
  // letting the button look ready would spend a tap to learn that.
  const ready = Boolean(
    code &&
    origin &&
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    (!namedHelper || scheduledFor),
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-3xl font-black text-gray-900">What do you need?</h1>
      <p className="mt-1 text-gray-600">
        We&apos;ll show your request to verified helpers nearby, closest first.
      </p>

      <div className="mt-8 space-y-6">
        {/* ── service ─────────────────────────────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-sm font-medium text-gray-900">Choose a service</h2>
          {services == null ? (
            <div className="flex justify-center py-8">
              <Loader2 className="animate-spin text-primary" aria-label="Loading services" />
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {services.map((s) => {
                const active = s.code === code;
                const p = CATEGORY_PRICING[CATEGORY_FOR_SERVICE[s.code] ?? "errand"];
                return (
                  <button
                    key={s.code}
                    type="button"
                    onClick={() => {
                      setCode(s.code);
                      // Pre-fill a sensible title so the fastest path through this form is
                      // three taps. Someone in distress should not have to compose a subject
                      // line; they can still edit it.
                      if (!title.trim()) setTitle(s.name);
                    }}
                    aria-pressed={active}
                    className={`rounded-2xl border p-4 text-left transition-colors ${
                      active
                        ? "border-primary bg-primary/5 ring-1 ring-inset ring-primary"
                        : "border-gray-200 bg-white hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-gray-900">{s.name}</span>
                      <span className="shrink-0 text-sm font-semibold text-gray-700">
                        {p > 0 ? `₹${p}` : "Free"}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-gray-600">{s.description}</p>
                    {s.isMandatory && (
                      // Worth saying out loud: this is the one service the whole verified pool
                      // offers, which is why it is the emergency path.
                      <p className="mt-2 text-xs font-medium text-primary">
                        Every verified helper offers this
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* ── where ───────────────────────────────────────────────────────── */}
        <section>
          <h2 className="mb-1 text-sm font-medium text-gray-900">Where are you?</h2>
          <p className="mb-3 text-sm text-gray-500">
            Drag the pin if it isn&apos;t exactly right. Helpers only see a rough area until one of
            them accepts.
          </p>
          <OriginPicker value={origin} onChange={setOrigin} />
        </section>

        {/* ── what ────────────────────────────────────────────────────────── */}
        <Field label="Give it a short name" htmlFor="title">
          <TextInput
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={140}
            placeholder="Pick up my medicines"
          />
        </Field>

        <Field
          label="What would help most?"
          hint="The helper reads this before they accept, so anything that matters — stairs, a gate code, how urgent it is — belongs here."
          htmlFor="description"
        >
          <textarea
            id="description"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            placeholder="I need my blood pressure tablets from the chemist on the main road. I'm on the second floor and the lift is out."
            className="block w-full rounded-xl border-0 p-4 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-primary sm:text-sm"
          />
        </Field>

        {/* ── when, for a booking with a named person ─────────────────────── */}
        {namedHelper && (
          <Field
            label="When would you like them to come?"
            hint={`A booking with a specific person is arranged in advance rather than dispatched
                   now, so it needs at least ${MIN_LEAD_HOURS} hours' notice.`}
            htmlFor="scheduledFor"
          >
            <TextInput
              id="scheduledFor"
              type="datetime-local"
              value={scheduledFor}
              // The same floor the server enforces, so the picker cannot offer a time that
              // will be refused. `min` is advisory in some browsers, which is why the server
              // still checks and this screen still renders that refusal.
              min={minBookingLocal()}
              onChange={(e) => setScheduledFor(e.target.value)}
            />
          </Field>
        )}

        <FormError>{error}</FormError>
        {refusal && <PairingRefusal code={refusal.code} helperId={refusal.helperId} />}

        <div className="rounded-2xl bg-white p-4 ring-1 ring-inset ring-gray-100">
          <div className="flex items-center justify-between">
            <span className="text-gray-600">
              {selected ? selected.name : "Nothing selected yet"}
            </span>
            <span className="font-display text-xl font-bold text-gray-900">
              {/* No figure until something is chosen: a price beside "Nothing selected yet"
                  is a price for nothing. */}
              {!selected ? "—" : price > 0 ? `₹${price}` : "Free"}
            </span>
          </div>
          {/* Stated before they commit, not after. A flat price is one of the few honest
              things this product can promise, and burying it would waste that. */}
          <p className="mt-1 text-xs text-gray-500">
            Flat price, agreed up front. In-app payment is not available yet, so nothing is charged
            through Needy for now.
          </p>
        </div>

        <Button onClick={submit} loading={submitting} disabled={!ready}>
          Find someone to help
        </Button>
      </div>
    </div>
  );
}

/** The eligibility matrix, explained to the person it just refused.
 *
 *  This is the most delicate copy in the product. The rule exists to protect both parties, and
 *  the person reading it has done nothing wrong — so it names the rule, does not imply anything
 *  about them, and gives the route that exists. Vagueness here reads as suspicion. */
/** The server's review SLA, in hours, for copy. Derived rather than written down twice. */
const MIN_LEAD_HOURS = Math.round(EXCEPTION_REVIEW_SLA_MS / (60 * 60 * 1000));

/** The earliest bookable slot, formatted for `datetime-local` (which wants local wall-clock,
 *  not an ISO instant — `toISOString()` here would silently offer a UTC time as if it were the
 *  user's). */
function minBookingLocal(): string {
  const earliest = new Date(Date.now() + EXCEPTION_REVIEW_SLA_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${earliest.getFullYear()}-${pad(earliest.getMonth() + 1)}-${pad(
    earliest.getDate(),
  )}T${pad(earliest.getHours())}:${pad(earliest.getMinutes())}`;
}

function PairingRefusal({ code, helperId }: { code: string; helperId?: string }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-700" aria-hidden />
        <div className="text-sm text-amber-900">
          {code === "exception-required" ? (
            <>
              <p className="font-semibold">This pairing needs a review first</p>
              <p className="mt-1">
                For safety, we don&apos;t automatically match two young adults of different genders.
                It isn&apos;t about either of you — it applies to everyone, both ways round.
              </p>
              <p className="mt-2">
                If you both want to go ahead, you can each record a short video saying so and a
                member of our team will review it within one working day.
              </p>
              {/* The route out, not just the rule. A refusal that names a remedy and then
                  doesn't offer it is worse than one that says nothing — the person now knows
                  something is possible and has to go hunting for it. */}
              {helperId && (
                <Link
                  href={paths.exceptions(helperId)}
                  className="mt-3 inline-block rounded-xl bg-amber-800 px-4 py-2.5 font-semibold text-white transition-colors hover:bg-amber-900"
                >
                  Start that review
                </Link>
              )}
            </>
          ) : (
            <>
              <p className="font-semibold">We can&apos;t arrange this particular pairing</p>
              <p className="mt-1">
                Our safety rules don&apos;t allow this specific match. Choosing an open request
                instead will find you someone nearby straight away.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
