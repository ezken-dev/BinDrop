# BinDrop — Cross-Device Party Sync, 6-Character Invite Codes & Social Pop-Up Notifications

This update resolves the 6-character invite code mismatch so roommates can seamlessly join households, adds full **Leave Party** and **Delete Party** controls, synchronizes user accounts and party memberships in the cloud so logging in from PC or mobile (or after pushing new builds) always restores your exact household, and replaces the email alert system with Facebook/Instagram-style real-time pop-up banners and native browser/OS push notifications.

## User Review & Critical Decisions

> [!IMPORTANT]
> All core product decisions have been confirmed and incorporated into this plan:

- **Confirmed Decision 1 — 6-Character Invite Code Format**: Household invite codes are standardized to **6 alphanumeric characters** formatted as `XXX-XXX` (e.g., `BIN-7X4` — 3-character prefix + 3-character suffix = 6 characters matching the 6 visual boxes). Existing 6- or 7-character codes are also normalized and accepted seamlessly.
- **Confirmed Decision 2 — Leave Party & Delete Party Rules**:
  - **Regular Members**: Can click **Leave Party** at any time to exit the household rotation and join or create another party.
  - **Party Host**: Can either **Leave Party** (which automatically transfers the Host role to the next roommate in the rotation, or deletes the party if they are the last member) OR **Delete Party** (which permanently dissolves the household for all members after confirmation).
- **Confirmed Decision 3 — Social Pop-Up & OS Push Notifications**: Replaces the email notification system with **real-time in-app social pop-up toast banners** (with avatar, action badge, chime/vibration, and slide-down animation like Instagram/Facebook) paired with **native OS/Browser Push Notifications** (`Notification` API) and a live **Notifications Bell Feed** in the top bar.

---

## 1. Overview & Core Concept

- **What It Does**: Provides a unified, cloud-synced household trash duty tracker where roommates join via a 6-character code, track 1-to-7 day turn rotations, verify trash drop photos, and receive instant social pop-up and browser push notifications when turns rotate, 5-hour warnings trigger, or deadlines are missed.
- **Target Audience / Persona**: Roommates and household members accessing BinDrop across multiple devices (desktop browsers, mobile phones, and static deployments like Netlify).
- **Key Value**: Eliminates lost sessions after app updates, fixes the truncated 7th character bug on invite codes, gives users full control over leaving or deleting a household party, and delivers instant notifications without SMTP/email configuration friction.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Cross-Device Login & Automatic Party Restoration**: When a user signs in with their email or Google account on PC or mobile, BinDrop checks both the server/cloud store and local cache by normalized email. If the user is already in a party (either as Host or enrolled roommate), they are taken straight to their active **Duty HUD**—never prompted to create a household again after pushing updates.
  2. **6-Character Invite Code & Instant Join**: The Party Setup screen displays the 6 characters of the invite code inside 6 rounded character tiles (e.g., `B` `I` `N` `7` `X` `4` for `BIN-7X4`). When a roommate types or pastes `BIN-7X4` or `BIN7X4`, all 6 visual slots fill accurately and join the exact household.
  3. **Leave Party & Delete Party Controls**: Inside the **Party Setup** tab (and accessible from the household header strip), members see a dedicated **Household Membership Actions** card:
     - **Leave Party**: Removes the current user from `members`, recalculates the active turn index, transfers Host ownership if the leaving member was the Host, and returns the user to the Create/Join party screen.
     - **Delete Party (Host Only)**: Shows a two-step inline confirmation before permanently deleting the party and returning all members to the household setup screen.
  4. **Instagram/Facebook-Style Pop-Up Notifications & Bell Feed**:
     - Clicking **Send Reminder Alert** or triggering a **5-Hour Warning**, **Missed Deadline**, **Photo Submitted**, or **Host Verified** event immediately broadcasts a live notification event to the household.
     - **Floating Pop-Up Card**: Slides down from the top-right / top-center with the sender's avatar, bold action title, relative timestamp (`Just now`), unread indicator, and quick action button (`View HUD` / `Review Photo`).
     - **OS / Browser Push Notification**: Fires a native `new Notification(...)` alert (with a 1-click "Enable Push Alerts" permission toggle in the header/HUD).
     - **Notification Bell Drawer**: Clicking the top-bar Bell icon opens an Instagram-style activity dropdown showing unread and historical household notifications with a "Mark all as read" control.
- **Visual Identity & Theme**:
  - Preserves the existing **Overused Grotesk** (`--font-display`, `--font-sans`) and **JetBrains Mono** (`--font-mono`, `tabular-nums`) typography, dark forest obsidian canvas (`#041206`), translucent glass panels (`glass-panel`, `glass-panel-elevated`), and neon lime (`#d0ff45`) primary accents.
- **Interactive Feedback & Motion**:
  - Smooth slide-in toast transitions (`cubic-bezier(0.16, 1, 0.3, 1)`), subtle Web Audio notification chime on incoming pop-up alerts, and immediate optimistic UI updates.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Cloud-First Cross-Device Persistence (Express + Firestore + Local Mirror)**
  - *Chosen Approach*: Store and query user accounts, party state, drop logs, turn history, and live notifications in a shared cloud/server layer (syncing with Firestore by deterministic email/party keys as well as Express `/api/*` and local storage cache).
  - *Why*: Previously, static hosts like Netlify fell back exclusively to browser-local `localStorage`, meaning logging in on a phone vs. PC—or deploying a new build—couldn't see parties created on another device. Syncing deterministically by normalized email and invite code ensures that any device immediately finds the user's account and active party.
- **Decision 2: Native Pop-Up & Push Notifications Over Email SMTP**
  - *Chosen Approach*: Replace all email composition/SMTP panels in the HUD and Admin views with an integrated **Real-Time Pop-Up & Push Notification Engine**.
  - *Why*: Eliminates third-party Gmail App Password blocks while giving roommates immediate, familiar social-app style alerts both inside the app and at the OS/browser level.

---

## 4. Technical Architecture & Data Strategy

### Architecture & Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        BinDrop Application Shell                            │
│  ┌───────────────────┐  ┌─────────────────────────┐  ┌───────────────────┐  │
│  │ Top Bar & Bell    │  │ Social Pop-Up Toast     │  │ Web Notification  │  │
│  │ Activity Feed     │  │ Overlay (IG/FB Style)   │  │ OS Push Bridge    │  │
│  └─────────┬─────────┘  └────────────┬────────────┘  └─────────┬─────────┘  │
│            └─────────────────────────┼─────────────────────────┘            │
│                                      ▼                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    Unified Cross-Device Sync Engine                   │  │
│  │   Firestore Cloud Sync  ◄───►  Express /api/*  ◄───►  Local Mirror    │  │
│  └─────────┬─────────────────────────┬─────────────────────────┬─────────┘  │
│            ▼                         ▼                         ▼            │
│  ┌───────────────────┐     ┌───────────────────┐     ┌───────────────────┐  │
│  │     Duty HUD      │     │   Party Setup     │     │  Admin & History  │  │
│  │ • Turn Countdown  │     │ • 6-Box Code      │     │ • Photo Review    │  │
│  │ • Send Pop Alert  │     │ • Add Roommate    │     │ • Turn Audit Log  │  │
│  │ • Leaderboard     │     │ • Leave / Delete  │     │ • Push Alert Log  │  │
│  └───────────────────┘     └───────────────────┘     └───────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Model & State

- **Invite Code Generator & Validator**:
  - `generateInviteCode(prefix)`: Produces a 3-letter uppercase prefix + `-` + 3 alphanumeric characters (e.g., `BIN-7X4`, total 6 alphanumeric characters).
  - `normalizeInviteCode(input)`: Strips spaces/hyphens to 6–7 uppercase alphanumeric characters so both `BIN-7X4` and `BIN7X4` resolve identically.
- **Party Membership & Lifecycle Endpoints**:
  - `POST /api/party/leave`: Removes `userId`/`userEmail` from `party.members` and `party.memberIds`. If the leaving member was `hostId` and other members remain, promotes `party.members[0]` to `HOST` (`hostId`, `hostEmail`). If no members remain, deletes the party. Clears `partyId` on the user's account record.
  - `POST /api/party/delete`: Verifies the caller is the Party Host, deletes the party document and its associated queues, and clears `partyId` for all enrolled member accounts so everyone cleanly transitions back to household setup.
- **Pop-Up Notification Entity (`PartyAlertItem` / `PushNotificationLog`)**:
  - Contains `id`, `partyId`, `senderName`, `senderAvatar`, `recipientUserId` (`'ALL'` or specific `uid`), `recipientName`, `type` (`'WARNING_5H' | 'MISSED_DEADLINE' | 'TURN_REMINDER' | 'PHOTO_SUBMITTED' | 'PHOTO_VERIFIED' | 'MEMBER_JOINED'`), `title`, `message`, `createdAt`, and `readByUserIds`.
  - Tracked in real time: whenever a new notification arrives that hasn't been seen on the current client, the app triggers the Instagram/Facebook-style floating pop-up toast, plays a subtle notification chime, and fires a native browser `Notification` if permission is granted.
