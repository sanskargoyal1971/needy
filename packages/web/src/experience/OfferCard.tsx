"use client";

import { useEffect, useState } from "react";
import { MapPin, Timer } from "lucide-react";
import type { MatchOffer } from "@needy/shared";

/** ── One offer, with the time actually left on it ──────────────────────────
 *  Offers are broadcast to every eligible helper at once and the first to accept wins, so the
 *  only honest thing this card can show is how long the window has left — and it has to keep
 *  showing it as it runs down.
 *
 *  A static "expires in 30s" rendered once would be wrong within a second and would still be on
 *  screen, unchanged, after the window shut: a helper taps it, loses, and has been told nothing
 *  except that they were too slow at something they were given no way to judge. The countdown
 *  ticks from `expiresAt`, which is the SERVER's deadline carried in the offer, not a local
 *  timer started when the card rendered — those differ by however long the frame took to
 *  arrive, and it is the server's one that decides.
 */
export function OfferCard({
  offer,
  onAccept,
  onDecline,
}: {
  offer: MatchOffer;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [taking, setTaking] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const msLeft = Math.max(0, offer.expiresAt - now);
  const secondsLeft = Math.ceil(msLeft / 1000);
  const lapsed = msLeft <= 0;

  return (
    <li className="rounded-3xl border-2 border-accent/40 bg-white p-5 shadow-[0_14px_36px_rgba(255,122,89,0.18)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            {offer.direct ? "Asked for you by name" : "Someone nearby needs help"}
          </p>
          <h3 className="mt-1 font-display text-xl font-bold text-gray-900">{offer.title}</h3>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-gray-600">
            <MapPin size={14} aria-hidden />
            {[
              offer.scheduledFor != null ? `Booked for ${formatWhen(offer.scheduledFor)}` : null,
              offer.distanceMeters != null
                ? `About ${formatDistance(offer.distanceMeters)} away`
                : null,
              "exact address once you accept",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {/* Reddens in the last ten seconds. Colour is doing a second job here, so the number
            is always present too — this must read on a phone held at arm's length. */}
        <span
          className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold tabular-nums ${
            lapsed
              ? "bg-gray-100 text-gray-500"
              : secondsLeft <= 10
                ? "bg-red-50 text-red-700"
                : "bg-gray-100 text-gray-700"
          }`}
        >
          <Timer size={14} aria-hidden />
          {lapsed ? "Gone" : formatLeft(secondsLeft)}
        </span>
      </div>

      <div className="mt-4 flex gap-3">
        <button
          type="button"
          // Disabled the instant the window shuts, rather than left tappable to produce a
          // refusal the helper cannot act on.
          disabled={lapsed || taking}
          onClick={() => {
            setTaking(true);
            onAccept();
          }}
          className="flex-1 rounded-2xl bg-primary px-4 py-4 text-lg font-semibold text-white transition-colors hover:bg-primary-dark disabled:bg-gray-300"
        >
          {lapsed ? "Too late" : taking ? "Taking it…" : "I'll help"}
        </button>
        <button
          type="button"
          onClick={onDecline}
          className="rounded-xl px-4 py-3 font-medium text-gray-600 hover:text-gray-900"
        >
          Not now
        </button>
      </div>
    </li>
  );
}

/** A booking is confirmed with an hour or more to spare; "5400s" is not a way to say that. */
function formatLeft(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString("en-IN", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Metres under a kilometre, then one decimal. A helper deciding whether to walk needs "400 m"
 *  and "1.2 km"; "1247 metres" is the same fact in a form nobody converts in their head. */
function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
}
