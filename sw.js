// Bumped 2026-05-01 to pre-cache the full schema-variant set: base v1.2
// + 7 work-category variants (CONQUAS, Building Defects Landed/Highrise,
// Construction Site, Interior Works, FM, Infrastructure). Variant routing
// drives both the AI prompt (different fields per work category) and
// the photo-ZIP export. The activate handler below deletes every cache
// whose name doesn't equal CACHE.
const CACHE = 'siteshrimp-v112';
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/db.js',
  '/js/constants.js',
  '/js/app.compiled.js',
  '/js/lang.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png',
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
  '/lang/fi.json',
  '/reference-texts/manifest.json',
  '/templates/profiles.json',
  '/schema/entries/v1.json',
  '/schema/entries/manifest.json',
  '/schema/entries/conquas/v1.json',
  '/schema/entries/landed/v1.json',
  '/schema/entries/highrise/v1.json',
  '/schema/entries/construction-site/v1.json',
  '/schema/entries/interior-works/v1.json',
  '/schema/entries/fm/v1.json',
  '/schema/entries/infra/v1.json',
  '/schema/entries/handover/v1.json',
  '/schema/entries/tnc/v1.json',
  '/schema/entries/me/v1.json',
  '/schema/entries/top/v1.json'
];

// ── Install: pre-cache app shell, then warm Requirements Advisor corpus ──
// Reference corpus (~500 KB of pre-extracted .txt) is warmed best-effort from
// the manifest so the Advisor's reference picker works on flaky / offline site
// connections. App shell caching is critical and its failure must not block
// the install; reference warming is best-effort per file.
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    try { await c.addAll(ASSETS); } catch {}
    try {
      const resp = await fetch('/reference-texts/manifest.json');
      if (resp.ok) {
        const m = await resp.json();
        const urls = (m.documents || [])
          .map(d => d && d.file)
          .filter(Boolean)
          .map(f => f.startsWith('/') ? f : '/' + f);
        await Promise.all(urls.map(u => c.add(u).catch(() => {})));
      }
    } catch {}
  })());
  self.skipWaiting();
});

// ── Activate: clean old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first with offline fallback ──
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Never cache third-party or API traffic
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Always fetch index.html from network with cache:'no-store' so a
    // user with a cached old shell can never end up with stale ?v= refs
    // pointing at a buggy bundle. Falls back to cache only if network
    // genuinely fails (offline mode). The bundle URLs (?v=<commit>) stay
    // network-first-then-cache as before — they're already URL-versioned
    // so a successful network fetch always returns the right code.
    const isShell = url.pathname === '/' || url.pathname === '/index.html';
    // Network-first: try fresh, fall back to cache
    try {
      const res = await fetch(e.request, isShell ? { cache: 'no-store' } : undefined);
      if (res.ok) {
        cache.put(e.request, res.clone()).catch(() => {});
      }
      return res;
    } catch {
      const cached = await cache.match(e.request);
      if (cached) return cached;
      // Offline fallback for navigation requests
      if (e.request.mode === 'navigate') {
        return (await cache.match('/index.html')) || new Response(
          '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SiteShrimp — Offline</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1a1a1a;color:#fff;text-align:center}h1{color:#ff6b00}p{color:rgba(255,255,255,0.6);margin-top:8px}</style></head><body><div><h1>SiteShrimp</h1><p>You are offline. Please check your connection and try again.</p></div></body></html>',
          { headers: { 'Content-Type': 'text/html' } }
        );
      }
      return Response.error();
    }
  })());
});

// ── Push notifications (for future Telegram/web-push integration) ──
self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const data = e.data.json();
    e.waitUntil(
      self.registration.showNotification(data.title || 'SiteShrimp', {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: data.url || '/',
        tag: data.tag || 'siteshrimp-notification'
      })
    );
  } catch {}
});

// ── Notification click: open or focus the app ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ── Background Sync (retry failed requests when back online) ──
self.addEventListener('sync', e => {
  if (e.tag === 'sync-queue') {
    e.waitUntil(
      clients.matchAll({ type: 'window' }).then(list => {
        list.forEach(client => client.postMessage({ type: 'SYNC_QUEUE' }));
      })
    );
  }
});

// ── Periodic background sync (scheduled queue sync) ──
self.addEventListener('periodicsync', e => {
  if (e.tag === 'sync-queue') {
    e.waitUntil(
      clients.matchAll({ type: 'window' }).then(list => {
        list.forEach(client => client.postMessage({ type: 'SYNC_QUEUE' }));
      })
    );
  }
});
