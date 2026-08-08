import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { SosKind } from "@needy/shared";
import { BreathingPulse, spring } from "../motion/index.js";
import { useReducedMotionPref } from "../motion/preferences.js";
import { SOS_KINDS, type SosPort } from "./sosPort.js";

/**
 * ── SOS, connected to an actual server ─────────────────────────────────────
 *
 * The audit's finding on the original buttons: arming them set a React flag and nothing else. No
 * server was told, no record was kept, no operator could see it. The UI showed a red pulsing
 * alarm state to a frightened person while the alarm existed only in their own browser tab, and a
 * reload erased it. For an app whose users are explicitly elderly and vulnerable, that is the
 * worst possible failure — it converts a real emergency into a silent one while telling the user
 * help is coming. The helper side was fixed; the requester side was not, and kept the animation.
 *
 * The three rules this component follows as a result:
 *
 *  1. **Never claim more than the server confirmed.** `raiseSos()` resolves with a persisted
 *     alert or with null. Until it resolves we say "Sending…"; only afterwards do we say the
 *     alert has been sent, and if it failed we say THAT and offer a phone call instead.
 *  2. **The armed state comes from the store, not from here.** Once raised, the live banner is
 *     driven by `port.sos` (fed by the ack and by `sos-raised`), so it survives a re-render, a
 *     remount, and a reconnect-with-resync. Local state here covers only the transient
 *     "choosing a kind" / "sending" steps.
 *  3. **Deliberate, not accidental.** One tap opens a sheet asking what is wrong; a second tap
 *     sends. That costs a couple of seconds, which is the right trade against a pocket-press
 *     dispatching an operator — and the kind is genuinely useful to whoever responds.
 *
 * On motion: the idle glow is `BreathingPulse`, which already honours reduced motion. There is
 * deliberately NO armed shake/scale loop here. The old requester button ran an infinite
 * `scale + x` shake that ignored `useReducedMotionPref` entirely — the single animation in the
 * app most likely to physically affect a vestibular-sensitive user, on the screen they are least
 * able to leave. The armed state is now a static banner, which is also simply clearer.
 */
export function SosControl({ port }: { port: SosPort }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  // Nothing to raise an alarm against, or one is already live — the banner owns that state.
  if (!port.hasTask || port.sos) return null;

  return (
    <>
      <BreathingPulse size={62} color="alarm" intensity="subtle">
        <motion.button
          onClick={() => {
            setFailed(false);
            setOpen(true);
          }}
          whileTap={{ scale: 0.92 }}
          transition={spring.alarm}
          aria-label="Get urgent help"
          aria-haspopup="dialog"
          style={{
            width: 52,
            height: 52,
            borderRadius: "50%",
            border: "none",
            background: "var(--needy-alarm)",
            color: "#fff",
            fontWeight: 800,
            fontSize: 13,
            cursor: "pointer",
            boxShadow: "0 3px 10px rgba(0,0,0,.15)",
          }}
        >
          SOS
        </motion.button>
      </BreathingPulse>

      <AnimatePresence>
        {open && (
          <SosSheet
            port={port}
            onClose={() => setOpen(false)}
            onFailed={() => {
              setOpen(false);
              setFailed(true);
            }}
          />
        )}
      </AnimatePresence>

      {failed && <SosFailedNotice onDismiss={() => setFailed(false)} />}
    </>
  );
}

function SosSheet({
  port,
  onClose,
  onFailed,
}: {
  port: SosPort;
  onClose: () => void;
  onFailed: () => void;
}) {
  const [sending, setSending] = useState<SosKind | null>(null);
  const reduced = useReducedMotionPref();

  const raise = async (kind: SosKind) => {
    setSending(kind);
    const alert = await port.raiseSos(kind);
    setSending(null);
    // On success the store now holds the alert, so the live banner takes over and this closes.
    // On failure we hand back to a notice that offers a human, because a failed alarm must never
    // look like a sent one.
    if (alert) onClose();
    else onFailed();
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0 : 0.2 }}
      // A modal layer, because this must not be tapped through by accident and must not scroll
      // away mid-decision.
      role="dialog"
      aria-modal="true"
      aria-label="Get urgent help"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.45)",
        display: "grid",
        alignItems: "end",
        zIndex: 50,
      }}
      onClick={() => sending == null && onClose()}
    >
      <motion.div
        initial={reduced ? false : { y: 40 }}
        animate={{ y: 0 }}
        exit={reduced ? { opacity: 0 } : { y: 40 }}
        transition={reduced ? { duration: 0 } : spring.greet}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--needy-surface)",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          borderTop: "1px solid var(--needy-border)",
          // Safe-area padding: this sheet is bottom-anchored, so on a notched phone its last
          // button would otherwise sit under the home indicator — on the one screen where a
          // mis-tap matters most.
          padding: "20px 16px calc(28px + env(safe-area-inset-bottom, 0px))",
          display: "grid",
          gap: 10,
          maxWidth: 420,
          width: "100%",
          margin: "0 auto",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>What's happening?</h2>
        <p style={{ margin: "0 0 4px", fontSize: 16, lineHeight: 1.5, color: "var(--needy-text-soft)" }}>
          We'll alert our team straight away and share where you are.
        </p>

        {SOS_KINDS.map(({ kind, label, hint }) => (
          <button
            key={kind}
            onClick={() => void raise(kind)}
            disabled={sending != null}
            style={{
              textAlign: "left",
              minHeight: 60,
              border: "1px solid rgba(229,72,77,.35)",
              borderRadius: 16,
              background: sending === kind ? "rgba(229,72,77,.18)" : "var(--needy-surface-2)",
              color: "var(--needy-text)",
              padding: "12px 16px",
              cursor: sending != null ? "wait" : "pointer",
              opacity: sending != null && sending !== kind ? 0.5 : 1,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              {sending === kind ? "Sending…" : label}
            </div>
            <div style={{ fontSize: 16, color: "var(--needy-text-soft)", marginTop: 2 }}>{hint}</div>
          </button>
        ))}

        <button
          onClick={onClose}
          disabled={sending != null}
          style={{
            minHeight: 48,
            border: "none",
            background: "transparent",
            color: "var(--needy-text-soft)",
            fontSize: 16,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Never mind
        </button>
      </motion.div>
    </motion.div>
  );
}

/**
 * The alarm did NOT go through.
 *
 * This is the case the old UI could not even represent, and it is the one that most needs an
 * honest answer: rate-limited, refused, or the socket is down. Saying "we've alerted our team"
 * here would be the exact lie the audit was about, so instead we say plainly that it didn't send
 * and point at the two things that still work without our server — the emergency services and a
 * phone. `tel:` is used rather than a number in prose so it is one tap on a phone.
 */
function SosFailedNotice({ onDismiss }: { onDismiss: () => void }) {
  const support = import.meta.env.VITE_SUPPORT_PHONE ?? "";
  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        left: 12,
        right: 12,
        bottom: "calc(12px + env(safe-area-inset-bottom, 0px))",
        maxWidth: 400,
        margin: "0 auto",
        background: "var(--needy-surface)",
        border: "1px solid rgba(229,72,77,.5)",
        borderRadius: 18,
        padding: "16px 18px",
        display: "grid",
        gap: 8,
        zIndex: 60,
        boxShadow: "0 8px 30px rgba(0,0,0,.25)",
      }}
    >
      <strong style={{ fontSize: 16 }}>We couldn't send your alert</strong>
      <span style={{ fontSize: 16, lineHeight: 1.55, color: "var(--needy-text-soft)" }}>
        Please don't rely on this app right now. If you're in danger, call the emergency services.
        {support ? " You can also call us:" : ""}
      </span>
      {support && (
        <a
          href={`tel:${support.replace(/\s+/g, "")}`}
          style={{
            fontSize: 17,
            fontWeight: 800,
            color: "var(--needy-alarm)",
            textDecoration: "none",
          }}
        >
          {support}
        </a>
      )}
      <button
        onClick={onDismiss}
        style={{
          justifySelf: "start",
          border: "none",
          background: "transparent",
          color: "var(--needy-text-soft)",
          fontSize: 15,
          fontWeight: 700,
          padding: "6px 0",
          cursor: "pointer",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * The live alarm, shown to BOTH participants.
 *
 * Shown to the non-raiser too, on purpose: if the requester pulls the alarm the helper must know
 * an alert about this task is live rather than carrying on as normal, and vice versa — a helper
 * alone in a stranger's home can be the one in danger. It uses alarm red, which is reserved for
 * exactly this.
 */
export function SosLiveBanner({ port }: { port: SosPort }) {
  const [busy, setBusy] = useState(false);
  const reduced = useReducedMotionPref();
  const sos = port.sos;
  if (!sos) return null;
  const mine = sos.raisedBy === port.userId;

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
      transition={{ duration: reduced ? 0 : 0.3 }}
      role="alert"
      style={{
        background: "rgba(229,72,77,.14)",
        border: "1px solid rgba(229,72,77,.42)",
        borderRadius: 16,
        padding: "14px 16px",
        display: "grid",
        gap: 8,
      }}
    >
      <strong style={{ fontSize: 16, color: "var(--needy-text)" }}>
        {mine ? "Your alert has been sent" : "They've raised an alert"}
      </strong>
      <span style={{ fontSize: 16, lineHeight: 1.5, color: "var(--needy-text-soft)" }}>
        {mine
          ? "Our team has it and can see where you are. Stay on this screen if you can."
          : "Our team has it. If you can help safely, stay with them — otherwise keep yourself safe first."}
      </span>
      {/* Only the raiser may stand it down — the server enforces this too, and it is the abuse
          case that matters most: a helper must not be able to silence a requester's alarm about
          them. So the button only exists for our own alert. */}
      {mine && (
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void port.cancelSos(sos.id).finally(() => setBusy(false));
          }}
          style={{
            justifySelf: "start",
            border: "1px solid rgba(229,72,77,.42)",
            background: "transparent",
            color: "var(--needy-text)",
            borderRadius: 12,
            padding: "9px 14px",
            fontSize: 15,
            fontWeight: 700,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          {busy ? "Standing down…" : "It was a false alarm"}
        </button>
      )}
    </motion.div>
  );
}
