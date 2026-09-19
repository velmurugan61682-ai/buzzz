/**
 * BUZZZ Progressive Web App Service Worker
 * Version: 1.0.0
 */

const CACHE_NAME = "buzzz-cache-v2";
const PRECACHE_RESOURCES = [
  "/",
  "/index.html",
  "/favicon.ico",
  "/icon-32.png",
  "/icon-180.png",
  "/icon.png",
  "/manifest.json"
];

// 1. Install: Precache core shell assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_RESOURCES).catch((err) => {
        console.warn("[SW] Precache asset fetch warning:", err);
      });
    })
  );
  self.skipWaiting();
});

// 2. Activate: Clear old caches and take control immediately
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch strategy:
// - Pass through all API requests directly to network (never stale API responses)
// - Let native browser module loader handle JavaScript modulepreloads without cross-world mismatch
// - Cache-First for static assets (fonts, images, icons, css)
// - Network-First with cache fallback for page navigation
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Ignore non-GET and chrome-extension requests
  if (req.method !== "GET" || !url.protocol.startsWith("http")) {
    return;
  }

  // Network-only for API, EventSource SSE, OAuth and dynamic endpoints
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname === "/api/events"
  ) {
    return;
  }

  // Let browser native module loader handle JavaScript chunks & modulepreloads cleanly
  if (req.destination === "script" || req.destination === "worker" || url.pathname.endsWith(".js")) {
    return;
  }

  // Cache-First for static assets (images, fonts, scripts, css)
  if (
    url.pathname.startsWith("/assets/") ||
    url.pathname.match(/\.(png|jpg|jpeg|svg|webp|ico|woff2?|ttf|css|js)$/i) ||
    url.hostname.includes("fonts.googleapis.com") ||
    url.hostname.includes("fonts.gstatic.com")
  ) {
    event.respondWith(
      caches.match(req).then((cachedResponse) => {
        if (cachedResponse) {
          // Revalidate in background
          fetch(req).then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
              caches.open(CACHE_NAME).then((cache) => cache.put(req, networkResponse));
            }
          }).catch(() => {});
          return cachedResponse;
        }

        return fetch(req).then((networkResponse) => {
          if (!networkResponse || !networkResponse.ok || networkResponse.type === "opaque") {
            return networkResponse;
          }
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          return networkResponse;
        });
      })
    );
    return;
  }

  // Network-First with Cache Fallback for navigation requests (HTML)
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then((networkResponse) => {
        if (networkResponse && networkResponse.ok) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return networkResponse;
      }).catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const indexFallback = await caches.match("/index.html");
        if (indexFallback) return indexFallback;
        return new Response("You are currently offline. Please check your network connection.", {
          headers: { "Content-Type": "text/plain" }
        });
      })
    );
  }
});
