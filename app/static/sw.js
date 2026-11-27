'use strict';

const cacheName = 'lab-note-shell-v1.6.0';
// Only public files in the distributed application. Navigations (including / and /pair)
// and data requests always reach the server and its authentication checks.
const shell = new Set([
  '/app.js', '/theme.js', '/style.css', '/theme-dark.css', '/groups.js', '/selection.js',
  '/manual-groups.js', '/manual-groups.css', '/well-groups.js', '/well-groups.css',
  '/source-picker.js', '/source-picker.css', '/replate.js', '/replate.css',
  '/transfer-cards.js', '/occupied-targets.js', '/occupied-targets.css', '/assay-groups.js',
  '/transfer.js', '/relocation.js', '/relocation.css', '/autocomplete.js', '/medium.js',
  '/medium.css', '/quick-medium.js', '/quick-medium.css', '/count.js', '/count.css',
  '/workday.js', '/workday.css', '/home.js', '/home.css', '/experiments.js', '/experiments.css',
  '/result-paste.js', '/lineage-links.js', '/archived-cultures.js', '/archived-cultures.css',
  '/cryo-storage.js', '/cryo-storage.css', '/notebook.webmanifest', '/notebook-256.png',
  '/notebook-512.png',
]);
const types = {
  js: ['text/javascript', 'application/javascript'],
  css: ['text/css'],
  png: ['image/png'],
  webmanifest: ['application/manifest+json'],
};

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const old = (await caches.keys()).filter(key => key.startsWith('lab-note-shell-') && key !== cacheName);
    await Promise.all(old.map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function loadAsset(request, url) {
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const saved = await (await caches.open(cacheName)).match(url.href);
    if (saved) return saved;
    throw error;
  }
  const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (response.status === 200 && response.type === 'basic' && !response.redirected &&
      response.url === url.href && types[url.pathname.split('.').pop()].includes(mime)) {
    try {
      // Store only the public URL and file content. Request headers and response
      // metadata from authenticated sessions are never copied into Cache Storage.
      const copy = new Response(response.clone().body, {headers: {'Content-Type': mime}});
      await (await caches.open(cacheName)).put(url.href, copy);
    } catch { /* The live response still works when storage is full or disabled. */ }
  }
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode === 'navigate' ||
      request.headers.has('Authorization') || request.headers.has('X-Lab-Token') || request.headers.has('Range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.username || url.password || !shell.has(url.pathname)) return;
  if (url.search && !/^\?v=[0-9a-f]{12}$/.test(url.search)) return;
  event.respondWith(loadAsset(request, url));
});
