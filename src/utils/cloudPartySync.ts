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
const NTFY_TOPIC_PREFIX = 'https://ntfy.sh/bd242575ad_v3_';
const CLOUD_TIMEOUT_MS = 2200;
const READ_CACHE_TTL_MS = 4500;

let firestoreWriteQuotaCooldownUntil = 0;
const lastWrittenHashByDocId = new Map<string, string>();
const readCacheByDocId = new Map<string, { value: any; fetchedAt: number }>();
const publishedActivePartyIdsInSession = new Set<string>();

export interface CloudSyncStoreLike {
  parties: Record<string, PartyState>;
  dropsByParty: Record<string, TrashDropLog[]>;
  historyByParty: Record<string, TurnHistoryRecord[]>;
  emailsByParty: Record<string, EmailDispatchLog[]>;
  alertsByParty: Record<string, PartyAlertItem[]>;
  invitations: HouseholdInvitation[];
  deletedPartyIds: string[];
  leftPartyKeys: string[];
}

export function cleanAlphanumericCode(code: string): string {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function sanitizeDocId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 56);
}

export function sanitizeEmailForCloudDoc(email?: string | null): string {
  const clean = String(email || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .slice(0, 44);
  return `inv_${clean}`;
}

/**
 * Strips huge base64 data URLs (>600 chars) from cloud index copies so every
 * party & invite code payload stays < 3KB for instant inline transfer across all devices.
 */
export function compactPartyForCloud(party: PartyState): PartyState {
  return {
    ...party,
    inviteCode: formatSixCharInviteCode(party.inviteCode),
    members: (party.members || []).map((m) => ({
      ...m,
      photoURL:
        m.photoURL && m.photoURL.length > 600 && m.photoURL.startsWith('data:')
          ? undefined
          : m.photoURL,
    })),
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

async function readNtfyDoc<T = any>(safeId: string): Promise<{ value: T | null; updatedAtMs: number }> {
  try {
    const res = await fetchWithTimeout(`${NTFY_TOPIC_PREFIX}${safeId}/json?poll=1&since=48h`);
    if (!res || !res.ok) return { value: null, updatedAtMs: 0 };
    const text = (await res.text()).trim();
    if (!text) return { value: null, updatedAtMs: 0 };

    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.event !== 'message') continue;
        const tsMs = (Number(evt.time) || 0) * 1000;

        let rawPayloadStr: string | null = null;
        if (evt.attachment?.url) {
          const attRes = await fetchWithTimeout(String(evt.attachment.url));
          if (attRes && attRes.ok) {
            rawPayloadStr = await attRes.text();
          }
        } else if (typeof evt.message === 'string' && evt.message.trim().startsWith('{')) {
          rawPayloadStr = evt.message;
        }

        if (rawPayloadStr) {
          const parsedWrapper = JSON.parse(rawPayloadStr);
          if (parsedWrapper && parsedWrapper.__deleted === true) {
            return { value: null, updatedAtMs: tsMs };
          }
          if (parsedWrapper && parsedWrapper.payload !== undefined) {
            const updatedMs = parsedWrapper.updatedAtIso
              ? new Date(parsedWrapper.updatedAtIso).getTime()
              : tsMs;
            return { value: parsedWrapper.payload as T, updatedAtMs: updatedMs };
          }
          return { value: parsedWrapper as T, updatedAtMs: tsMs };
        }
      } catch {
        // try earlier message
      }
    }
  } catch {
    // ignore network errors
  }
  return { value: null, updatedAtMs: 0 };
}

async function readFirestoreDoc<T = any>(safeId: string): Promise<{ value: T | null; updatedAtMs: number }> {
  try {
    const res = await fetchWithTimeout(`${FIRESTORE_REST_BASE}/${safeId}`);
    if (!res || !res.ok) return { value: null, updatedAtMs: 0 };
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
  kind: 'GLOBAL_INDEX' | 'PARTY_BUNDLE' | 'INVITE_CODE' | 'INVITATIONS' | 'PUSH_SUBS',
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

  // 1. Write to Ntfy Realtime JSON Relay (always available even when Firestore daily quota is exhausted)
  const ntfyWrapper = JSON.stringify({
    docId: safeId,
    kind,
    updatedAtIso: nowIso,
    payload,
  });
  if (ntfyWrapper.length < 180000) {
    tasks.push(
      fetchWithTimeout(`${NTFY_TOPIC_PREFIX}${safeId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
        },
        body: ntfyWrapper,
      })
    );
  }

  // 2. Write to Cloud Firestore REST (unless in 429 quota cooldown)
  if (Date.now() > firestoreWriteQuotaCooldownUntil) {
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
          firestoreWriteQuotaCooldownUntil = Date.now() + 5 * 60 * 1000;
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

  if (Date.now() > firestoreWriteQuotaCooldownUntil) {
    tasks.push(
      fetchWithTimeout(`${FIRESTORE_REST_BASE}/${safeId}`, {
        method: 'DELETE',
      })
    );
  }

  await Promise.allSettled(tasks);
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
      mergedMembersMap.set(key, { ...m });
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
        photoURL: m.photoURL || prev.photoURL,
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
 * Pulls a specific party by its 6-character invite code from our Dual-Engine Cloud Store
 * (`code_<6CHAR>`, `party_<ID>`, `global_index`, and `invitations_all`) and merges it into the store.
 */
export async function pullPartyByInviteCodeFromCloud(
  store: CloudSyncStoreLike,
  rawInviteCode: string,
  options?: { forceFresh?: boolean }
): Promise<PartyState | null> {
  const cleanCode = cleanAlphanumericCode(rawInviteCode);
  if (cleanCode.length < 4) return null;

  const forceFresh = options?.forceFresh ?? true;

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

    if (partyBundle?.drops && !store.dropsByParty[pid]?.length) {
      store.dropsByParty[pid] = partyBundle.drops;
    }
    if (partyBundle?.history && !store.historyByParty[pid]?.length) {
      store.historyByParty[pid] = partyBundle.history;
    }
    if (partyBundle?.alerts && !store.alertsByParty[pid]?.length) {
      store.alertsByParty[pid] = partyBundle.alerts;
    }
    return store.parties[pid];
  }

  // 2. Match from `global_index.parties`
  if (globalDoc?.parties) {
    for (const remoteParty of Object.values(globalDoc.parties)) {
      if (
        remoteParty &&
        !isFakeStubParty(remoteParty) &&
        !store.deletedPartyIds.includes(remoteParty.id) &&
        doesInviteCodeMatch(remoteParty.inviteCode, cleanCode)
      ) {
        const pid = remoteParty.id;
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
      const partyBundle = await readCloudDoc<{
        party: PartyState;
      }>(`party_${inv.partyId}`, { forceFresh });

      const foundParty = partyBundle?.party || inv.partySnapshot;
      if (foundParty && !isFakeStubParty(foundParty)) {
        foundParty.inviteCode = formatSixCharInviteCode(foundParty.inviteCode);
        store.parties[foundParty.id] =
          store.parties[foundParty.id] && !isFakeStubParty(store.parties[foundParty.id])
            ? mergePartyStates(store.parties[foundParty.id], foundParty, store.leftPartyKeys)
            : foundParty;
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
  options?: { forceFresh?: boolean }
): Promise<PartyState | null> {
  if (!partyId || store.deletedPartyIds.includes(partyId)) return null;
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
    if (partyBundle.drops && !store.dropsByParty[partyId]?.length) {
      store.dropsByParty[partyId] = partyBundle.drops;
    }
    if (partyBundle.history && !store.historyByParty[partyId]?.length) {
      store.historyByParty[partyId] = partyBundle.history;
    }
    if (partyBundle.alerts && !store.alertsByParty[partyId]?.length) {
      store.alertsByParty[partyId] = partyBundle.alerts;
    }
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
 * Pushes a specific party, its 6-character invite code (`code_<6CHAR>`), any per-email invitations,
 * and the global index to our Dual-Engine Cloud Store.
 */
export async function pushPartyStoreToCloud(
  store: CloudSyncStoreLike,
  targetPartyId?: string,
  options?: { forceWrite?: boolean }
): Promise<void> {
  try {
    // Purge any fake stub parties before syncing
    for (const [pid, p] of Object.entries(store.parties)) {
      if (isFakeStubParty(p)) {
        delete store.parties[pid];
      }
    }

    const partyIds = targetPartyId
      ? [targetPartyId]
      : Object.keys(store.parties)
          .filter((id) => !store.deletedPartyIds.includes(id) && !isFakeStubParty(store.parties[id]))
          .slice(0, 8);

    const writeTasks: Promise<void>[] = [];

    for (const pid of partyIds) {
      const party = store.parties[pid];
      if (!party || isFakeStubParty(party) || store.deletedPartyIds.includes(pid)) continue;
      party.inviteCode = formatSixCharInviteCode(party.inviteCode);
      const cleanCode = cleanAlphanumericCode(party.inviteCode);
      const compactParty = compactPartyForCloud(party);

      const compactDrops = (store.dropsByParty[pid] || []).slice(0, 8).map((d) => ({
        ...d,
        imageUrl: d.imageUrl && d.imageUrl.length > 60000 ? d.imageUrl.slice(0, 60000) : d.imageUrl,
      }));
      const compactHistory = (store.historyByParty[pid] || []).slice(0, 15).map((h) => ({
        ...h,
        imageUrl: undefined,
      }));
      const compactAlerts = (store.alertsByParty[pid] || []).slice(0, 15);
      const partyInvitations = (store.invitations || [])
        .filter((i) => i.partyId === pid)
        .map((i) => ({
          ...i,
          inviteCode: party.inviteCode,
          partySnapshot: compactParty,
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
            invitations: partyInvitations,
          },
          options
        )
      );

      if (cleanCode.length >= 4) {
        writeTasks.push(
          writeCloudDoc(
            `code_${cleanCode}`,
            'INVITE_CODE',
            {
              partyId: pid,
              inviteCode: party.inviteCode,
              party: compactParty,
              alerts: compactAlerts,
              invitations: partyInvitations,
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
            .map((item) => {
              const p = store.parties[item.partyId];
              return {
                ...item,
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
      parties?: Record<string, PartyState>;
      invitations?: HouseholdInvitation[];
      deletedPartyIds?: string[];
      leftPartyKeys?: string[];
    }>('global_index');

    const mergedDeleted = Array.from(
      new Set([...(existingGlobal?.deletedPartyIds || []), ...(store.deletedPartyIds || [])])
    );
    const mergedLeft = Array.from(
      new Set([...(existingGlobal?.leftPartyKeys || []), ...(store.leftPartyKeys || [])])
    );

    store.deletedPartyIds = mergedDeleted;
    store.leftPartyKeys = mergedLeft;

    const mergedParties: Record<string, PartyState> = {};
    for (const [pid, rp] of Object.entries(existingGlobal?.parties || {})) {
      if (!rp || isFakeStubParty(rp) || mergedDeleted.includes(pid)) continue;
      mergedParties[pid] = compactPartyForCloud(rp);
    }
    for (const [pid, localParty] of Object.entries(store.parties)) {
      if (!localParty || isFakeStubParty(localParty) || mergedDeleted.includes(pid)) continue;
      const compactLocal = compactPartyForCloud(localParty);
      if (mergedParties[pid]) {
        mergedParties[pid] = compactPartyForCloud(
          mergePartyStates(mergedParties[pid], compactLocal, mergedLeft)
        );
      } else {
        mergedParties[pid] = compactLocal;
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
          inviteCode: formatSixCharInviteCode(hostParty?.inviteCode || inv.inviteCode),
          partySnapshot: hostParty ? compactPartyForCloud(hostParty) : inv.partySnapshot,
        });
      }
    }
    const mergedInvitations = Array.from(invMap.values()).slice(0, 60);

    writeTasks.push(
      writeCloudDoc(
        'global_index',
        'GLOBAL_INDEX',
        {
          parties: mergedParties,
          invitations: mergedInvitations,
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

      const [globalDoc, bundleDoc, emailInvitesDoc, allInvitesDoc] = await Promise.all([
        readCloudDoc<{
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
      ]);

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
              store.leftPartyKeys.push(lk);
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
        if (
          Array.isArray(bundleDoc.drops) &&
          bundleDoc.drops.length > (store.dropsByParty[activePid]?.length || 0)
        ) {
          store.dropsByParty[activePid] = bundleDoc.drops;
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
    new Promise<void>((resolve) => setTimeout(resolve, 2400)),
  ]);
}
