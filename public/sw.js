/* K. Streamer service worker.
 *
 * What it does, and what it deliberately does not:
 *  - Makes the app installable and shows a "can't reach the server" page when
 *    the server is unreachable.
 *  - Keeps scripts, styles and icons so the app shell opens fast and still
 *    appears when offline. Scripts and styles are fetched from the network
 *    first, so an edit shows up on the next load, not the one after.
 *  - Never touches the API, video/audio streams, thumbnails or HTML pages:
 *    those are live, per-account, and (for media) need Range requests.
 *
 * Bump VERSION to throw away everything cached by an older worker.
 */
const VERSION = "v1";
const STATIC = `ks-static-${VERSION}`;
const MAX_ENTRIES = 150;
const PRECACHE = ["/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

// Built in, not fetched: real pages are behind sign-in, so a fetched copy
// could turn out to be the sign-in page.
const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline · K. Streamer</title>
<style>
html,body{height:100%;margin:0;background:#000;color:#f5f2fa;font:500 18px system-ui,sans-serif}
body{display:grid;place-items:center;text-align:center;padding:1.5rem}
h1{margin:0 0 .5rem;font-size:1.8rem} p{margin:0 0 1.5rem;color:#a79fb4;max-width:26rem}
button{min-height:3rem;padding:0 1.6rem;border:0;border-radius:999px;background:#f0344a;color:#fff;font:inherit;font-weight:650;cursor:pointer}
</style></head><body><main><h1>Can’t reach the server</h1>
<p>Check that the server is running and that you are on the same network, then try again.</p>
<button onclick="location.reload()">Try again</button></main>
<script>addEventListener("online",()=>location.reload())</script></body></html>`;

const offlineResponse = () =>
  new Response(OFFLINE_HTML, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith("ks-") && n !== STATIC).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) await cache.delete(keys[i]);
}

async function remember(request, response) {
  if (!response || !response.ok || response.type !== "basic") return;
  const cache = await caches.open(STATIC);
  await cache.put(request, response.clone());
  trim(cache);
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    remember(request, response);
    return response;
  } catch (err) {
    const hit = await caches.match(request);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  remember(request, response);
  return response;
}

async function staleWhileRevalidate(request) {
  const hit = await caches.match(request);
  const refresh = fetch(request).then((response) => {
    remember(request, response);
    return response;
  });
  if (hit) {
    refresh.catch(() => {});
    return hit;
  }
  return refresh;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return; // media seeking: leave to the browser

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path === "/sw.js" || path.startsWith("/api/") || path.startsWith("/stream/") || path.startsWith("/thumbnails/") || path.startsWith("/__")) return;

  // Pages: always live. Offline gets the built-in page.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(offlineResponse));
    return;
  }

  if (path.startsWith("/icons/")) {
    event.respondWith(cacheFirst(request));
  } else if (/\.(?:css|js|json)$/i.test(path)) {
    event.respondWith(networkFirst(request));
  } else if (/\.(?:png|jpe?g|webp|gif|svg|ico|woff2?|ttf)$/i.test(path)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
