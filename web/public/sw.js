// App shell and static cache. /api/* always goes to the network: sync handles offline data, not the cache.
const CACHE = 'bugrail-v2';
const SHELL = ['/login'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const put = (req, res) => caches.open(CACHE).then((c) => c.put(req, res));
const offlineRes = () => new Response('offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
const isRsc = (req, url) => req.headers.get('RSC') === '1' || url.searchParams.has('_rsc');

// Network first, remember the answer, fall back to the last one. `loose` also matches a cached copy that differs only in
// the query string: the _rsc value changes with router state, but the payload for a path is what offline soft navigation needs.
function networkFirst(event, loose) {
  const req = event.request;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) event.waitUntil(put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: loose }).then((hit) => hit || offlineRes())),
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Hashed build assets (JS, CSS, the wasm engine): cache first, they never change under the same URL.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) event.waitUntil(put(req, res.clone()));
        return res;
      })),
    );
    return;
  }

  if (isRsc(req, url)) return networkFirst(event, true); // soft navigation payloads and prefetches
  if (req.mode === 'navigate') return networkFirst(event, false);
});
