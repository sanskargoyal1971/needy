"use client";

import { useEffect, useState } from "react";
import { taskClient } from "./taskClient";

/** ── Web push, browser side ────────────────────────────────────────────────
 *  Registers `/sw.js` and hands the browser's push subscription to the server, so an offer or
 *  "they're at your door" reaches someone whose tab is closed.
 *
 *  Where it works: desktop Chrome/Edge/Firefox, Android Chrome, and Safari on macOS. On an
 *  iPhone only once Needy has been added to the home screen (Apple's rule, iOS 16.4+) — in a
 *  plain Safari tab `PushManager` does not exist, and `pushState()` says "unsupported" rather
 *  than pretending.
 */

export type PushState = "unsupported" | "off" | "on" | "blocked" | "unavailable";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  return existing ?? navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

let inFlight: Promise<PushState> | null = null;

/** Subscribe (or re-confirm an existing subscription) and tell the server. Single-flight: two
 *  callers at once (the page's sync plus a click, or a dev-mode double effect) would race two
 *  `register()`/`subscribe()` calls against a worker that is still installing, and the loser
 *  fails. Everyone shares one attempt instead. */
function subscribeAndSave(): Promise<PushState> {
  inFlight ??= doSubscribeAndSave().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doSubscribeAndSave(): Promise<PushState> {
  const config = await taskClient.pushConfig();
  if (!config.enabled || !config.publicKey) return "unavailable";
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    });
  }
  await taskClient.savePushSubscription(sub.toJSON());
  return "on";
}

/**
 * Turn push on. MUST be called from inside a click handler: browsers only show the permission
 * prompt for a user gesture, and Safari loses the gesture across an `await` — so the prompt is
 * requested first, synchronously, before anything else is awaited.
 */
export function enablePush(): Promise<PushState> {
  if (!pushSupported()) return Promise.resolve("unsupported");
  const permission =
    Notification.permission === "default"
      ? Notification.requestPermission()
      : Promise.resolve(Notification.permission);
  return permission
    .then((p) => (p === "granted" ? subscribeAndSave() : p === "denied" ? "blocked" : "off"))
    .catch((err: unknown) => {
      console.warn("Needy: push registration failed", err instanceof Error ? err.message : err);
      return "unavailable" as const;
    });
}

/** On page load: if permission was already granted, make sure the server has this device.
 *  Never prompts. This is also what heals a subscription the server has lost. */
export function syncPush(): Promise<PushState> {
  if (!pushSupported()) return Promise.resolve("unsupported");
  if (Notification.permission === "denied") return Promise.resolve("blocked");
  if (Notification.permission !== "granted") return Promise.resolve("off");
  return subscribeAndSave().catch((err: unknown) => {
    // Said in the console, not swallowed: a device that silently never gets push looks
    // exactly like a quiet day. The message names the failure, never the subscription.
    console.warn("Needy: push registration failed", err instanceof Error ? err.message : err);
    return "unavailable" as const;
  });
}

/** Current push state for this device, synced once on mount. */
export function usePushState(): [PushState | null, (s: PushState) => void] {
  const [state, setState] = useState<PushState | null>(null);
  useEffect(() => {
    let cancelled = false;
    void syncPush().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return [state, setState];
}
