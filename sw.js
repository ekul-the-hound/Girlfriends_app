/* Our Corner v3 — service worker (offline PWA) */
const CACHE = "our-corner-v7";
const ASSETS = ["./","./index.html","./styles.css","./app.js","./manifest.json"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS).catch(()=>{}))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const u=new URL(e.request.url); if(u.origin!==location.origin) return;
  e.respondWith(fetch(e.request).then(res=>{const c=res.clone();caches.open(CACHE).then(x=>x.put(e.request,c)).catch(()=>{});return res;}).catch(()=>caches.match(e.request).then(c=>c||caches.match("./index.html"))));
});