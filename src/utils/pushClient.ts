import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { apiFetch } from './apiClient';

// Default fallback public VAPID key (overridden dynamically by /api/push/vapid-public-key when backend is reachable)
export const FALLBACK_VAPID_PUBLIC_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

const PUSH_SUB_STORAGE_KEY = 'bindrop_webpush_subscription_v2';

export interface MobilePushEnvironment {
  isIOS: boolean;
  isAndroid: boolean;
  isMobile: boolean;
  isStandalone: boolean;
  /** True on iPhone/iPad when browsing in Safari instead of opening from "Add to Home Screen" */
  iosNeedsHomeScreenInstall: boolean;
  supportsNotifications: boolean;
  supportsServiceWorker: boolean;
  supportsPushManager: boolean;
  permission: NotificationPermission | 'unsupported';
}

/**
 * Converts a URL-safe Base64 VAPID public key into a Uint8Array required by
 * `registration.pushManager.subscribe({ applicationServerKey })`.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Detects mobile OS, standalone PWA status, and enforces the iOS "Home Screen" rule.
 */
export function getMobilePushEnvironment(): MobilePushEnvironment {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      isIOS: false,
      isAndroid: false,
      isMobile: false,
      isStandalone: false,
      iosNeedsHomeScreenInstall: false,
      supportsNotifications: false,
      supportsServiceWorker: false,
      supportsPushManager: false,
      permission: 'unsupported',
    };
  }

  const ua = navigator.userAgent || '';
  const isIOS =
    /iPad|iPhone|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isMobile = isIOS || isAndroid || /Mobile|Tablet/i.test(ua);

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (window.navigator as any).standalone === true;

  // Crucial iOS Rule: On iPhones, Web Push & Notification permission prompts only work
  // after the user taps Share -> "Add to Home Screen" and opens the app in standalone mode.
  const iosNeedsHomeScreenInstall = isIOS && !isStandalone;

  const supportsNotifications = 'Notification' in window;
  const supportsServiceWorker = 'serviceWorker' in navigator;
  const supportsPushManager = 'PushManager' in window;

  const permission: NotificationPermission | 'unsupported' = supportsNotifications
    ? Notification.permission
    : 'unsupported';

  return {
    isIOS,
    isAndroid,
    isMobile,
    isStandalone,
    iosNeedsHomeScreenInstall,
    supportsNotifications,
    supportsServiceWorker,
    supportsPushManager,
    permission,
  };
}

/**
 * Registers `/sw.js` at root scope (`/`) so background push events can wake the service worker
 * even when BinDrop is closed or the phone screen is locked.
 */
export async function registerBinDropServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
    });
    await navigator.serviceWorker.ready;
    return registration;
  } catch (err) {
    console.warn('Service worker registration warning:', err);
    return null;
  }
}

export function getSavedLocalPushState(): {
  enabled: boolean;
  endpoint?: string;
  updatedAt?: string;
} {
  try {
    const raw = localStorage.getItem(PUSH_SUB_STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {
    // ignore storage errors
  }
  return { enabled: false };
}

function saveLocalPushState(state: { enabled: boolean; endpoint?: string; updatedAt?: string }) {
  try {
    localStorage.setItem(PUSH_SUB_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage errors
  }
}

/**
 * Triggers a native OS notification through the active Service Worker (`registration.showNotification`).
 * Critical for mobile browsers (Android Chrome & iOS 16.4+ PWA) where `new Notification()`
 * throws an Illegal Constructor error on the main thread.
 */
export async function triggerSystemNotificationViaServiceWorker(params: {
  title: string;
  body: string;
  tag?: string;
  category?: string;
  url?: string;
}): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return false;
  }
  if (Notification.permission !== 'granted') {
    return false;
  }

  const options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
    body: params.body,
    icon: '/pwa-192x192.png',
    badge: '/badge-72x72.png',
    tag: params.tag || `bindrop-${Date.now()}`,
    renotify: true,
    vibrate: [200, 100, 220],
    requireInteraction:
      params.category === 'WARNING_5H' || params.category === 'MISSED_DEADLINE',
    data: {
      url: params.url || '/',
      category: params.category || 'TURN_REMINDER',
      timestamp: Date.now(),
    },
  };

  try {
    if ('serviceWorker' in navigator) {
      const reg =
        (await navigator.serviceWorker.getRegistration('/')) ||
        (await registerBinDropServiceWorker());
      if (reg && 'showNotification' in reg) {
        await reg.showNotification(params.title, options);
        return true;
      }
    }
  } catch {
    // Fallback to desktop Notification constructor if ServiceWorker showNotification fails
  }

  try {
    new Notification(params.title, {
      body: params.body,
      icon: '/pwa-192x192.png',
      badge: '/badge-72x72.png',
      tag: params.tag || `bindrop-${Date.now()}`,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Must ONLY be called inside an explicit user click/tap handler (e.g. "Turn on Alerts" toggle switch).
 * 1. Verifies iOS Home Screen rule
 * 2. Requests OS notification permission (`Notification.requestPermission()`)
 * 3. Fetches VAPID public key from backend
 * 4. Subscribes via `registration.pushManager.subscribe`
 * 5. Saves subscription to Backend (`/api/push/subscribe`) and Cloud Firestore (`bindrop_cloud/push_subs`)
 */
export async function subscribeUserToBackgroundPush(params: {
  userEmail: string;
  userUid?: string;
  userDisplayName?: string;
  partyId?: string | null;
}): Promise<{
  ok: boolean;
  permission: NotificationPermission | 'unsupported';
  error?: string;
  iosHomeScreenRequired?: boolean;
}> {
  const env = getMobilePushEnvironment();

  if (env.iosNeedsHomeScreenInstall) {
    return {
      ok: false,
      permission: env.permission,
      iosHomeScreenRequired: true,
      error:
        'On iPhone, tap the Safari Share button and select "Add to Home Screen" first, then open BinDrop from your Home Screen to enable lock-screen alerts.',
    };
  }

  if (!env.supportsNotifications) {
    return {
      ok: false,
      permission: 'unsupported',
      error:
        'This browser does not support system push notifications. Install BinDrop to your Home Screen or use Chrome / Safari 16.4+.',
    };
  }

  // Step 1: Request permission directly from the user's click gesture
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    saveLocalPushState({ enabled: false, updatedAt: new Date().toISOString() });
    return {
      ok: false,
      permission,
      error:
        permission === 'denied'
          ? 'Notifications are blocked in your browser/phone settings. Please allow notifications for BinDrop in your device settings.'
          : 'Notification permission was dismissed. Tap the toggle again and choose "Allow".',
    };
  }

  // Step 2: Register Service Worker
  const registration = await registerBinDropServiceWorker();

  // Step 3: Fetch VAPID Public Key from backend
  let vapidPublicKey = FALLBACK_VAPID_PUBLIC_KEY;
  try {
    const keyRes = await apiFetch<{ publicKey?: string }>('/api/push/vapid-public-key');
    if (keyRes.ok && keyRes.data?.publicKey) {
      vapidPublicKey = keyRes.data.publicKey;
    }
  } catch {
    // Use fallback VAPID key if offline
  }

  // Step 4: Generate PushSubscription via PushManager
  let subscriptionJson: PushSubscriptionJSON | null = null;
  if (registration && 'pushManager' in registration) {
    try {
      const existingSub = await registration.pushManager.getSubscription();
      if (existingSub) {
        subscriptionJson = existingSub.toJSON();
      } else {
        const convertedVapidKey = urlBase64ToUint8Array(vapidPublicKey);
        const newSub = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: convertedVapidKey as unknown as BufferSource,
        });
        subscriptionJson = newSub.toJSON();
      }
    } catch (subErr) {
      console.warn('PushManager subscription note:', subErr);
    }
  }

  const nowIso = new Date().toISOString();
  const cleanEmail = params.userEmail.trim().toLowerCase();

  // Step 5: Send subscription to Backend & Cloud Firestore
  try {
    await apiFetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userEmail: cleanEmail,
        userUid: params.userUid,
        userDisplayName: params.userDisplayName,
        partyId: params.partyId || null,
        subscription: subscriptionJson,
        userAgent: navigator.userAgent,
      }),
    });
  } catch {
    // ignore backend error if static host
  }

  // Also persist in Cloud Firestore `bindrop_cloud/push_subs` so any device/server can push
  if (cleanEmail && subscriptionJson?.endpoint) {
    try {
      const subRef = doc(db, 'bindrop_cloud', 'push_subs');
      const snap = await getDoc(subRef);
      let existingList: any[] = [];
      if (snap.exists() && typeof snap.data()?.payloadJson === 'string') {
        existingList = JSON.parse(snap.data().payloadJson) || [];
      }
      const filtered = existingList.filter(
        (item) => item.endpoint !== subscriptionJson?.endpoint && item.userEmail !== cleanEmail
      );
      filtered.unshift({
        userEmail: cleanEmail,
        userUid: params.userUid,
        userDisplayName: params.userDisplayName,
        partyId: params.partyId || null,
        endpoint: subscriptionJson.endpoint,
        subscription: subscriptionJson,
        updatedAtIso: nowIso,
      });
      await setDoc(subRef, {
        docId: 'push_subs',
        kind: 'PUSH_SUBS',
        payloadJson: JSON.stringify(filtered.slice(0, 60)),
        updatedAtIso: nowIso,
      });
    } catch {
      // ignore cloud error
    }
  }

  saveLocalPushState({
    enabled: true,
    endpoint: subscriptionJson?.endpoint || 'local-sw-notification',
    updatedAt: nowIso,
  });

  // Trigger an immediate confirmation alert via Service Worker so the user sees it on their phone right away
  await triggerSystemNotificationViaServiceWorker({
    title: '🔔 BinDrop Lock-Screen Alerts Active!',
    body: 'You will now receive Instagram-style banner & lock-screen alerts for all household turns, deadlines, and invites.',
    tag: 'bindrop-alerts-enabled',
    category: 'TURN_REMINDER',
  });

  return {
    ok: true,
    permission: 'granted',
  };
}

/**
 * Unsubscribes the current device when the user flips "Turn on Alerts" OFF.
 */
export async function unsubscribeUserFromBackgroundPush(params: {
  userEmail: string;
}): Promise<void> {
  saveLocalPushState({ enabled: false, updatedAt: new Date().toISOString() });
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = await reg?.pushManager?.getSubscription();
      if (sub) {
        await sub.unsubscribe();
      }
    }
  } catch {
    // ignore
  }

  try {
    await apiFetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userEmail: params.userEmail.trim().toLowerCase(),
      }),
    });
  } catch {
    // ignore
  }
}
