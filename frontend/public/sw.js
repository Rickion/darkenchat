// DarkenChat Service Worker — network-first, no caching of chat data
const CACHE = 'darkenchat-shell-v1'
const SHELL = ['/', '/src/main.ts']

self.addEventListener('install', e => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then(c => c.addAll(SHELL))
      .catch(() => {}),
  )
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))))
  self.clients.claim()
})

// Network-first: always try network, fall back to cache for navigation
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return
  if (e.request.url.includes('/ws') || e.request.url.includes('/api')) return

  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)))
})
