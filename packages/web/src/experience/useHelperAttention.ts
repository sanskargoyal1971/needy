"use client";

import { useEffect, useRef } from "react";
import type { MatchOffer } from "@needy/shared";

/** ── Getting a helper's attention, within what a web page can do ───────────
 *  A web page cannot wake a locked phone — that needs push, which comes next. What it CAN do
 *  is make sure an offer is not missed by a helper whose page is open:
 *
 *   - **Keep the screen awake** while they are available or on a task (Screen Wake Lock), so
 *     the phone does not sleep, suspend the page and silently drop them out of the index.
 *   - **Chime and vibrate** when a new offer lands, so it is noticed from across a room.
 *   - **A system notification** when the tab is in the background, where the browser allows
 *     one from the page itself (desktop browsers; not Android Chrome, which only allows them
 *     from a service worker).
 *
 *  Nothing here repeats or escalates. One chime per new offer, never a looping alarm — the
 *  countdown on the card is the only clock, and it is the server's.
 */

let audio: AudioContext | null = null;

/** Called from the availability toggle's click: browsers only let a page start audio inside a
 *  user gesture. */
export function primeHelperAttention(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx && !audio) audio = new Ctx();
    void audio?.resume();
  } catch {
    // No audio is a degraded alert, not a broken page.
  }
  // Notification permission is asked for by `enablePush` (lib/push.ts), in the same click.
}

/** Two soft rising tones — a doorbell, not an alarm. */
function chime(): void {
  if (!audio || audio.state !== "running") return;
  const t0 = audio.currentTime;
  for (const [i, freq] of [660, 880].entries()) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = t0 + i * 0.18;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.45);
    osc.connect(gain).connect(audio.destination);
    osc.start(start);
    osc.stop(start + 0.5);
  }
}

function notify(offer: MatchOffer): void {
  try {
    if (!document.hidden) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const n = new Notification("Someone nearby needs help", {
      body: offer.title,
      tag: `offer:${offer.taskId}`,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Android Chrome throws on the constructor; push (service worker) is the fix for that.
  }
}

/** Alert once for each offer this page has not seen before. */
export function useOfferAlerts(offers: MatchOffer[]): void {
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const fresh = offers.filter((o) => !seen.current.has(o.taskId));
    if (fresh.length === 0) return;
    fresh.forEach((o) => seen.current.add(o.taskId));
    chime();
    try {
      navigator.vibrate?.([180, 80, 180]);
    } catch {
      // Vibration is a nicety.
    }
    notify(fresh[0]!);
  }, [offers]);

  // The tab title is what someone sees across a row of tabs.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    document.title = offers.length > 0 ? `(${offers.length}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [offers.length]);
}

/** Hold a screen wake lock while `active`. Re-acquired when the page becomes visible again,
 *  because the browser releases it every time the tab is hidden. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        if (document.visibilityState !== "visible") return;
        lock = await navigator.wakeLock.request("screen");
        if (cancelled) void lock.release();
      } catch {
        // Refused (battery saver, unsupported context). The page still works; it may sleep.
      }
    };
    void acquire();
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
