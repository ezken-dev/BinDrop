import { doc, getDoc, getDocFromServer, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
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

const CLOUD_COLLECTION = 'bindrop_cloud';

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

async function readCloudDoc<T = any>(docId: string): Promise<T | null> {
  const safeId = sanitizeDocId(docId);
  const ref = doc(db, CLOUD_COLLECTION, safeId);
  try {
    const snap = await getDocFromServer(ref);
    if (!snap.exists()) return null;
    const raw = snap.data()?.payloadJson;
    if (typeof raw === 'string' && raw.length > 0) {
      return JSON.parse(raw) as T;
    }
    return null;
  } catch {
    try {
      const fallbackSnap = await getDoc(ref);
      if (!fallbackSnap.exists()) return null;
      const raw = fallbackSnap.data()?.payloadJson;
      if (typeof raw === 'string' && raw.length > 0) {
        return JSON.parse(raw) as T;
      }
    } catch {
      // ignore offline error
    }
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
    await setDoc(doc(db, CLOUD_COLLECTION, safeId), {
      docId: safeId,
      kind,
      payloadJson,
      updatedAtIso: new Date().toISOString(),
    });
  } catch {
    // ignore transient network errors
  }
}

/**
 * Merges two PartyState objects that share the same party ID or 6-character invite code,
 * ensuring that Host role, members who joined from other devices, and turn state are preserved.
 */
export function mergePartyStates(existing: PartyState, incoming: PartyState): PartyState {
  const existingTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
  const incomingTime = new Date(incoming.updatedAt || incoming.createdAt || 0).getTime();
  const primary = incomingTime >= existingTime ? { ...incoming } : { ...existing };
  const secondary = incomingTime >= existingTime ? existing : incoming;

  // If one party has a real Host and the other was a code-join stub, prefer the real Host metadata
  const existingIsStub = existing.id.startsWith('party_code_') && existing.name.startsWith('Household ');
  const incomingIsStub = incoming.id.startsWith('party_code_') && incoming.name.startsWith('Household ');

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
  // Ensure exactly one HOST matches primary.hostEmail or primary.hostId
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
    primary.currentTurnUserId = primary.members[primary.currentTurnIndex]?.uid || primary.members[0].uid;
  }

  return primary;
}

/**
 * Pulls a specific party by its 6-character invite code from Cloud Firestore
 * and merges it into the local store.
 */
export async function pullPartyByInviteCodeFromCloud(
  store: CloudSyncStoreLike,
  rawInviteCode: string
): Promise<PartyState | null> {
  const cleanCode = cleanAlphanumericCode(rawInviteCode);
  if (cleanCode.length < 4) return null;

  // 1. Check direct invite code document: bindrop_cloud/code_{CLEAN6CHAR}
  const codeDoc = await readCloudDoc<{
    partyId: string;
    inviteCode: string;
    party: PartyState;
    drops?: TrashDropLog[];
    history?: TurnHistoryRecord[];
    alerts?: PartyAlertItem[];
    invitations?: HouseholdInvitation[];
  }>(`code_${cleanCode}`);

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
      store.parties[pid] = mergePartyStates(store.parties[pid], remoteParty);
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

  // 2. Also check global_index in case party was indexed there
  const globalDoc = await readCloudDoc<{
    parties?: Record<string, PartyState>;
    invitations?: HouseholdInvitation[];
    deletedPartyIds?: string[];
  }>('global_index');

  if (globalDoc?.parties) {
    for (const remoteParty of Object.values(globalDoc.parties)) {
      if (
        remoteParty &&
        !store.deletedPartyIds.includes(remoteParty.id) &&
        doesInviteCodeMatch(remoteParty.inviteCode, cleanCode)
      ) {
        remoteParty.inviteCode = formatSixCharInviteCode(remoteParty.inviteCode);
        store.parties[remoteParty.id] = store.parties[remoteParty.id]
          ? mergePartyStates(store.parties[remoteParty.id], remoteParty)
          : remoteParty;
        return store.parties[remoteParty.id];
      }
    }
  }

  return null;
}

/**
 * Pushes a specific party and all its invitations/codes up to Cloud Firestore
 * so any other phone, PC, or static host (`bindrop.netlify.app`) can immediately join or sync.
 */
export async function pushPartyStoreToCloud(
  store: CloudSyncStoreLike,
  targetPartyId?: string
): Promise<void> {
  const partyIds = targetPartyId
    ? [targetPartyId]
    : Object.keys(store.parties).filter((id) => !store.deletedPartyIds.includes(id));

  for (const pid of partyIds) {
    const party = store.parties[pid];
    if (!party || store.deletedPartyIds.includes(pid)) continue;
    party.inviteCode = formatSixCharInviteCode(party.inviteCode);
    const cleanCode = cleanAlphanumericCode(party.inviteCode);

    // Strip huge base64 data URLs from cloud index if needed to keep under Firestore 1MB limit
    const compactDrops = (store.dropsByParty[pid] || []).slice(0, 12);
    const compactHistory = (store.historyByParty[pid] || []).slice(0, 25);
    const compactAlerts = (store.alertsByParty[pid] || []).slice(0, 25);
    const partyInvitations = (store.invitations || []).filter((i) => i.partyId === pid);

    await Promise.all([
      writeCloudDoc(`party_${pid}`, 'PARTY_BUNDLE', {
        party,
        drops: compactDrops,
        history: compactHistory,
        alerts: compactAlerts,
        invitations: partyInvitations,
      }),
      cleanCode.length >= 4
        ? writeCloudDoc(`code_${cleanCode}`, 'INVITE_CODE', {
            partyId: pid,
            inviteCode: party.inviteCode,
            party,
            alerts: compactAlerts,
            invitations: partyInvitations,
          })
        : Promise.resolve(),
    ]);
  }

  // Also sync global_index and invitations_all
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

  const mergedParties: Record<string, PartyState> = {
    ...(existingGlobal?.parties || {}),
  };
  for (const delId of mergedDeleted) {
    delete mergedParties[delId];
  }
  for (const [pid, localParty] of Object.entries(store.parties)) {
    if (!localParty || mergedDeleted.includes(pid)) continue;
    if (mergedParties[pid]) {
      mergedParties[pid] = mergePartyStates(mergedParties[pid], localParty);
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

  await Promise.all([
    writeCloudDoc('global_index', 'GLOBAL_INDEX', {
      parties: mergedParties,
      invitations: mergedInvitations,
      deletedPartyIds: mergedDeleted,
      leftPartyKeys: mergedLeft,
    }),
    writeCloudDoc('invitations_all', 'INVITATIONS', {
      invitations: mergedInvitations,
    }),
  ]);
}

/**
 * Bidirectional sync between the local store and Cloud Firestore.
 * Ensures that:
 * 1. Any party created on another device is pulled into `store.parties`
 * 2. Any party created locally before or after this update is pushed to `bindrop_cloud/code_{CODE}`
 * 3. If two devices have a party with the same 6-character `inviteCode` (e.g. `MUT-HJZ`), their rosters are merged!
 */
export async function syncStoreWithCloud(
  store: CloudSyncStoreLike,
  opts?: { email?: string; partyId?: string; inviteCode?: string }
): Promise<void> {
  try {
    if (opts?.inviteCode) {
      await pullPartyByInviteCodeFromCloud(store, opts.inviteCode);
    }

    const globalDoc = await readCloudDoc<{
      parties?: Record<string, PartyState>;
      invitations?: HouseholdInvitation[];
      deletedPartyIds?: string[];
      leftPartyKeys?: string[];
    }>('global_index');

    if (globalDoc) {
      if (Array.isArray(globalDoc.deletedPartyIds)) {
        for (const delId of globalDoc.deletedPartyIds) {
          if (!store.deletedPartyIds.includes(delId)) {
            store.deletedPartyIds.push(delId);
          }
          delete store.parties[delId];
        }
      }

      if (globalDoc.parties) {
        for (const [remotePid, remoteParty] of Object.entries(globalDoc.parties)) {
          if (!remoteParty || store.deletedPartyIds.includes(remotePid)) continue;
          remoteParty.inviteCode = formatSixCharInviteCode(remoteParty.inviteCode);

          // Check if local store has a party with the exact same 6-char invite code under a different ID
          const sameCodeLocalParty = Object.values(store.parties).find(
            (lp) =>
              lp &&
              !store.deletedPartyIds.includes(lp.id) &&
              doesInviteCodeMatch(lp.inviteCode, remoteParty.inviteCode)
          );

          if (sameCodeLocalParty && sameCodeLocalParty.id !== remotePid) {
            const merged = mergePartyStates(sameCodeLocalParty, remoteParty);
            // Prefer non-stub party ID
            const canonicalId = sameCodeLocalParty.id.startsWith('party_code_')
              ? remotePid
              : sameCodeLocalParty.id;
            merged.id = canonicalId;
            store.parties[canonicalId] = merged;
            if (canonicalId !== sameCodeLocalParty.id) {
              delete store.parties[sameCodeLocalParty.id];
            }
          } else if (store.parties[remotePid]) {
            store.parties[remotePid] = mergePartyStates(store.parties[remotePid], remoteParty);
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

    // Pull detailed bundle for the active partyId if available
    const activePid = opts?.partyId;
    if (activePid && !store.deletedPartyIds.includes(activePid)) {
      const bundleDoc = await readCloudDoc<{
        party: PartyState;
        drops?: TrashDropLog[];
        history?: TurnHistoryRecord[];
        alerts?: PartyAlertItem[];
        invitations?: HouseholdInvitation[];
      }>(`party_${activePid}`);

      if (bundleDoc?.party) {
        store.parties[activePid] = store.parties[activePid]
          ? mergePartyStates(store.parties[activePid], bundleDoc.party)
          : bundleDoc.party;
        if (Array.isArray(bundleDoc.drops) && bundleDoc.drops.length > (store.dropsByParty[activePid]?.length || 0)) {
          store.dropsByParty[activePid] = bundleDoc.drops;
        }
        if (Array.isArray(bundleDoc.history) && bundleDoc.history.length > (store.historyByParty[activePid]?.length || 0)) {
          store.historyByParty[activePid] = bundleDoc.history;
        }
        if (Array.isArray(bundleDoc.alerts) && bundleDoc.alerts.length > (store.alertsByParty[activePid]?.length || 0)) {
          store.alertsByParty[activePid] = bundleDoc.alerts;
        }
      }
    }

    // Push any local parties/codes to Cloud Firestore so other devices can find them by 6-char code
    if (Object.keys(store.parties).length > 0 || store.invitations.length > 0) {
      await pushPartyStoreToCloud(store, activePid);
    }
  } catch {
    // ignore offline errors
  }
}
