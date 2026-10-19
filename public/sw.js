/* yOA service worker：离线外壳 + 专注完成通知 */
const CACHE_NAME = 'yoa-shell-v2';
const SHELL_ASSETS = [
  '/',
  '/styles.css',
  '/app.js',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/badge-96.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 接口永远走网络，绝不缓存。
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/', copy)).catch(() => undefined);
          return response;
        })
        .catch(() => caches.match('/').then((hit) => hit || Response.error()))
    );
    return;
  }

  // 代码类资源走网络优先，避免更新后仍加载旧版页面脚本。
  if (
    url.pathname === '/app.js' ||
    url.pathname === '/styles.css' ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || Response.error()))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => hit || Response.error());

      // 先返回缓存保证秒开，同时后台更新；下次刷新即拿到新版本。
      return hit || network;
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (client.url.startsWith(self.location.origin)) {
            return client.focus();
          }
        }
        return self.clients.openWindow('/');
      })
      .catch(() => undefined)
  );
});
