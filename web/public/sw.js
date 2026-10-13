// App shell and static cache. /api/* always goes to the network: sync handles offline data, not the cache.
// Three caches: hashed build assets (kept), documents, and RSC payloads. Documents and RSC are kept apart because they
// share a pathname: one cache would let an offline page load match a flight payload (or the reverse).
const STATIC = 'bugrail-static-v3';
const PAGES = 'bugrail-pages-v3';
const RSC = 'bugrail-rsc-v3';
const SHELL = ['/login'];
// Pages and payloads are bounded so they cannot crowd out the local database's storage.
const MAX_ENTRIES = 60;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(PAGES).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![STATIC, PAGES, RSC].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function remember(cacheName, req, res, bounded) {
  const c = await caches.open(cacheName);
  await c.put(req, res);
  if (!bounded) return;
  // keys() is in insertion order, so the oldest entries go first; /login is the offline entry point and stays.
  const keys = (await c.keys()).filter((k) => new URL(k.url).pathname !== '/login');
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await c.delete(k);
}

const offlineText = () => new Response('offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
const esc = (s) => s.replace(/[&<>"']/g, (ch) => '&#' + ch.charCodeAt(0) + ';');

// A route only works offline when it was opened as a real page load while online (that is when both its document and the
// payload its first render asks for get cached). Anything else gets this page instead of a bare error: it says so, and lists
// the routes that do work on this device.
async function offlinePage() {
  const c = await caches.open(PAGES);
  const routes = (await c.keys()).map((k) => new URL(k.url).pathname).filter((p) => p.startsWith('/w/')).slice(-8).reverse();
  const list = routes.map((p) => '<li><a href="' + esc(p) + '">' + esc(decodeURIComponent(p)) + '</a></li>').join('');
  const body = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Offline</title>'
    + '<h1>You are offline</h1><p>This page was not opened on this device while online, so it is not available offline. '
    + 'Reconnect, or open a page you used before:</p><ul>' + (list || '<li>none yet</li>') + '</ul><p><a href="/login">Login</a></p>';
  return new Response(body, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Network first, remember the answer, fall back to the last one. For RSC the match ignores the query string (the _rsc value
// changes with router state) but NOT Vary: ignoring it hands a partial prefetch payload to a full navigation, which Next cannot
// render (offline soft navigation then falls back to a hard load and fails).
function networkFirst(event, cacheName, rsc) {
  const req = event.request;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) event.waitUntil(remember(cacheName, req, res.clone(), true));
        return res;
      })
      .catch(() => caches.open(cacheName)
        .then((c) => c.match(req, rsc ? { ignoreSearch: true } : undefined))
        .then((hit) => hit || (req.mode === 'navigate' ? offlinePage() : offlineText()))),
  );
}

const isRsc = (req, url) => req.headers.get('RSC') === '1' || url.searchParams.has('_rsc');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Hashed build assets (JS, CSS, the wasm engine): cache first, they never change under the same URL.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.open(STATIC).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) event.waitUntil(remember(STATIC, req, res.clone(), false));
        return res;
      }))),
    );
    return;
  }

  if (isRsc(req, url)) return networkFirst(event, RSC, true); // soft navigation payloads and prefetches
  if (req.mode === 'navigate') return networkFirst(event, PAGES, false);
});
