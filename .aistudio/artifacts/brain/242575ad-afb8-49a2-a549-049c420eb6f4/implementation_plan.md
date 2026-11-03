# Household Party Lifecycle, Fast Cloud Sync & Permanent Deletion Plan

## 1. Root Cause Analysis of Reported Issues

1. **Infinite `"Please wait..."` on Sign-In & `"Creating..."` on Party Creation**
   - The client API layer currently blocks sign-in, registration, session checks, and party creation on synchronous multi-document Firestore SDK operations (`getDocFromServer` and sequential `setDoc` loops over every party in the store) as well as un-timed cross-origin requests to a remote preview container.
   - When the browser's Firestore WebChannel is unauthenticated or throttled, or when the remote container is unreachable, those promises hang indefinitely, leaving the UI buttons stuck on `"Please wait..."` and `"Creating..."`.

2. **Infinite `"Joining..."` via 6-Character Invite Code or Email Invitation**
   - Joining by code or accepting an invitation currently awaits sequential cloud index pulls and full-store cloud pushes before resolving the HTTP/fallback response.
   - Additionally, after creating or updating a party, the UI awaits a secondary authenticated Firestore write before unlocking the form button.

3. **Deleted Older Party Reappearing After 1 Second**
   - When a user deletes or leaves a party, only that single `partyId` is removed while older historical parties in the store that still list the user's email remain active. One second later, the 5-second session poll runs, searches all remaining parties for the user's email, automatically re-attaches the user to an older party, and reloads it onto the screen.
   - Furthermore, in-flight session polls that started prior to clicking **Delete Party** can resolve after deletion and re-hydrate the deleted party from cached payloads or cloud snapshots.

---

## 2. System Architecture & Non-Blocking Sync Flow

```
+-------------------------------------------------------------------------+
|                        USER ACTION (Browser / PWA)                      |
|   Sign In / Sign Up  |  Create Party  |  Join (Code/Invite)  |  Delete  |
+----------+------------------+-------------------+----------------+------+
           |                  |                   |                |
           v                  v                   v                v
+-------------------------------------------------------------------------+
|               1. Instant Local & Express Execution (<100ms)             |
|  - Mutations increment client `sessionEpoch` to drop stale polls        |
|  - Sign-In / Create / Join update store & return bundle immediately     |
|  - Delete Party tombstones ALL parties for that user + invite codes     |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|            2. Bounded REST Cloud Sync (1.8s Hard Timeout)               |
|  - Uses direct Firestore REST JSON endpoints with AbortController       |
|  - Cloud pushes run asynchronously in the background (non-blocking)     |
|  - Code lookup (`code_XXXXXX`) runs with a strict 1.8s timeout cap      |
+-------------------------------------------------------------------------+
```

---

## 3. Core Fixes to Implement

### A. Instant Sign-In & Account Registration (`"Please wait..."` Fix)
- Remove blocking cloud sync calls from the critical path of email/password login, sign-up, and Google account sign-in.
- Enforce a strict `1800ms` `AbortController` timeout on any fallback network requests so static/mobile clients immediately resolve via the local/cloud store if the backend endpoint is unreachable.
- Trigger cloud state hydration asynchronously in the background after the user is signed in.

### B. Instant Household Creation (`"Creating..."` Fix)
- Generate the 6-character `XXX-XXX` invite code, persist the new household party locally and on the server, and return the new party bundle to the UI immediately.
- Run the Firestore cloud publication (`party_{id}`, `code_{XXXXXX}`, and `global_index`) in the background (`fire-and-forget` with bounded REST timeouts) instead of blocking the `"Creating..."` button state.
- Make post-creation Firestore syncing non-blocking in the main application handler so the user transitions to the Household Duty HUD immediately.

### C. Reliable & Fast Party Join via 6-Character Code or Email Invite (`"Joining..."` Fix)
- Replace hanging `getDocFromServer` calls with direct, bounded (`1800ms` timeout) Firestore REST lookups for `code_{CLEAN6CHAR}` and `invitations_all`.
- When a user joins via a 6-character code or clicks **Accept** in the Invitations tab, immediately enroll them in the party roster, persist to local/server storage, transition straight to the Household Duty HUD, and push the updated roster to the cloud in the background.

### D. Permanent Party Deletion & Anti-Resurrection Guard
- **Complete User Party Purge on Delete/Leave**: When a user deletes or leaves a party, tombstone the target `partyId`, its 6-character `inviteCode`, and **any older/stale parties** in the store where that user was still listed as a member or host, ensuring the session resolver never falls back to an older party 1 second later.
- **Explicit `hasNoActiveParty` Tombstone**: Record an explicit user-level cleared state when a user deletes or leaves their party so automatic background session polling (`POST /api/session`) never auto-attaches them to historical parties until they explicitly click **Create Party** or **Join Party**.
- **In-Flight Poll Cancellation (`mutationEpoch`)**: Increment a client-side mutation counter whenever Sign Out, Leave Party, Delete Party, Create Party, or Join Party is triggered; any in-flight 5-second `/api/session` poll started before that mutation is ignored when it returns.
- **Stop Re-Sending Deleted Parties in `cachedParties`**: Filter out all tombstoned party IDs and left party keys before attaching cached client state to session requests, and immediately push the tombstone list to the cloud index.

---

## 4. Verification Plan
- **New User Sign-Up & Sign-In**: Verify that creating a new account or signing in resolves in under 200ms without hanging on `"Please wait..."`.
- **New Household Party Creation**: Verify that clicking **Create Household Party** immediately transitions to the Duty HUD with a 6-character `XXX-XXX` code without getting stuck on `"Creating..."`.
- **Join by 6-Character Code & Email Invitation**: Verify that entering a 6-character invite code or accepting an email invite in the Invitations tab joins the household immediately without getting stuck on `"Joining..."`.
- **Permanent Party Deletion**: Verify that deleting a party returns to the Household Setup screen and remains there permanently across 5-second background polls and page reloads without reloading any older party.
