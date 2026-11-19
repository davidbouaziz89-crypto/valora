/* Service Worker VALORA — hors-ligne (même fonctionnement que celui de Zeste, sans notifications push)
   ⚠️ Toute modification de l'appli publiée : incrémenter CACHE, sinon les téléphones gardent l'ancienne version. */
const CACHE = 'valora-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('valora-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Réseau d'abord pour le HTML (mises à jour), cache d'abord pour le reste, tout en cache en secours
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // On ne gère QUE le même domaine : le serveur Supabase, Chrono24… vont direct au réseau (jamais en cache)
  const u = new URL(req.url);
  if (u.origin !== self.location.origin) return;
  // même domaine qu'une autre appli (ex. Zeste sur github.io) : on ne touche qu'à notre dossier
  const portee = new URL(self.registration.scope).pathname;
  if (!u.pathname.startsWith(portee)) return;
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    e.respondWith(
      fetch(req).then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)); return res; })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
  } else {
    e.respondWith(
      caches.match(req).then(r => r || fetch(req).then(res => {
        const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)); return res;
      }).catch(() => r))
    );
  }
});
