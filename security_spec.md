# Security Specification — BinDrop Household Trash Tracker

## 1. Data Invariants
1. **Default Deny**: All unmatched paths are strictly denied (`allow read, write: if false;`).
2. **Verified Identity**: All write operations require `request.auth != null && request.auth.token.email_verified == true`.
3. **PII Isolation**: User email addresses and notification preferences live strictly in `/users/{userId}/private/{docId}` and are readable/writable only by `request.auth.uid == userId`.
4. **Master Gate Relational Sync**: Subcollections `/parties/{partyId}/drops/{dropId}` and `/parties/{partyId}/alerts/{alertId}` require verifying that `request.auth.uid in get(/databases/$(database)/documents/parties/$(partyId)).data.memberIds`.
5. **Bounded Arrays**: `Party.memberIds` is strictly bounded to `size() >= 1 && size() <= 12`.
6. **Immutability**: `uid`, `id`, `hostId`, `partyId`, `userId`, and `createdAt` cannot be mutated after creation.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Write**: Creating `/users/user_1` with `auth == null` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoof**: Creating `/parties/party_1` with `email_verified == false` -> `PERMISSION_DENIED`.
3. **Shadow Field Injection on UserProfile**: Sending `isAdmin: true` to `/users/user_1` -> `PERMISSION_DENIED` via `hasOnly`.
4. **Cross-User Profile Hijack**: Authenticated `user_2` updating `/users/user_1` -> `PERMISSION_DENIED`.
5. **PII Snooping**: Authenticated `user_2` reading `/users/user_1/private/info` -> `PERMISSION_DENIED`.
6. **ID Poisoning**: Creating `/parties/bad..id$$$` -> `PERMISSION_DENIED` via `isValidId()`.
7. **Unbounded Member Array**: Updating `/parties/party_1` with 25 `memberIds` -> `PERMISSION_DENIED`.
8. **Host Hijacking**: Non-host modifying `hostId` on `/parties/party_1` -> `PERMISSION_DENIED`.
9. **Non-Member Drop Creation**: `user_outsider` creating `/parties/party_1/drops/drop_1` when not in `memberIds` -> `PERMISSION_DENIED`.
10. **Unverified Drop Spoofing**: Submitting a drop with `verified: false` to `/parties/party_1/drops/drop_1` -> `PERMISSION_DENIED`.
11. **Terminal Drop Mutation**: Attempting to update an already-verified `/parties/party_1/drops/drop_1` -> `PERMISSION_DENIED`.
12. **Blanket List Scraping**: Listing `/parties` without filtering `request.auth.uid in resource.data.memberIds` -> `PERMISSION_DENIED`.
