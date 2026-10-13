"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Power, ShieldCheck, UserPlus } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { adminClient, type StaffMember } from "@/lib/adminClient";
import { AuthError } from "@/lib/authClient";
import { Button, Field, FormError, TextInput } from "@/components/ui";
import { absoluteTime } from "@/admin/format";

/** ── Operators ─────────────────────────────────────────────────────────────
 *  Who can get into the console, and on what number.
 *
 *  Super admin only. The API refuses an ordinary admin outright; this screen additionally
 *  declines to render for them, so nobody is shown controls that will only ever fail.
 *
 *  The number is the load-bearing field. It is where an operator's second factor is sent, and
 *  assigning it here — rather than letting them register themselves — is what makes the second
 *  factor a second factor: it goes to the number the organisation was given, not to whichever
 *  number the person holding the password asks for.
 */
export default function StaffPage() {
  const { state } = useAuth();
  const isSuperAdmin = state.status === "authenticated" && state.user.role === "super_admin";

  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const [phone, setPhone] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");

  const load = useCallback(async () => {
    try {
      const { staff: list } = await adminClient.staff();
      setStaff(list);
      setError(null);
    } catch (err) {
      setStaff([]);
      setError(describe(err));
    }
  }, []);

  useEffect(() => {
    if (isSuperAdmin) void load();
  }, [isSuperAdmin, load]);

  if (state.status === "authenticated" && !isSuperAdmin) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-6">
        <h2 className="font-display text-lg font-bold text-gray-900">Not your surface</h2>
        <p className="mt-1 text-sm text-gray-600">
          Only a super admin can add or remove operators. That separation is deliberate: an operator
          who could create operators could review their own decisions under a second account.
        </p>
      </div>
    );
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const { staff: made } = await adminClient.createStaff({
        phone: phone.trim(),
        displayName: displayName.trim(),
        password,
      });
      setCreated(
        `${made.displayName} can now sign in with ${made.phone} and the password you set. They'll also be sent a code each time.`,
      );
      setPhone("");
      setDisplayName("");
      setPassword("");
      await load();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(member: StaffMember) {
    setError(null);
    setBusy(true);
    try {
      if (member.active) {
        // A reason is required by the API, and rightly: "deactivated, no reason given" is not
        // an answer anyone can act on three months later.
        const reason = window.prompt(`Why is ${member.displayName} being switched off?`)?.trim();
        if (!reason) return;
        await adminClient.deactivateStaff(member.id, reason);
      } else {
        await adminClient.activateStaff(member.id);
      }
      await load();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="font-display text-lg font-bold text-gray-900">Add an operator</h2>
        <p className="mt-1 text-sm text-gray-600">
          You choose their number. It&apos;s where their sign-in code goes, and they can&apos;t
          change it.
        </p>

        <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={add}>
          <Field label="Their name" htmlFor="displayName">
            <TextInput
              id="displayName"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Priya Sharma"
            />
          </Field>
          <Field label="Their mobile number" htmlFor="staff-phone">
            <TextInput
              id="staff-phone"
              type="tel"
              inputMode="tel"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
            />
          </Field>
          <Field
            label="First password"
            hint="At least 10 characters. They can change it once they're in."
            htmlFor="staff-password"
          >
            <TextInput
              id="staff-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" loading={busy}>
              <span className="inline-flex items-center gap-2">
                <UserPlus size={16} aria-hidden />
                Create operator
              </span>
            </Button>
          </div>
        </form>

        {error && (
          <div className="mt-4">
            <FormError>{error}</FormError>
          </div>
        )}
        {created && (
          <p role="status" className="mt-4 text-sm font-medium text-emerald-700">
            {created}
          </p>
        )}
      </section>

      <section>
        <h2 className="font-display text-lg font-bold text-gray-900">Operators</h2>
        {staff == null ? (
          <div className="flex justify-center py-10">
            <Loader2 className="animate-spin text-primary" aria-label="Loading" />
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white">
            {staff.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-gray-900">{m.displayName}</span>
                    {m.role === "super_admin" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        <ShieldCheck size={11} aria-hidden />
                        Super admin
                      </span>
                    )}
                    {!m.active && (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                        Switched off
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-sm text-gray-500">
                    {m.username ? `${m.username} · ` : ""}
                    {m.phone} · added {absoluteTime(m.createdAt)}
                  </p>
                  {!m.active && m.deactivatedReason && (
                    <p className="mt-0.5 text-sm text-gray-500">Reason: {m.deactivatedReason}</p>
                  )}
                </div>

                {/* A super admin cannot be switched off from here, including by themselves —
                    the API refuses both, so offering the control would be offering a failure. */}
                {m.role !== "super_admin" && (
                  <button
                    type="button"
                    onClick={() => void toggle(m)}
                    disabled={busy}
                    className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                      m.active
                        ? "border border-gray-300 text-gray-700 hover:bg-gray-50"
                        : "bg-primary text-white hover:bg-primary-dark"
                    }`}
                  >
                    <Power size={14} aria-hidden />
                    {m.active ? "Switch off" : "Switch back on"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function describe(err: unknown): string {
  if (err instanceof AuthError) {
    switch (err.code) {
      case "phone-in-use":
        return "Someone already has an account on that number. Operators need a number of their own.";
      case "username-in-use":
        return "That username is taken.";
      case "weak-password":
        return err.details?.problem === "contains-phone"
          ? "Don't build the password from their phone number — it's the part anyone already knows."
          : "That password is too easy to guess. Use at least 10 characters.";
      case "cannot-deactivate-self":
        return "You can't switch off your own account — nobody would be able to switch it back on.";
      case "cannot-deactivate-super-admin":
        return "A super admin can't be switched off from here.";
      case "forbidden":
        return "Only a super admin can manage operators.";
      default:
        return "Something went wrong. Please try again.";
    }
  }
  return "Something went wrong. Please try again.";
}
