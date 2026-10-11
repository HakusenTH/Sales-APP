const CACHE_NAME = 'sale-app-cache-v1';
const urlsToCache = [
  './index.html',
  './style.css',
  './script.js',
  './manifest.json'
];

// ติดตั้ง Service Worker และเก็บไฟล์ลง Cache
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    })
  );
});

// ดึงข้อมูลจาก Cache มาใช้เพื่อให้โหลดเร็วเหมือนแอป
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});