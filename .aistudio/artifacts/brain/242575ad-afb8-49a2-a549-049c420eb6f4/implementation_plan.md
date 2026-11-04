# BinDrop — Photo Uploader Attribution & Party Rejoin (6-Digit Code + Email Invite) Fix

This update fixes two critical household bugs:
1. **Accurate Photo Uploader Attribution**: Ensures that whenever any roommate uploads a trash photo (even if it is currently another roommate's scheduled turn), the camera modal, uploaded drop log, Host verification card, and notifications display the **actual user who uploaded the photo** rather than the scheduled turn assignee's name.
2. **Reliable Party Rejoin via 6-Digit Code & Email Invitation**: Fixes the multi-device leave tombstone (`leftPartyKeys`) and invitation deduplication bugs that prevented former party members from rejoining via the 6-digit invite code or accepting a new email invitation after leaving once.

### User Review & Critical Decisions

> [!IMPORTANT]
> Both bug fixes are ready to execute immediately upon your approval:

- **1. Out-of-Turn Photo Upload Attribution**:
  - Passes the currently signed-in user's identity (`currentAccount` / `selfMember`) into the camera modal and `POST /api/party/drop` (`userId`, `userEmail`, `userDisplayName`, `userPhotoURL`) instead of hardcoding `activeTurnMember.uid`.
  - Updates backend and client `/api/party/drop` handlers to resolve the uploader by matching `uid` or `email` against `party.members` (falling back to the caller's profile if needed) so the photo card, notifications, and points always credit the person who actually took the photo.
- **2. Rejoin Party After Leaving (6-Digit Code & Email Invitation)**:
  - **Stop Cross-Device Leave Key Re-Infection**: Prevents `/api/session` polls from other open devices (such as the Host's phone/PC) from re-injecting stale `clientLeftPartyKeys` into the server store and kicking a newly rejoined member back out 5 seconds later.
  - **Fix Email Re-Invitations**: Generates a fresh unique invitation ID whenever a Host re-invites a former member and updates cloud invitation merging to compare timestamps (`createdAt` / `respondedAt`) instead of overwriting `PENDING` re-invitations with older `ACCEPTED` records.
  - **Fix Client Leave Cleanup**: Prevents `mirrorServerPayloadToClientStore` from mistakenly adding an active party to `deletedPartyIds` when a member or former host leaves without deleting the party.

---

### 1. Overview & Core Concept

- **What It Does**:
  1. Credits the actual logged-in roommate who snaps and uploads a trash disposal photo, whether they are uploading on their own turn or helping out during another roommate's turn.
  2. Allows any roommate who has left a household party to rejoin seamlessly using either the **6-digit invite code** or an **email invitation** from the Host, staying permanently in the household across all 5-second sync cycles.
- **Target Audience / Persona**: Roommates sharing trash duty across multiple mobile and desktop devices.
- **Key Value**: Eliminates misattributed photo uploads and ensures leaving and rejoining a party works reliably every time.

---

### 2. User Experience & Visual Design

- **Key User Flows**:
  - **Uploading a Photo Out of Turn**:
    1. Roommate B opens the camera while the HUD shows it is Roommate A's turn.
    2. The camera header and submission credit **Roommate B** (`currentAccount.displayName`).
    3. Once uploaded (and approved by the Host), the verification feed, activity history, and alerts all display **Roommate B's** name and avatar.
  - **Leaving & Rejoining via 6-Digit Code or Email Invite**:
    1. A roommate leaves the household party.
    2. They either enter the household's **6-digit invite code** or accept a new **Email Invitation** sent by the Host.
    3. They immediately enter the household HUD and remain in the party permanently without being kicked out on subsequent background syncs.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Server-Authoritative Leave State (No Client Poll Re-Injection)**
  - *Chosen Approach*: Remove `clientLeftPartyKeys` ingestion from `/api/session` polling on the server and filter `global_index.leftPartyKeys` against all active members across all parties (not just the current request caller).
  - *Why*: Previously, when User B rejoined on Device 2, the Host's browser on Device 1 still had `partyId:userB` in its `localStorage` and sent it back to the server on its next 5-second `/api/session` poll—causing the server to re-mark User B as "left" and kick them out.
- **Decision 2: Fresh Invitation IDs & Timestamp-Based Invitation Merging**
  - *Chosen Approach*: Always issue a new `inv_<timestamp>` ID when re-inviting a member by email and merge invitations in cloud sync by newest timestamp.
  - *Why*: Reusing the previous invitation ID caused the cloud sync merger (`if (!prev || inv.status !== 'PENDING')`) to overwrite the new `PENDING` invitation with the old `ACCEPTED` status from before the user left.

---

### 4. Technical Architecture & Data Strategy *(Technical Reference)*

- **Architecture & Data Flow Diagram**:
```
┌─────────────────────────────────────────────────────────────────────────┐
│                    1. Photo Upload Attribution Flow                     │
│  • Logged-In User (selfMember / currentAccount) opens Camera            │
│  • POST /api/party/drop sends { userId, userEmail, userDisplayName }    │
│  • Server & Client resolve uploader by UID/Email -> Credits Uploader    │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│             2. Party Rejoin Flow (6-Digit Code & Email Invite)          │
│  • Join by Code (/api/party/join) OR Accept Invite (/respond-invite)    │
│  • Purges <partyId>:<email> leave keys across Server, Client & Cloud    │
│  • Host /api/session polls blocked from re-injecting stale leave keys   │
│  • Email Re-Invite (/add-member) creates fresh PENDING invitation ID    │
└─────────────────────────────────────────────────────────────────────────┘
```
