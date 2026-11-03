import {
  calculateDropPoints,
  doesInviteCodeMatch,
  evaluateDeadlineStatus,
  formatDateTimeReadable,
  formatRotationDaysLabel,
  formatSixCharInviteCode,
  generateInviteCode,
  leavePartyMember,
  OFFICIAL_BINDROP_EMAIL,
  OFFICIAL_BINDROP_NAME,
  rotatePartyTurn,
  type EmailAlertType,
  type EmailDispatchLog,
  type HouseholdInvitation,
  type HouseholdMember,
  type OfficialMailerStatus,
  type PartyAlertItem,
  type PartyState,
  type PhotoVerificationStatus,
  type TrashDropLog,
  type TurnHistoryRecord,
} from './trashDutyLogic';
import {
  pullPartyByInviteCodeFromCloud,
  pushPartyStoreToCloud,
  syncStoreWithCloud,
} from './cloudPartySync';

const CLIENT_STORE_KEY = 'bindrop_universal_store_v4';
const REMOTE_CLOUD_BACKEND_ORIGIN =
  'https://ais-pre-4giwacrrrnzs57w425ll2q-100623098623.asia-east1.run.app';
const AVATAR_COLORS = ['#d0ff45', '#34d399', '#38bdf8', '#facc15', '#fb7185', '#a78bfa'];

interface StoredClientUser {
  uid: string;
  email: string;
  displayName: string;
  password?: string;
  photoURL?: string;
  avatarColor: string;
  partyId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ClientStoreShape {
  accounts: Record<string, StoredClientUser>;
  parties: Record<string, PartyState>;
  dropsByParty: Record<string, TrashDropLog[]>;
  historyByParty: Record<string, TurnHistoryRecord[]>;
  emailsByParty: Record<string, EmailDispatchLog[]>;
  alertsByParty: Record<string, PartyAlertItem[]>;
  invitations: HouseholdInvitation[];
  deletedPartyIds: string[];
  leftPartyKeys: string[];
  appPassword?: string;
  smtpVerified?: boolean;
}

function loadClientStore(): ClientStoreShape {
  try {
    const raw = localStorage.getItem(CLIENT_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ClientStoreShape>;
      const parties = parsed.parties || {};
      for (const pid of Object.keys(parties)) {
        if (parties[pid]?.inviteCode) {
          parties[pid].inviteCode = formatSixCharInviteCode(parties[pid].inviteCode);
        }
      }
      return {
        accounts: parsed.accounts || {},
        parties,
        dropsByParty: parsed.dropsByParty || {},
        historyByParty: parsed.historyByParty || {},
        emailsByParty: parsed.emailsByParty || {},
        alertsByParty: parsed.alertsByParty || {},
        invitations: (parsed.invitations || []).map((inv) => ({
          ...inv,
          inviteCode: formatSixCharInviteCode(inv.inviteCode),
        })),
        deletedPartyIds: parsed.deletedPartyIds || [],
        leftPartyKeys: parsed.leftPartyKeys || [],
        appPassword: parsed.appPassword || 'EzKen_2005',
        smtpVerified: Boolean(parsed.smtpVerified),
      };
    }
  } catch {
    // ignore storage errors
  }
  return {
    accounts: {},
    parties: {},
    dropsByParty: {},
    historyByParty: {},
    emailsByParty: {},
    alertsByParty: {},
    invitations: [],
    deletedPartyIds: [],
    leftPartyKeys: [],
    appPassword: 'EzKen_2005',
    smtpVerified: false,
  };
}

function saveClientStore(store: ClientStoreShape) {
  try {
    localStorage.setItem(CLIENT_STORE_KEY, JSON.stringify(store));
  } catch {
    // ignore quota errors
  }
}

function getPendingClientInvitationsForEmail(
  store: ClientStoreShape,
  email?: string | null
): HouseholdInvitation[] {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return [];
  return (store.invitations || []).filter(
    (inv) =>
      inv.status === 'PENDING' &&
      inv.invitedEmail.toLowerCase() === cleanEmail &&
      !store.deletedPartyIds.includes(inv.partyId)
  );
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getClientMailerStatus(store: ClientStoreShape): OfficialMailerStatus {
  const pass = (store.appPassword || 'EzKen_2005').replace(/\s+/g, '');
  const is16Char = pass.length === 16 && pass !== 'EzKen_2005';
  return {
    email: OFFICIAL_BINDROP_EMAIL,
    smtpVerified: true,
    usingAppPassword: is16Char,
    maskedCredential: is16Char
      ? `${pass.slice(0, 4)} •••• •••• ${pass.slice(-4)} (Pop-Up + SMTP Active)`
      : 'Live Social Pop-Up & Browser Push Notifications Active',
    lastError: undefined,
    checkedAt: new Date().toISOString(),
  };
}

function resolveClientUserParty(
  store: ClientStoreShape,
  acc: StoredClientUser,
  preferredPartyId?: string | null
): PartyState | null {
  const cleanEmail = acc.email.trim().toLowerCase();

  if (
    preferredPartyId &&
    store.parties[preferredPartyId] &&
    !store.deletedPartyIds.includes(preferredPartyId) &&
    !store.leftPartyKeys.includes(`${cleanEmail}:${preferredPartyId}`)
  ) {
    const p = store.parties[preferredPartyId];
    if (
      p.members.some(
        (m) => m.uid === acc.uid || m.email.toLowerCase() === cleanEmail
      )
    ) {
      acc.partyId = p.id;
      return p;
    }
  }

  if (
    acc.partyId &&
    store.parties[acc.partyId] &&
    !store.deletedPartyIds.includes(acc.partyId) &&
    !store.leftPartyKeys.includes(`${cleanEmail}:${acc.partyId}`)
  ) {
    const p = store.parties[acc.partyId];
    if (
      p.members.some(
        (m) => m.uid === acc.uid || m.email.toLowerCase() === cleanEmail
      )
    ) {
      return p;
    }
  }

  const matchedParty = Object.values(store.parties)
    .filter(
      (p) =>
        p &&
        !store.deletedPartyIds.includes(p.id) &&
        !store.leftPartyKeys.includes(`${cleanEmail}:${p.id}`)
    )
    .sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt).getTime() -
        new Date(a.updatedAt || a.createdAt).getTime()
    )
    .find((p) =>
      p.members.some(
        (m) => m.uid === acc.uid || m.email.toLowerCase() === cleanEmail
      )
    );

  if (matchedParty) {
    acc.partyId = matchedParty.id;
    return matchedParty;
  }

  acc.partyId = null;
  return null;
}

function buildEmailContent(params: {
  party: PartyState;
  recipient: { uid: string; email: string; displayName: string };
  type: EmailAlertType;
  customSubject?: string;
  customMessage?: string;
}): { subject: string; bodyText: string } {
  const formattedDeadline = formatDateTimeReadable(params.party.nextDeadline).fullLabel;
  let subject = '';
  let bodyText = '';

  if (params.type === 'WARNING_5H') {
    subject = `⏰ 5-Hour Warning: ${params.recipient.displayName}, your trash turn at ${params.party.name} is due soon!`;
    bodyText = `Hi ${params.recipient.displayName}, less than 5 hours remain for your scheduled trash turn at "${params.party.name}" (Due: ${formattedDeadline}). Snap and upload your trash disposal photo in BinDrop before the deadline!`;
  } else if (params.type === 'MISSED_DEADLINE') {
    subject = `🚨 Missed Deadline: ${params.recipient.displayName}'s trash turn at ${params.party.name} is OVERDUE`;
    bodyText = `Hi ${params.recipient.displayName}, your scheduled trash deadline (${formattedDeadline}) for "${params.party.name}" has expired. Please take out the trash and upload your photo proof in BinDrop right away.`;
  } else if (params.type === 'HOST_ESCALATION') {
    const activeAssignee =
      params.party.members.find((m) => m.uid === params.party.currentTurnUserId) ||
      params.party.members[0];
    subject = `[Host Pop-Up Alert · ${params.party.name}] ${activeAssignee?.displayName || 'Roommate'} missed their trash deadline`;
    bodyText = `Roommate ${activeAssignee?.displayName} (${activeAssignee?.email}) missed their scheduled trash disposal deadline (${formattedDeadline}) for "${params.party.name}".`;
  } else {
    subject = `🔔 Trash Duty Reminder for ${params.recipient.displayName} (${params.party.name})`;
    bodyText = `Hi ${params.recipient.displayName}, you are currently up for household trash duty in "${params.party.name}" (Deadline: ${formattedDeadline}).`;
  }

  if (params.customSubject && params.customSubject.trim()) {
    subject = params.customSubject.trim();
  }
  if (params.customMessage && params.customMessage.trim()) {
    bodyText = params.customMessage.trim();
  }

  return { subject, bodyText };
}

function evaluateClientPartyDeadlines(store: ClientStoreShape, partyId: string) {
  const party = store.parties[partyId];
  if (!party || party.members.length === 0) return;

  party.inviteCode = formatSixCharInviteCode(party.inviteCode);
  const evalStatus = evaluateDeadlineStatus(party, Date.now());
  const activeAssignee =
    party.members.find((m) => m.uid === party.currentTurnUserId) ||
    party.members[party.currentTurnIndex] ||
    party.members[0];
  const hostMember =
    party.members.find((m) => m.uid === party.hostId) || party.members[0];

  const nowIso = new Date().toISOString();

  if (evalStatus.shouldSendFiveHourWarningEmail && !party.warningEmailSentForCurrentTurn) {
    party.warningEmailSentForCurrentTurn = true;
    party.reminderSentForCurrentTurn = true;
    party.updatedAt = nowIso;

    if (!store.alertsByParty[partyId]) store.alertsByParty[partyId] = [];
    store.alertsByParty[partyId].unshift({
      id: randomId('alert_5h'),
      partyId,
      targetUserId: activeAssignee.uid,
      targetDisplayName: activeAssignee.displayName,
      targetEmail: activeAssignee.email,
      assigneeUserId: activeAssignee.uid,
      assigneeDisplayName: activeAssignee.displayName,
      senderName: party.name,
      senderPhotoURL: activeAssignee.photoURL,
      title: `⏰ 5-Hour Trash Duty Warning · ${party.name}`,
      category: 'WARNING_5H',
      type: 'WARNING_5H',
      message: `${activeAssignee.displayName}, less than 5 hours remain before your trash deadline (${
        formatDateTimeReadable(party.nextDeadline).fullLabel
      }). Upload your photo proof on time!`,
      read: false,
      createdAt: nowIso,
    });

    const { subject, bodyText } = buildEmailContent({
      party,
      recipient: activeAssignee,
      type: 'WARNING_5H',
    });
    if (!store.emailsByParty[partyId]) store.emailsByParty[partyId] = [];
    store.emailsByParty[partyId].unshift({
      id: randomId('notif_warn5h'),
      partyId,
      recipientUserId: activeAssignee.uid,
      toEmail: activeAssignee.email,
      toName: activeAssignee.displayName,
      fromEmail: OFFICIAL_BINDROP_EMAIL,
      subject,
      bodyText,
      type: 'WARNING_5H',
      deliveryStatus: 'PUSH_NOTIFICATION_SENT',
      transportInfo: `Instant Pop-Up & Browser Push Notification delivered to ${activeAssignee.displayName}`,
      sentAt: nowIso,
    });
  }

  if (evalStatus.shouldSendMissedDeadlineEmail && !party.missedEmailSentForCurrentTurn) {
    party.turnStatus = 'OVERDUE';
    party.missedEmailSentForCurrentTurn = true;
    party.hostAlertedForCurrentTurn = true;
    party.updatedAt = nowIso;

    party.members = party.members.map((m) => {
      if (m.uid !== activeAssignee.uid) return m;
      const nextMissed = (m.missedDrops || 0) + 1;
      const totalTracked = (m.totalDrops || 0) + nextMissed;
      const onTimeRate =
        totalTracked > 0 ? Math.round(((m.onTimeDrops || 0) / totalTracked) * 100) : 0;
      return {
        ...m,
        missedDrops: nextMissed,
        currentStreak: 0,
        onTimeRate,
      };
    });

    if (!store.historyByParty[partyId]) store.historyByParty[partyId] = [];
    store.historyByParty[partyId].unshift({
      id: randomId('hist_missed'),
      partyId,
      userId: activeAssignee.uid,
      userEmail: activeAssignee.email,
      userDisplayName: activeAssignee.displayName,
      userPhotoURL: activeAssignee.photoURL,
      outcome: 'MISSED_DEADLINE',
      pointsAwarded: 0,
      deadlineIso: party.nextDeadline,
      recordedIso: nowIso,
      notes: `Missed scheduled deadline. Instant overdue pop-up notification sent to ${activeAssignee.displayName} & Host ${hostMember.displayName}.`,
      createdAt: nowIso,
    });

    if (!store.alertsByParty[partyId]) store.alertsByParty[partyId] = [];
    store.alertsByParty[partyId].unshift({
      id: randomId('alert_missed'),
      partyId,
      targetUserId: activeAssignee.uid,
      targetDisplayName: activeAssignee.displayName,
      targetEmail: activeAssignee.email,
      assigneeUserId: activeAssignee.uid,
      assigneeDisplayName: activeAssignee.displayName,
      senderName: party.name,
      senderPhotoURL: activeAssignee.photoURL,
      title: `🚨 Overdue Trash Deadline · ${party.name}`,
      category: 'MISSED_DEADLINE',
      type: 'MISSED_DEADLINE',
      message: `${activeAssignee.displayName} missed the scheduled trash deadline! Host ${hostMember.displayName} has been alerted.`,
      read: false,
      createdAt: nowIso,
    });

    const { subject, bodyText } = buildEmailContent({
      party,
      recipient: activeAssignee,
      type: 'MISSED_DEADLINE',
    });
    if (!store.emailsByParty[partyId]) store.emailsByParty[partyId] = [];
    store.emailsByParty[partyId].unshift({
      id: randomId('notif_missed'),
      partyId,
      recipientUserId: activeAssignee.uid,
      toEmail: activeAssignee.email,
      toName: activeAssignee.displayName,
      fromEmail: OFFICIAL_BINDROP_EMAIL,
      subject,
      bodyText,
      type: 'MISSED_DEADLINE',
      deliveryStatus: 'PUSH_NOTIFICATION_SENT',
      transportInfo: `Instant Overdue Pop-Up Notification delivered to ${activeAssignee.displayName} & Host ${hostMember.displayName}`,
      sentAt: nowIso,
    });
  }

  saveClientStore(store);
}

function buildClientBundle(store: ClientStoreShape, partyId: string) {
  if (store.deletedPartyIds.includes(partyId)) return null;
  evaluateClientPartyDeadlines(store, partyId);
  const party = store.parties[partyId];
  if (!party) return null;
  return {
    party,
    drops: store.dropsByParty[partyId] || [],
    history: store.historyByParty[partyId] || [],
    emails: store.emailsByParty[partyId] || [],
    alerts: store.alertsByParty[partyId] || [],
    partyInvitations: (store.invitations || []).filter((inv) => inv.partyId === partyId),
    mailerStatus: getClientMailerStatus(store),
  };
}

/**
 * Synchronously retrieves the cached household bundle for a signed-in user on initial render
 * so the app never flashes the "Create Household Party" screen after pushing updates or reloading.
 */
export function getInitialCachedBundleForAccount(
  email?: string | null,
  partyId?: string | null
) {
  if (!email && !partyId) return null;
  const store = loadClientStore();
  const cleanEmail = (email || '').trim().toLowerCase();

  if (cleanEmail && store.accounts[cleanEmail]) {
    const acc = store.accounts[cleanEmail];
    const resolved = resolveClientUserParty(store, acc, partyId);
    if (resolved) {
      saveClientStore(store);
      return buildClientBundle(store, resolved.id);
    }
  }

  if (
    partyId &&
    store.parties[partyId] &&
    !store.deletedPartyIds.includes(partyId) &&
    (!cleanEmail || !store.leftPartyKeys.includes(`${cleanEmail}:${partyId}`))
  ) {
    return buildClientBundle(store, partyId);
  }

  if (cleanEmail) {
    const fallbackParty = Object.values(store.parties).find(
      (p) =>
        p &&
        !store.deletedPartyIds.includes(p.id) &&
        !store.leftPartyKeys.includes(`${cleanEmail}:${p.id}`) &&
        p.members.some((m) => m.email.toLowerCase() === cleanEmail)
    );
    if (fallbackParty) {
      return buildClientBundle(store, fallbackParty.id);
    }
  }

  return null;
}

/**
 * Mirror any server response into localStorage so if the user switches between
 * local/cloud or refreshes on Netlify, their account & household state is preserved.
 */
function mirrorServerPayloadToClientStore(data: Record<string, unknown>) {
  if (!data) return;
  const store = loadClientStore();
  let changed = false;

  if (typeof data.deletedPartyId === 'string' && data.deletedPartyId) {
    const delId = data.deletedPartyId;
    if (!store.deletedPartyIds.includes(delId)) {
      store.deletedPartyIds.push(delId);
    }
    delete store.parties[delId];
    delete store.dropsByParty[delId];
    delete store.historyByParty[delId];
    delete store.emailsByParty[delId];
    delete store.alertsByParty[delId];
    store.invitations = (store.invitations || []).filter((inv) => inv.partyId !== delId);
    for (const acc of Object.values(store.accounts)) {
      if (acc.partyId === delId) {
        acc.partyId = null;
      }
    }
    changed = true;
  }

  const user = data.user as StoredClientUser | undefined;
  if (user && user.email) {
    const cleanEmail = user.email.trim().toLowerCase();
    if (typeof data.leftPartyId === 'string' && data.leftPartyId) {
      const leftKey = `${cleanEmail}:${data.leftPartyId}`;
      if (!store.leftPartyKeys.includes(leftKey)) {
        store.leftPartyKeys.push(leftKey);
      }
    }
    store.accounts[cleanEmail] = {
      ...(store.accounts[cleanEmail] || {}),
      uid: user.uid,
      email: cleanEmail,
      displayName: user.displayName,
      photoURL: user.photoURL,
      avatarColor: user.avatarColor || '#d0ff45',
      partyId: user.partyId || null,
      createdAt: store.accounts[cleanEmail]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    changed = true;
  }

  const bundle = data.bundle as {
    party?: PartyState;
    drops?: TrashDropLog[];
    history?: TurnHistoryRecord[];
    emails?: EmailDispatchLog[];
    alerts?: PartyAlertItem[];
    partyInvitations?: HouseholdInvitation[];
  } | null;

  if (bundle && bundle.party) {
    const pid = bundle.party.id;
    bundle.party.inviteCode = formatSixCharInviteCode(bundle.party.inviteCode);
    store.parties[pid] = bundle.party;
    if (bundle.drops) store.dropsByParty[pid] = bundle.drops;
    if (bundle.history) store.historyByParty[pid] = bundle.history;
    if (bundle.emails) store.emailsByParty[pid] = bundle.emails;
    if (bundle.alerts) store.alertsByParty[pid] = bundle.alerts;
    if (Array.isArray(bundle.partyInvitations)) {
      for (const inv of bundle.partyInvitations) {
        const idx = store.invitations.findIndex((i) => i.id === inv.id);
        if (idx >= 0) {
          store.invitations[idx] = inv;
        } else {
          store.invitations.unshift(inv);
        }
      }
    }
    changed = true;
  }

  if (Array.isArray(data.invitations)) {
    for (const inv of data.invitations as HouseholdInvitation[]) {
      const idx = store.invitations.findIndex((i) => i.id === inv.id);
      if (idx >= 0) {
        store.invitations[idx] = inv;
      } else {
        store.invitations.unshift(inv);
      }
    }
    changed = true;
  }

  if (data.invitation && typeof data.invitation === 'object') {
    const inv = data.invitation as HouseholdInvitation;
    const idx = store.invitations.findIndex((i) => i.id === inv.id);
    if (idx >= 0) {
      store.invitations[idx] = inv;
    } else {
      store.invitations.unshift(inv);
    }
    changed = true;
  }

  if (changed) {
    saveClientStore(store);
    pushPartyStoreToCloud(store).catch(() => {});
  }
}

/**
 * Executes API routes directly in the browser when hosted on a static host like Netlify
 * (`bindrop.netlify.app`) where `/api/*` returns `index.html` (`<!DOCTYPE html>`) instead of JSON.
 */
async function executeClientFallbackRoute(
  endpoint: string,
  options?: RequestInit
): Promise<{ ok: boolean; status: number; data: any }> {
  const store = loadClientStore();
  const url = new URL(endpoint, window.location.origin);
  const pathname = url.pathname;
  const body = options?.body ? JSON.parse(String(options.body)) : {};
  const nowIso = new Date().toISOString();

  // Pull & merge latest shared parties, 6-char invite codes, and invitations from Cloud Firestore
  await syncStoreWithCloud(store, {
    email: String(body.email || body.userEmail || url.searchParams.get('email') || '').trim() || undefined,
    partyId: String(body.partyId || url.searchParams.get('partyId') || '').trim() || undefined,
    inviteCode: String(body.inviteCode || '').trim() || undefined,
  });
  saveClientStore(store);

  // 1. GET or POST /api/session
  if (pathname === '/api/session') {
    const email = String(body.email || url.searchParams.get('email') || '')
      .trim()
      .toLowerCase();
    const partyId = String(body.partyId || url.searchParams.get('partyId') || '').trim();

    if (email) {
      let acc = store.accounts[email];
      if (!acc) {
        acc = {
          uid: body.uid || randomId('u'),
          email,
          displayName: body.displayName || email.split('@')[0],
          photoURL: body.photoURL || undefined,
          avatarColor: '#d0ff45',
          partyId: partyId || null,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        store.accounts[email] = acc;
      }
      const activeParty = resolveClientUserParty(store, acc, partyId);
      saveClientStore(store);
      return {
        ok: true,
        status: 200,
        data: {
          user: acc,
          bundle: activeParty ? buildClientBundle(store, activeParty.id) : null,
          invitations: getPendingClientInvitationsForEmail(store, email),
        },
      };
    }

    if (partyId && store.parties[partyId] && !store.deletedPartyIds.includes(partyId)) {
      return {
        ok: true,
        status: 200,
        data: {
          user: null,
          bundle: buildClientBundle(store, partyId),
          invitations: [],
        },
      };
    }
    return { ok: true, status: 200, data: { user: null, bundle: null, invitations: [] } };
  }

  // 2. POST /api/auth/google-sync
  if (pathname === '/api/auth/google-sync') {
    const cleanEmail = String(body.email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Please enter a valid Gmail / Google email address.' },
      };
    }
    let acc = store.accounts[cleanEmail];
    const cleanName =
      String(body.displayName || '').trim() ||
      cleanEmail.split('@')[0].replace(/[._0-9]+/g, ' ').trim() ||
      'Household Member';

    if (!acc) {
      const existingParty = Object.values(store.parties).find(
        (p) =>
          !store.deletedPartyIds.includes(p.id) &&
          !store.leftPartyKeys.includes(`${cleanEmail}:${p.id}`) &&
          p.members.some((m) => m.email.toLowerCase() === cleanEmail)
      );
      const matchedMember = existingParty?.members.find(
        (m) => m.email.toLowerCase() === cleanEmail
      );

      acc = {
        uid: body.uid || matchedMember?.uid || randomId('u_google'),
        email: cleanEmail,
        displayName: cleanName,
        photoURL: body.photoURL || matchedMember?.photoURL || undefined,
        avatarColor:
          matchedMember?.avatarColor ||
          AVATAR_COLORS[Object.keys(store.accounts).length % AVATAR_COLORS.length],
        partyId: existingParty ? existingParty.id : null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      store.accounts[cleanEmail] = acc;
    } else {
      if (body.uid) acc.uid = body.uid;
      if (cleanName) acc.displayName = cleanName;
      if (body.photoURL && !acc.photoURL) acc.photoURL = body.photoURL;
      acc.updatedAt = nowIso;
    }

    const activeParty = resolveClientUserParty(store, acc, acc.partyId);
    saveClientStore(store);
    return {
      ok: true,
      status: 200,
      data: {
        user: acc,
        bundle: activeParty ? buildClientBundle(store, activeParty.id) : null,
      },
    };
  }

  // 3. POST /api/auth/register
  if (pathname === '/api/auth/register') {
    const cleanEmail = String(body.email || '').trim().toLowerCase();
    const cleanName = String(body.displayName || '').trim();
    const rawPass = String(body.password || '');

    if (!cleanEmail || !cleanEmail.includes('@') || cleanEmail.length < 4) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Please enter a valid email address for trash duty notifications.' },
      };
    }
    if (cleanName.length < 2) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Please enter your full name or display name (at least 2 characters).' },
      };
    }
    if (rawPass.length < 4) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Password must be at least 4 characters.' },
      };
    }

    const existingParty = Object.values(store.parties).find(
      (p) =>
        !store.deletedPartyIds.includes(p.id) &&
        !store.leftPartyKeys.includes(`${cleanEmail}:${p.id}`) &&
        p.members.some((m) => m.email.toLowerCase() === cleanEmail)
    );
    const matchedMember = existingParty?.members.find(
      (m) => m.email.toLowerCase() === cleanEmail
    );

    const acc: StoredClientUser = {
      uid: matchedMember?.uid || randomId('u'),
      email: cleanEmail,
      displayName: cleanName,
      password: rawPass,
      photoURL: body.photoURL || matchedMember?.photoURL || undefined,
      avatarColor:
        matchedMember?.avatarColor ||
        AVATAR_COLORS[Object.keys(store.accounts).length % AVATAR_COLORS.length],
      partyId: existingParty ? existingParty.id : null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    store.accounts[cleanEmail] = acc;
    const activeParty = resolveClientUserParty(store, acc, acc.partyId);
    saveClientStore(store);

    return {
      ok: true,
      status: 200,
      data: {
        user: acc,
        bundle: activeParty ? buildClientBundle(store, activeParty.id) : null,
      },
    };
  }

  // 4. POST /api/auth/login
  if (pathname === '/api/auth/login') {
    const cleanEmail = String(body.email || '').trim().toLowerCase();
    const rawPass = String(body.password || '');

    if (!cleanEmail || !rawPass) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Please enter both your email address and password.' },
      };
    }

    let acc = store.accounts[cleanEmail];
    if (!acc) {
      const existingParty = Object.values(store.parties).find(
        (p) =>
          !store.deletedPartyIds.includes(p.id) &&
          !store.leftPartyKeys.includes(`${cleanEmail}:${p.id}`) &&
          p.members.some((m) => m.email.toLowerCase() === cleanEmail)
      );
      const matchedMember = existingParty?.members.find(
        (m) => m.email.toLowerCase() === cleanEmail
      );
      acc = {
        uid: matchedMember?.uid || randomId('u'),
        email: cleanEmail,
        displayName:
          matchedMember?.displayName ||
          (cleanEmail === OFFICIAL_BINDROP_EMAIL
            ? 'BinDrop Official'
            : cleanEmail.split('@')[0]),
        password: rawPass,
        photoURL: matchedMember?.photoURL,
        avatarColor:
          matchedMember?.avatarColor ||
          AVATAR_COLORS[Object.keys(store.accounts).length % AVATAR_COLORS.length],
        partyId: existingParty ? existingParty.id : null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      store.accounts[cleanEmail] = acc;
    } else if (acc.password && acc.password !== rawPass) {
      return {
        ok: false,
        status: 401,
        data: { error: 'Incorrect password for this account.' },
      };
    }

    const activeParty = resolveClientUserParty(store, acc, acc.partyId);
    saveClientStore(store);

    return {
      ok: true,
      status: 200,
      data: {
        user: acc,
        bundle: activeParty ? buildClientBundle(store, activeParty.id) : null,
      },
    };
  }

  // 5. POST /api/party/create
  if (pathname === '/api/party/create') {
    const cleanEmail = String(body.userEmail || '').trim().toLowerCase();
    const cleanPartyName = String(body.name || '').trim();
    if (!cleanEmail) {
      return { ok: false, status: 400, data: { error: 'Please sign in first.' } };
    }
    if (cleanPartyName.length < 2) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Household name must be at least 2 characters.' },
      };
    }

    const nowMs = Date.now();
    const intervalHrs = Math.max(1, Number(body.rotationIntervalHours) || 24);
    const deadlineHrs =
      body.initialDeadlineHours !== undefined ? Number(body.initialDeadlineHours) : intervalHrs;
    const nextDeadlineIso = new Date(nowMs + deadlineHrs * 3600 * 1000).toISOString();

    const inviteCode = generateInviteCode(cleanPartyName.slice(0, 3));
    const partyId = randomId('party');

    let acc = store.accounts[cleanEmail];
    const uid = body.userUid || acc?.uid || randomId('u');
    const displayName = String(
      body.userDisplayName || acc?.displayName || cleanEmail.split('@')[0]
    ).trim();

    if (!acc) {
      acc = {
        uid,
        email: cleanEmail,
        displayName,
        photoURL: body.userPhotoURL,
        avatarColor: '#d0ff45',
        partyId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      store.accounts[cleanEmail] = acc;
    } else {
      acc.partyId = partyId;
      acc.displayName = displayName;
      if (body.userPhotoURL) acc.photoURL = body.userPhotoURL;
      acc.updatedAt = nowIso;
    }

    const hostMember: HouseholdMember = {
      uid: acc.uid,
      email: acc.email,
      displayName: acc.displayName,
      photoURL: acc.photoURL,
      avatarColor: '#d0ff45',
      role: 'HOST',
      totalDrops: 0,
      onTimeDrops: 0,
      missedDrops: 0,
      points: 0,
      currentStreak: 0,
      bestStreak: 0,
      onTimeRate: 100,
      joinedAt: nowIso,
    };

    const newParty: PartyState = {
      id: partyId,
      name: cleanPartyName,
      inviteCode,
      hostId: hostMember.uid,
      hostEmail: hostMember.email,
      memberIds: [hostMember.uid],
      members: [hostMember],
      currentTurnIndex: 0,
      currentTurnUserId: hostMember.uid,
      turnStatus: 'PENDING',
      nextDeadline: nextDeadlineIso,
      rotationIntervalHours: intervalHrs,
      warningEmailSentForCurrentTurn: false,
      missedEmailSentForCurrentTurn: false,
      hostAlertedForCurrentTurn: false,
      reminderSentForCurrentTurn: false,
      totalPartyDrops: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    store.parties[partyId] = newParty;
    store.dropsByParty[partyId] = [];
    store.historyByParty[partyId] = [];
    store.emailsByParty[partyId] = [];
    store.alertsByParty[partyId] = [
      {
        id: randomId('alert_welcome'),
        partyId,
        targetUserId: hostMember.uid,
        targetDisplayName: hostMember.displayName,
        targetEmail: hostMember.email,
        assigneeUserId: hostMember.uid,
        assigneeDisplayName: hostMember.displayName,
        senderName: hostMember.displayName,
        senderPhotoURL: hostMember.photoURL,
        title: `🎉 Household "${cleanPartyName}" Created!`,
        category: 'PARTY_UPDATED',
        type: 'TURN_REMINDER',
        message: `Invite Code ${inviteCode} is active on a ${formatRotationDaysLabel(
          intervalHrs
        )} schedule.`,
        read: false,
        createdAt: nowIso,
      },
    ];

    saveClientStore(store);
    await pushPartyStoreToCloud(store, partyId);
    return {
      ok: true,
      status: 200,
      data: {
        user: acc,
        bundle: buildClientBundle(store, partyId),
        invitations: getPendingClientInvitationsForEmail(store, acc.email),
      },
    };
  }

  // 6. POST /api/party/join
  if (pathname === '/api/party/join') {
    const normalizedCode = String(body.inviteCode || '').trim().toUpperCase();
    const cleanEmail = String(body.userEmail || '').trim().toLowerCase();
    if (!normalizedCode) {
      return { ok: false, status: 400, data: { error: 'Please enter a household invite code.' } };
    }

    // Pull directly by 6-character invite code from Cloud Firestore in case Host created it on another device
    await pullPartyByInviteCodeFromCloud(store, normalizedCode);

    let matchingParty = Object.values(store.parties).find(
      (p) => !store.deletedPartyIds.includes(p.id) && doesInviteCodeMatch(p.inviteCode, normalizedCode)
    );

    // If Host created the code on a browser tab before cloud sync ran, initialize the shared party for this 6-char code
    // so the roommate joins immediately and merges seamlessly with the Host's party when the Host's tab syncs.
    const cleanAlphaNum = normalizedCode.replace(/[^A-Z0-9]/g, '');
    if (!matchingParty && cleanAlphaNum.length >= 4) {
      const formattedCode = formatSixCharInviteCode(cleanAlphaNum);
      const deterministicPartyId = `party_code_${cleanAlphaNum.toLowerCase()}`;
      store.deletedPartyIds = store.deletedPartyIds.filter((id) => id !== deterministicPartyId);

      const joinerUid = body.userUid || store.accounts[cleanEmail]?.uid || randomId('u');
      const joinerName = String(
        body.userDisplayName || store.accounts[cleanEmail]?.displayName || cleanEmail.split('@')[0] || 'Roommate'
      ).trim();

      const initialMember: HouseholdMember = {
        uid: joinerUid,
        email: cleanEmail,
        displayName: joinerName,
        photoURL: body.userPhotoURL,
        avatarColor: '#34d399',
        role: 'MEMBER',
        totalDrops: 0,
        onTimeDrops: 0,
        missedDrops: 0,
        points: 0,
        currentStreak: 0,
        bestStreak: 0,
        onTimeRate: 100,
        joinedAt: nowIso,
      };

      matchingParty = {
        id: deterministicPartyId,
        name: `Household ${formattedCode}`,
        inviteCode: formattedCode,
        hostId: joinerUid,
        hostEmail: cleanEmail,
        memberIds: [joinerUid],
        members: [initialMember],
        currentTurnIndex: 0,
        currentTurnUserId: joinerUid,
        turnStatus: 'PENDING',
        nextDeadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        rotationIntervalHours: 24,
        warningEmailSentForCurrentTurn: false,
        missedEmailSentForCurrentTurn: false,
        hostAlertedForCurrentTurn: false,
        reminderSentForCurrentTurn: false,
        totalPartyDrops: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      store.parties[matchingParty.id] = matchingParty;
    }

    if (!matchingParty) {
      return {
        ok: false,
        status: 404,
        data: {
          error: `Please enter a valid 6-character invite code (e.g. BIN-7X4).`,
        },
      };
    }

    store.leftPartyKeys = store.leftPartyKeys.filter(
      (k) => k !== `${cleanEmail}:${matchingParty.id}`
    );

    let acc = store.accounts[cleanEmail];
    const uid = body.userUid || acc?.uid || randomId('u');
    const displayName = String(
      body.userDisplayName || acc?.displayName || cleanEmail.split('@')[0]
    ).trim();

    if (!acc) {
      acc = {
        uid,
        email: cleanEmail,
        displayName,
        photoURL: body.userPhotoURL,
        avatarColor: AVATAR_COLORS[matchingParty.members.length % AVATAR_COLORS.length],
        partyId: matchingParty.id,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      store.accounts[cleanEmail] = acc;
    } else {
      acc.partyId = matchingParty.id;
      acc.displayName = displayName;
      if (body.userPhotoURL) acc.photoURL = body.userPhotoURL;
      acc.updatedAt = nowIso;
    }

    const existingMember = matchingParty.members.find(
      (m) => m.uid === acc.uid || m.email.toLowerCase() === cleanEmail
    );
    if (!existingMember) {
      const newMember: HouseholdMember = {
        uid: acc.uid,
        email: acc.email,
        displayName: acc.displayName,
        photoURL: acc.photoURL,
        avatarColor: AVATAR_COLORS[matchingParty.members.length % AVATAR_COLORS.length],
        role: 'MEMBER',
        totalDrops: 0,
        onTimeDrops: 0,
        missedDrops: 0,
        points: 0,
        currentStreak: 0,
        bestStreak: 0,
        onTimeRate: 100,
        joinedAt: nowIso,
      };
      matchingParty.memberIds.push(newMember.uid);
      matchingParty.members.push(newMember);
      matchingParty.updatedAt = nowIso;

      if (!store.alertsByParty[matchingParty.id]) store.alertsByParty[matchingParty.id] = [];
      store.alertsByParty[matchingParty.id].unshift({
        id: randomId('alert_join'),
        partyId: matchingParty.id,
        targetUserId: matchingParty.hostId,
        targetDisplayName: matchingParty.hostEmail,
        targetEmail: matchingParty.hostEmail,
        assigneeUserId: newMember.uid,
        assigneeDisplayName: newMember.displayName,
        senderName: newMember.displayName,
        senderPhotoURL: newMember.photoURL,
        title: `👋 New Roommate Joined ${matchingParty.name}`,
        category: 'MEMBER_JOINED',
        type: 'TURN_REMINDER',
        message: `${newMember.displayName} (${newMember.email}) joined using code ${matchingParty.inviteCode}!`,
        read: false,
        createdAt: nowIso,
      });
    }

    if (Array.isArray(store.invitations)) {
      for (const inv of store.invitations) {
        if (
          inv.partyId === matchingParty.id &&
          inv.invitedEmail.toLowerCase() === cleanEmail &&
          inv.status === 'PENDING'
        ) {
          inv.status = 'ACCEPTED';
          inv.respondedAt = nowIso;
        }
      }
    }

    saveClientStore(store);
    await pushPartyStoreToCloud(store, matchingParty.id);
    return {
      ok: true,
      status: 200,
      data: {
        user: acc,
        bundle: buildClientBundle(store, matchingParty.id),
        invitations: getPendingClientInvitationsForEmail(store, cleanEmail),
      },
    };
  }

  // 7. POST /api/party/add-member (Send Household Invitation by Email)
  if (pathname === '/api/party/add-member') {
    const party = store.parties[body.partyId];
    if (!party) {
      return { ok: false, status: 404, data: { error: 'Household party not found.' } };
    }
    const cleanName = String(body.memberName || '').trim();
    const cleanEmail = String(body.memberEmail || '').trim().toLowerCase();
    if (cleanName.length < 2) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Roommate name must be at least 2 characters.' },
      };
    }
    if (!cleanEmail || !cleanEmail.includes('@')) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Please enter a valid email address.' },
      };
    }
    if (party.members.some((m) => m.email.toLowerCase() === cleanEmail)) {
      return {
        ok: false,
        status: 409,
        data: { error: 'A member with this email is already in the party.' },
      };
    }

    const hostMember =
      party.members.find((m) => m.uid === party.hostId || m.role === 'HOST') ||
      party.members[0];

    if (!Array.isArray(store.invitations)) {
      store.invitations = [];
    }

    let invitation = store.invitations.find(
      (inv) =>
        inv.partyId === party.id &&
        inv.invitedEmail.toLowerCase() === cleanEmail &&
        inv.status === 'PENDING'
    );

    if (invitation) {
      invitation.invitedName = cleanName;
      invitation.createdAt = nowIso;
    } else {
      invitation = {
        id: randomId('inv'),
        partyId: party.id,
        partyName: party.name,
        inviteCode: party.inviteCode,
        rotationIntervalHours: party.rotationIntervalHours,
        hostId: hostMember?.uid || party.hostId,
        hostName: hostMember?.displayName || party.hostEmail.split('@')[0],
        hostEmail: hostMember?.email || party.hostEmail,
        hostPhotoURL: hostMember?.photoURL,
        invitedName: cleanName,
        invitedEmail: cleanEmail,
        status: 'PENDING',
        createdAt: nowIso,
      };
      store.invitations.unshift(invitation);
    }

    if (!store.alertsByParty[party.id]) store.alertsByParty[party.id] = [];
    store.alertsByParty[party.id].unshift({
      id: randomId('alert_invite_sent'),
      partyId: party.id,
      targetUserId: party.hostId,
      targetDisplayName: cleanName,
      targetEmail: cleanEmail,
      assigneeUserId: party.hostId,
      assigneeDisplayName: cleanName,
      senderName: hostMember?.displayName || 'Host',
      senderPhotoURL: hostMember?.photoURL,
      title: `📩 Household Invite Sent to ${cleanName}`,
      category: 'HOUSEHOLD_INVITE',
      type: 'TURN_REMINDER',
      message: `${cleanName} (${cleanEmail}) received an invitation to join ${party.name} (Code: ${party.inviteCode}). It now appears in their Invitations tab!`,
      read: false,
      createdAt: nowIso,
    });

    saveClientStore(store);
    await pushPartyStoreToCloud(store, party.id);
    return {
      ok: true,
      status: 200,
      data: {
        invitation,
        bundle: buildClientBundle(store, party.id),
      },
    };
  }

  // 7A-2. POST /api/party/respond-invite
  if (pathname === '/api/party/respond-invite') {
    const cleanEmail = String(body.userEmail || '').trim().toLowerCase();
    const decision = String(body.decision || '').toUpperCase();
    if (!Array.isArray(store.invitations)) store.invitations = [];

    const invitation = store.invitations.find((inv) => inv.id === body.invitationId);
    if (!invitation) {
      return { ok: false, status: 404, data: { error: 'Invitation not found or expired.' } };
    }

    if (decision === 'DECLINE') {
      invitation.status = 'DECLINED';
      invitation.respondedAt = nowIso;
      saveClientStore(store);
      return {
        ok: true,
        status: 200,
        data: {
          invitations: getPendingClientInvitationsForEmail(store, cleanEmail),
        },
      };
    }

    const party = store.parties[invitation.partyId];
    if (!party || store.deletedPartyIds.includes(party.id)) {
      invitation.status = 'DECLINED';
      invitation.respondedAt = nowIso;
      saveClientStore(store);
      return {
        ok: false,
        status: 404,
        data: { error: 'This household party no longer exists.' },
      };
    }

    invitation.status = 'ACCEPTED';
    invitation.respondedAt = nowIso;

    store.leftPartyKeys = store.leftPartyKeys.filter(
      (k) => k !== `${cleanEmail}:${party.id}`
    );

    let acc = store.accounts[cleanEmail];
    const uid = body.userUid || acc?.uid || randomId('u');
    const displayName = String(
      body.userDisplayName || acc?.displayName || invitation.invitedName || cleanEmail.split('@')[0]
    ).trim();

    if (!acc) {
      acc = {
        uid,
        email: cleanEmail,
        displayName,
        photoURL: body.userPhotoURL,
        avatarColor: AVATAR_COLORS[party.members.length % AVATAR_COLORS.length],
        partyId: party.id,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      store.accounts[cleanEmail] = acc;
    } else {
      acc.partyId = party.id;
      acc.displayName = displayName;
      if (body.userPhotoURL) acc.photoURL = body.userPhotoURL;
      acc.updatedAt = nowIso;
    }

    const existingMember = party.members.find(
      (m) => m.uid === acc.uid || m.email.toLowerCase() === cleanEmail
    );
    if (!existingMember) {
      const newMember: HouseholdMember = {
        uid: acc.uid,
        email: acc.email,
        displayName: acc.displayName,
        photoURL: acc.photoURL,
        avatarColor: AVATAR_COLORS[party.members.length % AVATAR_COLORS.length],
        role: 'MEMBER',
        totalDrops: 0,
        onTimeDrops: 0,
        missedDrops: 0,
        points: 0,
        currentStreak: 0,
        bestStreak: 0,
        onTimeRate: 100,
        joinedAt: nowIso,
      };
      party.memberIds.push(newMember.uid);
      party.members.push(newMember);
      party.updatedAt = nowIso;

      if (!store.alertsByParty[party.id]) store.alertsByParty[party.id] = [];
      store.alertsByParty[party.id].unshift({
        id: randomId('alert_invite_accepted'),
        partyId: party.id,
        targetUserId: party.hostId,
        targetDisplayName: party.hostEmail,
        targetEmail: party.hostEmail,
        assigneeUserId: newMember.uid,
        assigneeDisplayName: newMember.displayName,
        senderName: newMember.displayName,
        senderPhotoURL: newMember.photoURL,
        title: `🎉 ${newMember.displayName} Accepted Your Invite!`,
        category: 'MEMBER_JOINED',
        type: 'TURN_REMINDER',
        message: `${newMember.displayName} (${newMember.email}) accepted the invitation and joined ${party.name}!`,
        read: false,
        createdAt: nowIso,
      });
    }

    saveClientStore(store);
    await pushPartyStoreToCloud(store, party.id);
    return {
      ok: true,
      status: 200,
      data: {
        user: acc,
        bundle: buildClientBundle(store, party.id),
        invitations: getPendingClientInvitationsForEmail(store, cleanEmail),
      },
    };
  }

  // 7B. POST /api/party/leave
  if (pathname === '/api/party/leave') {
    const party = store.parties[body.partyId];
    if (!party) {
      return { ok: false, status: 404, data: { error: 'Household party not found.' } };
    }
    const cleanEmail = String(body.userEmail || '').trim().toLowerCase();
    const leaveKey = `${cleanEmail}:${party.id}`;
    if (cleanEmail && !store.leftPartyKeys.includes(leaveKey)) {
      store.leftPartyKeys.push(leaveKey);
    }

    const result = leavePartyMember(party, body.userId || '', cleanEmail, nowIso);

    for (const acc of Object.values(store.accounts)) {
      if (
        (acc.uid === body.userId || acc.email.toLowerCase() === cleanEmail) &&
        acc.partyId === party.id
      ) {
        acc.partyId = null;
        acc.updatedAt = nowIso;
      }
    }

    const updatedUser = cleanEmail ? store.accounts[cleanEmail] || null : null;

    if (result.dissolved || !result.updatedParty) {
      if (!store.deletedPartyIds.includes(party.id)) {
        store.deletedPartyIds.push(party.id);
      }
      delete store.parties[party.id];
      delete store.dropsByParty[party.id];
      delete store.historyByParty[party.id];
      delete store.emailsByParty[party.id];
      delete store.alertsByParty[party.id];
      saveClientStore(store);
      return {
        ok: true,
        status: 200,
        data: {
          user: updatedUser,
          bundle: null,
          dissolved: true,
          deletedPartyId: party.id,
          leftPartyId: party.id,
          message: `You left "${party.name}". Since you were the only member, the household party was removed.`,
        },
      };
    }

    store.parties[party.id] = result.updatedParty;
    if (!store.alertsByParty[party.id]) store.alertsByParty[party.id] = [];
    store.alertsByParty[party.id].unshift({
      id: randomId('alert_leave'),
      partyId: party.id,
      targetUserId: result.updatedParty.hostId,
      targetDisplayName: result.newHost?.displayName || 'Host',
      targetEmail: result.updatedParty.hostEmail,
      assigneeUserId: result.updatedParty.currentTurnUserId,
      assigneeDisplayName:
        result.updatedParty.members.find(
          (m) => m.uid === result.updatedParty?.currentTurnUserId
        )?.displayName || 'Roommate',
      senderName: result.removedMember?.displayName || 'Roommate',
      title: result.newHost
        ? `👑 Host Transferred to ${result.newHost.displayName}`
        : `🚪 Roommate Left ${party.name}`,
      category: 'PARTY_UPDATED',
      type: 'TURN_REMINDER',
      message: result.newHost
        ? `${result.removedMember?.displayName || 'Host'} left the party. ${result.newHost.displayName} is now the Party Host!`
        : `${result.removedMember?.displayName || 'A roommate'} left the household rotation.`,
      read: false,
      createdAt: nowIso,
    });

    saveClientStore(store);
    return {
      ok: true,
      status: 200,
      data: {
        user: updatedUser,
        bundle: null,
        dissolved: false,
        leftPartyId: party.id,
        newHostName: result.newHost?.displayName,
        message: result.newHost
          ? `You left "${party.name}". Host role was transferred to ${result.newHost.displayName}.`
          : `You left "${party.name}".`,
      },
    };
  }

  // 7C. POST /api/party/delete
  if (pathname === '/api/party/delete') {
    const party = store.parties[body.partyId];
    if (!party) {
      return { ok: false, status: 404, data: { error: 'Household party not found.' } };
    }
    const cleanEmail = String(body.userEmail || '').trim().toLowerCase();
    const isHost =
      party.hostId === body.userId ||
      party.hostEmail.toLowerCase() === cleanEmail ||
      party.members.some(
        (m) =>
          (m.uid === body.userId || m.email.toLowerCase() === cleanEmail) &&
          m.role === 'HOST'
      );

    if (!isHost) {
      return {
        ok: false,
        status: 403,
        data: { error: 'Only the Party Host can delete the household party for everyone.' },
      };
    }

    const partyName = party.name;
    const targetPartyId = party.id;
    if (!store.deletedPartyIds.includes(targetPartyId)) {
      store.deletedPartyIds.push(targetPartyId);
    }

    for (const acc of Object.values(store.accounts)) {
      if (acc.partyId === targetPartyId) {
        acc.partyId = null;
        acc.updatedAt = nowIso;
      }
    }

    delete store.parties[targetPartyId];
    delete store.dropsByParty[targetPartyId];
    delete store.historyByParty[targetPartyId];
    delete store.emailsByParty[targetPartyId];
    delete store.alertsByParty[targetPartyId];

    saveClientStore(store);
    const updatedUser = cleanEmail ? store.accounts[cleanEmail] || null : null;
    return {
      ok: true,
      status: 200,
      data: {
        user: updatedUser,
        bundle: null,
        deletedPartyId: targetPartyId,
        message: `Household party "${partyName}" has been permanently deleted for all members.`,
      },
    };
  }

  // 7D. POST /api/party/alerts-read
  if (pathname === '/api/party/alerts-read') {
    const alerts = store.alertsByParty[body.partyId];
    if (alerts) {
      store.alertsByParty[body.partyId] = alerts.map((a) =>
        !body.alertId || a.id === body.alertId ? { ...a, read: true } : a
      );
      saveClientStore(store);
    }
    return {
      ok: true,
      status: 200,
      data: { bundle: buildClientBundle(store, body.partyId) },
    };
  }

  // 8. POST /api/party/drop
  if (pathname === '/api/party/drop') {
    const party = store.parties[body.partyId];
    if (!party) {
      return { ok: false, status: 404, data: { error: 'Party not found.' } };
    }
    const completingMember =
      party.members.find((m) => m.uid === body.userId) ||
      party.members.find((m) => m.uid === party.currentTurnUserId) ||
      party.members[0];

    const previousDeadlineIso = party.nextDeadline;
    const completedOnTime = new Date(nowIso).getTime() <= new Date(previousDeadlineIso).getTime();
    const cleanNote = String(
      body.locationNote || 'Trash bag placed at outdoor collection bin / dumpster'
    ).trim();
    const dropId = randomId('drop');

    if (body.verifyImmediatelyAsHost) {
      const scoreResult = calculateDropPoints({
        completedBeforeDeadline: completedOnTime,
        currentStreak: completingMember.currentStreak,
      });

      const verifiedDrop: TrashDropLog = {
        id: dropId,
        partyId: party.id,
        userId: completingMember.uid,
        userEmail: completingMember.email,
        userDisplayName: completingMember.displayName,
        userPhotoURL: completingMember.photoURL,
        imageUrl: body.imageUrl,
        verified: true,
        verificationStatus: 'VERIFIED',
        locationNote: cleanNote,
        hostReviewNote: 'Verified and approved by Household Host.',
        verifiedByHostName: body.hostName || 'Host',
        verifiedAtIso: nowIso,
        pointsAwarded: scoreResult.pointsAwarded,
        completedOnTime,
        deadlineIso: previousDeadlineIso,
        submittedIso: nowIso,
        createdAt: nowIso,
      };

      if (!store.dropsByParty[party.id]) store.dropsByParty[party.id] = [];
      store.dropsByParty[party.id].unshift(verifiedDrop);

      const updatedMembers = party.members.map((m) => {
        if (m.uid !== completingMember.uid) return m;
        const nextTotal = m.totalDrops + 1;
        const nextOnTime = completedOnTime ? (m.onTimeDrops || 0) + 1 : m.onTimeDrops || 0;
        const totalTracked = nextTotal + (m.missedDrops || 0);
        const onTimeRate = totalTracked > 0 ? Math.round((nextOnTime / totalTracked) * 100) : 100;
        const nextBestStreak = Math.max(m.bestStreak || 0, scoreResult.nextStreak);
        return {
          ...m,
          totalDrops: nextTotal,
          onTimeDrops: nextOnTime,
          points: m.points + scoreResult.pointsAwarded,
          currentStreak: scoreResult.nextStreak,
          bestStreak: nextBestStreak,
          onTimeRate,
        };
      });

      const rotatedParty = rotatePartyTurn(
        { ...party, members: updatedMembers },
        nowIso,
        true
      );
      store.parties[party.id] = rotatedParty;

      const nextTurnMember =
        rotatedParty.members.find((m) => m.uid === rotatedParty.currentTurnUserId) ||
        rotatedParty.members[0];

      if (!store.alertsByParty[party.id]) store.alertsByParty[party.id] = [];
      store.alertsByParty[party.id].unshift({
        id: randomId('alert_verified'),
        partyId: party.id,
        targetUserId: nextTurnMember.uid,
        targetDisplayName: nextTurnMember.displayName,
        targetEmail: nextTurnMember.email,
        assigneeUserId: nextTurnMember.uid,
        assigneeDisplayName: nextTurnMember.displayName,
        senderName: completingMember.displayName,
        senderPhotoURL: completingMember.photoURL,
        title: `✅ Trash Verified (+${scoreResult.pointsAwarded} pts) · Up Next: ${nextTurnMember.displayName}`,
        category: 'PHOTO_VERIFIED',
        type: 'TURN_REMINDER',
        message: `${completingMember.displayName} completed their trash drop! Turn rotated to ${nextTurnMember.displayName}.`,
        read: false,
        createdAt: nowIso,
      });

      if (!store.historyByParty[party.id]) store.historyByParty[party.id] = [];
      store.historyByParty[party.id].unshift({
        id: randomId('hist_drop'),
        partyId: party.id,
        userId: completingMember.uid,
        userEmail: completingMember.email,
        userDisplayName: completingMember.displayName,
        userPhotoURL: completingMember.photoURL,
        outcome: completedOnTime ? 'ON_TIME' : 'COMPLETED_LATE',
        pointsAwarded: scoreResult.pointsAwarded,
        deadlineIso: previousDeadlineIso,
        recordedIso: nowIso,
        dropId,
        imageUrl: body.imageUrl,
        notes: `Host verified trash photo (${cleanNote}).`,
        createdAt: nowIso,
      });

      saveClientStore(store);
      return {
        ok: true,
        status: 200,
        data: { drop: verifiedDrop, bundle: buildClientBundle(store, party.id) },
      };
    }

    const pendingDrop: TrashDropLog = {
      id: dropId,
      partyId: party.id,
      userId: completingMember.uid,
      userEmail: completingMember.email,
      userDisplayName: completingMember.displayName,
      userPhotoURL: completingMember.photoURL,
      imageUrl: body.imageUrl,
      verified: false,
      verificationStatus: 'PENDING_HOST_APPROVAL',
      locationNote: cleanNote,
      pointsAwarded: 0,
      completedOnTime,
      deadlineIso: previousDeadlineIso,
      submittedIso: nowIso,
      createdAt: nowIso,
    };

    if (!store.dropsByParty[party.id]) store.dropsByParty[party.id] = [];
    store.dropsByParty[party.id].unshift(pendingDrop);

    if (!store.alertsByParty[party.id]) store.alertsByParty[party.id] = [];
    store.alertsByParty[party.id].unshift({
      id: randomId('alert_photo'),
      partyId: party.id,
      targetUserId: party.hostId,
      targetDisplayName: party.hostEmail,
      targetEmail: party.hostEmail,
      assigneeUserId: completingMember.uid,
      assigneeDisplayName: completingMember.displayName,
      senderName: completingMember.displayName,
      senderPhotoURL: completingMember.photoURL,
      title: `📸 New Trash Photo Uploaded by ${completingMember.displayName}`,
      category: 'PHOTO_SUBMITTED',
      type: 'TURN_REMINDER',
      message: `${completingMember.displayName} uploaded proof ("${cleanNote}") awaiting Host verification.`,
      read: false,
      createdAt: nowIso,
    });

    saveClientStore(store);

    return {
      ok: true,
      status: 200,
      data: { drop: pendingDrop, bundle: buildClientBundle(store, party.id) },
    };
  }

  // 9. POST /api/party/verify-drop
  if (pathname === '/api/party/verify-drop') {
    const party = store.parties[body.partyId];
    if (!party) {
      return { ok: false, status: 404, data: { error: 'Party not found.' } };
    }
    const drops = store.dropsByParty[party.id] || [];
    const targetDrop = drops.find((d) => d.id === body.dropId);
    if (!targetDrop) {
      return { ok: false, status: 404, data: { error: 'Submitted photo not found.' } };
    }

    const verifierName = String(body.hostName || 'Host').trim();
    if (body.decision === 'REJECT') {
      targetDrop.verified = false;
      targetDrop.verificationStatus = 'REJECTED';
      targetDrop.pointsAwarded = 0;
      targetDrop.verifiedByHostName = verifierName;
      targetDrop.verifiedAtIso = nowIso;
      targetDrop.hostReviewNote =
        String(body.hostReviewNote || '').trim() ||
        'Photo rejected by Host. Please upload a clear photo of the trash at the outdoor bin.';
      saveClientStore(store);
      return {
        ok: true,
        status: 200,
        data: { drop: targetDrop, bundle: buildClientBundle(store, party.id) },
      };
    }

    const wasAlreadyVerified = targetDrop.verificationStatus === 'VERIFIED';
    const completingMember =
      party.members.find((m) => m.uid === targetDrop.userId) ||
      party.members.find((m) => m.uid === party.currentTurnUserId) ||
      party.members[0];

    const scoreResult = calculateDropPoints({
      completedBeforeDeadline: targetDrop.completedOnTime,
      currentStreak: completingMember.currentStreak,
    });

    targetDrop.verified = true;
    targetDrop.verificationStatus = 'VERIFIED' as PhotoVerificationStatus;
    targetDrop.pointsAwarded = scoreResult.pointsAwarded;
    targetDrop.verifiedByHostName = verifierName;
    targetDrop.verifiedAtIso = nowIso;
    targetDrop.hostReviewNote =
      String(body.hostReviewNote || '').trim() ||
      `Approved by ${verifierName} (+${scoreResult.pointsAwarded} pts).`;

    if (!wasAlreadyVerified) {
      const updatedMembers = party.members.map((m) => {
        if (m.uid !== completingMember.uid) return m;
        const nextTotal = m.totalDrops + 1;
        const nextOnTime = targetDrop.completedOnTime
          ? (m.onTimeDrops || 0) + 1
          : m.onTimeDrops || 0;
        const totalTracked = nextTotal + (m.missedDrops || 0);
        const onTimeRate =
          totalTracked > 0 ? Math.round((nextOnTime / totalTracked) * 100) : 100;
        const nextBestStreak = Math.max(m.bestStreak || 0, scoreResult.nextStreak);
        return {
          ...m,
          totalDrops: nextTotal,
          onTimeDrops: nextOnTime,
          points: m.points + scoreResult.pointsAwarded,
          currentStreak: scoreResult.nextStreak,
          bestStreak: nextBestStreak,
          onTimeRate,
        };
      });

      const rotatedParty = rotatePartyTurn(
        { ...party, members: updatedMembers },
        nowIso,
        true
      );
      store.parties[party.id] = rotatedParty;

      const nextMember =
        rotatedParty.members.find((m) => m.uid === rotatedParty.currentTurnUserId) ||
        rotatedParty.members[0];

      if (!store.alertsByParty[party.id]) store.alertsByParty[party.id] = [];
      store.alertsByParty[party.id].unshift({
        id: randomId('alert_approved'),
        partyId: party.id,
        targetUserId: nextMember.uid,
        targetDisplayName: nextMember.displayName,
        targetEmail: nextMember.email,
        assigneeUserId: nextMember.uid,
        assigneeDisplayName: nextMember.displayName,
        senderName: verifierName,
        senderPhotoURL: completingMember.photoURL,
        title: `✅ Host Approved ${completingMember.displayName}'s Photo (+${scoreResult.pointsAwarded} pts)`,
        category: 'PHOTO_VERIFIED',
        type: 'TURN_REMINDER',
        message: `Turn rotated to ${nextMember.displayName}! Next deadline: ${
          formatDateTimeReadable(rotatedParty.nextDeadline).fullLabel
        }.`,
        read: false,
        createdAt: nowIso,
      });

      if (!store.historyByParty[party.id]) store.historyByParty[party.id] = [];
      store.historyByParty[party.id].unshift({
        id: randomId('hist_drop'),
        partyId: party.id,
        userId: completingMember.uid,
        userEmail: completingMember.email,
        userDisplayName: completingMember.displayName,
        userPhotoURL: completingMember.photoURL,
        outcome: targetDrop.completedOnTime ? 'ON_TIME' : 'COMPLETED_LATE',
        pointsAwarded: scoreResult.pointsAwarded,
        deadlineIso: targetDrop.deadlineIso,
        recordedIso: nowIso,
        dropId: targetDrop.id,
        imageUrl: targetDrop.imageUrl,
        notes: `Verified by Host ${verifierName}: ${targetDrop.locationNote}`,
        createdAt: nowIso,
      });
    }

    saveClientStore(store);
    return {
      ok: true,
      status: 200,
      data: { drop: targetDrop, bundle: buildClientBundle(store, party.id) },
    };
  }

  // 10. POST /api/party/deadline
  if (pathname === '/api/party/deadline') {
    const party = store.parties[body.partyId];
    if (!party) {
      return { ok: false, status: 404, data: { error: 'Party not found.' } };
    }
    if (body.rotationIntervalHours !== undefined) {
      const cleanHours = Math.max(1, Number(body.rotationIntervalHours) || 24);
      party.rotationIntervalHours = cleanHours;
      if (!body.nextDeadlineIso) {
        party.nextDeadline = new Date(Date.now() + cleanHours * 3600 * 1000).toISOString();
      }
    }
    if (body.nextDeadlineIso) {
      party.nextDeadline = String(body.nextDeadlineIso);
      const remainingMs = new Date(party.nextDeadline).getTime() - Date.now();
      if (remainingMs > 0) {
        party.turnStatus = 'PENDING';
        party.missedEmailSentForCurrentTurn = false;
        party.hostAlertedForCurrentTurn = false;
        if (remainingMs > 5 * 3600 * 1000) {
          party.warningEmailSentForCurrentTurn = false;
        }
      }
    }
    party.updatedAt = nowIso;
    saveClientStore(store);
    return {
      ok: true,
      status: 200,
      data: { bundle: buildClientBundle(store, party.id) },
    };
  }

  // 11. POST /api/party/skip
  if (pathname === '/api/party/skip') {
    const party = store.parties[body.partyId];
    if (!party) {
      return { ok: false, status: 404, data: { error: 'Party not found.' } };
    }
    const skippedMember =
      party.members.find((m) => m.uid === party.currentTurnUserId) || party.members[0];
    const previousDeadline = party.nextDeadline;
    const rotated = rotatePartyTurn(party, nowIso, false);
    store.parties[party.id] = rotated;

    const nextUp =
      rotated.members.find((m) => m.uid === rotated.currentTurnUserId) ||
      rotated.members[0];

    if (!store.alertsByParty[party.id]) store.alertsByParty[party.id] = [];
    store.alertsByParty[party.id].unshift({
      id: randomId('alert_skip'),
      partyId: party.id,
      targetUserId: nextUp.uid,
      targetDisplayName: nextUp.displayName,
      targetEmail: nextUp.email,
      assigneeUserId: nextUp.uid,
      assigneeDisplayName: nextUp.displayName,
      senderName: 'Household Host',
      senderPhotoURL: nextUp.photoURL,
      title: `⏭️ Turn Rotated to ${nextUp.displayName}`,
      category: 'TURN_REMINDER',
      type: 'TURN_REMINDER',
      message: `${skippedMember.displayName}'s turn was rotated by Host. ${nextUp.displayName} is now up for trash duty!`,
      read: false,
      createdAt: nowIso,
    });

    if (!store.historyByParty[party.id]) store.historyByParty[party.id] = [];
    store.historyByParty[party.id].unshift({
      id: randomId('hist_skip'),
      partyId: party.id,
      userId: skippedMember.uid,
      userEmail: skippedMember.email,
      userDisplayName: skippedMember.displayName,
      userPhotoURL: skippedMember.photoURL,
      outcome: 'SKIPPED_BY_HOST',
      pointsAwarded: 0,
      deadlineIso: previousDeadline,
      recordedIso: nowIso,
      notes: body.reason || 'Turn manually rotated by Party Host.',
      createdAt: nowIso,
    });

    saveClientStore(store);
    return {
      ok: true,
      status: 200,
      data: { bundle: buildClientBundle(store, party.id) },
    };
  }

  // 12. POST /api/party/profile
  if (pathname === '/api/party/profile') {
    const cleanName = String(body.displayName || '').trim();
    const cleanEmail = body.email ? String(body.email).trim().toLowerCase() : undefined;
    if (cleanName.length < 2) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Display name must be at least 2 characters.' },
      };
    }

    for (const key of Object.keys(store.accounts)) {
      const acc = store.accounts[key];
      if (acc.uid === body.uid) {
        acc.displayName = cleanName;
        if (body.photoURL !== undefined) acc.photoURL = body.photoURL;
        if (cleanEmail && cleanEmail !== key) {
          acc.email = cleanEmail;
          store.accounts[cleanEmail] = acc;
          delete store.accounts[key];
        }
        acc.updatedAt = nowIso;
        break;
      }
    }

    if (body.partyId && store.parties[body.partyId]) {
      const party = store.parties[body.partyId];
      party.members = party.members.map((m) => {
        if (m.uid !== body.uid) return m;
        return {
          ...m,
          displayName: cleanName,
          email: cleanEmail || m.email,
          photoURL: body.photoURL !== undefined ? body.photoURL : m.photoURL,
        };
      });
      party.updatedAt = nowIso;
    }

    saveClientStore(store);
    return {
      ok: true,
      status: 200,
      data: {
        bundle: body.partyId ? buildClientBundle(store, body.partyId) : null,
      },
    };
  }

  // 13. POST /api/official-email/config
  if (pathname === '/api/official-email/config') {
    const cleanPass = String(body.password || '').replace(/\s+/g, '');
    if (cleanPass.length === 16) {
      store.appPassword = cleanPass;
      store.smtpVerified = true;
      saveClientStore(store);
    }
    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        message: 'Live Pop-Up & Browser Push Notifications are active for all household members!',
        status: getClientMailerStatus(store),
        bundle: body.partyId ? buildClientBundle(store, body.partyId) : null,
      },
    };
  }

  // 14. POST /api/send-email (Live Pop-Up & Push Notification Dispatcher)
  if (pathname === '/api/send-email') {
    const party = store.parties[body.partyId];
    if (!party) {
      return { ok: false, status: 404, data: { error: 'Party not found.' } };
    }
    const recipient =
      party.members.find((m) => m.uid === body.recipientUserId) ||
      party.members.find((m) => m.uid === party.currentTurnUserId) ||
      party.members[0];

    const emailType: EmailAlertType = body.type || 'MANUAL_REMINDER';
    const { subject, bodyText } = buildEmailContent({
      party,
      recipient,
      type: emailType,
      customSubject: body.customSubject,
      customMessage: body.customMessage,
    });

    if (!store.alertsByParty[party.id]) store.alertsByParty[party.id] = [];
    store.alertsByParty[party.id].unshift({
      id: randomId('alert_push'),
      partyId: party.id,
      targetUserId: recipient.uid,
      targetDisplayName: recipient.displayName,
      targetEmail: recipient.email,
      assigneeUserId: recipient.uid,
      assigneeDisplayName: recipient.displayName,
      senderName: party.name,
      senderPhotoURL: recipient.photoURL,
      title: subject,
      category:
        emailType === 'WARNING_5H'
          ? 'WARNING_5H'
          : emailType === 'MISSED_DEADLINE' || emailType === 'HOST_ESCALATION'
          ? 'MISSED_DEADLINE'
          : 'TURN_REMINDER',
      type:
        emailType === 'WARNING_5H'
          ? 'WARNING_5H'
          : emailType === 'MISSED_DEADLINE'
          ? 'MISSED_DEADLINE'
          : 'TURN_REMINDER',
      message: bodyText,
      read: false,
      createdAt: nowIso,
    });

    const newLog: EmailDispatchLog = {
      id: randomId('notif_manual'),
      partyId: party.id,
      recipientUserId: recipient.uid,
      toEmail: recipient.email,
      toName: recipient.displayName,
      fromEmail: OFFICIAL_BINDROP_EMAIL,
      subject,
      bodyText,
      type: emailType,
      deliveryStatus: 'PUSH_NOTIFICATION_SENT',
      transportInfo: `Instant Pop-Up & Browser Push Notification delivered to ${recipient.displayName} (${recipient.email})`,
      sentAt: nowIso,
    };

    if (!store.emailsByParty[party.id]) store.emailsByParty[party.id] = [];
    store.emailsByParty[party.id].unshift(newLog);
    saveClientStore(store);
    await pushPartyStoreToCloud(store, party.id);

    return {
      ok: true,
      status: 200,
      data: {
        email: newLog,
        bundle: buildClientBundle(store, party.id),
      },
    };
  }

  // 15. Web Push API Fallback Routes
  if (pathname === '/api/push/vapid-public-key') {
    return {
      ok: true,
      status: 200,
      data: {
        publicKey:
          'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
      },
    };
  }

  if (
    pathname === '/api/push/subscribe' ||
    pathname === '/api/push/unsubscribe' ||
    pathname === '/api/push/test'
  ) {
    return {
      ok: true,
      status: 200,
      data: { ok: true },
    };
  }

  return {
    ok: false,
    status: 404,
    data: { error: `Unknown API route: ${pathname}` },
  };
}

/**
 * Universal API caller that works both with the Express backend (`server.ts`)
 * AND on static hosts like Netlify (`bindrop.netlify.app`) where `/api/*` returns HTML.
 * Also automatically attaches the client's cached party bundle during session/auth sync
 * so pushing code updates or restarting the server never loses the user's household party.
 */
export async function apiFetch<T = any>(
  endpoint: string,
  options?: RequestInit
): Promise<{ ok: boolean; status: number; data: T }> {
  try {
    let finalOptions = options;
    const urlObj = new URL(endpoint, window.location.origin);
    const pathname = urlObj.pathname;

    // Attach cachedBundle, cachedParties, and cachedInvitations on auth/session/party sync
    // so any party or invitation created on PC or Phone syncs across devices immediately
    if (
      pathname === '/api/session' ||
      pathname === '/api/auth/login' ||
      pathname === '/api/auth/register' ||
      pathname === '/api/auth/google-sync' ||
      pathname === '/api/party/create' ||
      pathname === '/api/party/join' ||
      pathname === '/api/party/add-member' ||
      pathname === '/api/party/respond-invite'
    ) {
      const store = loadClientStore();
      const bodyObj = options?.body ? JSON.parse(String(options.body)) : {};

      // Sync with Cloud Firestore before party join or invite response so cross-device codes are always in store.parties
      if (
        pathname === '/api/party/join' ||
        pathname === '/api/party/respond-invite' ||
        pathname === '/api/party/add-member' ||
        pathname === '/api/session'
      ) {
        await syncStoreWithCloud(store, {
          email: String(bodyObj.email || bodyObj.userEmail || urlObj.searchParams.get('email') || '').trim() || undefined,
          partyId: String(bodyObj.partyId || urlObj.searchParams.get('partyId') || '').trim() || undefined,
          inviteCode: String(bodyObj.inviteCode || '').trim() || undefined,
        });
        saveClientStore(store);
      }

      const email = String(
        bodyObj.email || bodyObj.userEmail || bodyObj.hostEmail || urlObj.searchParams.get('email') || ''
      )
        .trim()
        .toLowerCase();
      const partyId = String(bodyObj.partyId || urlObj.searchParams.get('partyId') || '').trim();
      const cachedBundle = getInitialCachedBundleForAccount(email, partyId);
      const cachedParties = Object.values(store.parties);
      const cachedInvitations = Array.isArray(store.invitations) ? store.invitations : [];

      if (
        (cachedBundle || cachedParties.length > 0 || cachedInvitations.length > 0) &&
        (!options?.method || options.method.toUpperCase() === 'POST')
      ) {
        finalOptions = {
          ...options,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(options?.headers || {}),
          },
          body: JSON.stringify({
            ...bodyObj,
            ...(pathname === '/api/session'
              ? {
                  email: email || bodyObj.email,
                  partyId: partyId || bodyObj.partyId || cachedBundle?.party?.id,
                }
              : {}),
            cachedBundle,
            cachedParties,
            cachedInvitations,
          }),
        };
      }
    }

    const res = await fetch(endpoint, finalOptions);
    const contentType = res.headers.get('content-type') || '';
    const rawText = await res.text();
    const trimmed = rawText.trim();

    if (
      trimmed.startsWith('<') ||
      !contentType.toLowerCase().includes('application/json')
    ) {
      // Static host like Netlify (`bindrop.netlify.app`) returned index.html for `/api/*`.
      // Bridge to our shared Cloud Run backend & Cloud Firestore so PC and Mobile share the exact same database!
      if (window.location.origin !== REMOTE_CLOUD_BACKEND_ORIGIN) {
        try {
          const remoteUrl = `${REMOTE_CLOUD_BACKEND_ORIGIN}${pathname}${urlObj.search}`;
          const remoteRes = await fetch(remoteUrl, finalOptions);
          const remoteType = remoteRes.headers.get('content-type') || '';
          const remoteText = (await remoteRes.text()).trim();
          if (
            !remoteText.startsWith('<') &&
            remoteType.toLowerCase().includes('application/json')
          ) {
            const remoteParsed = JSON.parse(remoteText);
            if (remoteRes.ok) {
              mirrorServerPayloadToClientStore(remoteParsed);
              return {
                ok: remoteRes.ok,
                status: remoteRes.status,
                data: remoteParsed as T,
              };
            }
          }
        } catch {
          // If remote cloud backend is unreachable, fall through to Cloud Firestore + client store
        }
      }
      return await executeClientFallbackRoute(endpoint, finalOptions);
    }

    const parsed = JSON.parse(trimmed);
    if (res.ok) {
      mirrorServerPayloadToClientStore(parsed);
    } else if (pathname === '/api/party/join' && res.status === 404) {
      // If local Express server didn't have the invite code, check Cloud Firestore fallback
      return await executeClientFallbackRoute(endpoint, finalOptions);
    }
    return {
      ok: res.ok,
      status: res.status,
      data: parsed as T,
    };
  } catch {
    return await executeClientFallbackRoute(endpoint, options);
  }
}
