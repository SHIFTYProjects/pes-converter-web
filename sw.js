// Keeps a copy of the whole app on this device so it opens and works with no internet connection.
// Online, files always come fresh from the network (so an update never mixes old and new files);
// offline, the saved copy is used. Bump VERSION whenever a file changes.
const VERSION = "shifty-stitch-2.3.0";
const FILES = [
  "./", "index.html", "editor.js", "previewer.js", "formats.js", "stitches.js",
  "vendor/imagetracer.js", "vendor/fonts.js", "icon.svg", "manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      // Network first, with a short timeout so a weak connection does not stall the app.
      const response = await Promise.race([
        fetch(request, { cache: "no-cache" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000))
      ]);
      if (response.ok) cache.put(request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === "navigate") return (await cache.match("index.html")) || Response.error();
      return new Response("Offline", { status: 503 });
    }
  })());
});
