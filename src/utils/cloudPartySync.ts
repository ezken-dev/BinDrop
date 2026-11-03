import {
  doesInviteCodeMatch,
  formatSixCharInviteCode,
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
const CLOUD_TIMEOUT_MS = 1800;

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

function cleanAlphanumericCode(code: string): string {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function sanitizeDocId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
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

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = CLOUD_TIMEOUT_MS): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readCloudDoc<T = any>(docId: string): Promise<T | null> {
  const safeId = sanitizeDocId(docId);
  try {
    const res = await fetchWithTimeout(`${FIRESTORE_REST_BASE}/${safeId}`);
    if (!res || !res.ok) return null;
    const data = (await res.json()) as any;
    const raw = data?.fields?.payloadJson?.stringValue;
    if (typeof raw === 'string' && raw.length > 0) {
      return JSON.parse(raw) as T;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCloudDoc(
  docId: string,
  kind: 'GLOBAL_INDEX' | 'PARTY_BUNDLE' | 'INVITE_CODE' | 'INVITATIONS' | 'PUSH_SUBS',
  payload: unknown
): Promise<void> {
  const safeId = sanitizeDocId(docId);
  const payloadJson = JSON.stringify(payload);
  if (payloadJson.length > 940000) return;
  try {
    await fetchWithTimeout(`${FIRESTORE_REST_BASE}/${safeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          docId: { stringValue: safeId },
          kind: { stringValue: kind },
          payloadJson: { stringValue: payloadJson },
          updatedAtIso: { stringValue: new Date().toISOString() },
        },
      }),
    });
  } catch {
    // ignore transient network errors
  }
}

async function deleteCloudDoc(docId: string): Promise<void> {
  const safeId = sanitizeDocId(docId);
  try {
    await fetchWithTimeout(`${FIRESTORE_REST_BASE}/${safeId}`, {
      method: 'DELETE',
    });
  } catch {
    // ignore
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
  const existingTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
  const incomingTime = new Date(incoming.updatedAt || incoming.createdAt || 0).getTime();
  const primary = incomingTime >= existingTime ? { ...incoming } : { ...existing };
  const secondary = incomingTime >= existingTime ? existing : incoming;

  const existingIsStub =
    existing.id.startsWith('party_code_') && existing.name.startsWith('Household ');
  const incomingIsStub =
    incoming.id.startsWith('party_code_') && incoming.name.startsWith('Household ');

  if (existingIsStub && !incomingIsStub) {
    primary.name = incoming.name;
    primary.hostId = incoming.hostId;
    primary.hostEmail = incoming.hostEmail;
    primary.rotationIntervalHours = incoming.rotationIntervalHours;
  } else if (incomingIsStub && !existingIsStub) {
    primary.name = existing.name;
    primary.hostId = existing.hostId;
    primary.hostEmail = existing.hostEmail;
    primary.rotationIntervalHours = existing.rotationIntervalHours;
  }

  const mergedMembersMap = new Map<string, HouseholdMember>();
  for (const m of [...(primary.members || []), ...(secondary.members || [])]) {
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
        m.uid === primary.hostId ||
        m.email.toLowerCase() === (primary.hostEmail || '').toLowerCase() ||
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
 * Pulls a specific party by its 6-character invite code from Cloud Firestore
 * and merges it into the local store. Bounded by fast REST timeouts so it never hangs.
 */
export async function pullPartyByInviteCodeFromCloud(
  store: CloudSyncStoreLike,
  rawInviteCode: string
): Promise<PartyState | null> {
  const cleanCode = cleanAlphanumericCode(rawInviteCode);
  if (cleanCode.length < 4) return null;

  const [codeDoc, globalDoc] = await Promise.all([
    readCloudDoc<{
      partyId: string;
      inviteCode: string;
      party: PartyState;
      drops?: TrashDropLog[];
      history?: TurnHistoryRecord[];
      alerts?: PartyAlertItem[];
      invitations?: HouseholdInvitation[];
    }>(`code_${cleanCode}`),
    readCloudDoc<{
      parties?: Record<string, PartyState>;
      invitations?: HouseholdInvitation[];
      deletedPartyIds?: string[];
      leftPartyKeys?: string[];
    }>('global_index'),
  ]);

  if (globalDoc?.deletedPartyIds) {
    for (const delId of globalDoc.deletedPartyIds) {
      if (!store.deletedPartyIds.includes(delId)) {
        store.deletedPartyIds.push(delId);
      }
      delete store.parties[delId];
    }
  }

  if (codeDoc && codeDoc.party && !store.deletedPartyIds.includes(codeDoc.party.id)) {
    const pid = codeDoc.party.id;
    const partyBundle = await readCloudDoc<{
      party: PartyState;
      drops?: TrashDropLog[];
      history?: TurnHistoryRecord[];
      alerts?: PartyAlertItem[];
      invitations?: HouseholdInvitation[];
    }>(`party_${pid}`);

    const remoteParty = partyBundle?.party || codeDoc.party;
    remoteParty.inviteCode = formatSixCharInviteCode(remoteParty.inviteCode);

    if (store.parties[pid]) {
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

  if (globalDoc?.parties) {
    for (const remoteParty of Object.values(globalDoc.parties)) {
      if (
        remoteParty &&
        !store.deletedPartyIds.includes(remoteParty.id) &&
        doesInviteCodeMatch(remoteParty.inviteCode, cleanCode)
      ) {
        remoteParty.inviteCode = formatSixCharInviteCode(remoteParty.inviteCode);
        store.parties[remoteParty.id] = store.parties[remoteParty.id]
          ? mergePartyStates(
              store.parties[remoteParty.id],
              remoteParty,
              store.leftPartyKeys
            )
          : remoteParty;
        return store.parties[remoteParty.id];
      }
    }
  }

  return null;
}

/**
 * Permanently removes deleted parties and their invite codes from Cloud Firestore
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
    await pushPartyStoreToCloud(store);
  } catch {
    // ignore
  }
}

/**
 * Pushes a specific party (or top active parties) and global index to Cloud Firestore
 * using parallel bounded REST calls so it never blocks UI interactions.
 */
export async function pushPartyStoreToCloud(
  store: CloudSyncStoreLike,
  targetPartyId?: string
): Promise<void> {
  try {
    const partyIds = targetPartyId
      ? [targetPartyId]
      : Object.keys(store.parties)
          .filter((id) => !store.deletedPartyIds.includes(id))
          .slice(0, 6);

    const writeTasks: Promise<void>[] = [];

    for (const pid of partyIds) {
      const party = store.parties[pid];
      if (!party || store.deletedPartyIds.includes(pid)) continue;
      party.inviteCode = formatSixCharInviteCode(party.inviteCode);
      const cleanCode = cleanAlphanumericCode(party.inviteCode);

      const compactDrops = (store.dropsByParty[pid] || []).slice(0, 12);
      const compactHistory = (store.historyByParty[pid] || []).slice(0, 25);
      const compactAlerts = (store.alertsByParty[pid] || []).slice(0, 25);
      const partyInvitations = (store.invitations || []).filter((i) => i.partyId === pid);

      writeTasks.push(
        writeCloudDoc(`party_${pid}`, 'PARTY_BUNDLE', {
          party,
          drops: compactDrops,
          history: compactHistory,
          alerts: compactAlerts,
          invitations: partyInvitations,
        })
      );

      if (cleanCode.length >= 4) {
        writeTasks.push(
          writeCloudDoc(`code_${cleanCode}`, 'INVITE_CODE', {
            partyId: pid,
            inviteCode: party.inviteCode,
            party,
            alerts: compactAlerts,
            invitations: partyInvitations,
          })
        );
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

    const mergedParties: Record<string, PartyState> = {
      ...(existingGlobal?.parties || {}),
    };
    for (const delId of mergedDeleted) {
      delete mergedParties[delId];
      delete store.parties[delId];
    }
    for (const [pid, localParty] of Object.entries(store.parties)) {
      if (!localParty || mergedDeleted.includes(pid)) continue;
      if (mergedParties[pid]) {
        mergedParties[pid] = mergePartyStates(mergedParties[pid], localParty, mergedLeft);
      } else {
        mergedParties[pid] = localParty;
      }
    }

    const invMap = new Map<string, HouseholdInvitation>();
    for (const inv of [...(existingGlobal?.invitations || []), ...(store.invitations || [])]) {
      if (!inv || !inv.id || mergedDeleted.includes(inv.partyId)) continue;
      const prev = invMap.get(inv.id);
      if (!prev || inv.status !== 'PENDING') {
        invMap.set(inv.id, {
          ...inv,
          inviteCode: formatSixCharInviteCode(inv.inviteCode),
        });
      }
    }
    const mergedInvitations = Array.from(invMap.values()).slice(0, 100);

    writeTasks.push(
      writeCloudDoc('global_index', 'GLOBAL_INDEX', {
        parties: mergedParties,
        invitations: mergedInvitations,
        deletedPartyIds: mergedDeleted,
        leftPartyKeys: mergedLeft,
      }),
      writeCloudDoc('invitations_all', 'INVITATIONS', {
        invitations: mergedInvitations,
      })
    );

    await Promise.allSettled(writeTasks);
  } catch {
    // ignore transient network errors
  }
}

/**
 * Fast, timeout-bounded sync between the local store and Cloud Firestore.
 */
export async function syncStoreWithCloud(
  store: CloudSyncStoreLike,
  opts?: { email?: string; partyId?: string; inviteCode?: string }
): Promise<void> {
  const runSync = async () => {
    try {
      if (opts?.inviteCode) {
        await pullPartyByInviteCodeFromCloud(store, opts.inviteCode);
      }

      const activePid = opts?.partyId;
      const [globalDoc, bundleDoc] = await Promise.all([
        readCloudDoc<{
          parties?: Record<string, PartyState>;
          invitations?: HouseholdInvitation[];
          deletedPartyIds?: string[];
          leftPartyKeys?: string[];
        }>('global_index'),
        activePid && !store.deletedPartyIds.includes(activePid)
          ? readCloudDoc<{
              party: PartyState;
              drops?: TrashDropLog[];
              history?: TurnHistoryRecord[];
              alerts?: PartyAlertItem[];
              invitations?: HouseholdInvitation[];
            }>(`party_${activePid}`)
          : Promise.resolve(null),
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
            if (!remoteParty || store.deletedPartyIds.includes(remotePid)) continue;
            remoteParty.inviteCode = formatSixCharInviteCode(remoteParty.inviteCode);

            const sameCodeLocalParty = Object.values(store.parties).find(
              (lp) =>
                lp &&
                !store.deletedPartyIds.includes(lp.id) &&
                doesInviteCodeMatch(lp.inviteCode, remoteParty.inviteCode)
            );

            if (sameCodeLocalParty && sameCodeLocalParty.id !== remotePid) {
              const merged = mergePartyStates(
                sameCodeLocalParty,
                remoteParty,
                store.leftPartyKeys
              );
              const canonicalId = sameCodeLocalParty.id.startsWith('party_code_')
                ? remotePid
                : sameCodeLocalParty.id;
              merged.id = canonicalId;
              store.parties[canonicalId] = merged;
              if (canonicalId !== sameCodeLocalParty.id) {
                delete store.parties[sameCodeLocalParty.id];
              }
            } else if (store.parties[remotePid]) {
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

        if (Array.isArray(globalDoc.invitations)) {
          const invMap = new Map<string, HouseholdInvitation>();
          for (const inv of [...globalDoc.invitations, ...(store.invitations || [])]) {
            if (!inv || !inv.id || store.deletedPartyIds.includes(inv.partyId)) continue;
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
      }

      if (activePid && bundleDoc?.party && !store.deletedPartyIds.includes(activePid)) {
        store.parties[activePid] = store.parties[activePid]
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
    } catch {
      // ignore offline errors
    }
  };

  await Promise.race([
    runSync(),
    new Promise<void>((resolve) => setTimeout(resolve, 2200)),
  ]);
}
