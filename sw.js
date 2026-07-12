// Cache-first service worker so the app works offline once visited.
const CACHE = "minmax-v1";
const ASSETS = [
  ".", "index.html", "styles.css", "app.js", "program.js",
  "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "apple-touch-icon.png", "favicon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  // Never intercept API calls (the Claude coach)
  if (e.request.url.includes("api.anthropic.com")) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
