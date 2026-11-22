// Service worker: lets the app open instantly / offline from the Home Screen.
// Network-first for the app's own files, so updates show up on the next open.
// (Supabase requests are cross-origin and are never cached.)
// It also shows push notifications (sent by the duo-photos Worker).

const CACHE = "duo-v21";
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "mock-supabase.js", "i18n.js", "i18n-fr.js", "lists.js", "trips.js", "mail.js", "questions.js", "questions-data.js", "questions-fr.js", "games.js", "sketch.js", "drawing.js", "media.js", "gifts.js", "words.js", "words-data.js", "push.js", "manifest.webmanifest", "icons/icon-180.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// ---------- push notifications ----------
self.addEventListener("push", (e) => {
  let msg = {};
  try { msg = e.data?.json() ?? {}; } catch {}
  e.waitUntil(self.registration.showNotification(msg.title || "Duo", {
    body: msg.body || "",
    tag: msg.tag,
    data: { tab: msg.tab || "board" },
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
  }));
});

// Tapping one opens Duo on the right tab (or brings it to the front if it's open)
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const tab = e.notification.data?.tab || "board";
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of open) {
      c.postMessage({ type: "open-tab", tab });
      if ("focus" in c) return c.focus();
    }
    return self.clients.openWindow(new URL(`./?tab=${tab}`, self.registration.scope).href);
  })());
});
