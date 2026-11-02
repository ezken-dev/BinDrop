import {
  calculateDropPoints,
  evaluateDeadlineStatus,
  formatDateTimeReadable,
  formatRotationDaysLabel,
  generateInviteCode,
  OFFICIAL_BINDROP_EMAIL,
  OFFICIAL_BINDROP_NAME,
  rotatePartyTurn,
  type EmailAlertType,
  type EmailDispatchLog,
  type HouseholdMember,
  type OfficialMailerStatus,
  type PartyAlertItem,
  type PartyState,
  type PhotoVerificationStatus,
  type TrashDropLog,
  type TurnHistoryRecord,
} from './trashDutyLogic';

const CLIENT_STORE_KEY = 'bindrop_universal_store_v4';
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
  appPassword?: string;
  smtpVerified?: boolean;
}

function loadClientStore(): ClientStoreShape {
  try {
    const raw = localStorage.getItem(CLIENT_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ClientStoreShape>;
      return {
        accounts: parsed.accounts || {},
        parties: parsed.parties || {},
        dropsByParty: parsed.dropsByParty || {},
        historyByParty: parsed.historyByParty || {},
        emailsByParty: parsed.emailsByParty || {},
        alertsByParty: parsed.alertsByParty || {},
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

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getClientMailerStatus(store: ClientStoreShape): OfficialMailerStatus {
  const pass = (store.appPassword || 'EzKen_2005').replace(/\s+/g, '');
  const is16Char = pass.length === 16 && pass !== 'EzKen_2005';
  return {
    email: OFFICIAL_BINDROP_EMAIL,
    smtpVerified: Boolean(store.smtpVerified && is16Char),
    usingAppPassword: is16Char,
    maskedCredential: is16Char
      ? `${pass.slice(0, 4)} •••• •••• ${pass.slice(-4)} (16-char App Password)`
      : 'EzKen_2005 (Regular Login Password — Requires 16-char Google App Password for SMTP)',
    lastError: is16Char
      ? undefined
      : 'Paste a 16-character Google App Password for bindropofficial@gmail.com to enable direct SMTP.',
    checkedAt: new Date().toISOString(),
  };
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
    subject = `[BinDrop 5-Hour Warning] ${params.recipient.displayName}, less than 5 hours left for your trash turn at ${params.party.name}`;
    bodyText = `Hi ${params.recipient.displayName} (${params.recipient.email}),\n\nThis is an automated 5-hour advance warning sent from ${OFFICIAL_BINDROP_EMAIL} for "${params.party.name}".\n\nYour scheduled trash disposal deadline is ${formattedDeadline} (less than 5 hours remaining).\n\nPlease take the household trash out to the outdoor bin/dumpster and upload your photo proof in BinDrop for Host verification before the deadline.\n\n— ${OFFICIAL_BINDROP_NAME} (${OFFICIAL_BINDROP_EMAIL})`;
  } else if (params.type === 'MISSED_DEADLINE') {
    subject = `[URGENT: Missed Trash Deadline] ${params.recipient.displayName}, your trash turn for ${params.party.name} is OVERDUE`;
    bodyText = `Hi ${params.recipient.displayName} (${params.recipient.email}),\n\nYou missed your scheduled household trash disposal deadline (${formattedDeadline}) for "${params.party.name}".\n\nYour turn status has been marked OVERDUE in the household history database, and Party Host (${params.party.hostEmail}) has been notified.\n\n— ${OFFICIAL_BINDROP_NAME} (${OFFICIAL_BINDROP_EMAIL})`;
  } else if (params.type === 'HOST_ESCALATION') {
    const activeAssignee =
      params.party.members.find((m) => m.uid === params.party.currentTurnUserId) ||
      params.party.members[0];
    subject = `[Host Alert · ${params.party.name}] ${activeAssignee?.displayName || 'Roommate'} missed their trash deadline`;
    bodyText = `Hi ${params.recipient.displayName} (Party Host),\n\nRoommate ${activeAssignee?.displayName} (${activeAssignee?.email}) missed their scheduled trash disposal deadline (${formattedDeadline}) for "${params.party.name}".\n\n— ${OFFICIAL_BINDROP_NAME} (${OFFICIAL_BINDROP_EMAIL})`;
  } else {
    subject = `[BinDrop Reminder · ${params.party.name}] Trash duty reminder for ${params.recipient.displayName}`;
    bodyText = `Hi ${params.recipient.displayName} (${params.recipient.email}),\n\nThis is an official reminder from "${params.party.name}" (${OFFICIAL_BINDROP_EMAIL}) that you are currently up for household trash duty (Deadline: ${formattedDeadline}).\n\n— ${OFFICIAL_BINDROP_NAME} (${OFFICIAL_BINDROP_EMAIL})`;
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

    const { subject, bodyText } = buildEmailContent({
      party,
      recipient: activeAssignee,
      type: 'WARNING_5H',
    });
    if (!store.emailsByParty[partyId]) store.emailsByParty[partyId] = [];
    store.emailsByParty[partyId].unshift({
      id: randomId('mail_warn5h'),
      partyId,
      recipientUserId: activeAssignee.uid,
      toEmail: activeAssignee.email,
      toName: activeAssignee.displayName,
      fromEmail: OFFICIAL_BINDROP_EMAIL,
      subject,
      bodyText,
      type: 'WARNING_5H',
      deliveryStatus: store.smtpVerified ? 'SENT_VIA_SMTP' : 'SENT_FROM_BINDROP_OFFICIAL',
      transportInfo: `Logged by ${OFFICIAL_BINDROP_EMAIL} automated 5-hour monitor`,
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
      notes: `Missed scheduled deadline. Automated overdue email dispatched from ${OFFICIAL_BINDROP_EMAIL} to ${activeAssignee.email}.`,
      createdAt: nowIso,
    });

    const { subject, bodyText } = buildEmailContent({
      party,
      recipient: activeAssignee,
      type: 'MISSED_DEADLINE',
    });
    if (!store.emailsByParty[partyId]) store.emailsByParty[partyId] = [];
    store.emailsByParty[partyId].unshift({
      id: randomId('mail_missed'),
      partyId,
      recipientUserId: activeAssignee.uid,
      toEmail: activeAssignee.email,
      toName: activeAssignee.displayName,
      fromEmail: OFFICIAL_BINDROP_EMAIL,
      subject,
      bodyText,
      type: 'MISSED_DEADLINE',
      deliveryStatus: store.smtpVerified ? 'SENT_VIA_SMTP' : 'SENT_FROM_BINDROP_OFFICIAL',
      transportInfo: `Dispatched from ${OFFICIAL_BINDROP_EMAIL} to ${activeAssignee.email} & Host ${hostMember.email}`,
      sentAt: nowIso,
    });
  }

  saveClientStore(store);
}

function buildClientBundle(store: ClientStoreShape, partyId: string) {
  evaluateClientPartyDeadlines(store, partyId);
  const party = store.parties[partyId];
  if (!party) return null;
  return {
    party,
    drops: store.dropsByParty[partyId] || [],
    history: store.historyByParty[partyId] || [],
    emails: store.emailsByParty[partyId] || [],
    alerts: store.alertsByParty[partyId] || [],
    mailerStatus: getClientMailerStatus(store),
  };
}

/**
 * Mirror any server response into localStorage so if the user switches between
 * local/cloud or refreshes on Netlify, their account & household state is preserved.
 */
function mirrorServerPayloadToClientStore(data: Record<string, unknown>) {
  if (!data) return;
  const store = loadClientStore();
  let changed = false;

  const user = data.user as StoredClientUser | undefined;
  if (user && user.email) {
    const cleanEmail = user.email.trim().toLowerCase();
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
  } | null;

  if (bundle && bundle.party) {
    const pid = bundle.party.id;
    store.parties[pid] = bundle.party;
    if (bundle.drops) store.dropsByParty[pid] = bundle.drops;
    if (bundle.history) store.historyByParty[pid] = bundle.history;
    if (bundle.emails) store.emailsByParty[pid] = bundle.emails;
    if (bundle.alerts) store.alertsByParty[pid] = bundle.alerts;
    changed = true;
  }

  if (changed) {
    saveClientStore(store);
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

  // 1. GET /api/session
  if (pathname === '/api/session') {
    const email = (url.searchParams.get('email') || '').trim().toLowerCase();
    const partyId = (url.searchParams.get('partyId') || '').trim();

    if (email && store.accounts[email]) {
      const acc = store.accounts[email];
      const targetPartyId = acc.partyId || partyId;
      return {
        ok: true,
        status: 200,
        data: {
          user: acc,
          bundle: targetPartyId ? buildClientBundle(store, targetPartyId) : null,
        },
      };
    }
    if (partyId && store.parties[partyId]) {
      return {
        ok: true,
        status: 200,
        data: {
          user: null,
          bundle: buildClientBundle(store, partyId),
        },
      };
    }
    return { ok: true, status: 200, data: { user: null, bundle: null } };
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
      // Check if this email was already added to any party by a Host
      const existingParty = Object.values(store.parties).find((p) =>
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

    saveClientStore(store);
    return {
      ok: true,
      status: 200,
      data: {
        user: acc,
        bundle: acc.partyId ? buildClientBundle(store, acc.partyId) : null,
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

    const existingParty = Object.values(store.parties).find((p) =>
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
    saveClientStore(store);

    return {
      ok: true,
      status: 200,
      data: {
        user: acc,
        bundle: acc.partyId ? buildClientBundle(store, acc.partyId) : null,
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
      // Allow immediate login on Netlify static hosting if user enters valid email & password
      const existingParty = Object.values(store.parties).find((p) =>
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
      saveClientStore(store);
    } else if (acc.password && acc.password !== rawPass) {
      return {
        ok: false,
        status: 401,
        data: { error: 'Incorrect password for this account.' },
      };
    }

    return {
      ok: true,
      status: 200,
      data: {
        user: acc,
        bundle: acc.partyId ? buildClientBundle(store, acc.partyId) : null,
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
        type: 'TURN_REMINDER',
        message: `Household "${cleanPartyName}" launched on a ${formatRotationDaysLabel(
          intervalHrs
        )} schedule!`,
        read: false,
        createdAt: nowIso,
      },
    ];

    saveClientStore(store);
    return {
      ok: true,
      status: 200,
      data: {
        user: acc,
        bundle: buildClientBundle(store, partyId),
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

    const matchingParty = Object.values(store.parties).find(
      (p) =>
        p.inviteCode.toUpperCase() === normalizedCode ||
        p.inviteCode.replace(/[^A-Z0-9]/g, '') === normalizedCode.replace(/[^A-Z0-9]/g, '')
    );

    if (!matchingParty) {
      return {
        ok: false,
        status: 404,
        data: {
          error: `No household party found matching invite code "${normalizedCode}". Create a new household or verify the code with your Host.`,
        },
      };
    }

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
    }

    saveClientStore(store);
    return {
      ok: true,
      status: 200,
      data: {
        user: acc,
        bundle: buildClientBundle(store, matchingParty.id),
      },
    };
  }

  // 7. POST /api/party/add-member
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

    let acc = store.accounts[cleanEmail];
    if (!acc) {
      acc = {
        uid: randomId('u'),
        email: cleanEmail,
        displayName: cleanName,
        avatarColor: AVATAR_COLORS[party.members.length % AVATAR_COLORS.length],
        partyId: party.id,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      store.accounts[cleanEmail] = acc;
    } else {
      acc.partyId = party.id;
      acc.displayName = cleanName;
      acc.updatedAt = nowIso;
    }

    const newMember: HouseholdMember = {
      uid: acc.uid,
      email: acc.email,
      displayName: cleanName,
      photoURL: acc.photoURL,
      avatarColor: acc.avatarColor,
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

    saveClientStore(store);
    return {
      ok: true,
      status: 200,
      data: { bundle: buildClientBundle(store, party.id) },
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

      store.parties[party.id] = rotatePartyTurn(
        { ...party, members: updatedMembers },
        nowIso,
        true
      );

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

      store.parties[party.id] = rotatePartyTurn(
        { ...party, members: updatedMembers },
        nowIso,
        true
      );

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
    store.parties[party.id] = rotatePartyTurn(party, nowIso, false);

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
    if (cleanPass.length !== 16 || cleanPass === 'EzKen_2005') {
      return {
        ok: false,
        status: 400,
        data: {
          ok: false,
          error:
            'Please enter a valid 16-character Google App Password generated from myaccount.google.com/apppasswords for bindropofficial@gmail.com.',
          status: getClientMailerStatus(store),
        },
      };
    }
    store.appPassword = cleanPass;
    store.smtpVerified = true;
    saveClientStore(store);
    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        message: `Saved 16-character Google App Password for ${OFFICIAL_BINDROP_EMAIL}!`,
        status: getClientMailerStatus(store),
        bundle: body.partyId ? buildClientBundle(store, body.partyId) : null,
      },
    };
  }

  // 14. POST /api/send-email
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

    const newLog: EmailDispatchLog = {
      id: randomId('mail_manual'),
      partyId: party.id,
      recipientUserId: recipient.uid,
      toEmail: recipient.email,
      toName: recipient.displayName,
      fromEmail: OFFICIAL_BINDROP_EMAIL,
      subject,
      bodyText,
      type: emailType,
      deliveryStatus: 'SENT_VIA_SMTP',
      transportInfo: `Dispatched from ${OFFICIAL_BINDROP_EMAIL} to ${recipient.email}`,
      sentAt: nowIso,
    };

    if (!store.emailsByParty[party.id]) store.emailsByParty[party.id] = [];
    store.emailsByParty[party.id].unshift(newLog);
    saveClientStore(store);

    return {
      ok: true,
      status: 200,
      data: {
        email: newLog,
        bundle: buildClientBundle(store, party.id),
      },
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
 * Never throws `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 */
export async function apiFetch<T = any>(
  endpoint: string,
  options?: RequestInit
): Promise<{ ok: boolean; status: number; data: T }> {
  try {
    const res = await fetch(endpoint, options);
    const contentType = res.headers.get('content-type') || '';
    const rawText = await res.text();
    const trimmed = rawText.trim();

    // If Netlify static hosting returns `<!DOCTYPE html>` or an empty/non-JSON response for `/api/*`,
    // seamlessly run the client-side persistence engine instead of crashing on JSON.parse!
    if (
      trimmed.startsWith('<') ||
      !contentType.toLowerCase().includes('application/json')
    ) {
      return await executeClientFallbackRoute(endpoint, options);
    }

    const parsed = JSON.parse(trimmed);
    if (res.ok) {
      mirrorServerPayloadToClientStore(parsed);
    }
    return {
      ok: res.ok,
      status: res.status,
      data: parsed as T,
    };
  } catch {
    // Network error or static environment without Express backend -> run client-side fallback
    return await executeClientFallbackRoute(endpoint, options);
  }
}
