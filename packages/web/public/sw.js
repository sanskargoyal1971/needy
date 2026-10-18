/* Needy service worker — web push only.
 *
 * Deliberately does nothing else: no fetch handler, no offline cache. Caching a page that shows
 * a live task or a safety alarm would let someone look at a stale copy and believe it, which is
 * the one failure this product cannot afford. This file exists so a notification can reach a
 * person whose tab is closed or whose phone is locked.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "Needy";
  const offer = data.kind === "offer";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || undefined,
      // An offer stays until it is dealt with; a status update can fade like any other.
      requireInteraction: offer,
      renotify: Boolean(data.tag),
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      vibrate: offer ? [180, 80, 180, 80, 180] : [120],
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse an open Needy tab rather than stacking new ones.
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
