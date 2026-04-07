const CACHE = 'siteshrimp-v84';
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/db.js',
  '/js/constants.js',
  '/js/app.js',
  '/js/lang.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/lang/en.json',
  '/lang/zh.json',
  '/lang/zh-TW.json',
  '/lang/ms.json',
  '/lang/id.json',
  '/lang/hi.json',
  '/lang/ta.json',
  '/lang/th.json',
  '/lang/vi.json',
  '/lang/bn.json',
  '/lang/ja.json',
  '/lang/ko.json',
  '/lang/de.json',
  '/lang/fr.json',
  '/lang/es.json',
  '/lang/pt.json',
  '/lang/it.json',
  '/lang/tr.json',
  '/lang/sv.json',
  '/lang/no.json',
  '/lang/da.json',
  '/lang/fi.json'
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
