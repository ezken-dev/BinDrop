import {
  doesInviteCodeMatch,
  formatSixCharInviteCode,
  isFakeStubParty,
  type EmailDispatchLog,
  type HouseholdInvitation,
  type HouseholdMember,
  type PartyAlertItem,
  type PartyState,
  type TrashDropLog,
  type TurnHistoryRecord,
} from './trashDutyLogic';

const FIRESTORE_REST_BASE =
  'https://firestore.googleapis.com/v1/projects/gen-lang-client-0842283767/databases/ai-studio-bindropgamifiedh-242575ad-afb8-49a2-a549-049c420eb6f4/documents/bindrop_cloud';
const NTFY_TOPIC_PREFIX = 'https://ntfy.sh/bd242575ad_v4_';
const CLOUD_TIMEOUT_MS = 2500;
const READ_CACHE_TTL_MS = 4000;
const NTFY_INLINE_CHUNK_SIZE = 2900; // Strictly under ntfy.sh 4,096-byte inline message threshold
const QUOTA_COOLDOWN_STORAGE_KEY = 'bindrop_fs_quota_cooldown_until';

let firestoreQuotaCooldownUntil = 0;
try {
  if (typeof sessionStorage !== 'undefined') {
    const saved = Number(sessionStorage.getItem(QUOTA_COOLDOWN_STORAGE_KEY) || '0');
    if (saved > Date.now()) {
      firestoreQuotaCooldownUntil = saved;
    }
  }
} catch {
  // ignore
}

function markFirestoreQuotaCooldown() {
  firestoreQuotaCooldownUntil = Date.now() + 60 * 60 * 1000; // 60 minutes cooldown on 429
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(QUOTA_COOLDOWN_STORAGE_KEY, String(firestoreQuotaCooldownUntil));
    }
  } catch {
    // ignore
  }
}

const lastWrittenHashByDocId = new Map<string, string>();
const readCacheByDocId = new Map<string, { value: any; fetchedAt: number }>();
const publishedActivePartyIdsInSession = new Set<string>();
const CUSTOM_AVATAR_STORAGE_KEY = 'bindrop_custom_avatars_v1';
const hydratedDropPhotoCache = new Map<string, string>();
const hydratedAvatarCache = new Map<string, string>();

try {
  if (typeof localStorage !== 'undefined') {
    const rawAvatars = localStorage.getItem(CUSTOM_AVATAR_STORAGE_KEY);
    if (rawAvatars) {
      const parsed = JSON.parse(rawAvatars) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) {
        if (k && typeof v === 'string' && v.length > 20) {
          hydratedAvatarCache.set(k.trim().toLowerCase(), v);
        }
      }
    }
  }
} catch {
  // ignore localStorage read errors
}

function persistCustomAvatarCacheToStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      const obj: Record<string, string> = {};
      for (const [k, v] of hydratedAvatarCache.entries()) {
        if (k && v) obj[k] = v;
      }
      localStorage.setItem(CUSTOM_AVATAR_STORAGE_KEY, JSON.stringify(obj));
    }
  } catch {
    // ignore storage quota errors
  }
}

export function isCustomUploadedAvatar(url?: string | null): boolean {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('data:image/') && url.length > 80;
}

export function getCachedMemberAvatar(email?: string | null): string | undefined {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return undefined;
  return hydratedAvatarCache.get(clean);
}

export function setCachedMemberAvatar(email?: string | null, photoURL?: string | null): void {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !photoURL || photoURL.length < 20) return;
  const existing = hydratedAvatarCache.get(clean);
  // Do not overwrite an existing custom uploaded data:image/ avatar with a default Google OAuth URL
  if (isCustomUploadedAvatar(existing) && !isCustomUploadedAvatar(photoURL) && photoURL.includes('googleusercontent.com')) {
    return;
  }
  hydratedAvatarCache.set(clean, photoURL);
  persistCustomAvatarCacheToStorage();
}

export function chooseBestAvatar(
  existingPhoto?: string | null,
  incomingPhoto?: string | null,
  email?: string | null
): string | undefined {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cached = cleanEmail ? hydratedAvatarCache.get(cleanEmail) : undefined;

  if (isCustomUploadedAvatar(incomingPhoto)) {
    if (cleanEmail) setCachedMemberAvatar(cleanEmail, incomingPhoto!);
    return incomingPhoto!;
  }
  if (isCustomUploadedAvatar(existingPhoto)) {
    if (cleanEmail) setCachedMemberAvatar(cleanEmail, existingPhoto!);
    return existingPhoto!;
  }
  if (isCustomUploadedAvatar(cached)) {
    return cached!;
  }
  const chosen = incomingPhoto || existingPhoto || cached || undefined;
  if (cleanEmail && chosen) {
    setCachedMemberAvatar(cleanEmail, chosen);
  }
  return chosen;
}

export interface CloudSyncStoreLike {
  parties: Record<string, PartyState>;
  dropsByParty: Record<string, TrashDropLog[]>;
  historyByParty: Record<string, TurnHistoryRecord[]>;
  emailsByParty: Record<string, EmailDispatchLog[]>;
  alertsByParty: Record<string, PartyAlertItem[]>;
  invitations: HouseholdInvitation[];
  deletedPartyIds: string[];
  leftPartyKeys: string[];
  clearedPartyUsers?: string[];
}

export function cleanAlphanumericCode(code: string): string {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function sanitizeDocId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 52);
}

export function sanitizeEmailForCloudDoc(email?: string | null): string {
  const clean = String(email || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .slice(0, 44);
  return `inv_${clean}`;
}

export function sanitizeAvatarDocId(email?: string | null): string {
  const clean = String(email || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .slice(0, 42);
  return `avatar_${clean}`;
}

export function sanitizeUserMembershipDocId(email?: string | null): string {
  const clean = String(email || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .slice(0, 42);
  return `user_${clean}`;
}

/**
 * Compacts a party for cloud storage.
 * For `party_<pid>`, preserves compact member avatars (`<= 7000` chars) inline so all devices
 * see profile pictures immediately, while `stripAvatarsForIndex: true` strips data URLs in
 * `code_<6CHAR>` and `global_index` so invite code lookups stay under 2KB.
 */
export function compactPartyForCloud(
  party: PartyState,
  options?: { stripAvatarsForIndex?: boolean }
): PartyState {
  const maxInlineAvatarLen = options?.stripAvatarsForIndex ? 500 : 7000;
  return {
    ...party,
    inviteCode: formatSixCharInviteCode(party.inviteCode),
    lastDropImageUrl: undefined,
    members: (party.members || []).map((m) => {
      const bestPhoto = chooseBestAvatar(m.photoURL, undefined, m.email);
      return {
        ...m,
        photoURL:
          bestPhoto &&
          bestPhoto.length > maxInlineAvatarLen &&
          bestPhoto.startsWith('data:')
            ? undefined
            : bestPhoto,
      };
    }),
  };
}

export function isUserLeftKeyMatched(
  leftPartyKeys: string[],
  partyId: string,
  email?: string | null
): boolean {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !partyId) return false;
  return (
    leftPartyKeys.includes(`${cleanEmail}:${partyId}`) ||
    leftPartyKeys.includes(`${partyId}:${cleanEmail}`)
  );
}

export function addUserLeftKey(
  leftPartyKeys: string[],
  partyId: string,
  email?: string | null
): void {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !partyId) return;
  const k1 = `${cleanEmail}:${partyId}`;
  const k2 = `${partyId}:${cleanEmail}`;
  if (!leftPartyKeys.includes(k1)) leftPartyKeys.push(k1);
  if (!leftPartyKeys.includes(k2)) leftPartyKeys.push(k2);
}

export function removeUserLeftKey(
  leftPartyKeys: string[],
  partyId: string,
  email?: string | null
): string[] {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !partyId) return leftPartyKeys;
  const k1 = `${cleanEmail}:${partyId}`;
  const k2 = `${partyId}:${cleanEmail}`;
  return leftPartyKeys.filter((k) => k !== k1 && k !== k2);
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = CLOUD_TIMEOUT_MS
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readSingleNtfyTopicMessage(topicId: string): Promise<{
  parsed: any | null;
  tsMs: number;
}> {
  try {
    const res = await fetchWithTimeout(`${NTFY_TOPIC_PREFIX}${topicId}/json?poll=1&since=72h`);
    if (!res || !res.ok) return { parsed: null, tsMs: 0 };
    const text = (await res.text()).trim();
    if (!text) return { parsed: null, tsMs: 0 };

    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.event !== 'message') continue;
        const tsMs = (Number(evt.time) || 0) * 1000;
        if (typeof evt.message === 'string' && evt.message.trim().startsWith('{')) {
          return { parsed: JSON.parse(evt.message), tsMs };
        }
      } catch {
        // try earlier line
      }
    }
  } catch {
    // ignore
  }
  return { parsed: null, tsMs: 0 };
}

async function readNtfyDoc<T = any>(
  safeId: string
): Promise<{ value: T | null; updatedAtMs: number }> {
  try {
    const { parsed: parsedWrapper, tsMs } = await readSingleNtfyTopicMessage(safeId);
    if (!parsedWrapper) return { value: null, updatedAtMs: 0 };

    if (parsedWrapper.__deleted === true) {
      return { value: null, updatedAtMs: tsMs };
    }

    // Reassemble multi-chunk inline payload if chunked (avoids ntfy.sh 4096-byte attachment CORS block)
    if (
      parsedWrapper.__chunked === true &&
      typeof parsedWrapper.chunkCount === 'number' &&
      parsedWrapper.chunkCount > 0
    ) {
      const count = Math.min(20, parsedWrapper.chunkCount);
      const chunkResults = await Promise.all(
        Array.from({ length: count }, (_, idx) =>
          readSingleNtfyTopicMessage(`${safeId}_c${idx}`)
        )
      );
      const pieces: string[] = [];
      for (let idx = 0; idx < count; idx++) {
        const chunkObj = chunkResults[idx]?.parsed;
        if (!chunkObj || typeof chunkObj.data !== 'string') {
          return { value: null, updatedAtMs: 0 };
        }
        pieces.push(chunkObj.data);
      }
      const fullPayloadJson = pieces.join('');
      const reconstructed = JSON.parse(fullPayloadJson) as T;
      const updatedMs = parsedWrapper.updatedAtIso
        ? new Date(parsedWrapper.updatedAtIso).getTime()
        : tsMs;
      return { value: reconstructed, updatedAtMs: updatedMs };
    }

    if (parsedWrapper.payload !== undefined) {
      const updatedMs = parsedWrapper.updatedAtIso
        ? new Date(parsedWrapper.updatedAtIso).getTime()
        : tsMs;
      return { value: parsedWrapper.payload as T, updatedAtMs: updatedMs };
    }

    return { value: parsedWrapper as T, updatedAtMs: tsMs };
  } catch {
    return { value: null, updatedAtMs: 0 };
  }
}

async function writeNtfyDoc(
  safeId: string,
  kind: string,
  payload: unknown,
  nowIso: string
): Promise<void> {
  const inlineWrapper = JSON.stringify({
    docId: safeId,
    kind,
    updatedAtIso: nowIso,
    payload,
  });

  // If <= 3,500 bytes, post directly as a single inline message (< 4,096 bytes)
  if (inlineWrapper.length <= 3500) {
    await fetchWithTimeout(`${NTFY_TOPIC_PREFIX}${safeId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: inlineWrapper,
    });
    return;
  }

  // Otherwise split payloadJson into <= 2,900-byte inline chunks so ntfy NEVER turns it into a CORS-blocked attachment
  const payloadJson = JSON.stringify(payload);
  if (payloadJson.length > 55000) return;

  const chunks: string[] = [];
  for (let offset = 0; offset < payloadJson.length; offset += NTFY_INLINE_CHUNK_SIZE) {
    chunks.push(payloadJson.slice(offset, offset + NTFY_INLINE_CHUNK_SIZE));
  }

  await Promise.all(
    chunks.map((chunkStr, idx) =>
      fetchWithTimeout(`${NTFY_TOPIC_PREFIX}${safeId}_c${idx}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({
          idx,
          data: chunkStr,
          updatedAtIso: nowIso,
        }),
      })
    )
  );

  await fetchWithTimeout(`${NTFY_TOPIC_PREFIX}${safeId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({
      docId: safeId,
      kind,
      __chunked: true,
      chunkCount: chunks.length,
      updatedAtIso: nowIso,
    }),
  });
}

async function readFirestoreDoc<T = any>(
  safeId: string
): Promise<{ value: T | null; updatedAtMs: number }> {
  if (Date.now() < firestoreQuotaCooldownUntil) {
    return { value: null, updatedAtMs: 0 };
  }
  try {
    const res = await fetchWithTimeout(`${FIRESTORE_REST_BASE}/${safeId}`);
    if (!res) return { value: null, updatedAtMs: 0 };
    if (res.status === 429) {
      markFirestoreQuotaCooldown();
      return { value: null, updatedAtMs: 0 };
    }
    if (!res.ok) return { value: null, updatedAtMs: 0 };
    const data = (await res.json()) as any;
    const raw = data?.fields?.payloadJson?.stringValue;
    const updatedAtIso = data?.fields?.updatedAtIso?.stringValue;
    if (typeof raw === 'string' && raw.length > 0) {
      const parsed = JSON.parse(raw) as T;
      const updatedMs = updatedAtIso ? new Date(updatedAtIso).getTime() : 1;
      return { value: parsed, updatedAtMs: updatedMs };
    }
  } catch {
    // ignore
  }
  return { value: null, updatedAtMs: 0 };
}

export async function readCloudDoc<T = any>(
  docId: string,
  options?: { forceFresh?: boolean }
): Promise<T | null> {
  const safeId = sanitizeDocId(docId);
  const now = Date.now();
  const cached = readCacheByDocId.get(safeId);
  if (!options?.forceFresh && cached && now - cached.fetchedAt < READ_CACHE_TTL_MS) {
    return cached.value as T | null;
  }

  const [ntfyRes, fsRes] = await Promise.all([
    readNtfyDoc<T>(safeId),
    readFirestoreDoc<T>(safeId),
  ]);

  let chosen: T | null = null;
  if (ntfyRes.value && fsRes.value) {
    chosen = ntfyRes.updatedAtMs >= fsRes.updatedAtMs ? ntfyRes.value : fsRes.value;
  } else {
    chosen = ntfyRes.value ?? fsRes.value ?? null;
  }

  readCacheByDocId.set(safeId, { value: chosen, fetchedAt: Date.now() });
  return chosen;
}

export async function writeCloudDoc(
  docId: string,
  kind:
    | 'GLOBAL_INDEX'
    | 'PARTY_BUNDLE'
    | 'INVITE_CODE'
    | 'INVITATIONS'
    | 'PUSH_SUBS'
    | 'PHOTO_BLOB'
    | 'USER_MEMBERSHIP',
  payload: unknown,
  options?: { forceWrite?: boolean }
): Promise<void> {
  const safeId = sanitizeDocId(docId);
  const payloadJson = JSON.stringify(payload);
  if (payloadJson.length > 900000) return;

  if (!options?.forceWrite && lastWrittenHashByDocId.get(safeId) === payloadJson) {
    return;
  }
  lastWrittenHashByDocId.set(safeId, payloadJson);
  readCacheByDocId.set(safeId, { value: payload, fetchedAt: Date.now() });

  const nowIso = new Date().toISOString();
  const tasks: Promise<unknown>[] = [];

  // 1. Write to Ntfy Realtime JSON Relay with automatic inline chunking (< 3.5KB per message)
  tasks.push(writeNtfyDoc(safeId, kind, payload, nowIso));

  // 2. Write to Cloud Firestore REST (unless in 429 quota cooldown)
  if (Date.now() > firestoreQuotaCooldownUntil) {
    tasks.push(
      fetchWithTimeout(`${FIRESTORE_REST_BASE}/${safeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            docId: { stringValue: safeId },
            kind: { stringValue: kind },
            payloadJson: { stringValue: payloadJson },
            updatedAtIso: { stringValue: nowIso },
          },
        }),
      }).then((res) => {
        if (res && res.status === 429) {
          markFirestoreQuotaCooldown();
        }
      })
    );
  }

  await Promise.allSettled(tasks);
}

export async function deleteCloudDoc(docId: string): Promise<void> {
  const safeId = sanitizeDocId(docId);
  lastWrittenHashByDocId.delete(safeId);
  readCacheByDocId.set(safeId, { value: null, fetchedAt: Date.now() });

  const tasks: Promise<unknown>[] = [
    fetchWithTimeout(`${NTFY_TOPIC_PREFIX}${safeId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: JSON.stringify({
        docId: safeId,
        __deleted: true,
        updatedAtIso: new Date().toISOString(),
      }),
    }),
  ];

  if (Date.now() > firestoreQuotaCooldownUntil) {
    tasks.push(
      fetchWithTimeout(`${FIRESTORE_REST_BASE}/${safeId}`, {
        method: 'DELETE',
      }).then((res) => {
        if (res && res.status === 429) {
          markFirestoreQuotaCooldown();
        }
      })
    );
  }

  await Promise.allSettled(tasks);
}

/**
 * Saves and retrieves full-clarity uploaded trash drop photos in dedicated chunked cloud docs
 * (`photo_<dropId>`) so photos are NEVER truncated or lost across devices.
 */
export async function writeDropPhotoToCloud(
  dropId: string,
  imageUrl?: string
): Promise<void> {
  if (!dropId || !imageUrl || imageUrl.length < 64) return;
  hydratedDropPhotoCache.set(dropId, imageUrl);
  await writeCloudDoc(`photo_${dropId}`, 'PHOTO_BLOB', {
    dropId,
    imageUrl,
  });
}

export async function hydratePartyDropPhotosFromCloud(
  store: CloudSyncStoreLike,
  partyId: string
): Promise<void> {
  const drops = store.dropsByParty[partyId] || [];
  if (drops.length === 0) return;

  await Promise.all(
    drops.slice(0, 8).map(async (drop) => {
      if (!drop || !drop.id) return;
      const existingImg = drop.imageUrl || '';
      const isCompleteValidImage =
        existingImg.length > 200 &&
        (existingImg.startsWith('data:image/') || existingImg.startsWith('http'));

      if (isCompleteValidImage) {
        hydratedDropPhotoCache.set(drop.id, existingImg);
        return;
      }

      const cachedImg = hydratedDropPhotoCache.get(drop.id);
      if (cachedImg) {
        drop.imageUrl = cachedImg;
        return;
      }

      const photoDoc = await readCloudDoc<{ dropId: string; imageUrl: string }>(
        `photo_${drop.id}`
      );
      if (photoDoc?.imageUrl && photoDoc.imageUrl.length > 100) {
        hydratedDropPhotoCache.set(drop.id, photoDoc.imageUrl);
        drop.imageUrl = photoDoc.imageUrl;
      }
    })
  );

  // Also link hydrated drop photos to matching turn history records
  const historyList = store.historyByParty[partyId] || [];
  for (const hist of historyList) {
    if (hist.dropId && (!hist.imageUrl || hist.imageUrl.length < 200)) {
      const fromCache = hydratedDropPhotoCache.get(hist.dropId);
      if (fromCache) {
        hist.imageUrl = fromCache;
      }
    }
  }
}

/**
 * Saves and retrieves member profile pictures in dedicated cloud docs (`avatar_<email>`)
 * so custom uploaded profile photos sync globally across all roommates and devices.
 */
export async function writeMemberAvatarToCloud(
  email?: string | null,
  photoURL?: string
): Promise<void> {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !photoURL || photoURL.length < 20) return;
  setCachedMemberAvatar(cleanEmail, photoURL);
  await writeCloudDoc(sanitizeAvatarDocId(cleanEmail), 'PHOTO_BLOB', {
    email: cleanEmail,
    photoURL: getCachedMemberAvatar(cleanEmail) || photoURL,
    updatedAtIso: new Date().toISOString(),
  });
}

/**
 * Writes a lightweight per-user cloud pointer (`user_<email>`) so signing in with Google or email
 * on any new device (PC or phone) immediately resolves the user's active household party.
 */
export async function writeUserMembershipToCloud(
  email?: string | null,
  membership?: {
    partyId: string | null;
    inviteCode?: string;
    displayName?: string;
    photoURL?: string;
    updatedAtIso?: string;
  }
): Promise<void> {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !membership) return;
  const bestPhoto = chooseBestAvatar(membership.photoURL, undefined, cleanEmail);
  await writeCloudDoc(sanitizeUserMembershipDocId(cleanEmail), 'USER_MEMBERSHIP', {
    email: cleanEmail,
    partyId: membership.partyId || null,
    inviteCode: membership.inviteCode ? formatSixCharInviteCode(membership.inviteCode) : undefined,
    displayName: membership.displayName,
    photoURL: bestPhoto && bestPhoto.length <= 7000 ? bestPhoto : undefined,
    updatedAtIso: membership.updatedAtIso || new Date().toISOString(),
  });
}

export async function hydratePartyMemberAvatarsFromCloud(
  store: CloudSyncStoreLike,
  partyId: string
): Promise<void> {
  const party = store.parties[partyId];
  if (!party || !Array.isArray(party.members)) return;

  await Promise.all(
    party.members.map(async (member) => {
      if (!member || !member.email) return;
      const cleanEmail = member.email.trim().toLowerCase();

      if (isCustomUploadedAvatar(member.photoURL)) {
        setCachedMemberAvatar(cleanEmail, member.photoURL);
        return;
      }

      const cached = getCachedMemberAvatar(cleanEmail);
      if (isCustomUploadedAvatar(cached)) {
        member.photoURL = cached;
        return;
      }

      const avatarDoc = await readCloudDoc<{ email: string; photoURL: string }>(
        sanitizeAvatarDocId(cleanEmail)
      );
      if (avatarDoc?.photoURL && avatarDoc.photoURL.length > 20) {
        const chosen = chooseBestAvatar(member.photoURL, avatarDoc.photoURL, cleanEmail);
        if (chosen) member.photoURL = chosen;
      } else if (cached && !member.photoURL) {
        member.photoURL = cached;
      }
    })
  );

  // Propagate hydrated member avatars into dropLogs, historyLogs, and alerts for this party
  const avatarByUid = new Map<string, string>();
  const avatarByEmail = new Map<string, string>();
  for (const m of party.members) {
    if (m.photoURL) {
      avatarByUid.set(m.uid, m.photoURL);
      if (m.email) avatarByEmail.set(m.email.trim().toLowerCase(), m.photoURL);
    }
  }

  for (const drop of store.dropsByParty[partyId] || []) {
    const resolved =
      avatarByUid.get(drop.userId) ||
      (drop.userEmail ? avatarByEmail.get(drop.userEmail.trim().toLowerCase()) : undefined);
    if (resolved) drop.userPhotoURL = resolved;
  }

  for (const hist of store.historyByParty[partyId] || []) {
    const resolved =
      avatarByUid.get(hist.userId) ||
      (hist.userEmail ? avatarByEmail.get(hist.userEmail.trim().toLowerCase()) : undefined);
    if (resolved) hist.userPhotoURL = resolved;
  }
}

/**
 * Merges two PartyState objects that share the same party ID or 6-character invite code,
 * ensuring that Host role, members who joined from other devices, and turn state are preserved.
 */
export function mergePartyStates(
  existing: PartyState,
  incoming: PartyState,
  leftPartyKeys: string[] = []
): PartyState {
  if (isFakeStubParty(existing) && !isFakeStubParty(incoming)) {
    return { ...incoming, inviteCode: formatSixCharInviteCode(incoming.inviteCode) };
  }
  if (isFakeStubParty(incoming) && !isFakeStubParty(existing)) {
    return { ...existing, inviteCode: formatSixCharInviteCode(existing.inviteCode) };
  }

  const existingTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
  const incomingTime = new Date(incoming.updatedAt || incoming.createdAt || 0).getTime();
  const primary = incomingTime >= existingTime ? { ...incoming } : { ...existing };
  const secondary = incomingTime >= existingTime ? existing : incoming;

  // Always preserve the canonical Host ID, Host Email, and Party Name from the non-stub creator
  const canonicalHostEmail = (existing.hostEmail || incoming.hostEmail || '').toLowerCase();

  const mergedMembersMap = new Map<string, HouseholdMember>();
  // Put existing members first so turn rotation order stays stable, then append any newly joined members
  for (const m of [...(existing.members || []), ...(incoming.members || [])]) {
    if (!m || !m.email) continue;
    const key = m.email.trim().toLowerCase();
    if (
      isUserLeftKeyMatched(leftPartyKeys, primary.id, key) ||
      isUserLeftKeyMatched(leftPartyKeys, secondary.id, key)
    ) {
      continue;
    }
    const prev = mergedMembersMap.get(key);
    if (!prev) {
      mergedMembersMap.set(key, {
        ...m,
        photoURL: chooseBestAvatar(undefined, m.photoURL, key),
      });
    } else {
      mergedMembersMap.set(key, {
        ...prev,
        ...m,
        role: prev.role === 'HOST' || m.role === 'HOST' ? 'HOST' : 'MEMBER',
        points: Math.max(prev.points || 0, m.points || 0),
        totalDrops: Math.max(prev.totalDrops || 0, m.totalDrops || 0),
        onTimeDrops: Math.max(prev.onTimeDrops || 0, m.onTimeDrops || 0),
        missedDrops: Math.max(prev.missedDrops || 0, m.missedDrops || 0),
        currentStreak: Math.max(prev.currentStreak || 0, m.currentStreak || 0),
        bestStreak: Math.max(prev.bestStreak || 0, m.bestStreak || 0),
        photoURL: chooseBestAvatar(prev.photoURL, m.photoURL, key),
      });
    }
  }

  const mergedMembers = Array.from(mergedMembersMap.values());
  const hostEntry =
    mergedMembers.find(
      (m) =>
        (canonicalHostEmail && m.email.toLowerCase() === canonicalHostEmail) ||
        m.uid === primary.hostId ||
        m.role === 'HOST'
    ) || mergedMembers[0];

  if (hostEntry) {
    primary.hostId = hostEntry.uid;
    primary.hostEmail = hostEntry.email;
    for (const m of mergedMembers) {
      m.role = m.email.toLowerCase() === hostEntry.email.toLowerCase() ? 'HOST' : 'MEMBER';
    }
  }

  primary.members = mergedMembers;
  primary.memberIds = mergedMembers.map((m) => m.uid);
  primary.inviteCode = formatSixCharInviteCode(primary.inviteCode);
  if (primary.currentTurnIndex >= primary.members.length) {
    primary.currentTurnIndex = 0;
  }
  if (!primary.members.some((m) => m.uid === primary.currentTurnUserId) && primary.members[0]) {
    primary.currentTurnUserId =
      primary.members[primary.currentTurnIndex]?.uid || primary.members[0].uid;
  }

  return primary;
}

/**
 * Merges incoming cloud drops with local drops while preserving already-hydrated imageUrls.
 */
function mergePartyDrops(
  existingDrops: TrashDropLog[] = [],
  incomingDrops: TrashDropLog[] = []
): TrashDropLog[] {
  const byId = new Map<string, TrashDropLog>();
  for (const d of [...incomingDrops, ...existingDrops]) {
    if (!d || !d.id) continue;
    const prev = byId.get(d.id);
    const cachedPhoto = hydratedDropPhotoCache.get(d.id);
    const bestImageUrl =
      cachedPhoto ||
      (d.imageUrl && d.imageUrl.length > 200 ? d.imageUrl : undefined) ||
      (prev?.imageUrl && prev.imageUrl.length > 200 ? prev.imageUrl : undefined) ||
      d.imageUrl ||
      prev?.imageUrl;

    if (!prev) {
      byId.set(d.id, { ...d, imageUrl: bestImageUrl || '' });
    } else {
      byId.set(d.id, {
        ...prev,
        ...d,
        verified: Boolean(d.verified || prev.verified),
        verificationStatus:
          d.verificationStatus !== 'PENDING_HOST_APPROVAL'
            ? d.verificationStatus
            : prev.verificationStatus || d.verificationStatus,
        pointsAwarded: Math.max(d.pointsAwarded || 0, prev.pointsAwarded || 0),
        imageUrl: bestImageUrl || '',
      });
    }
  }
  return Array.from(byId.values()).sort(
    (a, b) =>
      new Date(b.submittedIso || b.createdAt || 0).getTime() -
      new Date(a.submittedIso || a.createdAt || 0).getTime()
  );
}

/**
 * Pulls a specific party by its 6-character invite code from our Dual-Engine Cloud Store
 * (`code_<6CHAR>`, `party_<ID>`, `global_index`, and `invitations_all`) and merges it into the store.
 */
export async function pullPartyByInviteCodeFromCloud(
  store: CloudSyncStoreLike,
  rawInviteCode: string,
  options?: { forceFresh?: boolean; joiningEmail?: string }
): Promise<PartyState | null> {
  const cleanCode = cleanAlphanumericCode(rawInviteCode);
  if (cleanCode.length < 4) return null;

  const forceFresh = options?.forceFresh ?? true;
  const cleanJoiningEmail = options?.joiningEmail ? options.joiningEmail.trim().toLowerCase() : '';

  const [codeDoc, globalDoc, allInvitesDoc] = await Promise.all([
    readCloudDoc<{
      partyId: string;
      inviteCode: string;
      party: PartyState;
      drops?: TrashDropLog[];
      history?: TurnHistoryRecord[];
      alerts?: PartyAlertItem[];
      invitations?: HouseholdInvitation[];
    }>(`code_${cleanCode}`, { forceFresh }),
    readCloudDoc<{
      codeMap?: Record<string, string>;
      parties?: Record<string, PartyState>;
      invitations?: HouseholdInvitation[];
      deletedPartyIds?: string[];
      leftPartyKeys?: string[];
    }>('global_index', { forceFresh }),
    readCloudDoc<{
      invitations?: HouseholdInvitation[];
    }>('invitations_all', { forceFresh }),
  ]);

  if (globalDoc?.deletedPartyIds) {
    for (const delId of globalDoc.deletedPartyIds) {
      if (!store.deletedPartyIds.includes(delId)) {
        store.deletedPartyIds.push(delId);
      }
      delete store.parties[delId];
    }
  }

  // 1. Direct match from `code_<6CHAR>` document
  if (
    codeDoc &&
    codeDoc.party &&
    !isFakeStubParty(codeDoc.party) &&
    !store.deletedPartyIds.includes(codeDoc.party.id)
  ) {
    const pid = codeDoc.party.id;
    if (cleanJoiningEmail) {
      store.leftPartyKeys = removeUserLeftKey(store.leftPartyKeys, pid, cleanJoiningEmail);
    }
    const partyBundle = await readCloudDoc<{
      party: PartyState;
      drops?: TrashDropLog[];
      history?: TurnHistoryRecord[];
      alerts?: PartyAlertItem[];
      invitations?: HouseholdInvitation[];
    }>(`party_${pid}`, { forceFresh });

    const remoteParty =
      partyBundle?.party && !isFakeStubParty(partyBundle.party)
        ? partyBundle.party
        : codeDoc.party;
    remoteParty.inviteCode = formatSixCharInviteCode(remoteParty.inviteCode);

    if (store.parties[pid] && !isFakeStubParty(store.parties[pid])) {
      store.parties[pid] = mergePartyStates(
        store.parties[pid],
        remoteParty,
        store.leftPartyKeys
      );
    } else {
      store.parties[pid] = remoteParty;
    }

    if (Array.isArray(partyBundle?.drops)) {
      store.dropsByParty[pid] = mergePartyDrops(store.dropsByParty[pid], partyBundle.drops);
      await hydratePartyDropPhotosFromCloud(store, pid);
    }
    if (Array.isArray(partyBundle?.history) && partyBundle.history.length > 0) {
      store.historyByParty[pid] = partyBundle.history;
    }
    if (Array.isArray(partyBundle?.alerts) && partyBundle.alerts.length > 0) {
      store.alertsByParty[pid] = partyBundle.alerts;
    }
    await hydratePartyMemberAvatarsFromCloud(store, pid);
    return store.parties[pid];
  }

  // 2. Match from `global_index.codeMap` or `global_index.parties`
  const mappedPartyId = globalDoc?.codeMap?.[cleanCode];
  if (mappedPartyId && !store.deletedPartyIds.includes(mappedPartyId)) {
    const pulled = await pullPartyByIdFromCloud(store, mappedPartyId, {
      forceFresh: true,
      joiningEmail: cleanJoiningEmail || undefined,
    });
    if (pulled) return pulled;
  }

  if (globalDoc?.parties) {
    for (const remoteParty of Object.values(globalDoc.parties)) {
      if (
        remoteParty &&
        !isFakeStubParty(remoteParty) &&
        !store.deletedPartyIds.includes(remoteParty.id) &&
        doesInviteCodeMatch(remoteParty.inviteCode, cleanCode)
      ) {
        const pid = remoteParty.id;
        if (cleanJoiningEmail) {
          store.leftPartyKeys = removeUserLeftKey(store.leftPartyKeys, pid, cleanJoiningEmail);
        }
        const partyBundle = await readCloudDoc<{
          party: PartyState;
          drops?: TrashDropLog[];
          history?: TurnHistoryRecord[];
          alerts?: PartyAlertItem[];
        }>(`party_${pid}`, { forceFresh });

        const latestRemote =
          partyBundle?.party && !isFakeStubParty(partyBundle.party)
            ? partyBundle.party
            : remoteParty;
        latestRemote.inviteCode = formatSixCharInviteCode(latestRemote.inviteCode);

        store.parties[pid] =
          store.parties[pid] && !isFakeStubParty(store.parties[pid])
            ? mergePartyStates(store.parties[pid], latestRemote, store.leftPartyKeys)
            : latestRemote;

        if (Array.isArray(partyBundle?.drops)) {
          store.dropsByParty[pid] = mergePartyDrops(store.dropsByParty[pid], partyBundle.drops);
          await hydratePartyDropPhotosFromCloud(store, pid);
        }
        return store.parties[pid];
      }
    }
  }

  // 3. Match from `invitations_all` or `globalDoc.invitations` partySnapshot
  const candidateInvites = [
    ...(allInvitesDoc?.invitations || []),
    ...(globalDoc?.invitations || []),
    ...(store.invitations || []),
  ];
  for (const inv of candidateInvites) {
    if (
      inv &&
      !store.deletedPartyIds.includes(inv.partyId) &&
      doesInviteCodeMatch(inv.inviteCode, cleanCode)
    ) {
      if (cleanJoiningEmail) {
        store.leftPartyKeys = removeUserLeftKey(
          store.leftPartyKeys,
          inv.partyId,
          cleanJoiningEmail
        );
      }
      const partyBundle = await readCloudDoc<{
        party: PartyState;
        drops?: TrashDropLog[];
      }>(`party_${inv.partyId}`, { forceFresh });

      const foundParty = partyBundle?.party || inv.partySnapshot;
      if (foundParty && !isFakeStubParty(foundParty)) {
        foundParty.inviteCode = formatSixCharInviteCode(foundParty.inviteCode);
        store.parties[foundParty.id] =
          store.parties[foundParty.id] && !isFakeStubParty(store.parties[foundParty.id])
            ? mergePartyStates(store.parties[foundParty.id], foundParty, store.leftPartyKeys)
            : foundParty;
        if (Array.isArray(partyBundle?.drops)) {
          store.dropsByParty[foundParty.id] = mergePartyDrops(
            store.dropsByParty[foundParty.id],
            partyBundle.drops
          );
          await hydratePartyDropPhotosFromCloud(store, foundParty.id);
        }
        return store.parties[foundParty.id];
      }
    }
  }

  return null;
}

/**
 * Pulls a specific party by its Party ID from the cloud.
 */
export async function pullPartyByIdFromCloud(
  store: CloudSyncStoreLike,
  partyId: string,
  options?: { forceFresh?: boolean; joiningEmail?: string }
): Promise<PartyState | null> {
  if (!partyId || store.deletedPartyIds.includes(partyId)) return null;
  if (options?.joiningEmail) {
    store.leftPartyKeys = removeUserLeftKey(
      store.leftPartyKeys,
      partyId,
      options.joiningEmail.trim().toLowerCase()
    );
  }
  const forceFresh = options?.forceFresh ?? true;
  const partyBundle = await readCloudDoc<{
    party: PartyState;
    drops?: TrashDropLog[];
    history?: TurnHistoryRecord[];
    alerts?: PartyAlertItem[];
    invitations?: HouseholdInvitation[];
  }>(`party_${partyId}`, { forceFresh });

  if (
    partyBundle?.party &&
    !isFakeStubParty(partyBundle.party) &&
    !store.deletedPartyIds.includes(partyBundle.party.id)
  ) {
    const remoteParty = partyBundle.party;
    remoteParty.inviteCode = formatSixCharInviteCode(remoteParty.inviteCode);
    store.parties[partyId] =
      store.parties[partyId] && !isFakeStubParty(store.parties[partyId])
        ? mergePartyStates(store.parties[partyId], remoteParty, store.leftPartyKeys)
        : remoteParty;
    if (Array.isArray(partyBundle.drops)) {
      store.dropsByParty[partyId] = mergePartyDrops(
        store.dropsByParty[partyId],
        partyBundle.drops
      );
      await hydratePartyDropPhotosFromCloud(store, partyId);
    }
    if (Array.isArray(partyBundle.history) && partyBundle.history.length > 0) {
      store.historyByParty[partyId] = partyBundle.history;
    }
    if (Array.isArray(partyBundle.alerts) && partyBundle.alerts.length > 0) {
      store.alertsByParty[partyId] = partyBundle.alerts;
    }
    await hydratePartyMemberAvatarsFromCloud(store, partyId);
    return store.parties[partyId];
  }
  return null;
}

/**
 * Permanently removes deleted parties and their invite codes from the cloud
 * and records their IDs in `global_index.deletedPartyIds` so they never reappear.
 */
export async function deletePartiesFromCloud(
  store: CloudSyncStoreLike,
  deletedIds: string[],
  inviteCodes: string[] = []
): Promise<void> {
  try {
    for (const id of deletedIds) {
      if (id && !store.deletedPartyIds.includes(id)) {
        store.deletedPartyIds.push(id);
      }
      delete store.parties[id];
    }

    const deleteTasks: Promise<void>[] = [];
    for (const id of deletedIds) {
      if (id) deleteTasks.push(deleteCloudDoc(`party_${id}`));
    }
    for (const code of inviteCodes) {
      const clean = cleanAlphanumericCode(code);
      if (clean.length >= 4) {
        deleteTasks.push(deleteCloudDoc(`code_${clean}`));
      }
    }

    await Promise.allSettled(deleteTasks);
    await pushPartyStoreToCloud(store, undefined, { forceWrite: true });
  } catch {
    // ignore
  }
}

/**
 * Pushes a specific party, its 6-character invite code (`code_<6CHAR>`), any uploaded drop photos,
 * any per-email invitations, and the global index to our Dual-Engine Cloud Store.
 */
export async function pushPartyStoreToCloud(
  store: CloudSyncStoreLike,
  targetPartyId?: string,
  options?: { forceWrite?: boolean; rejoinedEmail?: string }
): Promise<void> {
  try {
    if (targetPartyId && options?.rejoinedEmail) {
      store.leftPartyKeys = removeUserLeftKey(
        store.leftPartyKeys,
        targetPartyId,
        options.rejoinedEmail.trim().toLowerCase()
      );
    }
    // Purge any fake stub parties before syncing
    for (const [pid, p] of Object.entries(store.parties)) {
      if (isFakeStubParty(p)) {
        delete store.parties[pid];
      }
    }

    const partyIds = targetPartyId
      ? [targetPartyId]
      : Object.keys(store.parties)
          .filter(
            (id) => !store.deletedPartyIds.includes(id) && !isFakeStubParty(store.parties[id])
          )
          .slice(0, 8);

    const writeTasks: Promise<void>[] = [];

    for (const pid of partyIds) {
      const party = store.parties[pid];
      if (!party || isFakeStubParty(party) || store.deletedPartyIds.includes(pid)) continue;
      party.inviteCode = formatSixCharInviteCode(party.inviteCode);
      const cleanCode = cleanAlphanumericCode(party.inviteCode);
      const compactParty = compactPartyForCloud(party);
      const indexCompactParty = compactPartyForCloud(party, { stripAvatarsForIndex: true });

      // Sync each member's profile photo to `avatar_<email>` and membership pointer to `user_<email>`
      // so custom avatars and party membership work globally across phone and PC
      for (const m of party.members || []) {
        if (m.email) {
          const bestPhoto = chooseBestAvatar(m.photoURL, undefined, m.email);
          if (bestPhoto && bestPhoto.length > 60) {
            writeTasks.push(writeMemberAvatarToCloud(m.email, bestPhoto));
          }
          if (!isUserLeftKeyMatched(store.leftPartyKeys, pid, m.email)) {
            writeTasks.push(
              writeUserMembershipToCloud(m.email, {
                partyId: pid,
                inviteCode: party.inviteCode,
                displayName: m.displayName,
                photoURL: bestPhoto,
                updatedAtIso: party.updatedAt,
              })
            );
          }
        }
      }

      const rawDrops = (store.dropsByParty[pid] || []).slice(0, 8);
      // Save each drop's full-clarity photo into its own chunked `photo_<dropId>` doc
      // and keep `party_<pid>` metadata lightweight so both party state and photos sync 100% reliably
      for (const d of rawDrops) {
        if (d.id && d.imageUrl && d.imageUrl.length > 200) {
          writeTasks.push(writeDropPhotoToCloud(d.id, d.imageUrl));
        }
      }

      const compactDrops: TrashDropLog[] = rawDrops.map((d) => ({
        ...d,
        userPhotoURL: undefined,
        imageUrl: d.imageUrl && d.imageUrl.length <= 2200 ? d.imageUrl : '',
      }));

      const compactHistory = (store.historyByParty[pid] || []).slice(0, 12).map((h) => ({
        ...h,
        userPhotoURL: undefined,
        imageUrl: undefined,
      }));
      const compactAlerts = (store.alertsByParty[pid] || []).slice(0, 10).map((a) => ({
        ...a,
        senderPhotoURL: undefined,
      }));
      const partyInvitations = (store.invitations || [])
        .filter((i) => i.partyId === pid)
        .slice(0, 12)
        .map((i) => ({
          ...i,
          hostPhotoURL: undefined,
          inviteCode: party.inviteCode,
          partySnapshot: indexCompactParty,
        }));

      writeTasks.push(
        writeCloudDoc(
          `party_${pid}`,
          'PARTY_BUNDLE',
          {
            party: compactParty,
            drops: compactDrops,
            history: compactHistory,
            alerts: compactAlerts,
            invitations: partyInvitations.map((inv) => ({
              ...inv,
              partySnapshot: undefined,
            })),
          },
          options
        )
      );

      // Keep `code_<6CHAR>` strictly < 2,000 bytes (single inline message, identical reliability to email invites)
      if (cleanCode.length >= 4) {
        writeTasks.push(
          writeCloudDoc(
            `code_${cleanCode}`,
            'INVITE_CODE',
            {
              partyId: pid,
              inviteCode: party.inviteCode,
              party: indexCompactParty,
            },
            options
          )
        );
      }

      // Also write per-email invitation inbox docs so invited roommates see their invite immediately
      for (const inv of partyInvitations) {
        if (inv.invitedEmail) {
          const emailDocId = sanitizeEmailForCloudDoc(inv.invitedEmail);
          const allForThisEmail = (store.invitations || [])
            .filter(
              (item) =>
                item.invitedEmail.toLowerCase() === inv.invitedEmail.toLowerCase() &&
                !store.deletedPartyIds.includes(item.partyId)
            )
            .slice(0, 6)
            .map((item) => {
              const p = store.parties[item.partyId];
              return {
                ...item,
                hostPhotoURL: undefined,
                inviteCode: formatSixCharInviteCode(p?.inviteCode || item.inviteCode),
                partySnapshot: p ? compactPartyForCloud(p) : item.partySnapshot,
              };
            });
          writeTasks.push(
            writeCloudDoc(
              emailDocId,
              'INVITATIONS',
              { invitations: allForThisEmail },
              options
            )
          );
        }
      }
    }

    const existingGlobal = await readCloudDoc<{
      codeMap?: Record<string, string>;
      userPartyMap?: Record<string, string>;
      parties?: Record<string, PartyState>;
      invitations?: HouseholdInvitation[];
      deletedPartyIds?: string[];
      leftPartyKeys?: string[];
    }>('global_index');

    const mergedDeleted = Array.from(
      new Set([...(existingGlobal?.deletedPartyIds || []), ...(store.deletedPartyIds || [])])
    ).slice(-60);
    const rawMergedLeft = Array.from(
      new Set([...(existingGlobal?.leftPartyKeys || []), ...(store.leftPartyKeys || [])])
    );

    // Strip any stale leftPartyKey from existingGlobal if the member is currently active in a local party
    // and NOT marked as left in local store.leftPartyKeys (e.g., they rejoined with the 6-digit invite code!)
    const mergedLeft = rawMergedLeft
      .filter((lk) => {
        if (targetPartyId && options?.rejoinedEmail) {
          const cleanRejoined = options.rejoinedEmail.trim().toLowerCase();
          if (
            lk === `${targetPartyId}:${cleanRejoined}` ||
            lk === `${cleanRejoined}:${targetPartyId}`
          ) {
            return false;
          }
        }
        for (const [pid, localParty] of Object.entries(store.parties)) {
          if (!localParty || isFakeStubParty(localParty) || mergedDeleted.includes(pid)) continue;
          for (const m of localParty.members || []) {
            const mEmail = (m.email || '').trim().toLowerCase();
            if (!mEmail) continue;
            const isMatchingKey = lk === `${pid}:${mEmail}` || lk === `${mEmail}:${pid}`;
            if (isMatchingKey && !isUserLeftKeyMatched(store.leftPartyKeys || [], pid, mEmail)) {
              return false;
            }
          }
        }
        return true;
      })
      .slice(-60);

    store.deletedPartyIds = mergedDeleted;
    store.leftPartyKeys = mergedLeft;

    const mergedParties: Record<string, PartyState> = {};
    const mergedCodeMap: Record<string, string> = { ...(existingGlobal?.codeMap || {}) };
    const mergedUserPartyMap: Record<string, string> = { ...(existingGlobal?.userPartyMap || {}) };

    for (const [pid, rp] of Object.entries(existingGlobal?.parties || {})) {
      if (!rp || isFakeStubParty(rp) || mergedDeleted.includes(pid)) continue;
      const compacted = compactPartyForCloud(rp, { stripAvatarsForIndex: true });
      mergedParties[pid] = compacted;
      const cCode = cleanAlphanumericCode(compacted.inviteCode);
      if (cCode.length >= 4) mergedCodeMap[cCode] = pid;
      for (const m of compacted.members || []) {
        if (m.email && !isUserLeftKeyMatched(mergedLeft, pid, m.email)) {
          mergedUserPartyMap[m.email.trim().toLowerCase()] = pid;
        }
      }
    }
    for (const [pid, localParty] of Object.entries(store.parties)) {
      if (!localParty || isFakeStubParty(localParty) || mergedDeleted.includes(pid)) continue;
      const compactLocal = compactPartyForCloud(localParty, { stripAvatarsForIndex: true });
      if (mergedParties[pid]) {
        mergedParties[pid] = compactPartyForCloud(
          mergePartyStates(mergedParties[pid], compactLocal, mergedLeft),
          { stripAvatarsForIndex: true }
        );
      } else {
        mergedParties[pid] = compactLocal;
      }
      const cCode = cleanAlphanumericCode(mergedParties[pid].inviteCode);
      if (cCode.length >= 4) mergedCodeMap[cCode] = pid;
      for (const m of mergedParties[pid].members || []) {
        if (m.email && !isUserLeftKeyMatched(mergedLeft, pid, m.email)) {
          mergedUserPartyMap[m.email.trim().toLowerCase()] = pid;
        }
      }
    }

    // Remove any deleted or left parties from codeMap and userPartyMap
    for (const [cCode, pid] of Object.entries(mergedCodeMap)) {
      if (mergedDeleted.includes(pid)) {
        delete mergedCodeMap[cCode];
      }
    }
    for (const [uEmail, pid] of Object.entries(mergedUserPartyMap)) {
      if (mergedDeleted.includes(pid) || isUserLeftKeyMatched(mergedLeft, pid, uEmail)) {
        delete mergedUserPartyMap[uEmail];
      }
    }

    const invMap = new Map<string, HouseholdInvitation>();
    for (const inv of [...(existingGlobal?.invitations || []), ...(store.invitations || [])]) {
      if (!inv || !inv.id || mergedDeleted.includes(inv.partyId)) continue;
      const prev = invMap.get(inv.id);
      const hostParty = store.parties[inv.partyId] || mergedParties[inv.partyId];
      if (!prev || inv.status !== 'PENDING') {
        invMap.set(inv.id, {
          ...inv,
          hostPhotoURL: undefined,
          inviteCode: formatSixCharInviteCode(hostParty?.inviteCode || inv.inviteCode),
          partySnapshot: hostParty ? compactPartyForCloud(hostParty) : inv.partySnapshot,
        });
      }
    }
    const mergedInvitations = Array.from(invMap.values()).slice(0, 25);

    writeTasks.push(
      writeCloudDoc(
        'global_index',
        'GLOBAL_INDEX',
        {
          codeMap: mergedCodeMap,
          userPartyMap: mergedUserPartyMap,
          parties: mergedParties,
          invitations: mergedInvitations.map((inv) => ({
            ...inv,
            partySnapshot: undefined,
          })),
          deletedPartyIds: mergedDeleted,
          leftPartyKeys: mergedLeft,
        },
        options
      ),
      writeCloudDoc(
        'invitations_all',
        'INVITATIONS',
        {
          invitations: mergedInvitations,
        },
        options
      )
    );

    await Promise.allSettled(writeTasks);
  } catch {
    // ignore transient network errors
  }
}

/**
 * Ensures that if a user already has an active party in local/server memory,
 * its `party_<ID>` and `code_<6CHAR>` are published to the cloud at least once per session
 * so roommates can always join using its 6-character code.
 */
export async function ensurePartyPublishedToCloud(
  store: CloudSyncStoreLike,
  partyId?: string | null
): Promise<void> {
  if (!partyId || store.deletedPartyIds.includes(partyId)) return;
  const party = store.parties[partyId];
  if (!party || isFakeStubParty(party)) return;
  if (publishedActivePartyIdsInSession.has(partyId)) return;
  publishedActivePartyIdsInSession.add(partyId);
  await pushPartyStoreToCloud(store, partyId, { forceWrite: true });
}

/**
 * Fast, timeout-bounded sync between the local/server store and our Dual-Engine Cloud Store.
 */
export async function syncStoreWithCloud(
  store: CloudSyncStoreLike,
  opts?: {
    email?: string;
    partyId?: string;
    inviteCode?: string;
    forceFresh?: boolean;
  }
): Promise<void> {
  const runSync = async () => {
    try {
      // Purge any fake stub parties first
      for (const [pid, p] of Object.entries(store.parties)) {
        if (isFakeStubParty(p)) {
          delete store.parties[pid];
        }
      }

      const forceFresh = Boolean(opts?.forceFresh || opts?.inviteCode);

      if (opts?.inviteCode) {
        await pullPartyByInviteCodeFromCloud(store, opts.inviteCode, { forceFresh: true });
      }

      const activePid = opts?.partyId;
      const cleanEmail = String(opts?.email || '').trim().toLowerCase();

      const [
        globalDoc,
        bundleDoc,
        emailInvitesDoc,
        allInvitesDoc,
        userMembershipDoc,
        userAvatarDoc,
      ] = await Promise.all([
        readCloudDoc<{
          codeMap?: Record<string, string>;
          userPartyMap?: Record<string, string>;
          parties?: Record<string, PartyState>;
          invitations?: HouseholdInvitation[];
          deletedPartyIds?: string[];
          leftPartyKeys?: string[];
        }>('global_index', { forceFresh }),
        activePid && !store.deletedPartyIds.includes(activePid)
          ? readCloudDoc<{
              party: PartyState;
              drops?: TrashDropLog[];
              history?: TurnHistoryRecord[];
              alerts?: PartyAlertItem[];
              invitations?: HouseholdInvitation[];
            }>(`party_${activePid}`, { forceFresh })
          : Promise.resolve(null),
        cleanEmail
          ? readCloudDoc<{ invitations?: HouseholdInvitation[] }>(
              sanitizeEmailForCloudDoc(cleanEmail),
              { forceFresh }
            )
          : Promise.resolve(null),
        readCloudDoc<{ invitations?: HouseholdInvitation[] }>('invitations_all', {
          forceFresh,
        }),
        cleanEmail
          ? readCloudDoc<{
              email: string;
              partyId: string | null;
              inviteCode?: string;
              displayName?: string;
              photoURL?: string;
              updatedAtIso?: string;
            }>(sanitizeUserMembershipDocId(cleanEmail), { forceFresh })
          : Promise.resolve(null),
        cleanEmail
          ? readCloudDoc<{
              email: string;
              photoURL: string;
            }>(sanitizeAvatarDocId(cleanEmail), { forceFresh })
          : Promise.resolve(null),
      ]);

      if (cleanEmail && userAvatarDoc?.photoURL && userAvatarDoc.photoURL.length > 20) {
        setCachedMemberAvatar(cleanEmail, userAvatarDoc.photoURL);
      } else if (cleanEmail && userMembershipDoc?.photoURL && userMembershipDoc.photoURL.length > 20) {
        setCachedMemberAvatar(cleanEmail, userMembershipDoc.photoURL);
      }

      if (globalDoc) {
        if (Array.isArray(globalDoc.deletedPartyIds)) {
          for (const delId of globalDoc.deletedPartyIds) {
            if (!store.deletedPartyIds.includes(delId)) {
              store.deletedPartyIds.push(delId);
            }
            delete store.parties[delId];
          }
        }

        if (Array.isArray(globalDoc.leftPartyKeys)) {
          for (const lk of globalDoc.leftPartyKeys) {
            if (!store.leftPartyKeys.includes(lk)) {
              // Do not import a stale cloud leftPartyKey if the user rejoined their active party
              const isRejoinedActiveMember = Boolean(
                cleanEmail &&
                  ((activePid &&
                    (lk === `${activePid}:${cleanEmail}` || lk === `${cleanEmail}:${activePid}`) &&
                    (userMembershipDoc?.partyId === activePid ||
                      (store.parties[activePid]?.members?.some(
                        (m) => m.email?.toLowerCase() === cleanEmail
                      ) &&
                        !isUserLeftKeyMatched(store.leftPartyKeys, activePid, cleanEmail)))) ||
                    (userMembershipDoc?.partyId &&
                      (lk === `${userMembershipDoc.partyId}:${cleanEmail}` ||
                        lk === `${cleanEmail}:${userMembershipDoc.partyId}`)))
              );
              if (!isRejoinedActiveMember) {
                store.leftPartyKeys.push(lk);
              }
            }
          }
        }

        if (globalDoc.parties) {
          for (const [remotePid, remoteParty] of Object.entries(globalDoc.parties)) {
            if (
              !remoteParty ||
              isFakeStubParty(remoteParty) ||
              store.deletedPartyIds.includes(remotePid)
            ) {
              continue;
            }
            remoteParty.inviteCode = formatSixCharInviteCode(remoteParty.inviteCode);

            if (store.parties[remotePid] && !isFakeStubParty(store.parties[remotePid])) {
              store.parties[remotePid] = mergePartyStates(
                store.parties[remotePid],
                remoteParty,
                store.leftPartyKeys
              );
            } else {
              store.parties[remotePid] = remoteParty;
            }
          }
        }
      }

      // Merge invitations from global_index, invitations_all, and user's personal email inbox
      const combinedInvites = [
        ...(emailInvitesDoc?.invitations || []),
        ...(allInvitesDoc?.invitations || []),
        ...(globalDoc?.invitations || []),
        ...(bundleDoc?.invitations || []),
        ...(store.invitations || []),
      ];
      if (combinedInvites.length > 0) {
        const invMap = new Map<string, HouseholdInvitation>();
        for (const inv of combinedInvites) {
          if (!inv || !inv.id || store.deletedPartyIds.includes(inv.partyId)) continue;
          if (inv.partySnapshot && !isFakeStubParty(inv.partySnapshot)) {
            const snapPid = inv.partySnapshot.id;
            if (!store.parties[snapPid] && !store.deletedPartyIds.includes(snapPid)) {
              store.parties[snapPid] = {
                ...inv.partySnapshot,
                inviteCode: formatSixCharInviteCode(inv.partySnapshot.inviteCode),
              };
            }
          }
          const prev = invMap.get(inv.id);
          if (!prev || inv.status !== 'PENDING') {
            invMap.set(inv.id, {
              ...inv,
              inviteCode: formatSixCharInviteCode(inv.inviteCode),
            });
          }
        }
        store.invitations = Array.from(invMap.values());
      }

      if (
        activePid &&
        bundleDoc?.party &&
        !isFakeStubParty(bundleDoc.party) &&
        !store.deletedPartyIds.includes(activePid)
      ) {
        store.parties[activePid] =
          store.parties[activePid] && !isFakeStubParty(store.parties[activePid])
            ? mergePartyStates(store.parties[activePid], bundleDoc.party, store.leftPartyKeys)
            : bundleDoc.party;
        if (Array.isArray(bundleDoc.drops)) {
          store.dropsByParty[activePid] = mergePartyDrops(
            store.dropsByParty[activePid],
            bundleDoc.drops
          );
          await hydratePartyDropPhotosFromCloud(store, activePid);
        }
        if (
          Array.isArray(bundleDoc.history) &&
          bundleDoc.history.length > (store.historyByParty[activePid]?.length || 0)
        ) {
          store.historyByParty[activePid] = bundleDoc.history;
        }
        if (
          Array.isArray(bundleDoc.alerts) &&
          bundleDoc.alerts.length > (store.alertsByParty[activePid]?.length || 0)
        ) {
          store.alertsByParty[activePid] = bundleDoc.alerts;
        }
        await hydratePartyMemberAvatarsFromCloud(store, activePid);
      } else if (activePid && store.parties[activePid]) {
        await hydratePartyMemberAvatarsFromCloud(store, activePid);
      }

      // If a user signed in on PC/phone without knowing their partyId yet, resolve it from
      // `user_<email>`, `global_index.userPartyMap`, or `store.parties` and pull the full party bundle!
      if (cleanEmail) {
        let candidatePartyId: string | undefined =
          activePid && !store.deletedPartyIds.includes(activePid) ? activePid : undefined;

        if (
          !candidatePartyId &&
          userMembershipDoc?.partyId &&
          !store.deletedPartyIds.includes(userMembershipDoc.partyId) &&
          !isUserLeftKeyMatched(store.leftPartyKeys, userMembershipDoc.partyId, cleanEmail)
        ) {
          candidatePartyId = userMembershipDoc.partyId;
        }

        if (
          !candidatePartyId &&
          globalDoc?.userPartyMap?.[cleanEmail] &&
          !store.deletedPartyIds.includes(globalDoc.userPartyMap[cleanEmail]) &&
          !isUserLeftKeyMatched(
            store.leftPartyKeys,
            globalDoc.userPartyMap[cleanEmail],
            cleanEmail
          )
        ) {
          candidatePartyId = globalDoc.userPartyMap[cleanEmail];
        }

        if (!candidatePartyId) {
          const matchedFromStore = Object.values(store.parties)
            .filter(
              (p) =>
                p &&
                !isFakeStubParty(p) &&
                !store.deletedPartyIds.includes(p.id) &&
                !isUserLeftKeyMatched(store.leftPartyKeys, p.id, cleanEmail) &&
                (p.hostEmail?.toLowerCase() === cleanEmail ||
                  p.members?.some((m) => m.email?.toLowerCase() === cleanEmail))
            )
            .sort(
              (a, b) =>
                new Date(b.updatedAt || b.createdAt || 0).getTime() -
                new Date(a.updatedAt || a.createdAt || 0).getTime()
            )[0];
          if (matchedFromStore) {
            candidatePartyId = matchedFromStore.id;
          }
        }

        if (candidatePartyId) {
          if (candidatePartyId !== activePid || !store.parties[candidatePartyId]) {
            await pullPartyByIdFromCloud(store, candidatePartyId, { forceFresh });
          }
          if (!store.parties[candidatePartyId] && userMembershipDoc?.inviteCode) {
            await pullPartyByInviteCodeFromCloud(store, userMembershipDoc.inviteCode, {
              forceFresh: true,
            });
          }
          // If the cloud confirms the user is in an active party that hasn't been deleted or left,
          // clear any stale local `clearedPartyUsers` entry so the PC loads their phone party!
          if (
            store.parties[candidatePartyId] &&
            !store.deletedPartyIds.includes(candidatePartyId) &&
            !isUserLeftKeyMatched(store.leftPartyKeys, candidatePartyId, cleanEmail) &&
            Array.isArray(store.clearedPartyUsers)
          ) {
            store.clearedPartyUsers = store.clearedPartyUsers.filter((e) => e !== cleanEmail);
          }
        }
      }

      // Ensure any valid active party in store is published to the cloud once per session so its 6-char code is discoverable
      for (const pid of Object.keys(store.parties)) {
        if (
          store.parties[pid] &&
          !isFakeStubParty(store.parties[pid]) &&
          !store.deletedPartyIds.includes(pid) &&
          !publishedActivePartyIdsInSession.has(pid)
        ) {
          ensurePartyPublishedToCloud(store, pid).catch(() => {});
        }
      }
    } catch {
      // ignore offline errors
    }
  };

  await Promise.race([
    runSync(),
    new Promise<void>((resolve) => setTimeout(resolve, 2800)),
  ]);
}
