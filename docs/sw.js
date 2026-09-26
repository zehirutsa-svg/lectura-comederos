// Service Worker: guarda la app en el teléfono para que abra sin señal.
// Al publicar una versión nueva, subir el número de CACHE para que los
// teléfonos descarguen los archivos nuevos.
const CACHE = 'comederos-v3';
const ARCHIVOS = [
  './',
  'index.html',
  'style.css',
  'config.js',
  'app.js',
  'manifest.webmanifest',
  'icons/logo.png',
  'icons/favicon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Solo archivos propios de la app; lo del Google Sheet va directo a la red.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Abre al instante con lo guardado (con señal débil, esperar la red la haría
  // lenta) y en segundo plano trae la versión nueva para la próxima vez.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((guardado) => {
      const deRed = fetch(e.request)
        .then((r) => {
          if (r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
          return r;
        })
        .catch(() => guardado || caches.match('index.html'));
      return guardado || deRed;
    })
  );
});
