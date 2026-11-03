/* eslint-disable no-restricted-globals */
// BinDrop Background Service Worker (sw.js)
// Handles system-level Web Push notifications on Android (FCM) & iOS 16.4+ (APNs)
// even when the PWA is completely closed and the phone is locked.

const SW_VERSION = 'bindrop-sw-v3';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Listen for encrypted background Web Push payloads from the OS push daemon
self.addEventListener('push', (event) => {
  let payload = {
    title: 'BinDrop Household Alert',
    body: 'You have a new household trash duty update!',
    icon: '/pwa-192x192.png',
    badge: '/badge-72x72.png',
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
        icon: parsed.icon || '/pwa-192x192.png',
        badge: parsed.badge || '/badge-72x72.png',
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
      payload.category === 'WARNING_5H' || payload.category === 'MISSED_DEADLINE',
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
