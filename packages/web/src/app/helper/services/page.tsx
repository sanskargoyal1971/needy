"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, Loader2, Lock } from "lucide-react";
import type { ServiceDefinition } from "@needy/shared";
import { FormError } from "@/components/ui";
import { paths } from "@/lib/paths";
import { taskClient } from "@/lib/taskClient";

/** ── What I can help with ──────────────────────────────────────────────────
 *  The screen that answers a question the platform has been asking helpers for since the
 *  catalog was built and had no way to hear the answer: `setHelperServices` was reachable only
 *  from the admin approval path, so every helper offered exactly one service and the matching
 *  filter had nothing to filter on.
 *
 *  The mandatory service is rendered as locked rather than as a ticked box. Both are enforced
 *  identically by the server — it unions the mandatory codes back in on every save, so opting
 *  out is not expressible through the API — but a checkbox that silently re-ticks itself reads
 *  as a bug, whereas a locked row with a reason reads as a rule. Hospital accompaniment is the
 *  emergency path, and a rota anyone can quietly leave is not an emergency service.
 */
export default function HelperServices() {
  const [catalog, setCatalog] = useState<ServiceDefinition[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [mandatory, setMandatory] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [{ services }, mine] = await Promise.all([
          taskClient.services(),
          taskClient.myServices(),
        ]);
        setCatalog(services);
        setChosen(new Set(mine.codes));
        setMandatory(mine.mandatory);
      } catch {
        setError("Couldn't load the list of services. Check your connection and try again.");
      }
    })();
  }, []);

  const toggle = useCallback((code: string) => {
    setSaved(false);
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // The server's response is the truth, not what was sent: it unions in the mandatory
      // codes and drops anything not in the catalog. Rendering from the request would show a
      // helper a selection the server did not actually store.
      const res = await taskClient.setMyServices([...chosen]);
      setChosen(new Set(res.codes));
      setSaved(true);
    } catch {
      setError("Couldn't save that. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <Link
        href={paths.helperHome}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft size={14} aria-hidden />
        Back
      </Link>

      <h1 className="mt-4 font-display text-3xl font-bold text-gray-900">What you can help with</h1>
      <p className="mt-2 text-gray-600">
        You&apos;ll only be offered work you&apos;ve chosen here. You can change this whenever you
        like.
      </p>

      {error && (
        <div className="mt-4">
          <FormError>{error}</FormError>
        </div>
      )}

      {catalog == null ? (
        <div className="flex justify-center py-12">
          <Loader2 className="animate-spin text-primary" aria-label="Loading services" />
        </div>
      ) : (
        <>
          <ul className="mt-6 space-y-3">
            {catalog.map((service) => {
              const locked = mandatory.includes(service.code);
              const on = locked || chosen.has(service.code);
              return (
                <li key={service.code}>
                  <button
                    type="button"
                    onClick={() => !locked && toggle(service.code)}
                    disabled={locked}
                    aria-pressed={on}
                    className={`flex w-full items-start gap-3 rounded-2xl border-2 p-4 text-left transition-colors ${
                      on ? "border-primary bg-primary/5" : "border-gray-200 bg-white"
                    } ${locked ? "cursor-default" : "hover:border-primary/50"}`}
                  >
                    <span
                      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                        on ? "bg-primary text-white" : "border-2 border-gray-300"
                      }`}
                      aria-hidden
                    >
                      {locked ? <Lock size={12} /> : on ? <Check size={14} /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-gray-900">{service.name}</span>
                        {service.basePrice > 0 ? (
                          <span className="text-sm text-gray-500">₹{service.basePrice}</span>
                        ) : (
                          <span className="text-sm text-gray-500">Volunteer</span>
                        )}
                      </span>
                      <span className="mt-1 block text-sm text-gray-600">
                        {service.description}
                      </span>
                      {locked && (
                        <span className="mt-1.5 block text-sm font-medium text-primary">
                          Every verified helper offers this — it&apos;s the emergency path, so it
                          can&apos;t be switched off.
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 font-semibold text-white transition-colors hover:bg-primary-dark disabled:bg-gray-300"
          >
            {saving && <Loader2 size={16} className="animate-spin" aria-hidden />}
            Save
          </button>

          {saved && (
            <p role="status" className="mt-3 text-center text-sm font-medium text-emerald-700">
              Saved. You&apos;ll be offered these from now on.
            </p>
          )}
        </>
      )}
    </div>
  );
}
