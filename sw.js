// ============================================================
// English Lab — Service Worker
// Cachea la app (HTML, fuentes) para que cargue más rápido en visitas
// repetidas y siga disponible (la interfaz, no la IA en la nube) sin conexión.
// ============================================================

const CACHE_NAME = 'english-lab-v2'; // subido de v1 a v2: se corrigió qué se precachea (ver más abajo), fuerza a los navegadores que ya tenían la v1 a limpiar el caché viejo
const APP_SHELL = [
  './english-lab.html', // el archivo real de la app — antes decía './index.html', que no existe con ese nombre en este proyecto
  './ai-worker.js',      // crítico para que la IA local/transcriptor/Kokoro funcionen sin conexión
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Se cachea cada URL POR SEPARADO (no con cache.addAll(), que es todo-o-nada: si UN
      // recurso de la lista falla, no cachea NINGUNO). Así, si algún día se agrega otro archivo
      // a esta lista y falla por lo que sea, el resto se sigue cacheando bien igual.
      Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => {})))
    )
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
