/* eslint-disable no-restricted-globals */
// BinDrop Background Service Worker (public/sw.js)
// Strictly enforces OS-level background Web Push execution on iOS 16.4+ PWAs (APNs) and Android (FCM)
// even when the application is completely closed or killed.

const SW_VERSION = 'bindrop-sw-v7';
const CACHE_NAME = 'bindrop-pwa-cache-v7';
const DEFAULT_VAPID_PUBLIC_KEY =
  'BBlcgquiiX4Z2nB_QHC0Kw95BUF6OZXyc64av5PeM5eFR3E49jEQFCynwwO2InaDlpteGl2WjluaRgFZDLio5Xk';

const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/pwa-maskable-512x512.png',
  '/apple-touch-icon.png',
  '/badge-72x72.png',
];

function urlBase64ToUint8ArraySw(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_ASSETS))
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
            return Promise.resolve();
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch handler required for Android / iOS PWA installability
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  ) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((networkRes) => {
        if (networkRes && networkRes.ok && networkRes.type === 'basic') {
          const clone = networkRes.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(req, clone))
            .catch(() => {});
        }
        return networkRes;
      })
      .catch(() =>
        caches.match(req).then((cachedRes) => {
          if (cachedRes) return cachedRes;
          if (req.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return Response.error();
        })
      )
  );
});

// 1. OS-Level Background Push Listener
// Strictly wraps self.registration.showNotification(...) inside event.waitUntil(...)
// and safely parses event.data.json() with a try/catch plain-text fallback.
self.addEventListener('push', (event) => {
  const origin = self.location.origin;
  const defaultIconUrl = new URL('/pwa-192x192.png', origin).href;
  const defaultBadgeUrl = new URL('/badge-72x72.png', origin).href;

  let payload = {
    title: 'BinDrop Household Alert',
    body: 'You have a new household trash duty update!',
    url: '/',
    icon: defaultIconUrl,
    badge: defaultBadgeUrl,
    tag: 'bindrop-alert-' + Date.now(),
    category: 'TURN_REMINDER',
    senderName: 'BinDrop',
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = {
        ...payload,
        ...parsed,
        title: parsed.title || payload.title,
        body: parsed.body || parsed.message || payload.body,
        url: parsed.url || '/',
        icon: new URL(parsed.icon || '/pwa-192x192.png', origin).href,
        badge: new URL(parsed.badge || '/badge-72x72.png', origin).href,
        tag: parsed.tag || 'bindrop-alert-' + Date.now(),
      };
    } catch (err) {
      const fallbackText = event.data.text();
      if (fallbackText) {
        payload.body = fallbackText;
      }
    }
  }

  const notificationOptions = {
    body: payload.body,
    icon: payload.icon,
    badge: payload.badge,
    tag: payload.tag,
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 300],
    data: {
      url: payload.url || '/',
      category: payload.category,
      senderName: payload.senderName,
      timestamp: Date.now(),
    },
    actions: [
      {
        action: 'open_app',
        title: 'Open BinDrop',
      },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, notificationOptions)
  );
});

// 2. Deep-Linking Lock-Screen Tap Listener
// Wrapped strictly inside event.waitUntil(...) using clients.openWindow(...)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetPath = (event.notification.data && event.notification.data.url) || '/';
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus();
          }
        }
        for (const client of windowClients) {
          if ('focus' in client) {
            return client.focus();
          }
        }
        return clients.openWindow(targetUrl);
      })
  );
});

// Automatically renew Web Push subscription if FCM or APNs rotates the device token in the background
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const applicationServerKey =
          (event.oldSubscription &&
            event.oldSubscription.options &&
            event.oldSubscription.options.applicationServerKey) ||
          urlBase64ToUint8ArraySw(DEFAULT_VAPID_PUBLIC_KEY);

        const newSubscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });

        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscription: newSubscription.toJSON(),
            oldEndpoint: event.oldSubscription ? event.oldSubscription.endpoint : undefined,
          }),
        });
      } catch {
        // ignore background renewal network errors
      }
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
