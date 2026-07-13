// Tau Service Worker — minimal, just enables PWA install
// No aggressive caching since Tau connects to a live local server
/// <reference lib="webworker" />

const CACHE_NAME = 'tau-v4';
const serviceWorker = self as unknown as ServiceWorkerGlobalScope;

// Cache only the app shell on install
serviceWorker.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        '/',
        '/style.css',
        '/app.js',
        '/app-main.js',
        '/state.js',
        '/themes.js',
        '/markdown.js',
        '/message-renderer.js',
        '/tool-card.js',
        '/tree-view.js',
        '/dialogs.js',
        '/session-sidebar.js',
        '/session-stats-card.js',
        '/websocket-client.js',
        '/manifest.json',
        // KaTeX shell assets; fonts are picked up on demand by the
        // network-first runtime cache so a missing font can't fail install.
        '/vendor/katex/katex.min.js',
        '/vendor/katex/katex.min.css',
      ]);
    })
  );
  serviceWorker.skipWaiting();
});

// Clean old caches
serviceWorker.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      );
    })
  );
  serviceWorker.clients.claim();
});

// Network-first strategy — always try live server, fall back to cache
serviceWorker.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // Don't cache API/WebSocket requests
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Update cache with fresh response
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline — serve from cache
        return caches.match(event.request).then((cached) => {
          return cached || new Response('Tau is offline — start your pi session to connect.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          });
        });
      })
  );
});
