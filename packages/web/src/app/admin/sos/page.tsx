"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MapPin,
  Phone,
  Radio,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import type { SosKind } from "@needy/shared";
import { adminClient, type AlertView } from "@/lib/adminClient";
import { Button, FormError } from "@/components/ui";
import { absoluteTime, describeAdminError, relativeTime } from "@/admin/format";
import { partitionAlerts, useSosFeed, type FeedStatus } from "@/admin/useSosFeed";

/** ── The SOS console ───────────────────────────────────────────────────────
 *  Somebody pressed a panic button and is waiting. Every decision on this screen follows from
 *  that:
 *
 *   - The queue is oldest-first, not newest-first. A feed sorted by arrival buries the person
 *     who has been waiting longest under each new alarm, which is the opposite of triage.
 *   - The waiting time is the headline, in red past a minute. It is the number this subsystem
 *     is judged on and it should be uncomfortable to look at.
 *   - Both parties' phone numbers are on the card, not behind a click. An operator answering
 *     an alarm is going to call someone.
 *   - "Acknowledge" is deliberately a button and not a side effect of the page loading: it
 *     tells the frightened person, over their socket, that a human has their alarm. That claim
 *     must be made by a person taking responsibility, not by a page render.
 *   - The connection state is always visible. An operator looking at an empty queue has to be
 *     able to tell "nothing is happening" from "this console stopped listening", because those
 *     look identical and only one of them is fine.
 */

const KIND_LABEL: Record<SosKind, string> = {
  panic: "Panic",
  medical: "Medical",
  unsafe: "Feels unsafe",
  other: "Other",
};

/**
 * Waiting time, escalating in colour. Past a minute this is no longer a queue entry.
 *
 * It TICKS. The first version read `Date.now()` during render and therefore froze at whatever
 * the clock said when the alert arrived — a console whose headline number is "12s" for the
 * next four minutes, which is worse than showing nothing because it actively reassures. The
 * whole argument for this number being the headline is that it should get uncomfortable to
 * look at, and a frozen one never does.
 */
function Waiting({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const seconds = Math.round((now - since) / 1000);
  const tone =
    seconds > 300 ? "text-red-700" : seconds > 60 ? "text-orange-600" : "text-gray-700";
  return (
    <span className={`font-semibold tabular-nums ${tone}`} title={absoluteTime(since)}>
      {seconds < 60 ? `${seconds}s` : relativeTime(since, now)}
    </span>
  );
}

function ConnectionBadge({ status }: { status: FeedStatus }) {
  if (status === "watching") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
        <Radio size={13} aria-hidden />
        Live
      </span>
    );
  }
  if (status === "connecting") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
        <Loader2 size={13} className="animate-spin" aria-hidden />
        Connecting
      </span>
    );
  }
  // Refused and disconnected both mean the same thing to the person at the desk: alarms are
  // not reaching this screen. Said plainly rather than in a status code.
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-700">
      <WifiOff size={13} aria-hidden />
      {status === "refused" ? "Not authorised" : "Not receiving alerts"}
    </span>
  );
}

function Party({
  role,
  party,
  raised,
}: {
  role: string;
  party: { displayName: string; phone: string } | null;
  raised: boolean;
}) {
  if (!party) {
    return (
      <div className="text-sm text-gray-400">
        {role}: <span className="italic">unknown</span>
      </div>
    );
  }
  return (
    <div className="text-sm">
      <span className="text-gray-500">{role}:</span>{" "}
      <span className="font-medium text-gray-900">{party.displayName}</span>
      {raised && (
        <span className="ml-1.5 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
          raised this
        </span>
      )}
      <a
        href={`tel:${party.phone}`}
        className="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
      >
        <Phone size={12} aria-hidden />
        {party.phone}
      </a>
    </div>
  );
}

function AlertCard({
  alert,
  onChanged,
}: {
  alert: AlertView;
  onChanged: (a: AlertView) => void;
}) {
  const [busy, setBusy] = useState<"ack" | "resolve" | null>(null);
  const [note, setNote] = useState("");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settled = alert.status === "resolved" || alert.status === "cancelled";

  async function acknowledge() {
    setBusy("ack");
    setError(null);
    try {
      const { alert: updated } = await adminClient.acknowledgeSos(alert.id);
      onChanged(updated);
    } catch (err) {
      setError(describeAdminError(err));
    } finally {
      setBusy(null);
    }
  }

  async function resolve() {
    setBusy("resolve");
    setError(null);
    try {
      const { alert: updated } = await adminClient.resolveSos(alert.id, note.trim());
      onChanged(updated);
      setResolving(false);
      setNote("");
    } catch (err) {
      setError(describeAdminError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li
      className={`rounded-3xl border p-5 ${
        settled
          ? "border-gray-100 bg-white opacity-60"
          : alert.status === "acknowledged"
            ? "border-amber-200 bg-amber-50/40"
            : "border-red-200 bg-red-50/40"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <AlertTriangle
              size={18}
              className={settled ? "text-gray-400" : "text-red-600"}
              aria-hidden
            />
            <span className="font-display text-lg font-bold text-gray-900">
              {KIND_LABEL[alert.kind]}
            </span>
            <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-gray-600 ring-1 ring-inset ring-gray-200">
              {alert.status}
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-600">
            {alert.task ? alert.task.title : "Task unavailable"}
            {alert.task && <span className="text-gray-400"> · {alert.task.state}</span>}
          </p>
        </div>
        <div className="text-right text-sm">
          <div className="text-gray-500">waiting</div>
          <Waiting since={alert.createdAt} />
        </div>
      </div>

      {/* The raiser's own words. Rendered as plain text and never copied into the audit log —
          it is written by someone in distress and can contain anything. */}
      {alert.note && (
        <p className="mt-3 rounded-2xl bg-white p-3 text-sm italic text-gray-800 ring-1 ring-inset ring-gray-100">
          “{alert.note}”
        </p>
      )}

      <div className="mt-3 space-y-1">
        <Party
          role="Requester"
          party={alert.requester}
          raised={alert.raisedByRole === "requester"}
        />
        <Party role="Helper" party={alert.helper} raised={alert.raisedByRole === "helper"} />
        {alert.at ? (
          <a
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            href={`https://www.openstreetmap.org/?mlat=${alert.at.lat}&mlon=${alert.at.lng}#map=17/${alert.at.lat}/${alert.at.lng}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            <MapPin size={12} aria-hidden />
            {alert.at.lat.toFixed(5)}, {alert.at.lng.toFixed(5)}
          </a>
        ) : (
          // Said out loud rather than omitted: an operator must know they are dispatching
          // without a location, not just fail to notice a missing line.
          <p className="text-sm text-amber-700">No location — ask on the phone.</p>
        )}
      </div>

      {alert.acknowledgedBy && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-amber-800">
          <ShieldCheck size={14} aria-hidden />
          Owned by {alert.acknowledgedByName ?? alert.acknowledgedBy}
          {alert.acknowledgedAt && <> · {relativeTime(alert.acknowledgedAt)}</>}
        </p>
      )}
      {alert.resolutionNote && (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-gray-700">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
          <span>
            {alert.resolutionNote}
            {alert.resolvedBy && (
              <span className="text-gray-400"> — {alert.resolvedByName ?? alert.resolvedBy}</span>
            )}
          </span>
        </p>
      )}

      <FormError>{error}</FormError>

      {!settled && (
        <div className="mt-4 space-y-3">
          {resolving ? (
            <div className="space-y-2">
              <label
                htmlFor={`note-${alert.id}`}
                className="block text-sm font-medium text-gray-900"
              >
                What happened?
              </label>
              {/* Required, and the copy says why. An alert closed with no account of it is
                  indistinguishable from an operator clearing their queue. */}
              <textarea
                id={`note-${alert.id}`}
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Phoned her — the helper was at the wrong building. Both fine."
                className="block w-full rounded-xl border-0 p-3 text-sm text-gray-900 ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-inset focus:ring-primary"
              />
              <div className="flex gap-2">
                <div className="w-44">
                  <Button onClick={resolve} loading={busy === "resolve"} disabled={!note.trim()}>
                    Close this alert
                  </Button>
                </div>
                <div className="w-32">
                  <Button variant="secondary" onClick={() => setResolving(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {/* Widths are constrained because `Button` is `w-full` by design (it was built
                  for the signup wizard's single-action panes). Left bare, every action here
                  spanned the whole card — and a full-width "Resolve" sitting under the
                  primary action on a triage screen is a mis-click waiting to happen. */}
              {alert.status === "raised" && (
                <div className="w-44">
                  <Button onClick={acknowledge} loading={busy === "ack"}>
                    I&apos;m on it
                  </Button>
                </div>
              )}
              <div className="w-32">
                <Button variant="secondary" onClick={() => setResolving(true)}>
                  Resolve
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export default function SosConsole() {
  const { alerts, status, error, replace } = useSosFeed();
  const { open, closed } = partitionAlerts(alerts);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold text-gray-900">Live alerts</h2>
          <p className="mt-0.5 text-sm text-gray-600">
            Oldest first — whoever has been waiting longest is answered next.
          </p>
        </div>
        <ConnectionBadge status={status} />
      </div>

      <FormError>{error}</FormError>

      {open.length === 0 ? (
        <div className="rounded-3xl border border-gray-100 bg-white p-12 text-center">
          <ShieldCheck size={28} className="mx-auto mb-3 text-emerald-500" aria-hidden />
          <p className="font-medium text-gray-900">No open alerts</p>
          <p className="mt-1 text-sm text-gray-600">
            {status === "watching"
              ? "This console is connected and will show an alarm the moment one is raised."
              : "This console is not currently receiving alerts."}
          </p>
        </div>
      ) : (
        <ul className="space-y-4">
          {open.map((a) => (
            <AlertCard key={a.id} alert={a} onChanged={replace} />
          ))}
        </ul>
      )}

      {closed.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Closed this session
          </h3>
          <ul className="space-y-4">
            {closed.map((a) => (
              <AlertCard key={a.id} alert={a} onChanged={replace} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
