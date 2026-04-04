const CACHE = 'siteshrimp-v60';
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/db.js',
  '/js/constants.js',
  '/js/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Never cache third-party or API traffic. Keep cache scoped to app shell/static files.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);

    // Network-first: always try to get fresh files, fall back to cache if offline
    try {
      const res = await fetch(e.request);
      if (res.ok) {
        cache.put(e.request, res.clone()).catch(() => {});
      }
      return res;
    } catch {
      const cached = await cache.match(e.request);
      if (cached) return cached;
      if (e.request.mode === 'navigate') {
        return (await cache.match('/index.html')) || Response.error();
      }
      return Response.error();
    }
  })());
});
