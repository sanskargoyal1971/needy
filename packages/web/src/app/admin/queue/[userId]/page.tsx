"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, Loader2, ShieldX, X } from "lucide-react";
import { adminClient, type PacketDocument, type PacketUser } from "@/lib/adminClient";
import type { Role } from "@/lib/authClient";
import { paths } from "@/lib/paths";
import { Button, Field, FormError, Select, TextInput } from "@/components/ui";
import { DocumentViewer } from "@/admin/DocumentViewer";
import { absoluteTime, ageFrom, describeAdminError, relativeTime } from "@/admin/format";

export default function PacketDetail() {
  const { userId } = useParams<{ userId: string }>();
  const router = useRouter();

  const [user, setUser] = useState<PacketUser | null>(null);
  const [documents, setDocuments] = useState<PacketDocument[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [role, setRole] = useState<Role>("requester");
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminClient.packet(userId);
      setUser(res.user);
      setDocuments(res.documents);
      setMissing(res.missing);
      setRole(res.user.role);
    } catch (err) {
      setError(describeAdminError(err));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(decision: "approve" | "reject") {
    // Checked here as well as server-side so the operator is told before the round trip —
    // the applicant reads this text on their terminal screen, so an empty one is not a review.
    if (decision === "reject" && reason.trim().length === 0) {
      setReasonError("The applicant is shown this. Say why.");
      return;
    }
    setReasonError(null);
    setBusy(true);
    setError(null);
    try {
      await adminClient.decide(userId, {
        decision,
        reason: reason.trim() || undefined,
        ...(decision === "approve" ? { role } : {}),
      });
      router.push(paths.adminQueue);
    } catch (err) {
      setError(describeAdminError(err));
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="animate-spin text-primary" aria-label="Loading" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-4">
        <FormError>{error ?? "Packet not found."}</FormError>
        <Link href={paths.adminQueue} className="text-sm font-medium text-primary">
          ← Back to the queue
        </Link>
      </div>
    );
  }

  const age = ageFrom(user.dateOfBirth);
  const decidable = user.onboardingStatus === "under_review";

  return (
    <div className="space-y-6">
      <Link
        href={paths.adminQueue}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-primary"
      >
        <ArrowLeft size={16} aria-hidden />
        Back to the queue
      </Link>

      <FormError>{error}</FormError>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        {/* ── documents ─────────────────────────────────────────────────── */}
        <div className="space-y-4">
          {missing.length > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              Missing: {missing.join(", ")}. This packet cannot be approved.
            </div>
          )}
          {documents.map((d) => (
            <DocumentViewer key={d.kind} doc={d} />
          ))}
        </div>

        {/* ── the claim being checked, and the decision ──────────────────── */}
        <aside className="space-y-4">
          <section className="rounded-2xl border border-gray-200 bg-white p-5">
            <h2 className="font-display text-lg font-bold text-gray-900">Their claim</h2>
            <p className="mt-1 text-sm text-gray-600">Check this against the documents.</p>
            <dl className="mt-4 space-y-3 text-sm">
              <Row label="Name" value={user.displayName} />
              <Row label="Phone" value={user.phone} />
              <Row label="Email" value={user.email ?? "—"} />
              <Row
                label="Date of birth"
                value={user.dateOfBirth ? `${user.dateOfBirth} (${age} years)` : "—"}
              />
              <Row label="Gender" value={user.gender ?? "—"} />
              <Row label="Area" value={user.areaLabel ?? "—"} />
              <Row
                label="Submitted"
                value={user.submittedAt ? relativeTime(user.submittedAt) : "—"}
              />
            </dl>
          </section>

          {decidable ? (
            <section className="space-y-4 rounded-2xl border border-gray-200 bg-white p-5">
              <h2 className="font-display text-lg font-bold text-gray-900">Decision</h2>

              <Field
                label="Onboard as"
                hint="Helpers can accept requests. This can be changed later."
                htmlFor="role"
              >
                <Select id="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  <option value="requester">Requester only</option>
                  <option value="helper">Helper only</option>
                  <option value="both">Both</option>
                </Select>
              </Field>

              <Field
                label="Reason"
                hint="Required to reject — the applicant reads this. Optional note on approval."
                error={reasonError}
                htmlFor="reason"
              >
                <TextInput
                  id="reason"
                  value={reason}
                  invalid={Boolean(reasonError)}
                  placeholder="e.g. Name on ID does not match the video"
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>

              <div className="space-y-2">
                <Button
                  type="button"
                  loading={busy}
                  disabled={missing.length > 0}
                  onClick={() => void decide("approve")}
                >
                  <Check size={16} aria-hidden />
                  Approve
                </Button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide("reject")}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                >
                  <X size={16} aria-hidden />
                  Reject
                </button>
              </div>

              {/* Stated at the point of decision, not in a policy doc. Rejection blocks the
                  number permanently, and an operator should know that before clicking. */}
              <p className="flex items-start gap-2 rounded-xl bg-red-50 p-3 text-xs text-red-800">
                <ShieldX size={14} className="mt-0.5 shrink-0" aria-hidden />
                <span>
                  Rejecting is permanent. It blocks this mobile number from registering again
                  and signs the applicant out of every device.
                </span>
              </p>
            </section>
          ) : (
            <section className="rounded-2xl border border-gray-200 bg-white p-5 text-sm">
              <h2 className="font-display text-lg font-bold text-gray-900">Already decided</h2>
              <dl className="mt-3 space-y-3">
                <Row label="Outcome" value={user.onboardingStatus} />
                <Row label="By" value={user.reviewedBy ?? "—"} />
                <Row label="When" value={user.reviewedAt ? absoluteTime(user.reviewedAt) : "—"} />
                {user.rejectionReason && <Row label="Reason" value={user.rejectionReason} />}
              </dl>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-gray-500">{label}</dt>
      <dd className="text-right font-medium text-gray-900">{value}</dd>
    </div>
  );
}
