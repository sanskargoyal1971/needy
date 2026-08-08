import type { SosAlert, SosKind } from "@needy/shared";

/**
 * ── The narrow slice of a driver that the SOS control needs ──────────────────
 *
 * WHY A PORT RATHER THAN TWO COMPONENTS.
 *
 * The requester and the helper hold structurally different view-models — that separation is
 * deliberate and documented at the top of `helperTypes.ts`, and it is right. But the alarm is
 * not part of either role's shape: it is a property of the PROTOCOL. Either participant may
 * raise, either may be the one at risk, the server treats both identically, and the rules the
 * audit imposed on the UI ("never claim more than the server confirmed", "the armed state comes
 * from the store", "deliberate, not accidental") are the same rules for both.
 *
 * The requester's SOS shipped as a `useState` flag with no network call precisely because it was
 * written separately from the helper's. Two copies of a safety control is two chances to get it
 * wrong, and only one of them was ever audited. So there is now exactly ONE implementation, and
 * each side supplies this four-field adapter.
 */
export interface SosPort {
  /** The live alert on the current task, from the store — never from component state. */
  sos: SosAlert | null;
  /** Who we are, so the banner can tell "your alert" from "their alert". */
  userId: string;
  /** Whether there is a task to raise an alarm against at all. */
  hasTask: boolean;
  raiseSos(kind: SosKind, note?: string): Promise<SosAlert | null>;
  cancelSos(alertId: string): Promise<boolean>;
}

/** The four kinds the backend accepts, in the words someone would actually use. Ordered with
 *  the most common first rather than alphabetically — this list is read under stress. */
export const SOS_KINDS: ReadonlyArray<{ kind: SosKind; label: string; hint: string }> = [
  { kind: "unsafe", label: "I don't feel safe", hint: "Something here is wrong" },
  { kind: "medical", label: "Someone needs medical help", hint: "An injury or illness" },
  { kind: "panic", label: "I need help right now", hint: "Get someone to me" },
  { kind: "other", label: "Something else", hint: "Tell our team what's happening" },
];
