/* Our Corner — service worker (offline-friendly PWA) */
const CACHE = "our-corner-v2";
const ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js",
  "./js/state.js", "./js/ui.js", "./js/home.js", "./js/messages.js",
  "./js/diary.js", "./js/questions.js", "./js/games.js", "./js/checkers.js",
  "./js/draw.js", "./js/pet.js", "./js/dates.js", "./js/gallery.js",
  "./js/stats.js", "./js/prayer.js", "./js/settings.js",
  "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // let cross-origin (fonts, geocode) go to network
  // Network-first: always show the latest version when online,
  // fall back to cache when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then((cached) => cached || caches.match("./index.html")))
  );
});
