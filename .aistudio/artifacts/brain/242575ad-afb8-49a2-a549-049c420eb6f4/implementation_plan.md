# BinDrop — Pure Service Worker Background Web Push & Party Rejoin Fix

This update strictly enforces OS-level background Web Push execution across the Service Worker, client subscription manager, backend dispatcher, and frontend polling loop so lock-screen alerts are delivered exclusively by the Service Worker even when BinDrop is completely closed. It also resolves the party rejoin bug where a member who previously left a household is forcefully kicked back out a few seconds after rejoining with the 6-digit invite code.

### User Review & Critical Decisions

> [!IMPORTANT]
> All five architectural constraints specified in your request are incorporated into this plan and ready to execute upon approval:

- **1. Service Worker (`push` & `notificationclick`)**: Wraps `self.registration.showNotification(...)` strictly inside `event.waitUntil(...)`, safely parses `event.data.json()` inside a `try/catch` block with a plain-text fallback, enforces `requireInteraction: true`, `vibrate`, `icon`, and `badge`, and wraps deep-link navigation inside `event.waitUntil(clients.openWindow(...))`.
- **2. Client Subscription Logic**: Enforces `userVisibleOnly: true` and `urlBase64ToUint8Array(vapidPublicKey)` in `registration.pushManager.subscribe(...)` and removes browser-thread `new Notification(...)` calls.
- **3. Backend Web Push Dispatch**: Sends a stringified JSON payload (`title`, `body`, `url`, `icon`, `badge`, `tag`, `category`) via `webPush.sendNotification(...)` with `{ urgency: 'high', TTL: 86400 }` to wake Android from Doze mode and iOS APNs immediately.
- **4. Frontend Polling Cleanup**: Strips `new Notification(...)` / `triggerBrowserPushNotification` out of the client `/api/session` polling loop so OS notifications are triggered strictly by the Service Worker `push` event (preventing false positives while keeping in-app UI state synced).
- **5. Rejoin Household by 6-Digit Code Fix**: Purges stale `leftPartyKeys` from both the local session store and the cloud `global_index` document when a user rejoins via a 6-character code or invite so background cloud merges never forcefully eject a rejoined member.

---

### 1. Overview & Core Concept

- **What It Does**:
  1. Guarantees that every household notification on iOS and Android is a genuine Service Worker Web Push event woken by FCM/APNs (`urgency: 'high'`, `TTL: 86400`), eliminating frontend polling `new Notification(...)` calls that masked push delivery issues while the app was open.
  2. Fixes the household membership state machine so a user who leaves a household and later rejoins with the 6-digit party code remains permanently in the party across cloud sync cycles.
- **Target Audience / Persona**: Household roommates using BinDrop on iOS Home Screen Web Apps, Android Chrome PWAs, and desktop browsers.
- **Key Value**: True background lock-screen delivery when the app is swiped away, plus reliable household leave-and-rejoin flows.

---

### 2. User Experience & Visual Design

- **Key User Flows**:
  - **Closed-App Lock-Screen Push Flow**:
    1. When a roommate logs in or enables alerts, the client registers the Service Worker and subscribes via `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`.
    2. When any household event occurs (photo verification, turn pass, deadline alert, or invite), the backend dispatches an encrypted Web Push with `{ urgency: 'high', TTL: 86400 }`.
    3. Even with BinDrop completely closed, the OS wakes the Service Worker (`event.waitUntil(self.registration.showNotification(...))`), displaying the alert with the BinDrop icon, monochrome badge, vibration pattern, and `requireInteraction: true`.
    4. Tapping the lock-screen notification triggers `notificationclick` (`event.waitUntil(clients.openWindow(targetUrl))`), opening or focusing BinDrop directly to the target screen.
  - **Leave & Rejoin by 6-Digit Code Flow**:
    1. A user leaves a household (`leftPartyKeys` records their departure so stale devices don't re-add them automatically).
    2. Later, the user enters the household's 6-character invite code and clicks **Join**.
    3. Both the local state and the cloud `global_index` immediately clear the user's `leftPartyKeys` entry for that household and persist their active membership, so subsequent 5-second `/api/session` polls keep them inside the household without kicking them back out.
- **Visual Identity & Theme**:
  - Preserves BinDrop's high-contrast tactical dark UI (`#080B12` surface, `#10B981` emerald accents) and crisp notification iconography (`/pwa-192x192.png` color icon and `/badge-72x72.png` alpha mask).
- **Interactive Feedback & Motion**:
  - In-app toasts continue to display smoothly while the app is open, while all OS-level system notifications are exclusively rendered by the Service Worker `push` listener.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Strict Separation Between In-App UI Sync and OS Notifications**
  - *Chosen Approach*: Strip `new Notification(...)` completely from the frontend `/api/session` polling loop and client utilities. Only the Service Worker `push` event listener calls `self.registration.showNotification(...)`.
  - *Why*: Calling `new Notification(...)` from a `setInterval` poll makes notifications appear to work while the tab is open even if Web Push is failing in the background, and causes duplicate alerts when both fire.
  - *Alternatives Considered*: Keeping a frontend notification fallback when push permissions are partial — rejected because it creates false positives during testing and fails the moment the app is backgrounded.
- **Decision 2: Cloud Tombstone (`leftPartyKeys`) Cleanup on Rejoin**
  - *Chosen Approach*: When a user joins a party via 6-digit code or accepts an invite, explicitly remove `<partyId>:<email>` and `<email>:<partyId>` from `store.leftPartyKeys` before pushing to cloud, and filter out any `existingGlobal.leftPartyKeys` entry in `pushPartyStoreToCloud` and `syncStoreWithCloud` whenever the user is an active member of that party.
  - *Why*: Previously, `pushPartyStoreToCloud` unioned local `leftPartyKeys` with `existingGlobal.leftPartyKeys` from Firestore, which re-injected the old leave tombstone right back into the store and caused the next `/api/session` poll (5 seconds later) to forcefully eject the user.

---

### 4. Technical Architecture & Data Strategy *(Technical Reference)*

- **Architecture & Component Diagram**:
```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Backend Web Push Dispatcher                       │
│  • webPush.sendNotification(sub, JSON.stringify({ title, body, url }),  │
│    { urgency: 'high', TTL: 86400 })                                     │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ Encrypted RFC 8030 Push (FCM / APNs)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     OS Background Service Worker                        │
│  • push listener: try/catch event.data.json() -> text() fallback        │
│  • event.waitUntil(self.registration.showNotification(title, {          │
│      body, icon, badge, vibrate, requireInteraction: true, data         │
│    }))                                                                  │
│  • notificationclick listener: event.waitUntil(clients.openWindow(url)) │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                   Household Rejoin & Cloud Sync Engine                  │
│  • Join by 6-Digit Code -> Clears leftPartyKeys locally & in Cloud      │
│  • Cloud Merge Filter -> Active party members strip stale leave keys    │
│  • Session Poll (/api/session) -> Updates React UI only (no OS Notify)  │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Data Model & State**:
  - **Push Payload Schema**: `{ title: string, body: string, url: string, icon: string, badge: string, tag: string, category: string, senderName?: string }`.
  - **Cloud Leave Tombstones (`leftPartyKeys`)**: Array of `<partyId>:<email>` strings tracking intentional departures. Cleared across local memory, client storage, and Firestore `global_index` whenever a user rejoins that `partyId`.
- **Interactive Component & State Mapping**:
  - **Push Subscription Manager**: Converts the VAPID public key via `urlBase64ToUint8Array`, subscribes with `userVisibleOnly: true`, and POSTs the endpoint + keys to `/api/push/subscribe`.
  - **Household Rejoin Handler**: Increments the client mutation epoch, removes leave tombstones prior to `pullPartyByInviteCodeFromCloud` and `pushPartyStoreToCloud`, writes `user_<email>` membership to cloud, and returns the updated household bundle.
