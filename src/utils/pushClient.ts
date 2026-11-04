import { apiFetch } from './apiClient';
import { readCloudDoc, writeCloudDoc } from './cloudPartySync';

// Canonical persistent VAPID public key shared with server.ts so mobile subscriptions never invalidate across server restarts
export const FALLBACK_VAPID_PUBLIC_KEY =
  'BBlcgquiiX4Z2nB_QHC0Kw95BUF6OZXyc64av5PeM5eFR3E49jEQFCynwwO2InaDlpteGl2WjluaRgFZDLio5Xk';

const PUSH_SUB_STORAGE_KEY = 'bindrop_webpush_subscription_v3';

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
 * `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`.
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
 * Verifies whether an existing browser PushSubscription was created with the current VAPID public key.
 * If a subscription was created with an older VAPID key, it is unsubscribed and re-created so
 * closed-app background pushes are accepted by FCM/APNs.
 */
function doesSubscriptionMatchVapidKey(
  sub: PushSubscription,
  expectedPublicKeyBase64: string
): boolean {
  try {
    const appServerKey = sub.options?.applicationServerKey;
    if (!appServerKey) return false;
    const actualBytes = new Uint8Array(appServerKey);
    const expectedBytes = urlBase64ToUint8Array(expectedPublicKeyBase64);
    if (actualBytes.length !== expectedBytes.length) return false;
    for (let i = 0; i < actualBytes.length; i++) {
      if (actualBytes[i] !== expectedBytes[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
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

export function isIosDevice(): boolean {
  return getMobilePushEnvironment().isIOS;
}

export function isStandalonePwa(): boolean {
  return getMobilePushEnvironment().isStandalone;
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
      updateViaCache: 'none',
    });
    registration.update().catch(() => {});
    await navigator.serviceWorker.ready;
    return registration;
  } catch (err) {
    console.warn('Service worker registration warning:', err);
    return null;
  }
}

export function getSavedLocalPushState(): {
  enabled: boolean;
  explicitlyDisabled?: boolean;
  endpoint?: string;
  vapidKey?: string;
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

function saveLocalPushState(state: {
  enabled: boolean;
  explicitlyDisabled?: boolean;
  endpoint?: string;
  vapidKey?: string;
  updatedAt?: string;
}) {
  try {
    localStorage.setItem(PUSH_SUB_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage errors
  }
}

/**
 * Internal helper that ensures the browser's PushManager subscription matches the server's
 * VAPID public key (using `userVisibleOnly: true` and `urlBase64ToUint8Array`) and registers
 * the subscription with both the Express backend and Cloud Sync.
 */
async function ensureValidPushSubscriptionAndRegister(params: {
  userEmail: string;
  userUid?: string;
  userDisplayName?: string;
  partyId?: string | null;
}): Promise<PushSubscriptionJSON | null> {
  const registration = await registerBinDropServiceWorker();
  if (!registration || !('pushManager' in registration)) {
    return null;
  }

  let vapidPublicKey = FALLBACK_VAPID_PUBLIC_KEY;
  try {
    const keyRes = await apiFetch<{ publicKey?: string }>('/api/push/vapid-public-key');
    if (keyRes.ok && keyRes.data?.publicKey) {
      vapidPublicKey = keyRes.data.publicKey;
    }
  } catch {
    // Use canonical fallback VAPID key if offline
  }

  let subscriptionJson: PushSubscriptionJSON | null = null;
  try {
    const existingSub = await registration.pushManager.getSubscription();
    if (existingSub && doesSubscriptionMatchVapidKey(existingSub, vapidPublicKey)) {
      subscriptionJson = existingSub.toJSON();
    } else {
      if (existingSub) {
        try {
          await existingSub.unsubscribe();
        } catch {
          // ignore unsubscribe error
        }
      }
      const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
      const newSub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey as unknown as BufferSource,
      });
      subscriptionJson = newSub.toJSON();
    }
  } catch (subErr) {
    console.warn('PushManager subscription error:', subErr);
  }

  const nowIso = new Date().toISOString();
  const cleanEmail = params.userEmail.trim().toLowerCase();

  if (cleanEmail && subscriptionJson?.endpoint) {
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

    // Persist in Dual-Engine Cloud Sync `push_subs` so any server instance can wake this phone
    (async () => {
      try {
        const existingList = (await readCloudDoc<any[]>('push_subs')) || [];
        const filtered = (Array.isArray(existingList) ? existingList : []).filter(
          (item) => item && item.endpoint !== subscriptionJson?.endpoint
        );
        filtered.unshift({
          userEmail: cleanEmail,
          userUid: params.userUid,
          userDisplayName: params.userDisplayName,
          partyId: params.partyId || null,
          endpoint: subscriptionJson.endpoint,
          subscription: subscriptionJson,
          userAgent: navigator.userAgent,
          updatedAt: nowIso,
          updatedAtIso: nowIso,
        });
        await writeCloudDoc('push_subs', 'PUSH_SUBS', filtered.slice(0, 50));
      } catch {
        // ignore cloud error
      }
    })();

    saveLocalPushState({
      enabled: true,
      explicitlyDisabled: false,
      endpoint: subscriptionJson.endpoint,
      vapidKey: vapidPublicKey,
      updatedAt: nowIso,
    });
  }

  return subscriptionJson;
}

/**
 * Automatically heals, re-subscribes (if VAPID key changed), and registers background Web Push
 * whenever a logged-in user has already granted OS notification permissions.
 */
export async function autoSyncAndHealPushSubscription(params: {
  userEmail?: string | null;
  userUid?: string;
  userDisplayName?: string;
  partyId?: string | null;
}): Promise<boolean> {
  const cleanEmail = String(params.userEmail || '').trim().toLowerCase();
  if (!cleanEmail) return false;

  const env = getMobilePushEnvironment();
  if (env.iosNeedsHomeScreenInstall || !env.supportsNotifications) {
    return false;
  }

  const saved = getSavedLocalPushState();
  if (saved.explicitlyDisabled) {
    return false;
  }

  if (Notification.permission === 'granted') {
    const sub = await ensureValidPushSubscriptionAndRegister({
      userEmail: cleanEmail,
      userUid: params.userUid,
      userDisplayName: params.userDisplayName,
      partyId: params.partyId,
    });
    return Boolean(sub?.endpoint);
  }

  return false;
}

/**
 * Must ONLY be called inside an explicit user click/tap handler (e.g. "Turn on Alerts" toggle switch).
 * Subscribes with `userVisibleOnly: true` and `urlBase64ToUint8Array(vapidPublicKey)` and dispatches
 * the confirmation notification strictly through the backend Web Push -> Service Worker `push` event.
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

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    saveLocalPushState({
      enabled: false,
      explicitlyDisabled: false,
      updatedAt: new Date().toISOString(),
    });
    return {
      ok: false,
      permission,
      error:
        permission === 'denied'
          ? 'Notifications are blocked in your browser/phone settings. Please allow notifications for BinDrop in your device settings.'
          : 'Notification permission was dismissed. Tap the toggle again and choose "Allow".',
    };
  }

  const subscriptionJson = await ensureValidPushSubscriptionAndRegister(params);

  if (!subscriptionJson?.endpoint) {
    return {
      ok: false,
      permission: 'granted',
      error:
        'Could not create a background Web Push subscription on this browser. Please make sure BinDrop is installed to your Home Screen.',
    };
  }

  // Trigger a genuine backend Web Push so the confirmation notification is delivered strictly
  // by the Service Worker `push` event listener (no frontend `new Notification()` fallback).
  await apiFetch('/api/push/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userEmail: params.userEmail.trim().toLowerCase(),
      userUid: params.userUid,
      userDisplayName: params.userDisplayName,
      partyId: params.partyId || null,
      title: '🔔 BinDrop Lock-Screen Alerts Active!',
      body: 'You will now receive lock-screen & banner alerts even when BinDrop is completely closed.',
    }),
  }).catch(() => {});

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
  saveLocalPushState({
    enabled: false,
    explicitlyDisabled: true,
    updatedAt: new Date().toISOString(),
  });
  let oldEndpoint: string | undefined;
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = await reg?.pushManager?.getSubscription();
      if (sub) {
        oldEndpoint = sub.endpoint;
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
        endpoint: oldEndpoint,
      }),
    });
  } catch {
    // ignore
  }
}
