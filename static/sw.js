/* ============================================================
   TrashRight Service Worker  — v2
   Strategy:
     - API endpoints  → Network first, fall back to cache
     - Static assets  → Cache first, fall back to network
     - Pages          → Network first, fall back to cache
   Auto-sync: polls /api/cache-version every 30s when online
              to detect new items added by admin.
   ============================================================ */

const CACHE_VERSION = 'trashright-v2';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const API_CACHE     = `${CACHE_VERSION}-api`;

/* Assets to pre-cache on install */
const PRECACHE_ASSETS = [
    '/',
    '/static/style.css',
    '/static/manifest.json',
    '/category/Recyclable',
    '/category/Biodegradable',
    '/category/Hazardous',
    '/category/Non-biodegradable',
    '/api/category/Recyclable',
    '/api/category/Biodegradable',
    '/api/category/Hazardous',
    '/api/category/Non-biodegradable',
    '/api/all_categories',
];

/* API routes — always try network first */
const API_ROUTES = [
    '/api/',
    '/results',
    '/category/',
];

/* ── Install: pre-cache core assets ── */
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then(cache => cache.addAll(PRECACHE_ASSETS))
            .then(() => self.skipWaiting())
    );
});

/* ── Activate: clean up old caches ── */
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(key => key.startsWith('trashright-') && key !== STATIC_CACHE && key !== API_CACHE)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

/* ── Fetch: route to correct strategy ── */
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    if (request.method !== 'GET') return;
    if (url.origin !== self.location.origin) return;

    const isAPI = API_ROUTES.some(route => url.pathname.startsWith(route));

    event.respondWith(
        isAPI ? networkFirst(request, API_CACHE)
              : cacheFirst(request, STATIC_CACHE)
    );
});

/* ── Network First ── */
async function networkFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.status === 200) {
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch {
        const cached = await cache.match(request);
        if (cached) return cached;

        if (request.url.includes('/api/')) {
            return new Response(
                JSON.stringify({
                    found: false,
                    error: 'You are offline. Showing cached data — reconnect to see new items.'
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }
        return await caches.match('/') || new Response('Offline', { status: 503 });
    }
}

/* ── Cache First ── */
async function cacheFirst(request, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.status === 200) {
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch {
        return new Response('Offline', { status: 503 });
    }
}

/* ── Message handler ── */
self.addEventListener('message', event => {
    /* Force SW update */
    if (event.data?.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    /* Clear API cache — called automatically when admin adds items */
    if (event.data?.type === 'CLEAR_API_CACHE') {
        caches.open(API_CACHE).then(cache => {
            cache.keys().then(keys => keys.forEach(k => cache.delete(k)));
        });
        /* Re-cache all category pages with fresh data */
        caches.open(API_CACHE).then(cache => {
            const freshRoutes = [
                '/api/category/Recyclable',
                '/api/category/Biodegradable',
                '/api/category/Hazardous',
                '/api/category/Non-biodegradable',
                '/api/all_categories',
            ];
            freshRoutes.forEach(route => {
                fetch(route)
                    .then(r => { if (r.ok) cache.put(route, r); })
                    .catch(() => {});
            });
        });
        event.ports[0]?.postMessage({ success: true });
    }
});

/* ── Background sync: check for new items every 30s when online ──
   Compares the DB item count to what was last seen.
   If count changed (admin added/deleted items) → clear API cache
   so next request fetches fresh data. */
let lastKnownVersion = null;

async function checkForUpdates() {
    try {
        const r = await fetch('/api/cache-version');
        if (!r.ok) return;
        const data = await r.json();
        const currentVersion = data.version;

        if (lastKnownVersion === null) {
            /* First check — just store the version */
            lastKnownVersion = currentVersion;
            return;
        }

        if (lastKnownVersion !== currentVersion) {
            /* Version changed — admin added or removed items */
            lastKnownVersion = currentVersion;

            /* Clear stale API cache */
            const cache = await caches.open(API_CACHE);
            const keys  = await cache.keys();
            await Promise.all(keys.map(k => cache.delete(k)));

            /* Notify all open app windows to refresh their autocomplete list */
            const clients = await self.clients.matchAll({ type: 'window' });
            clients.forEach(client => {
                client.postMessage({ type: 'ITEMS_UPDATED', version: currentVersion });
            });
        }
    } catch {
        /* Offline — skip silently */
    }
}

/* Start polling every 30 seconds */
setInterval(checkForUpdates, 30000);
/* Also check immediately on activation */
self.addEventListener('activate', () => { checkForUpdates(); });
