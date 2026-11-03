# BinDrop: Cross-Device Invite Code Fix & Native PWA Background Web Push Notifications

## 1. Fix Cross-Device 6-Character Invite Code Lookup (`MUT-HJZ`)
Currently, if a Host creates a party while signed in via BinDrop Email/Password, mobile Google Chooser, or on a static host (`bindrop.netlify.app`), the party may only save to local storage or fail to index in shared cloud storage—causing roommates on another phone/browser to see `"No household party found matching 6-character invite code 'MUT-HJZ'"`.

### What We Will Build
- **Universal Cloud Party & Invite Code Sync (Firestore + Express Server)**:
  - Ensure every party creation, join, member update, and invitation write is persisted to **both** the Express backend (`/api/party/*`) and the shared **Firebase Firestore** database (`parties/{partyId}` and `inviteCodes/{inviteCode}` index documents), regardless of whether the user signed in via Google OAuth, Email/Password, or on a static deployment (`bindrop.netlify.app`).
  - Update `firestore.rules` and `src/utils/cloudPartySync.ts` (using the Firestore SDK + REST API fallback) so any device can resolve a normalized 6-character invite code (e.g., `MUT-HJZ` or `MUTHJZ`) directly from the shared cloud database when joining a party, updating the shared party roster in real time for all members.
  - Sync email-based invitations (`invitations` collection) in the cloud so invited roommates see pending invites in their **Invitations** tab across any device.

---

## 2. True System-Level Background Push Notifications (PWA + Service Worker + VAPID)
Enable native lock-screen and banner notifications on Android and iOS (16.4+) even when BinDrop is completely closed and the phone is locked.

### Architecture & Features
1. **Standalone Web App Manifest (`public/manifest.json` & `index.html`)**:
   - Configure `id: "/"`, `name: "BinDrop — Household Trash Duty"`, `short_name: "BinDrop"`, `start_url: "/"`, `scope: "/"`, `display: "standalone"`, `background_color: "#061408"`, `theme_color: "#d0ff45"`, and dedicated `192x192`, `512x512`, and `maskable` PNG icons plus `apple-touch-icon.png` and iOS standalone meta tags (`apple-mobile-web-app-capable`).
2. **Background Service Worker (`public/sw.js`)**:
   - Listen for the background `'push'` event when the app is closed or the phone is locked, parse the incoming JSON payload, and invoke `self.registration.showNotification(title, options)` with icon, badge, vibration pattern, deep-link URL, and action buttons.
   - Listen for `'notificationclick'` to focus an open BinDrop window or launch the installed PWA directly to the household dashboard.
3. **Frontend Subscription Flow & Strict Mobile Compliance (`src/components/PushAlertsCard.tsx` & `src/utils/pushClient.ts`)**:
   - **The iOS "Home Screen" Rule**: Automatically detect iOS devices (`iPhone` / `iPad` / `iPod`) and check standalone status (`window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true`). If an iPhone user is browsing in Safari rather than the installed Home Screen app, disable the toggle and display a clear visual step-by-step **Share → Add to Home Screen** guide.
   - **Explicit User Interaction ("Turn on Alerts" Toggle Switch)**: Never prompt for permissions on page load. Place an interactive **"Turn on Alerts"** toggle switch in both the **main Duty HUD** and the **Notification Drawer**. Toggling it on triggers `Notification.requestPermission()`, converts the backend's VAPID public key via `urlBase64ToUint8Array()`, calls `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, and registers the subscription with the backend and cloud store.
4. **Backend `web-push` Trigger Engine (`server.ts`)**:
   - Configure `web-push` with persistent VAPID keys (`GET /api/push/vapid-public-key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `POST /api/push/test`).
   - Automatically dispatch encrypted Web Push notifications to subscribed devices for **all household events and turn alerts**:
     - New turn assignments & rotations
     - 5-hour urgency countdown warnings
     - Missed deadline alerts & point penalties
     - Direct Host / Roommate nudges
     - Trash proof photo uploads & validations
     - New household party invitations and member joins
5. **Comprehensive Developer Implementation Guide**:
   - Provide the full architectural breakdown, OS push daemon handshake lifecycle explanation (APNs on iOS & FCM on Android waking up the Service Worker), and copy-ready code blocks in our final summary.
