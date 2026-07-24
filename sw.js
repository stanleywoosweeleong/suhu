// SUHU service worker — offline app shell + fresh-data strategy
const VERSION = 'suhu-v15';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/qr.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
];

// Install: pre-cache the app shell so the app opens offline.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

// Activate: drop old caches.
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
//  - the page itself (navigations) + data.json -> NETWORK-FIRST, so an already-installed
//    app always shows fresh content when online (this is the real fix for "won't update"),
//    and still works offline from cache.
//  - static assets (icons, Chart.js) -> cache-first for instant, offline load.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  const isData = url.pathname.endsWith('data.json') || url.pathname.endsWith('meta.json') || url.pathname.endsWith('fires.json');
  const isDoc  = e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');

  if (isData || isDoc) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() =>
        caches.match(e.request).then((r) => r || caches.match('./index.html') || caches.match('./'))
      )
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) =>
      cached || fetch(e.request).then((res) => {
        // runtime-cache same-origin GETs
        if (e.request.method === 'GET' && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => cached)
    )
  );
});
