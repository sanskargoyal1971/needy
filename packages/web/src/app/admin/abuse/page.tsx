"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, ShieldCheck } from "lucide-react";
import {
  ABUSE_SIGNAL_LABELS,
  ABUSE_WINDOW_MS,
  type AbuseRollup,
  type AbuseSignal,
  type AbuseSignalKind,
} from "@needy/shared";
import { adminClient } from "@/lib/adminClient";
import { Button, FormError } from "@/components/ui";
import { absoluteTime, describeAdminError, relativeTime } from "@/admin/format";

/** ── The abuse review queue ────────────────────────────────────────────────
 *  A ranked list of accounts whose behaviour tripped something, and nothing more. No button on
 *  this screen restricts anybody: the outcome an operator records here is a note for the next
 *  operator, and blocking remains a separate, deliberate act on the Users page with its own
 *  reason and its own audit row.
 *
 *  The copy carries that distinction on purpose. The strongest signal in the list — a burned
 *  handoff code — is also genuinely ambiguous: it is either an impostor at the door or a
 *  helper outside the wrong flat while the requester has put their phone down. A console that
 *  presented these as findings rather than as questions would push operators toward acting on
 *  the reading that needs no phone call, and on this platform the cost of wrongly cutting
 *  someone off from help is not symmetric with the cost of reading one more row.
 */

const WINDOWS = [
  { label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { label: "7 days", ms: ABUSE_WINDOW_MS },
  { label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
];

/** A bar whose length is relative to the heaviest row on screen, not to an absolute scale.
 *  There is no meaningful absolute — the number is a ranking weight — so anchoring it to the
 *  top row is the honest rendering. */
function ScoreBar({ score, max }: { score: number; max: number }) {
  const pct = max > 0 ? Math.max(6, Math.round((score / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-gray-100">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-6 text-right text-sm font-semibold tabular-nums text-gray-700">
        {score}
      </span>
    </div>
  );
}

function SubjectDetail({ userId }: { userId: string }) {
  const [signals, setSignals] = useState<AbuseSignal[] | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<"no-action" | "warned" | "escalated">("no-action");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await adminClient.abuseSubject(userId);
        if (!live) return;
        setSignals(res.signals);
        setPhone(res.user?.phone ?? null);
      } catch (err) {
        if (live) setError(describeAdminError(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [userId]);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await adminClient.reviewAbuse(userId, outcome, note.trim());
      setSaved(true);
      setNote("");
    } catch (err) {
      setError(describeAdminError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-gray-100 bg-background/60 px-5 py-4">
      {phone && (
        <p className="mb-3 text-sm text-gray-600">
          <span className="text-gray-500">Phone:</span>{" "}
          <a href={`tel:${phone}`} className="text-primary hover:underline">
            {phone}
          </a>
        </p>
      )}

      {signals == null ? (
        <Loader2 className="animate-spin text-primary" aria-label="Loading signals" />
      ) : (
        <ul className="mb-4 space-y-1.5">
          {signals.map((s) => (
            <li key={s.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-medium text-gray-900">
                {ABUSE_SIGNAL_LABELS[s.kind as AbuseSignalKind] ?? s.kind}
              </span>
              <span className="text-gray-500" title={absoluteTime(s.at)}>
                {relativeTime(s.at)}
              </span>
              {s.taskId && <span className="text-gray-400">task {s.taskId}</span>}
            </li>
          ))}
        </ul>
      )}

      <FormError>{error}</FormError>

      {saved ? (
        <p className="flex items-center gap-1.5 text-sm text-emerald-700">
          <ShieldCheck size={14} aria-hidden />
          Recorded against your account. The signals themselves are kept.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {(["no-action", "warned", "escalated"] as const).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setOutcome(o)}
                aria-pressed={outcome === o}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  outcome === o
                    ? "bg-primary text-white"
                    : "bg-white text-gray-700 ring-1 ring-inset ring-gray-200 hover:bg-gray-50"
                }`}
              >
                {o === "no-action" ? "No action" : o === "warned" ? "Warned" : "Escalate"}
              </button>
            ))}
          </div>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What did you find? e.g. called him — wrong building both times."
            className="block w-full rounded-xl border-0 p-3 text-sm text-gray-900 ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-inset focus:ring-primary"
          />
          <div className="sm:w-56">
            <Button onClick={submit} loading={saving} disabled={!note.trim()}>
              Record this review
            </Button>
          </div>
          {/* Says plainly what "Escalate" does and does not do, so nobody clicks it believing
              they have suspended an account. */}
          <p className="text-xs text-gray-500">
            None of these restrict the account. To suspend someone, block them from the Users
            page — that is a separate decision with its own reason.
          </p>
        </div>
      )}
    </div>
  );
}

export default function AbuseQueue() {
  const [windowMs, setWindowMs] = useState(ABUSE_WINDOW_MS);
  const [entries, setEntries] = useState<AbuseRollup[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (ms: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminClient.abuseQueue(ms);
      setEntries(res.entries);
    } catch (err) {
      setError(describeAdminError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(windowMs);
  }, [windowMs, load]);

  const max = entries.reduce((m, e) => Math.max(m, e.score), 0);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-xl font-bold text-gray-900">Behaviour signals</h2>
        <p className="mt-0.5 text-sm text-gray-600">
          Accounts whose behaviour tripped something, ranked by weight. These are questions for
          a person, not findings — nothing here has restricted anybody.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {WINDOWS.map((w) => (
          <button
            key={w.ms}
            type="button"
            onClick={() => setWindowMs(w.ms)}
            aria-pressed={windowMs === w.ms}
            className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
              windowMs === w.ms
                ? "bg-primary text-white"
                : "bg-white text-gray-700 ring-1 ring-inset ring-gray-200 hover:bg-gray-50"
            }`}
          >
            {w.label}
          </button>
        ))}
      </div>

      <FormError>{error}</FormError>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-primary" aria-label="Loading" />
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-3xl border border-gray-100 bg-white p-12 text-center">
          <ShieldCheck size={28} className="mx-auto mb-3 text-emerald-500" aria-hidden />
          <p className="font-medium text-gray-900">Nothing tripped in this window</p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-3xl border border-gray-100 bg-white">
          {entries.map((e) => {
            const expanded = openId === e.subjectId;
            return (
              <li key={e.subjectId}>
                <button
                  type="button"
                  onClick={() => setOpenId(expanded ? null : e.subjectId)}
                  aria-expanded={expanded}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-background"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-900">
                      {e.displayName}
                      {e.blockedAt != null && (
                        <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                          blocked
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 truncate text-sm text-gray-500">
                      {e.phoneMasked} ·{" "}
                      {Object.entries(e.byKind)
                        .map(
                          ([kind, n]) =>
                            `${n}× ${ABUSE_SIGNAL_LABELS[kind as AbuseSignalKind] ?? kind}`,
                        )
                        .join(", ")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <ScoreBar score={e.score} max={max} />
                    <span className="hidden text-sm text-gray-500 sm:inline">
                      {relativeTime(e.lastAt)}
                    </span>
                    {expanded ? (
                      <ChevronDown size={16} aria-hidden />
                    ) : (
                      <ChevronRight size={16} aria-hidden />
                    )}
                  </div>
                </button>
                {expanded && <SubjectDetail userId={e.subjectId} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
