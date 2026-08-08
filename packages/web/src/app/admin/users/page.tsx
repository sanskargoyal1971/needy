"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Search, ShieldBan, ShieldCheck } from "lucide-react";
import { adminClient, type QueueEntry } from "@/lib/adminClient";
import { Button, Field, FormError, TextInput } from "@/components/ui";
import { describeAdminError, relativeTime } from "@/admin/format";

export default function AdminUsers() {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<QueueEntry | null>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      setUsers((await adminClient.users(q || undefined)).users);
    } catch (err) {
      setError(describeAdminError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  return (
    <div className="space-y-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load(query.trim());
        }}
      >
        <div className="flex-1">
          <label htmlFor="q" className="sr-only">
            Search users
          </label>
          <TextInput
            id="q"
            placeholder="Search by name or phone"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="w-32">
          <Button type="submit">
            <Search size={16} aria-hidden />
            Search
          </Button>
        </div>
      </form>

      <FormError>{error}</FormError>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-primary" aria-label="Loading" />
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-3xl border border-gray-100 bg-white">
          {users.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="truncate font-medium text-gray-900">
                  {u.displayName}
                  {u.blockedAt != null && (
                    <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                      blocked
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-sm text-gray-500">
                  {u.phoneMasked} · {u.role} · {u.onboardingStatus} · joined{" "}
                  {relativeTime(u.createdAt)}
                </p>
              </div>
              {u.blockedAt != null ? (
                <button
                  type="button"
                  onClick={() =>
                    void adminClient
                      .unblock(u.id)
                      .then(() => load(query.trim()))
                      .catch((err: unknown) => setError(describeAdminError(err)))
                  }
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-background"
                >
                  <ShieldCheck size={16} aria-hidden />
                  Unblock
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setTarget(u)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
                >
                  <ShieldBan size={16} aria-hidden />
                  Block
                </button>
              )}
            </li>
          ))}
          {users.length === 0 && (
            <li className="px-5 py-12 text-center text-sm text-gray-600">No users found.</li>
          )}
        </ul>
      )}

      {target && (
        <BlockDialog
          user={target}
          onClose={() => setTarget(null)}
          onDone={() => {
            setTarget(null);
            void load(query.trim());
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

/**
 * Blocking asks for a reason and an explicit choice about the phone number.
 *
 * A plain confirm() would be faster to write and worse: this is an irreversible-feeling action
 * against a real person, the reason is stored on the audit trail, and "also stop this number
 * registering again" is a materially different decision from "suspend this account" — it
 * should never be an implicit side effect of clicking Block.
 */
function BlockDialog({
  user,
  onClose,
  onDone,
  onError,
}: {
  user: QueueEntry;
  onClose: () => void;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [blockPhone, setBlockPhone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="block-title"
        className="w-full max-w-md space-y-4 rounded-3xl bg-white p-6 shadow-xl"
      >
        <h2 id="block-title" className="font-display text-xl font-bold text-gray-900">
          Block {user.displayName}?
        </h2>
        <p className="text-sm text-gray-600">
          They will be signed out everywhere and unable to book or accept help.
        </p>

        <Field label="Reason" error={err} htmlFor="block-reason">
          <TextInput
            id="block-reason"
            autoFocus
            value={reason}
            invalid={Boolean(err)}
            placeholder="e.g. Abuse report upheld"
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>

        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={blockPhone}
            onChange={(e) => setBlockPhone(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Also block this mobile number from registering again.{" "}
            <span className="text-gray-500">Reversible by unblocking the account.</span>
          </span>
        </label>

        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (reason.trim().length === 0) {
                setErr("A reason is required — it goes on the audit trail.");
                return;
              }
              setBusy(true);
              void adminClient
                .block(user.id, reason.trim(), blockPhone)
                .then(onDone)
                .catch((e: unknown) => {
                  onError(describeAdminError(e));
                  setBusy(false);
                });
            }}
            className="inline-flex w-full items-center justify-center rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:bg-gray-300"
          >
            Block
          </button>
        </div>
      </div>
    </div>
  );
}
