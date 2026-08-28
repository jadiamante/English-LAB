// ============================================================
// English Lab — Service Worker
// Cachea la app (HTML, fuentes) para que cargue más rápido en visitas
// repetidas y siga disponible (la interfaz, no la IA en la nube) sin conexión.
// ============================================================

const CACHE_NAME = 'english-lab-v1';
const APP_SHELL = [
  './',
  './english-lab.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {}) // si algún recurso no existe con ese nombre, no rompe la instalación
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Las llamadas a las APIs de IA (Groq, Cerebras, OpenRouter, Whisper, servidores propios)
  // NUNCA se cachean: siempre tienen que ir a la red, o fallar limpio si no hay conexión.
  if (/api\.(groq|cerebras|openrouter)\.com/.test(url.hostname)) return;
  if (url.pathname.includes('/chat/completions') || url.pathname.includes('/audio/transcriptions')) return;

  // Modelos de IA local (transformers.js) y fuentes: cache-first, se actualizan solos si cambian
  // Todo lo demás (la app, Google Fonts, etc.): stale-while-revalidate — responde rápido con lo cacheado
  // y actualiza el caché en segundo plano para la próxima vez.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkResponse;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
