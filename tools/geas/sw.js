// geas service worker — cache-first so the shell works offline.
// The whole app is one self-contained index.html, so the cache is tiny.

const CACHE = 'geas-v1';
const ASSETS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Cache-first: serve the cached copy when present, fall back to the
  // network (and ignore network failures — offline is the point).
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
