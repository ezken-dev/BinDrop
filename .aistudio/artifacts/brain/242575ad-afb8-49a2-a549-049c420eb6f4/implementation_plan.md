# Production Polish, Global Profile Pictures, Notification Icons & Live Streak Plan

## 1. Remove All Test Controls & Finalize Production UI
- **Notification Drawer (`src/App.tsx`)**:
  - Remove the `"Test Live Alert"` button and test toast handler (`handleEnableBrowserPush`), keeping only real household activity and a clean `"Nudge <Roommate>"` action when needed.
- **Push Alerts Switch (`src/components/PushAlertsCard.tsx`)**:
  - Remove the `"Test Push"` button and `handleSendTestPush` function so the card presents only the clean `"Turn on Alerts"` production toggle switch and iOS Home Screen instructions when applicable.
- **Admin Dashboard (`src/components/AdminDashboardView.tsx`) & Onboarding (`src/components/AuthLoginScreen.tsx`)**:
  - Remove the `"Fast-Forward Turn Deadline"` simulation buttons (`4h 30m` / `Expire Now`) in the Admin Notification tab and the `"Due in 4h 30m (Triggers 5h Warning Pop-Up)"` test option in party creation.

## 2. Global Cross-Device Profile Picture Sync
- **Root Cause**: `compactPartyForCloud` in `src/utils/cloudPartySync.ts` was stripping `photoURL` whenever it was a base64 `data:` URL longer than 500 characters so index documents stayed small, without storing or hydrating the member's uploaded avatar in a dedicated cloud document.
- **Solution**:
  - Add a dedicated avatar compression helper (`compressAvatarImage` in `src/utils/sceneImageGenerator.ts`) that produces a crisp square `160x160` JPEG data URL (~4KB–7KB).
  - Add `writeMemberAvatarToCloud(uid, email, photoURL)` and `hydratePartyMemberAvatarsFromCloud(party)` in `src/utils/cloudPartySync.ts` (using dedicated `avatar_<emailKey>` cloud documents across both `ntfy.sh` chunked storage and Firestore, with an in-memory + `localStorage` cache).
  - Automatically write the uploaded avatar to cloud during account registration (`/api/auth/register`), Google sign-in (`/api/auth/google-sync`), party creation/join, and profile save (`/api/party/profile`), and automatically hydrate member avatars across all devices whenever a party bundle is fetched or synced.

## 3. Fix Mobile & PC Notification Logo (Eliminate Android White Box)
- **Root Cause**: Android OS renders the notification `badge` (`/badge-72x72.png`) in the status bar and notification header as a **monochrome alpha mask**, turning every non-transparent pixel solid white. Because `/public/badge-72x72.png` had an opaque square background, Android rendered the entire square as a solid white box.
- **Solution**:
  - Generate a true **transparent-background monochrome alpha PNG** for `/public/badge-72x72.png` and `/public/badge-96x96.png` where the background is 100% transparent (`rgba(0, 0, 0, 0)`) and only the crisp BinDrop trash-bin silhouette is opaque white (`rgba(255, 255, 255, 255)`).
  - Update `/public/sw.js` (`SW_VERSION = 'bindrop-sw-v5'`) and `src/utils/pushClient.ts` to resolve absolute URLs for `icon` (`new URL('/pwa-192x192.png', self.location.origin).href`) and `badge` (`new URL('/badge-72x72.png', self.location.origin).href`), ensuring both Android status bars (monochrome silhouette) and Android/PC notification cards (full-color lime-and-forest BinDrop app icon) display the real BinDrop logo.

## 4. Working Interactive Current Streak Card & Streak Breakdown Sheet
- **Duty HUD Current Streak Card (`src/App.tsx`)**:
  - Replace the static decorative SVG curve with a live **Interactive Flame Counter** card driven by real household turn data:
    - Displays the active viewer's live streak count (`0x`, `1x`, `2x`, etc.) with a dynamic lime flame emblem that scales and illuminates based on active streak status.
    - Shows a live **Milestone Progress Bar** toward the next streak tier (e.g., `3x Streak`, `5x Streak`, `10x Streak` bonus multiplier) and **Recent Turn Dots** (last 5 turns color-coded: electric lime for on-time verified, amber for pending host review, rose for missed/late, muted for upcoming).
- **Tap-to-Open Streak Breakdown Sheet (`src/App.tsx`)**:
  - Tapping the **Current Streak** card opens a smooth spring-animated modal/sheet displaying:
    - Current Streak (`Xx`), On-Time Rate (`%`), Total Verified Drops, and Next Streak Bonus milestone.
    - A chronological list of recent turns and photo submissions for the user and household, with a quick button to upload a trash photo or view full standings.
