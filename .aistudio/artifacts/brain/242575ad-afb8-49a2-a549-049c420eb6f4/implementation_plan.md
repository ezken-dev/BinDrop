# BinDrop — Camera, Profile Sync, Host Controls & Cross-Device Party Sync Plan

## 1. Clean, Unobstructed Camera Viewfinder
- **Remove Cluttered Overlays**: Strip the translucent olive box, corner brackets, `"Waste Detected"`, `"Analyzing..."`, and `"Center trash in frame"` labels from the live camera screen (`src/components/VisionScannerModal.tsx`).
- **Pure Viewfinder Layout**: Keep the live video feed completely unobstructed from edge to edge, leaving only the top duty header bar and the bottom shutter/gallery/flash dock.

## 2. Working Camera Flash (Hardware LED Torch + Screen Flash Fallback)
- **Hardware Rear LED Torch**: Inspect the active video track (`track.getCapabilities()`) and toggle the hardware flash LED via `track.applyConstraints({ advanced: [{ torch: nextState }] })` (plus direct `{ torch: nextState }` fallback and `ImageCapture` track warm-up for mobile Chrome/Android).
- **Screen-Illumination Flash Fallback**: When a device or browser does not expose a hardware torch (e.g., PC webcams, front cameras, or restricted mobile browsers), toggling Flash On activates a high-brightness white screen illumination border/flash boost during capture so dark scenes are still illuminated and the Flash toggle always responds reliably.

## 3. Profile Picture Refresh Persistence & Animated "Save Profile" Flow
- **Eliminate Refresh Flicker**:
  - Prevent `onAuthStateChanged` (`initAuth` in `src/App.tsx`), `/api/auth/google-sync`, and `/api/session` from overwriting a user's saved custom `data:image/...` avatar with Google's default `googleusercontent.com` profile URL on page reload.
  - Persist custom avatars in a dedicated `localStorage` cache (`bindrop_custom_avatars_v1`) alongside the cloud `avatar_<email>` document and session storage so even after 2–3+ consecutive refreshes, the custom avatar renders immediately on frame 1 with zero revert/flicker.
- **Animated "Save Profile" Button & Confirmation**:
  - Add an active saving state to the **"Save Profile"** button (`src/components/ProfileAccountModal.tsx`) with a smooth loading spinner and press transition while syncing changes to the database/cloud.
  - Once saved, transition the button and status banner into a clear confirmation state (`"Edits saved to your profile!"`) before closing or resting.

## 4. Host-Only Rotation Cycle Control
- **UI Enforcement (`src/components/PartyManagerModal.tsx`)**: Restrict the 1-to-7 day rotation cycle selector so only the **Household Host** can tap and change the cycle duration. Non-host members see the active rotation cycle in read-only mode with a clear `Host Only` badge.
- **API Enforcement (`server.ts` & `src/utils/apiClient.ts`)**: Validate on `/api/party/deadline` that the requesting member is the party host before applying rotation cycle changes.

## 5. Cross-Device Google Login Party Sync (Phone ↔ PC)
- **Per-User Cloud Membership Pointer**: Store and maintain a dedicated cloud membership record (`user_<emailKey>`) and an email-to-party map inside `global_index` whenever a user creates a party, joins by 6-character code, accepts an invite, or loads their active party (`src/utils/cloudPartySync.ts`).
- **Await Cloud Membership on Google Login**: Update `/api/auth/google-sync`, `/api/auth/login`, and `/api/session` in both `server.ts` and `src/utils/apiClient.ts` to `await syncStoreWithCloud(..., { email: cleanEmail, forceFresh: true })` and hydrate the user's party directly from `user_<emailKey>` / `global_index` before returning the login response.
- **Result**: Logging into the same Google account on PC immediately loads the existing household party created or joined on the phone instead of prompting to create or join a new party.
