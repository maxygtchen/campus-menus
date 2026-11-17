/* Minimal service worker: enables install on some browsers without
   caching HTML/JS (so pushes still show up after refresh). */
const VERSION = "campus-menus-pwa-1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Menu JSON only: stale-while-revalidate for offline peek at last menu.
  if (url.pathname.includes("/data/") && url.pathname.endsWith(".json")) {
    event.respondWith(staleWhileRevalidate(event.request));
  }
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(VERSION + "-menus");
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || network || new Response("{}", { status: 503 });
}