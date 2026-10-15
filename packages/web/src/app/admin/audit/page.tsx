"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, Loader2, ShieldBan, ShieldCheck, ShieldX, Upload, UserCheck } from "lucide-react";
import { adminClient, type AuditRow } from "@/lib/adminClient";
import { FormError } from "@/components/ui";
import { absoluteTime, describeAdminError } from "@/admin/format";

/** Icon and colour per action, so a reviewer scanning the log can pick out decisions from
 *  the much noisier stream of document views. */
const STYLE: Record<string, { icon: typeof Eye; tone: string; label: string }> = {
  "admin.document_viewed": { icon: Eye, tone: "text-gray-500", label: "Viewed document" },
  "onboarding.approved": { icon: ShieldCheck, tone: "text-primary", label: "Approved" },
  "onboarding.rejected": { icon: ShieldX, tone: "text-red-600", label: "Rejected" },
  "admin.user_blocked": { icon: ShieldBan, tone: "text-red-600", label: "Blocked user" },
  "admin.user_unblocked": { icon: ShieldCheck, tone: "text-primary", label: "Unblocked user" },
  "onboarding.identity_submitted": {
    icon: UserCheck,
    tone: "text-gray-500",
    label: "Submitted identity",
  },
  "onboarding.document_uploaded": {
    icon: Upload,
    tone: "text-gray-500",
    label: "Uploaded document",
  },
  "onboarding.submitted_for_review": {
    icon: UserCheck,
    tone: "text-gray-500",
    label: "Submitted for review",
  },
};

export default function AuditLog() {
  const [entries, setEntries] = useState<AuditRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const who = (id: string | null): string => (id ? (names[id] ?? id) : "system");
  const [durable, setDurable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminClient.audit({ limit: 200 });
      setEntries(res.entries);
      setNames(res.names ?? {});
      setDurable(res.durable);
    } catch (err) {
      setError(describeAdminError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Append-only. Entries cannot be edited or deleted, including by an administrator.
      </p>

      {/* An empty log and a log that was never durable look identical on screen, and only one
          of those is acceptable. Say which this is. */}
      {!durable && (
        <div className="rounded-xl border-l-4 border-yellow-400 bg-yellow-50 p-3 text-sm text-yellow-800">
          <strong className="font-semibold">Not durable:</strong> no database is configured, so
          audit events are only written to the application log and are not queryable here.
        </div>
      )}

      <FormError>{error}</FormError>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-primary" aria-label="Loading" />
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-3xl border border-gray-100 bg-white p-12 text-center text-sm text-gray-600">
          No audit entries yet.
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-3xl border border-gray-100 bg-white">
          {entries.map((e) => {
            const s = STYLE[e.action] ?? { icon: Eye, tone: "text-gray-500", label: e.action };
            const Icon = s.icon;
            return (
              <li key={e.id} className="flex items-start gap-3 px-5 py-3.5 text-sm">
                <Icon size={16} className={`mt-0.5 shrink-0 ${s.tone}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-gray-900">
                    {s.label}
                    {typeof e.metadata?.kind === "string" && (
                      <span className="font-normal text-gray-500"> · {e.metadata.kind}</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {/* The name for reading, the id on hover for looking the record up. */}
                    by <span title={e.actorId ?? undefined}>{who(e.actorId)}</span>
                    {e.subjectId && (
                      <>
                        {" · "}
                        <span title={e.subjectId}>{who(e.subjectId)}</span>
                      </>
                    )}
                  </p>
                  {typeof e.metadata?.reason === "string" && (
                    <p className="mt-1 text-xs text-gray-600">“{e.metadata.reason}”</p>
                  )}
                </div>
                {/* Absolute, not relative: the log is evidence and may be read months later. */}
                <time className="shrink-0 text-xs text-gray-400">{absoluteTime(e.at)}</time>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
