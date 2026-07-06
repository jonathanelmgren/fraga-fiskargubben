// Minimal service worker: exists to make the app installable and to show a
// friendly offline page instead of the browser error. It deliberately caches
// nothing else — the chat requires network, and authenticated routes
// (/profile, /admin) must never be served from cache. Bump the cache name
// when offline.html changes.
const OFFLINE_CACHE = "offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(OFFLINE_CACHE)
      // cache: "reload" bypasses the HTTP cache so a new SW always picks up
      // the latest offline page.
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== OFFLINE_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  // Only page navigations get the offline fallback; every other request
  // (API, assets) passes through to the network untouched.
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request).catch(() => caches.match(OFFLINE_URL)),
  );
});
