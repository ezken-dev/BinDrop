/* eslint-disable no-restricted-globals */
// BinDrop Background Service Worker (sw.js)
// Provides offline-capable fetch handling and background Web Push lock-screen notifications
// on Android (FCM) and iOS 16.4+ Home Screen PWAs (APNs) even when the app is completely closed.

const SW_VERSION = 'bindrop-sw-v6';
const CACHE_NAME = 'bindrop-pwa-cache-v6';
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

// Required fetch handler so all Android browsers pass the PWA installability check
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

// Listen for encrypted background Web Push payloads from the OS push daemon (works when app is completely closed)
self.addEventListener('push', (event) => {
  const origin = self.location.origin;
  const defaultIconUrl = new URL('/pwa-192x192.png', origin).href;
  const defaultBadgeUrl = new URL('/badge-72x72.png', origin).href;

  let payload = {
    title: 'BinDrop Household Alert',
    body: 'You have a new household trash duty update!',
    icon: defaultIconUrl,
    badge: defaultBadgeUrl,
    tag: 'bindrop-alert-' + Date.now(),
    url: '/',
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
        icon: new URL(parsed.icon || '/pwa-192x192.png', origin).href,
        badge: new URL(parsed.badge || '/badge-72x72.png', origin).href,
        tag: parsed.tag || 'bindrop-alert-' + Date.now(),
        url: parsed.url || '/',
      };
    } catch {
      const rawText = event.data.text();
      if (rawText) {
        payload.body = rawText;
      }
    }
  }

  const notificationOptions = {
    body: payload.body,
    icon: payload.icon,
    badge: payload.badge,
    tag: payload.tag,
    renotify: true,
    requireInteraction:
      payload.category === 'WARNING_5H' ||
      payload.category === 'MISSED_DEADLINE' ||
      payload.category === 'PHOTO_SUBMITTED',
    vibrate: [220, 100, 220, 100, 320],
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

  const notifyClientsPromise = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((windowClients) => {
      for (const client of windowClients) {
        client.postMessage({
          type: 'BINDROP_PUSH_RECEIVED',
          payload,
        });
      }
    })
    .catch(() => {});

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(payload.title, notificationOptions),
      notifyClientsPromise,
    ])
  );
});

// Automatically renew Web Push subscription if Android FCM or iOS APNs rotates the device token in the background
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

// Handle lock-screen / banner tap to launch or focus the standalone PWA
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            client.postMessage({
              type: 'BINDROP_NOTIFICATION_CLICKED',
              data: event.notification.data,
            });
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      })
  );
});

// Allow immediate local OS notification trigger via Service Worker postMessage
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (event.data.type === 'SHOW_LOCAL_NOTIFICATION') {
    const { title, body, tag, icon, badge, category, url } = event.data.payload || {};
    event.waitUntil(
      self.registration.showNotification(title || 'BinDrop Alert', {
        body: body || 'Your household trash duty status has been updated.',
        icon: icon || '/pwa-192x192.png',
        badge: badge || '/badge-72x72.png',
        tag: tag || 'bindrop-local-' + Date.now(),
        renotify: true,
        vibrate: [180, 90, 220],
        data: {
          url: url || '/',
          category: category || 'TURN_REMINDER',
        },
      })
    );
  }
});
