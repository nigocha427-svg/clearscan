/* ClearScan — オフライン対応 */
const CACHE = 'clearscan-v9';
const SHELL = ['./', 'index.html', 'app.js', 'imaging.js', 'worker.js', 'pdf.js', 'drive.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Google のログイン・Drive API はキャッシュしない
  if (/^(www|oauth2)\.googleapis\.com$|^(accounts|apis)\.google\.com$/.test(url.host)) return;
  if (url.origin === location.origin) {
    // 自分のファイル: ネット優先(更新をすぐ反映)、オフライン時はキャッシュ
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  // Google Fonts: キャッシュ優先
  if (/^fonts\.(googleapis|gstatic)\.com$/.test(url.host)) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    })));
  }
});
