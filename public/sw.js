// المرحلة 8.37: Service Worker لموقع الطلب أونلاين (public/order.html) - كاش لهيكل الصفحة والصور بس
// عشان الموقع يفتح بسرعة ويكون قابل للتثبيت كـPWA. أي نداء لـ/api/ بيعدي شبكة مباشرة دايمًا (never
// cached) - المنيو والأسعار والفروع لازم تكون حية دايمًا، وأي طلب (POST) خطر يترجع من كاش بالغلط.
const CACHE_NAME = "satamoni-order-v1";
const APP_SHELL = [
  "/order.html",
  "/manifest.webmanifest",
  "/images/satamoni-logo.jpeg",
  "/images/satamoni-hero.jpeg",
  "/images/icon-192.png",
  "/images/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) return; // شبكة مباشرة دايمًا

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
