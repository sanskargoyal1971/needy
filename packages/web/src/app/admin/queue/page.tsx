"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Inbox, Loader2 } from "lucide-react";
import type { OnboardingStatus } from "@needy/shared";
import { adminClient, type QueueEntry } from "@/lib/adminClient";
import { FormError } from "@/components/ui";
import { describeAdminError, relativeTime } from "@/admin/format";

const TABS: { status: OnboardingStatus; label: string }[] = [
  { status: "under_review", label: "Awaiting review" },
  { status: "approved", label: "Approved" },
  { status: "rejected", label: "Rejected" },
  { status: "documents", label: "Incomplete" },
];

export default function ReviewQueue() {
  const [status, setStatus] = useState<OnboardingStatus>("under_review");
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (s: OnboardingStatus) => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminClient.queue(s);
      setEntries(res.entries);
      setCounts(res.counts);
    } catch (err) {
      setError(describeAdminError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(status);
  }, [status, load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.status}
            type="button"
            onClick={() => setStatus(t.status)}
            aria-pressed={status === t.status}
            className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
              status === t.status
                ? "bg-primary text-white"
                : "bg-white text-gray-700 ring-1 ring-inset ring-gray-200 hover:bg-gray-50"
            }`}
          >
            {t.label}
            {counts[t.status] != null && (
              <span className={status === t.status ? "ml-2 opacity-80" : "ml-2 text-gray-400"}>
                {counts[t.status]}
              </span>
            )}
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
          <Inbox size={28} className="mx-auto mb-3 text-gray-400" aria-hidden />
          <p className="font-medium text-gray-900">Nothing here</p>
          <p className="mt-1 text-sm text-gray-600">
            {status === "under_review"
              ? "No packets are waiting on a reviewer."
              : "No accounts in this state."}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-3xl border border-gray-100 bg-white">
          {entries.map((e) => (
            <li key={e.id}>
              <Link
                href={`/admin/queue/${e.id}`}
                className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-background"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-gray-900">{e.displayName}</p>
                  <p className="mt-0.5 text-sm text-gray-500">
                    {e.phoneMasked}
                    {e.blockedAt != null && (
                      <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                        blocked
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-sm text-gray-500">
                  {/* Waiting time, not a raw timestamp: the operator's question is "who has
                      been waiting longest", and the SLA is one working day. */}
                  <span>{e.submittedAt ? relativeTime(e.submittedAt) : "—"}</span>
                  <ChevronRight size={16} aria-hidden />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
