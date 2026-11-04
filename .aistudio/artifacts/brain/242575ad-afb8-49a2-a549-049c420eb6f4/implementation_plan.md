# Background Lock-Screen Push Notifications (Closed-App Android & iOS Support)

## Goal
Ensure household members on **Android** and **iOS (Home Screen PWA)** receive instant OS lock-screen and banner notifications **even when the BinDrop app and browser are completely closed**, for all household events (5-hour warnings, missed deadlines, trash photo uploads, host approvals/rejections, turn rotations, and party invites/joins).

---

## Root Causes Identified
1. **Missing Server-Side Push Dispatches on Key Events**:
   - Previously, `POST /api/party/drop` (photo upload), `POST /api/party/verify-drop` (host approval/rejection & turn rotation), `POST /api/party/skip` (manual turn skip), `POST /api/party/respond-invite`, and `POST /api/party/leave` only wrote in-app alerts to `store.alertsByParty`, which required the recipient's app to stay open and poll `/api/session`. They did not call `sendBackgroundWebPush()` to wake up closed phones via FCM (Android) and APNs (iOS).
2. **Ephemeral Server VAPID Keys Invalidating Phone Subscriptions**:
   - `server.ts` generated random VAPID keys whenever `.data/bindrop-store.json` was initialized or reset, and `pushClient.ts` had a different hardcoded fallback VAPID public key. If the server restarted or keys mismatched (`VapidPkHashMismatch`), existing mobile push subscriptions silently failed when the app was closed.
3. **No Auto-Sync / Self-Healing of Push Subscriptions on Login or App Launch**:
   - If a user had already granted notification permission on their phone, `pushClient.ts` reused stale `PushSubscription` objects without verifying that the `applicationServerKey` matched the server's active VAPID public key, and `App.tsx` did not automatically re-sync the subscription when the user logged in or switched parties.
4. **Cloud Sync Gap for Subscriptions (`push_subs`)**:
   - `server.ts` only read `push_subs` from raw Firestore REST rather than the Dual-Engine Cloud Sync (`readCloudDoc('push_subs')` / `writeCloudDoc('push_subs')`), so subscriptions registered during Firestore quota windows or across instances could be missed by the background dispatcher.

---

## Planned Changes

### 1. Deterministic VAPID Keypair & Cloud-Backed Subscription Registry (`server.ts`, `src/utils/pushClient.ts`, `src/utils/apiClient.ts`)
- Configure a **deterministic, persistent VAPID keypair** shared consistently across `server.ts`, `src/utils/pushClient.ts`, and `src/utils/apiClient.ts` so mobile push subscriptions never break across server restarts or deployments.
- Upgrade `sendBackgroundWebPush` in `server.ts` to:
  - Merge subscriptions from both local `store.pushSubscriptions` and Dual-Engine Cloud Sync (`readCloudDoc('push_subs')`).
  - Set high-priority Web Push headers (`Urgency: 'high'`, `TTL: 86400`, `Topic`) so Android Doze mode and iOS APNs wake the device immediately even when the app is force-closed.
  - Prune only genuinely expired (`404` / `410`) endpoints and re-sync active subscriptions to cloud storage.

### 2. Trigger Background Web Push on All Household Events (`server.ts`)
- Wire `sendBackgroundWebPush` into every household lifecycle event so closed phones wake up immediately:
  - **Trash Photo Uploaded (`POST /api/party/drop`)**:
    - When a roommate uploads a photo for review: push lock-screen notification to the **Household Host** (`"📸 New Trash Photo from <Name> — Tap to verify"`).
    - When verified immediately by Host: push lock-screen notification to the **next roommate in the rotation** (`"🗑️ You're Up Next for Trash Duty!"`) and all party members.
  - **Host Approves or Rejects Photo (`POST /api/party/verify-drop`)**:
    - On approval: push lock-screen notification to the **completing member** (`"✅ Trash Photo Approved (+Pts)!"`) and the **next roommate up for duty** (`"🗑️ Your Turn for Trash Duty at <Party>"`).
    - On rejection: push lock-screen notification to the **submitting member** (`"⚠️ Trash Photo Needs Retake"`).
  - **Turn Rotated / Skipped (`POST /api/party/skip`)**:
    - Push lock-screen notification to the **new active assignee** (`"⏭️ Turn Rotated — You're Up for Trash Duty"`).
  - **5-Hour Warning & Missed Deadline Background Monitor (`evaluateAndDispatchPartyDeadlines`)**:
    - Periodically sync active parties from cloud before sweeping deadlines every 10 seconds so the background server dispatches 5-hour warnings and overdue escalations even when zero browsers are open.
  - **Invitations & Party Membership (`add-member`, `join`, `respond-invite`, `leave`)**:
    - Push lock-screen notifications when a roommate is invited, joins by code, accepts an invite, or leaves the household.

### 3. Automatic Subscription Self-Healing & Service Worker Background Renewal (`src/utils/pushClient.ts`, `src/App.tsx`, `public/sw.js`)
- Add `autoSyncAndHealPushSubscription()` in `src/utils/pushClient.ts` and call it automatically in `src/App.tsx` whenever a logged-in user has `Notification.permission === 'granted'` (or when their `partyId` changes):
  - Compares the browser's current `PushSubscription.options.applicationServerKey` against the active VAPID public key. If mismatched or missing, automatically unsubscribes the stale token, creates a fresh `PushSubscription`, and registers it with `/api/push/subscribe` and cloud `push_subs`.
- Update `public/sw.js` (`bindrop-sw-v6`):
  - Add a `pushsubscriptionchange` listener so if Android Chrome or iOS Safari rotates the push token while the app is closed, the Service Worker automatically re-subscribes with the VAPID key and posts the updated subscription to `/api/push/subscribe`.
  - Ensure `registration.showNotification` always runs inside `event.waitUntil(...)` with full lock-screen vibration, badge (`/badge-72x72.png`), icon (`/pwa-192x192.png`), and deep-link click handling.

---

## Verification Plan
- Run `compile_applet` to verify zero TypeScript or bundler errors.
- Restart the server with `restart_dev_server` and verify `/api/push/vapid-public-key`, `/api/push/subscribe`, and event-driven background Web Push dispatches.
