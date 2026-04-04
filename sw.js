// Service Worker — JuicySpot PWA
// Solo habilita la instalación. No cachea la API para no romper SSE ni datos en tiempo real.

const CACHE_NAME = 'juicyspot-v1';
const STATIC = [
  '/',
  '/index.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Nunca interceptar: API, SSE, webhooks
  if (url.pathname.startsWith('/api/')) return;

  // Para el resto: network-first (siempre datos frescos)
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
