/** ── Abuse signals ─────────────────────────────────────────────────────────
 *  A record that something a user did looked wrong, emitted from the point in the code that
 *  already knew it.
 *
 *  The alternative design — a scheduled job that trawls tasks, messages and alerts looking
 *  for patterns — was rejected deliberately. Every signal below is already *detected* by
 *  existing code at the moment it happens: the handoff limiter knows it just burned a code,
 *  the chat limiter knows it just refused a flood, the SOS handler knows this is the fourth
 *  alarm from one account this hour. A trawler would re-derive, hours later and less
 *  accurately, facts the request already had in hand. Emitting at the choke point also means
 *  a signal cannot silently stop being produced when the code around it changes shape,
 *  because it lives inside that code.
 *
 *  What this is NOT: an automated enforcement system. Nothing here blocks anyone. Signals
 *  raise a human's attention and are weighted so the queue sorts sensibly, and a person
 *  decides. On a platform whose users are elderly and vulnerable, an automated ban that fires
 *  on "raised three alarms this week" would silence exactly the person most likely to need
 *  help — the pattern is at least as consistent with someone genuinely in trouble as with
 *  someone abusing the button.
 */

export const ABUSE_SIGNAL_KINDS = [
  /** More SOS alerts from one account in a short window than a real emergency explains.
   *  Ambiguous ON PURPOSE — see the note above about who this pattern might actually be. */
  "sos.repeated",
  /** An alert the raiser stood down themselves within seconds. A few are noise; a habit of
   *  them degrades every operator's trust in the queue. */
  "sos.cancelled_immediately",
  /** Five wrong handoff codes at the door. The code travels by voice from the requester to
   *  the person in front of them, so failing it repeatedly means the person holding the phone
   *  and the person at the door are not talking to each other. */
  "handoff.code_burned",
  /** Chat rate limiter refused a send. One is a fat finger; a run of them is a flood. */
  "chat.flood",
  /** Cancelled after a helper had already been matched and committed to travelling. */
  "task.cancelled_after_match",
  /** A number blocked by a rejection tried to register again. */
  "auth.blocked_phone_retry",
  /** Repeated wrong passwords against one real account. The caller is told nothing that
   *  distinguishes this from an unknown number, so the signal is the only way a grind against
   *  a specific person becomes visible to an operator. */
  "auth.password_failed",
] as const;

export type AbuseSignalKind = (typeof ABUSE_SIGNAL_KINDS)[number];

export function isAbuseSignalKind(value: unknown): value is AbuseSignalKind {
  return typeof value === "string" && (ABUSE_SIGNAL_KINDS as readonly string[]).includes(value);
}

/**
 * How much each kind contributes to a user's total in the review queue.
 *
 * These are ranking weights, not a punishment scale, and the ordering is the argument: a
 * burned handoff code (someone at a door who cannot prove they are the expected person)
 * outranks a chat flood (annoying) by a wide margin, and a repeated SOS sits low precisely
 * because it is the signal most likely to be produced by a victim rather than an abuser.
 */
export const ABUSE_SIGNAL_WEIGHTS: Record<AbuseSignalKind, number> = {
  "handoff.code_burned": 5,
  "auth.blocked_phone_retry": 5,
  // Low on its own — people forget passwords constantly. It is the ACCUMULATION against one
  // account that means something, which is what the rollup window is for.
  "auth.password_failed": 1,
  "task.cancelled_after_match": 3,
  "sos.cancelled_immediately": 2,
  "chat.flood": 2,
  "sos.repeated": 1,
};

/** Human-readable labels for the console. Kept beside the weights so a new kind cannot be
 *  added without deciding both. */
export const ABUSE_SIGNAL_LABELS: Record<AbuseSignalKind, string> = {
  "sos.repeated": "Repeated SOS alerts",
  "sos.cancelled_immediately": "SOS cancelled seconds after raising",
  "handoff.code_burned": "Handoff code burned at the door",
  "chat.flood": "Chat flood refused",
  "task.cancelled_after_match": "Cancelled after a helper was matched",
  "auth.blocked_phone_retry": "Blocked number attempted to re-register",
  "auth.password_failed": "Wrong password on this account",
};

export interface AbuseSignal {
  id: string;
  kind: AbuseSignalKind;
  /** The user the signal is ABOUT, which is not always the user who triggered the code path:
   *  a burned handoff code is emitted against the helper standing at the door, not against
   *  the requester whose phone displayed it. */
  subjectId: string;
  taskId: string | null;
  weight: number;
  metadata: Record<string, unknown>;
  at: number;
}

/** One user's standing in the review queue: their signals rolled up over a window. */
export interface AbuseRollup {
  subjectId: string;
  displayName: string;
  /** Masked. The console is a list, and a list of full phone numbers is a directory. */
  phoneMasked: string;
  role: string;
  blockedAt: number | null;
  /** Sum of weights over the window — the sort key. */
  score: number;
  total: number;
  byKind: Partial<Record<AbuseSignalKind, number>>;
  firstAt: number;
  lastAt: number;
}

/** Default review window. Long enough that a weekly pattern is visible, short enough that a
 *  user who was a problem in March does not sit at the top of the queue in August. */
export const ABUSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
