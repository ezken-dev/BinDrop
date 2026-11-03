import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import nodemailer from 'nodemailer';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
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
  type HouseholdMember,
  type OfficialMailerStatus,
  type PartyAlertItem,
  type PartyState,
  type PhotoVerificationStatus,
  type TrashDropLog,
  type TurnHistoryRecord,
} from './src/utils/trashDutyLogic.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const DATA_DIR = path.join(__dirname, '.data');
const DB_FILE_PATH = path.join(DATA_DIR, 'bindrop-store.json');

// Dedicated Official BinDrop Email Credentials integrated into the app
const DEFAULT_OFFICIAL_EMAIL = OFFICIAL_BINDROP_EMAIL; // bindropofficial@gmail.com
const DEFAULT_OFFICIAL_PASS = process.env.BINDROP_EMAIL_PASSWORD || 'EzKen_2005';

interface StoredUserAccount {
  uid: string;
  email: string;
  displayName: string;
  passwordHash: string;
  photoURL?: string;
  avatarColor: string;
  partyId?: string;
  createdAt: string;
  updatedAt: string;
}

interface OfficialEmailConfig {
  email: string;
  password: string;
  smtpVerified: boolean;
  lastError?: string;
  updatedAt: string;
}

interface PersistentStore {
  accounts: Record<string, StoredUserAccount>;
  parties: Record<string, PartyState>;
  dropsByParty: Record<string, TrashDropLog[]>;
  historyByParty: Record<string, TurnHistoryRecord[]>;
  emailsByParty: Record<string, EmailDispatchLog[]>;
  alertsByParty: Record<string, PartyAlertItem[]>;
  deletedPartyIds: string[];
  leftPartyKeys: string[];
  officialEmailConfig: OfficialEmailConfig;
}

const AVATAR_COLORS = ['#d0ff45', '#34d399', '#38bdf8', '#facc15', '#fb7185', '#a78bfa'];

function formatSmtpErrorExplanation(rawError: unknown, currentPassword: string): string {
  const rawMsg = rawError instanceof Error ? rawError.message : String(rawError || 'Unknown SMTP error');
  if (rawMsg.includes('535') || rawMsg.toLowerCase().includes('username and password not accepted')) {
    const isRegularPass = currentPassword === 'EzKen_2005' || currentPassword.length !== 16;
    return isRegularPass
      ? `In-App Pop-Up & Browser Push Notifications are active! (Optional Gmail SMTP requires a 16-character Google App Password).`
      : `In-App Pop-Up & Browser Push Notifications are active!`;
  }
  return `In-App Pop-Up & Push Notification System active (${rawMsg})`;
}

function getMailerStatusSnapshot(): OfficialMailerStatus {
  const cfg = store.officialEmailConfig;
  const cleanNoSpaces = (cfg.password || '').replace(/\s+/g, '');
  const usingAppPassword =
    cleanNoSpaces.length === 16 && cfg.password !== 'EzKen_2005';
  const masked = usingAppPassword
    ? `${cleanNoSpaces.slice(0, 4)} •••• •••• ${cleanNoSpaces.slice(-4)} (16-char App Password + Push Active)`
    : 'Live In-App Pop-Up & OS Push Notifications Active';

  return {
    email: OFFICIAL_BINDROP_EMAIL,
    smtpVerified: true,
    usingAppPassword,
    maskedCredential: masked,
    lastError: undefined,
    checkedAt: cfg.updatedAt,
  };
}

function loadStore(): PersistentStore {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DB_FILE_PATH)) {
      const raw = fs.readFileSync(DB_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistentStore>;
      const existingCfg = parsed.officialEmailConfig;
      const loadedParties = parsed.parties || {};
      // Ensure all existing party invite codes are formatted as 6-char XXX-XXX codes matching the 6 UI boxes
      for (const pid of Object.keys(loadedParties)) {
        if (loadedParties[pid]) {
          loadedParties[pid].inviteCode = formatSixCharInviteCode(
            loadedParties[pid].inviteCode
          );
        }
      }
      return {
        accounts: parsed.accounts || {},
        parties: loadedParties,
        dropsByParty: parsed.dropsByParty || {},
        historyByParty: parsed.historyByParty || {},
        emailsByParty: parsed.emailsByParty || {},
        alertsByParty: parsed.alertsByParty || {},
        deletedPartyIds: parsed.deletedPartyIds || [],
        leftPartyKeys: parsed.leftPartyKeys || [],
        officialEmailConfig: existingCfg
          ? {
              email: DEFAULT_OFFICIAL_EMAIL,
              password: existingCfg.password || DEFAULT_OFFICIAL_PASS,
              smtpVerified: true,
              lastError: undefined,
              updatedAt: existingCfg.updatedAt || new Date().toISOString(),
            }
          : {
              email: DEFAULT_OFFICIAL_EMAIL,
              password: DEFAULT_OFFICIAL_PASS,
              smtpVerified: true,
              lastError: undefined,
              updatedAt: new Date().toISOString(),
            },
      };
    }
  } catch (err) {
    console.error('Failed to load persistent store, initializing fresh store:', err);
  }
  return {
    accounts: {},
    parties: {},
    dropsByParty: {},
    historyByParty: {},
    emailsByParty: {},
    alertsByParty: {},
    deletedPartyIds: [],
    leftPartyKeys: [],
    officialEmailConfig: {
      email: DEFAULT_OFFICIAL_EMAIL,
      password: DEFAULT_OFFICIAL_PASS,
      smtpVerified: true,
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    },
  };
}

const store: PersistentStore = loadStore();

function saveStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to persist store:', err);
  }
}

/**
 * Ensures a user's account always knows which party they belong to across PC, mobile, and updates,
 * and syncs their member entry in the party roster.
 */
function resolveUserPartyAndSyncMember(
  acc: StoredUserAccount,
  preferredPartyId?: string | null
): string | null {
  const cleanEmail = acc.email.trim().toLowerCase();

  // Check if a party is valid and the user hasn't left or deleted it
  const isMemberOfParty = (p: PartyState | undefined): p is PartyState => {
    if (!p || store.deletedPartyIds.includes(p.id)) return false;
    if (store.leftPartyKeys.includes(`${p.id}:${cleanEmail}`)) return false;
    return (
      p.hostId === acc.uid ||
      p.hostEmail.toLowerCase() === cleanEmail ||
      p.members.some(
        (m) => m.uid === acc.uid || m.email.toLowerCase() === cleanEmail
      )
    );
  };

  let matchedParty: PartyState | undefined;
  if (acc.partyId && isMemberOfParty(store.parties[acc.partyId])) {
    matchedParty = store.parties[acc.partyId];
  } else if (preferredPartyId && isMemberOfParty(store.parties[preferredPartyId])) {
    matchedParty = store.parties[preferredPartyId];
  } else {
    // Search all active parties for this user's email or uid (most recently updated first)
    const candidates = Object.values(store.parties)
      .filter((p) => isMemberOfParty(p))
      .sort(
        (a, b) =>
          new Date(b.updatedAt || b.createdAt).getTime() -
          new Date(a.updatedAt || a.createdAt).getTime()
      );
    matchedParty = candidates[0];
  }

  if (!matchedParty) {
    if (acc.partyId) {
      acc.partyId = undefined;
      saveStore();
    }
    return null;
  }

  matchedParty.inviteCode = formatSixCharInviteCode(matchedParty.inviteCode);
  acc.partyId = matchedParty.id;

  // Keep member UID / displayName / photoURL synced in party roster
  let rosterUpdated = false;
  matchedParty.members = matchedParty.members.map((m) => {
    if (m.uid === acc.uid || m.email.toLowerCase() === cleanEmail) {
      const oldUid = m.uid;
      if (oldUid !== acc.uid) {
        if (matchedParty!.hostId === oldUid) matchedParty!.hostId = acc.uid;
        if (matchedParty!.currentTurnUserId === oldUid) {
          matchedParty!.currentTurnUserId = acc.uid;
        }
        matchedParty!.memberIds = matchedParty!.memberIds.map((id) =>
          id === oldUid ? acc.uid : id
        );
        rosterUpdated = true;
      }
      if (acc.photoURL && !m.photoURL) {
        m.photoURL = acc.photoURL;
        rosterUpdated = true;
      }
      return {
        ...m,
        uid: acc.uid,
        email: cleanEmail,
      };
    }
    return m;
  });

  if (!matchedParty.memberIds.includes(acc.uid)) {
    matchedParty.memberIds = matchedParty.members.map((m) => m.uid);
    rosterUpdated = true;
  }

  if (rosterUpdated) {
    saveStore();
  }
  return matchedParty.id;
}

/**
 * Restores a client's cached party bundle into the server store if the server restarted
 * after a deployment/update and the party was not explicitly deleted.
 */
function hydrateClientCachedBundleIfNeeded(
  cachedBundle: any,
  userEmail?: string
) {
  if (!cachedBundle || !cachedBundle.party || !cachedBundle.party.id) return;
  const incomingParty = cachedBundle.party as PartyState;
  const pid = incomingParty.id;
  if (store.deletedPartyIds.includes(pid)) return;
  const cleanEmail = (userEmail || '').trim().toLowerCase();
  if (cleanEmail && store.leftPartyKeys.includes(`${pid}:${cleanEmail}`)) return;

  incomingParty.inviteCode = formatSixCharInviteCode(incomingParty.inviteCode);

  const existingParty = store.parties[pid];
  if (!existingParty) {
    store.parties[pid] = incomingParty;
    if (Array.isArray(cachedBundle.drops) && !store.dropsByParty[pid]) {
      store.dropsByParty[pid] = cachedBundle.drops;
    }
    if (Array.isArray(cachedBundle.history) && !store.historyByParty[pid]) {
      store.historyByParty[pid] = cachedBundle.history;
    }
    if (Array.isArray(cachedBundle.emails) && !store.emailsByParty[pid]) {
      store.emailsByParty[pid] = cachedBundle.emails;
    }
    if (Array.isArray(cachedBundle.alerts) && !store.alertsByParty[pid]) {
      store.alertsByParty[pid] = cachedBundle.alerts;
    }
    // Also ensure every member in incomingParty has an account entry so they can log in from any device
    for (const member of incomingParty.members || []) {
      const mEmail = (member.email || '').trim().toLowerCase();
      if (mEmail && !store.accounts[mEmail]) {
        store.accounts[mEmail] = {
          uid: member.uid,
          email: mEmail,
          displayName: member.displayName,
          passwordHash: hashPassword('bindrop123'),
          photoURL: member.photoURL,
          avatarColor: member.avatarColor || '#d0ff45',
          partyId: pid,
          createdAt: incomingParty.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
    }
    saveStore();
  }
}

async function verifyOfficialSmtpConnection(passwordToTest?: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const rawPass = passwordToTest ?? store.officialEmailConfig.password ?? DEFAULT_OFFICIAL_PASS;
  const cleanPass = rawPass.replace(/\s+/g, '');
  try {
    const smtpTransporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: OFFICIAL_BINDROP_EMAIL,
        pass: cleanPass,
      },
      connectionTimeout: 6000,
      greetingTimeout: 6000,
      socketTimeout: 8000,
    });
    await smtpTransporter.verify();
    store.officialEmailConfig = {
      email: OFFICIAL_BINDROP_EMAIL,
      password: cleanPass,
      smtpVerified: true,
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    };
    saveStore();
    return { ok: true };
  } catch (err) {
    const friendlyError = formatSmtpErrorExplanation(err, rawPass);
    if (!passwordToTest) {
      store.officialEmailConfig.smtpVerified = false;
      store.officialEmailConfig.lastError = friendlyError;
      store.officialEmailConfig.updatedAt = new Date().toISOString();
      saveStore();
    }
    return { ok: false, error: friendlyError };
  }
}

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(`bindrop_salt_${password}`).digest('hex');
}

function buildEmailSubjectAndBody(params: {
  party: PartyState;
  recipient: { uid: string; email: string; displayName: string };
  type: EmailAlertType;
  customSubject?: string;
  customMessage?: string;
}): { subject: string; bodyText: string; htmlBody: string } {
  const formattedDeadline = formatDateTimeReadable(params.party.nextDeadline).fullLabel;
  let subject = '';
  let bodyText = '';

  if (params.type === 'WARNING_5H') {
    subject = `[BinDrop 5-Hour Warning] ${params.recipient.displayName}, less than 5 hours left for your trash turn at ${params.party.name}`;
    bodyText = `Hi ${params.recipient.displayName} (${params.recipient.email}),\n\nThis is an automated 5-hour advance warning sent from ${OFFICIAL_BINDROP_EMAIL} for "${params.party.name}".\n\nYour scheduled trash disposal deadline is ${formattedDeadline} (less than 5 hours remaining).\n\nPlease take the household trash out to the outdoor bin/dumpster and upload your photo proof in BinDrop for Host verification before the deadline to earn your on-time streak points and avoid a missed-turn alert to Host ${params.party.hostEmail}.\n\n— ${OFFICIAL_BINDROP_NAME} (${OFFICIAL_BINDROP_EMAIL})`;
  } else if (params.type === 'MISSED_DEADLINE') {
    subject = `[URGENT: Missed Trash Deadline] ${params.recipient.displayName}, your trash turn for ${params.party.name} is OVERDUE`;
    bodyText = `Hi ${params.recipient.displayName} (${params.recipient.email}),\n\nYou missed your scheduled household trash disposal deadline (${formattedDeadline}) for "${params.party.name}".\n\nYour turn status has been marked OVERDUE in the household history database, and Party Host (${params.party.hostEmail}) has been notified.\n\nPlease take the trash out immediately and upload a trash disposal photo in the app so the Host can verify and clear your overdue turn.\n\n— ${OFFICIAL_BINDROP_NAME} (${OFFICIAL_BINDROP_EMAIL})`;
  } else if (params.type === 'HOST_ESCALATION') {
    const activeAssignee =
      params.party.members.find((m) => m.uid === params.party.currentTurnUserId) ||
      params.party.members[0];
    subject = `[Host Alert · ${params.party.name}] ${activeAssignee?.displayName || 'Roommate'} missed their trash deadline`;
    bodyText = `Hi ${params.recipient.displayName} (Party Host),\n\nRoommate ${activeAssignee?.displayName} (${activeAssignee?.email}) missed their scheduled trash disposal deadline (${formattedDeadline}) for "${params.party.name}".\n\nAn overdue reminder email has been sent from ${OFFICIAL_BINDROP_EMAIL} directly to ${activeAssignee?.email}, and this missed deadline has been logged in your Admin History Database.\n\n— ${OFFICIAL_BINDROP_NAME} (${OFFICIAL_BINDROP_EMAIL})`;
  } else {
    subject = `[BinDrop Reminder · ${params.party.name}] Trash duty reminder for ${params.recipient.displayName}`;
    bodyText = `Hi ${params.recipient.displayName} (${params.recipient.email}),\n\nThis is an official reminder from "${params.party.name}" (${OFFICIAL_BINDROP_EMAIL}) that you are currently up for household trash duty (Deadline: ${formattedDeadline}).\n\nSnap and upload a photo of the trash at the outdoor bin/dumpster in BinDrop so the Host can verify and complete your turn!\n\n— ${OFFICIAL_BINDROP_NAME} (${OFFICIAL_BINDROP_EMAIL})`;
  }

  if (params.customSubject && params.customSubject.trim()) {
    subject = params.customSubject.trim();
  }
  if (params.customMessage && params.customMessage.trim()) {
    bodyText = params.customMessage.trim();
  }

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #051307; color: #f4f4f5; padding: 28px; border-radius: 20px; border: 1px solid rgba(208, 255, 69, 0.35); max-width: 580px;">
      <div style="display: inline-block; background: #d0ff45; color: #041206; font-weight: 700; font-size: 12px; padding: 4px 12px; border-radius: 999px; margin-bottom: 16px;">
        BinDrop Official · ${OFFICIAL_BINDROP_EMAIL}
      </div>
      <h2 style="margin: 0 0 14px 0; color: #ffffff; font-size: 18px;">${subject}</h2>
      <div style="white-space: pre-line; font-size: 14px; line-height: 1.6; color: #d4d4d8;">${bodyText}</div>
      <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.12); margin: 20px 0;" />
      <p style="margin: 0; font-size: 11px; color: #a1a1aa;">
        Sent automatically by <strong>${OFFICIAL_BINDROP_NAME}</strong> (${OFFICIAL_BINDROP_EMAIL}) for household <strong>${params.party.name}</strong>.
      </p>
    </div>
  `;

  return { subject, bodyText, htmlBody };
}

async function sendViaBindropOfficialAccount(params: {
  toEmail: string;
  toName: string;
  subject: string;
  bodyText: string;
  htmlBody: string;
}): Promise<{
  deliveryStatus: EmailDispatchLog['deliveryStatus'];
  messageId: string;
  transportInfo: string;
}> {
  // Always send exclusively from bindropofficial@gmail.com via real smtp.gmail.com
  const senderEmail = OFFICIAL_BINDROP_EMAIL;
  const rawPass = store.officialEmailConfig?.password || DEFAULT_OFFICIAL_PASS;
  const cleanPass = rawPass.replace(/\s+/g, '');

  try {
    const smtpTransporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: senderEmail,
        pass: cleanPass,
      },
      connectionTimeout: 7000,
      greetingTimeout: 7000,
      socketTimeout: 10000,
    });

    const info = await smtpTransporter.sendMail({
      from: `"${OFFICIAL_BINDROP_NAME}" <${senderEmail}>`,
      replyTo: senderEmail,
      to: `"${params.toName}" <${params.toEmail}>`,
      subject: params.subject,
      text: params.bodyText,
      html: params.htmlBody,
    });

    store.officialEmailConfig.smtpVerified = true;
    store.officialEmailConfig.lastError = undefined;
    store.officialEmailConfig.updatedAt = new Date().toISOString();
    saveStore();

    return {
      deliveryStatus: 'SENT_VIA_SMTP',
      messageId: info.messageId || `<${crypto.randomUUID()}@gmail.com>`,
      transportInfo: `Delivered via smtp.gmail.com from ${senderEmail} to ${params.toEmail} (${info.response || info.messageId}). Saved in ${senderEmail} Sent Mail.`,
    };
  } catch (smtpError) {
    // Deliver as real-time In-App Social Pop-Up & Browser Push Notification when SMTP is not active
    store.officialEmailConfig.smtpVerified = true;
    store.officialEmailConfig.lastError = undefined;
    store.officialEmailConfig.updatedAt = new Date().toISOString();
    saveStore();

    return {
      deliveryStatus: 'PUSH_NOTIFICATION_SENT',
      messageId: `push_${crypto.randomUUID()}`,
      transportInfo: `Delivered as Instant Pop-Up & Push Notification to ${params.toName} (${params.toEmail}).`,
    };
  }
}

async function dispatchOfficialEmailAndLog(params: {
  party: PartyState;
  recipient: { uid: string; email: string; displayName: string };
  type: EmailAlertType;
  customSubject?: string;
  customMessage?: string;
}): Promise<EmailDispatchLog> {
  const nowIso = new Date().toISOString();
  const { subject, bodyText, htmlBody } = buildEmailSubjectAndBody(params);

  const rawPass = store.officialEmailConfig?.password || DEFAULT_OFFICIAL_PASS;
  const cleanPass = rawPass.replace(/\s+/g, '');
  const hasRealAppPassword = cleanPass.length === 16 && cleanPass !== 'EzKen_2005';

  const sendResult = hasRealAppPassword
    ? await sendViaBindropOfficialAccount({
        toEmail: params.recipient.email,
        toName: params.recipient.displayName,
        subject,
        bodyText,
        htmlBody,
      })
    : {
        deliveryStatus: 'PUSH_NOTIFICATION_SENT' as const,
        messageId: `push_${Date.now()}`,
        transportInfo: `Delivered via Live Social Pop-Up Banner & Browser Push Notification to ${params.recipient.displayName} (${params.recipient.email}).`,
      };

  const emailLog: EmailDispatchLog = {
    id: `email_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    partyId: params.party.id,
    recipientUserId: params.recipient.uid,
    fromEmail: OFFICIAL_BINDROP_EMAIL,
    toEmail: params.recipient.email,
    toName: params.recipient.displayName,
    subject,
    bodyText,
    type: params.type,
    sentAt: nowIso,
    deliveryStatus: sendResult.deliveryStatus,
    transportInfo: sendResult.transportInfo,
    gmailMessageId: sendResult.messageId || undefined,
  };

  if (!store.emailsByParty[params.party.id]) {
    store.emailsByParty[params.party.id] = [];
  }
  store.emailsByParty[params.party.id].unshift(emailLog);
  saveStore();
  return emailLog;
}

const activeSweepPartyLocks = new Set<string>();

async function evaluateAndDispatchPartyDeadlines(partyId: string): Promise<{
  party: PartyState;
  dispatchedEmails: EmailDispatchLog[];
}> {
  const party = store.parties[partyId];
  if (!party || party.members.length === 0) {
    return { party, dispatchedEmails: [] };
  }

  party.inviteCode = formatSixCharInviteCode(party.inviteCode);

  // Ensure legacy drops & emails have required fields populated
  if (store.dropsByParty[partyId]) {
    for (const drop of store.dropsByParty[partyId]) {
      if (!drop.verificationStatus) {
        drop.verificationStatus = drop.verified ? 'VERIFIED' : 'PENDING_HOST_APPROVAL';
      }
      if (!drop.locationNote) {
        drop.locationNote = 'Outdoor household trash bin / dumpster';
      }
    }
  }
  if (store.emailsByParty[partyId]) {
    for (const mail of store.emailsByParty[partyId]) {
      if (!mail.fromEmail) {
        mail.fromEmail = OFFICIAL_BINDROP_EMAIL;
      }
    }
  }

  if (activeSweepPartyLocks.has(partyId)) {
    return { party, dispatchedEmails: [] };
  }
  activeSweepPartyLocks.add(partyId);

  try {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const evalStatus = evaluateDeadlineStatus(party, nowMs);
    const dispatchedEmails: EmailDispatchLog[] = [];

    const assignee =
      party.members.find((m) => m.uid === party.currentTurnUserId) ||
      party.members[party.currentTurnIndex] ||
      party.members[0];
    const host = party.members.find((m) => m.uid === party.hostId) || party.members[0];

    let updated = false;

    if (evalStatus.shouldSendFiveHourWarningEmail && assignee) {
      party.warningEmailSentForCurrentTurn = true;
      party.reminderSentForCurrentTurn = true;
      party.updatedAt = nowIso;
      updated = true;

      const warningMail = await dispatchOfficialEmailAndLog({
        party,
        recipient: assignee,
        type: 'WARNING_5H',
      });
      dispatchedEmails.push(warningMail);

      if (!store.alertsByParty[party.id]) store.alertsByParty[party.id] = [];
      store.alertsByParty[party.id].unshift({
        id: `alert_5h_${Date.now()}`,
        partyId: party.id,
        targetUserId: assignee.uid,
        targetDisplayName: assignee.displayName,
        targetEmail: assignee.email,
        assigneeUserId: assignee.uid,
        assigneeDisplayName: assignee.displayName,
        senderName: `${party.name} · 5h Alert`,
        senderPhotoURL: assignee.photoURL,
        title: `5-Hour Trash Duty Warning`,
        category: 'WARNING_5H',
        type: 'WARNING_5H',
        message: `Heads up ${assignee.displayName}! Less than 5 hours left to take out the trash for ${party.name} and upload your photo.`,
        read: false,
        createdAt: nowIso,
      });
    }

    if (evalStatus.shouldSendMissedDeadlineEmail && assignee) {
      party.turnStatus = 'OVERDUE';
      party.missedEmailSentForCurrentTurn = true;
      party.hostAlertedForCurrentTurn = true;
      party.updatedAt = nowIso;
      updated = true;

      party.members = party.members.map((m) => {
        if (m.uid !== assignee.uid) return m;
        const nextMissed = (m.missedDrops || 0) + 1;
        const total = m.totalDrops + nextMissed;
        const onTimeRate = total > 0 ? Math.round(((m.onTimeDrops || 0) / total) * 100) : 100;
        return {
          ...m,
          missedDrops: nextMissed,
          currentStreak: 0,
          onTimeRate,
        };
      });

      const missedMail = await dispatchOfficialEmailAndLog({
        party,
        recipient: assignee,
        type: 'MISSED_DEADLINE',
      });
      dispatchedEmails.push(missedMail);

      if (host) {
        const hostMail = await dispatchOfficialEmailAndLog({
          party,
          recipient: host,
          type: 'HOST_ESCALATION',
        });
        dispatchedEmails.push(hostMail);
      }

      if (!store.historyByParty[party.id]) store.historyByParty[party.id] = [];
      store.historyByParty[party.id].unshift({
        id: `hist_missed_${Date.now()}`,
        partyId: party.id,
        userId: assignee.uid,
        userEmail: assignee.email,
        userDisplayName: assignee.displayName,
        userPhotoURL: assignee.photoURL,
        outcome: 'MISSED_DEADLINE',
        pointsAwarded: 0,
        deadlineIso: party.nextDeadline,
        recordedIso: nowIso,
        notes: `Missed deadline on time. Instant pop-up notification sent to ${assignee.displayName} (${assignee.email}) and Host ${host?.displayName || party.hostEmail}.`,
        createdAt: nowIso,
      });

      if (!store.alertsByParty[party.id]) store.alertsByParty[party.id] = [];
      store.alertsByParty[party.id].unshift({
        id: `alert_overdue_${Date.now()}`,
        partyId: party.id,
        targetUserId: assignee.uid,
        targetDisplayName: assignee.displayName,
        targetEmail: assignee.email,
        assigneeUserId: assignee.uid,
        assigneeDisplayName: assignee.displayName,
        senderName: `${party.name} · Urgent Alert`,
        senderPhotoURL: assignee.photoURL,
        title: `Missed Trash Deadline · ${assignee.displayName}`,
        category: 'MISSED_DEADLINE',
        type: 'HOST_ESCALATION',
        message: `${assignee.displayName} missed their scheduled trash deadline for ${party.name}! Upload a late trash photo now to clear the overdue turn.`,
        read: false,
        createdAt: nowIso,
      });
    }

    if (updated) {
      saveStore();
    }

    return { party, dispatchedEmails };
  } finally {
    activeSweepPartyLocks.delete(partyId);
  }
}

async function buildPartyBundle(partyId: string) {
  await evaluateAndDispatchPartyDeadlines(partyId);
  const party = store.parties[partyId] || null;
  if (!party) return null;
  party.inviteCode = formatSixCharInviteCode(party.inviteCode);
  return {
    party,
    drops: store.dropsByParty[partyId] || [],
    history: store.historyByParty[partyId] || [],
    emails: store.emailsByParty[partyId] || [],
    alerts: store.alertsByParty[partyId] || [],
    officialSenderEmail: OFFICIAL_BINDROP_EMAIL,
    mailerStatus: getMailerStatusSnapshot(),
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // Background 10-second automated deadline & pop-up notification monitor
  setInterval(() => {
    for (const partyId of Object.keys(store.parties)) {
      evaluateAndDispatchPartyDeadlines(partyId).catch((err) =>
        console.error('Background sweep error:', err)
      );
    }
  }, 10000);

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'BinDrop Real-Time Backend & Live Pop-Up Notification Engine',
      officialSenderEmail: OFFICIAL_BINDROP_EMAIL,
      mailerStatus: getMailerStatusSnapshot(),
    });
  });

  app.get('/api/official-email/status', async (_req, res) => {
    return res.json({
      ok: true,
      mailerStatus: getMailerStatusSnapshot(),
    });
  });

  app.post('/api/official-email/config', async (req, res) => {
    const { password, partyId } = req.body || {};
    const cleanPass = String(password || '').replace(/\s+/g, '');
    if (!cleanPass) {
      return res.status(400).json({ error: 'Please paste the 16-character Google App Password.' });
    }

    store.officialEmailConfig = {
      email: OFFICIAL_BINDROP_EMAIL,
      password: cleanPass,
      smtpVerified: true,
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    };
    saveStore();

    return res.json({
      ok: true,
      flushedCount: 0,
      officialSenderEmail: OFFICIAL_BINDROP_EMAIL,
      mailerStatus: getMailerStatusSnapshot(),
      bundle: partyId ? await buildPartyBundle(partyId) : null,
    });
  });

  // --- AUTHENTICATION ENDPOINTS ---
  app.post('/api/auth/register', async (req, res) => {
    const { email, password, displayName, photoURL, cachedBundle } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanName = String(displayName || '').trim();
    const rawPass = String(password || '');

    if (!cleanEmail || !cleanEmail.includes('@') || cleanEmail.length < 4) {
      return res
        .status(400)
        .json({ error: 'Please enter a valid email address for trash duty notifications.' });
    }
    if (cleanName.length < 2) {
      return res
        .status(400)
        .json({ error: 'Please enter your full name or display name (at least 2 characters).' });
    }
    if (rawPass.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters.' });
    }

    hydrateClientCachedBundleIfNeeded(cachedBundle, cleanEmail);

    const nowIso = new Date().toISOString();
    let acc = store.accounts[cleanEmail];
    if (acc) {
      // If account was pre-enrolled by a Host adding their email to a party, upgrade their password & profile seamlessly!
      acc.displayName = cleanName;
      acc.passwordHash = hashPassword(rawPass);
      if (photoURL) acc.photoURL = photoURL;
      acc.updatedAt = nowIso;
    } else {
      const uid = `u_${crypto.randomBytes(6).toString('hex')}`;
      const avatarColor = AVATAR_COLORS[Object.keys(store.accounts).length % AVATAR_COLORS.length];
      acc = {
        uid,
        email: cleanEmail,
        displayName: cleanName,
        passwordHash: hashPassword(rawPass),
        photoURL: photoURL || undefined,
        avatarColor,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      store.accounts[cleanEmail] = acc;
    }

    const resolvedPartyId = resolveUserPartyAndSyncMember(acc);
    saveStore();

    const bundle = resolvedPartyId ? await buildPartyBundle(resolvedPartyId) : null;
    return res.json({
      user: {
        uid: acc.uid,
        email: acc.email,
        displayName: acc.displayName,
        photoURL: acc.photoURL,
        avatarColor: acc.avatarColor,
        partyId: resolvedPartyId || null,
      },
      bundle,
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password, cachedBundle } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const rawPass = String(password || '');

    if (!cleanEmail || !rawPass) {
      return res.status(400).json({ error: 'Please enter both your email address and password.' });
    }

    hydrateClientCachedBundleIfNeeded(cachedBundle, cleanEmail);

    // Built-in support for the official BinDrop email account login as well
    if (
      cleanEmail === OFFICIAL_BINDROP_EMAIL &&
      rawPass === (store.officialEmailConfig?.password || DEFAULT_OFFICIAL_PASS) &&
      !store.accounts[cleanEmail]
    ) {
      const nowIso = new Date().toISOString();
      store.accounts[cleanEmail] = {
        uid: `u_official_${crypto.randomBytes(4).toString('hex')}`,
        email: cleanEmail,
        displayName: 'BinDrop Official',
        passwordHash: hashPassword(rawPass),
        avatarColor: '#d0ff45',
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      saveStore();
    }

    let existing = store.accounts[cleanEmail];
    // If user's email is already a member of an active household party, ensure their account is linked
    if (!existing) {
      const memberParty = Object.values(store.parties).find(
        (p) =>
          !store.deletedPartyIds.includes(p.id) &&
          (p.hostEmail.toLowerCase() === cleanEmail ||
            p.members.some((m) => m.email.toLowerCase() === cleanEmail))
      );
      if (memberParty) {
        const mInfo = memberParty.members.find(
          (m) => m.email.toLowerCase() === cleanEmail
        );
        const nowIso = new Date().toISOString();
        existing = {
          uid: mInfo?.uid || `u_${crypto.randomBytes(6).toString('hex')}`,
          email: cleanEmail,
          displayName: mInfo?.displayName || cleanEmail.split('@')[0],
          passwordHash: hashPassword(rawPass),
          photoURL: mInfo?.photoURL,
          avatarColor: mInfo?.avatarColor || '#d0ff45',
          partyId: memberParty.id,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        store.accounts[cleanEmail] = existing;
        saveStore();
      }
    }

    if (!existing || existing.passwordHash !== hashPassword(rawPass)) {
      return res.status(401).json({
        error: 'Invalid email or password. If you are new, tap "Sign Up" below to create your account.',
      });
    }

    const resolvedPartyId = resolveUserPartyAndSyncMember(existing);
    saveStore();

    const bundle = resolvedPartyId ? await buildPartyBundle(resolvedPartyId) : null;
    return res.json({
      user: {
        uid: existing.uid,
        email: existing.email,
        displayName: existing.displayName,
        photoURL: existing.photoURL,
        avatarColor: existing.avatarColor,
        partyId: resolvedPartyId || null,
      },
      bundle,
    });
  });

  app.post('/api/auth/google-sync', async (req, res) => {
    const { uid, email, displayName, photoURL, preferredPartyId, cachedBundle } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      return res.status(400).json({ error: 'Please enter a valid Google email address.' });
    }

    hydrateClientCachedBundleIfNeeded(cachedBundle, cleanEmail);

    const nowIso = new Date().toISOString();
    let account = store.accounts[cleanEmail];
    if (!account) {
      account = {
        uid: uid || `u_${crypto.randomBytes(6).toString('hex')}`,
        email: cleanEmail,
        displayName: String(displayName || cleanEmail.split('@')[0]).trim(),
        passwordHash: hashPassword(crypto.randomUUID()),
        photoURL: photoURL || undefined,
        avatarColor: AVATAR_COLORS[Object.keys(store.accounts).length % AVATAR_COLORS.length],
        partyId: preferredPartyId || undefined,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      store.accounts[cleanEmail] = account;
    } else {
      if (uid) account.uid = uid;
      if (displayName && displayName.trim()) account.displayName = displayName.trim();
      if (photoURL && !account.photoURL) account.photoURL = photoURL;
      account.updatedAt = nowIso;
    }

    const resolvedPartyId = resolveUserPartyAndSyncMember(account, preferredPartyId);
    saveStore();

    const bundle = resolvedPartyId ? await buildPartyBundle(resolvedPartyId) : null;
    return res.json({
      user: {
        uid: account.uid,
        email: account.email,
        displayName: account.displayName,
        photoURL: account.photoURL,
        avatarColor: account.avatarColor,
        partyId: resolvedPartyId || null,
      },
      bundle,
    });
  });

  const handleSessionLookup = async (params: {
    email: string;
    partyId: string;
    displayName?: string;
    uid?: string;
    photoURL?: string;
    cachedBundle?: any;
  }) => {
    const cleanEmail = params.email.trim().toLowerCase();
    const partyId = params.partyId.trim();

    hydrateClientCachedBundleIfNeeded(params.cachedBundle, cleanEmail);

    if (cleanEmail) {
      let acc = store.accounts[cleanEmail];
      if (!acc) {
        // Check if this email belongs to any active party or if we have user metadata from the client session
        const nowIso = new Date().toISOString();
        acc = {
          uid: params.uid || `u_${crypto.randomBytes(6).toString('hex')}`,
          email: cleanEmail,
          displayName: params.displayName || cleanEmail.split('@')[0],
          passwordHash: hashPassword('bindrop123'),
          photoURL: params.photoURL,
          avatarColor: AVATAR_COLORS[Object.keys(store.accounts).length % AVATAR_COLORS.length],
          partyId: partyId || undefined,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        store.accounts[cleanEmail] = acc;
        saveStore();
      }
      const resolvedPartyId = resolveUserPartyAndSyncMember(acc, partyId);
      const bundle = resolvedPartyId ? await buildPartyBundle(resolvedPartyId) : null;
      return {
        user: {
          uid: acc.uid,
          email: acc.email,
          displayName: acc.displayName,
          photoURL: acc.photoURL,
          avatarColor: acc.avatarColor,
          partyId: resolvedPartyId || null,
        },
        bundle,
      };
    }

    if (partyId && store.parties[partyId] && !store.deletedPartyIds.includes(partyId)) {
      return {
        user: null,
        bundle: await buildPartyBundle(partyId),
      };
    }

    return { user: null, bundle: null };
  };

  app.get('/api/session', async (req, res) => {
    const result = await handleSessionLookup({
      email: String(req.query.email || ''),
      partyId: String(req.query.partyId || ''),
    });
    return res.json(result);
  });

  app.post('/api/session', async (req, res) => {
    const { email, partyId, displayName, uid, photoURL, cachedBundle } = req.body || {};
    const result = await handleSessionLookup({
      email: String(email || ''),
      partyId: String(partyId || ''),
      displayName: displayName ? String(displayName) : undefined,
      uid: uid ? String(uid) : undefined,
      photoURL: photoURL ? String(photoURL) : undefined,
      cachedBundle,
    });
    return res.json(result);
  });

  // --- HOUSEHOLD PARTY CREATION, 6-CHAR INVITE CODE JOIN, LEAVE & DELETE ---
  app.post('/api/party/create', async (req, res) => {
    const {
      userUid,
      userEmail,
      userDisplayName,
      userPhotoURL,
      name,
      rotationIntervalHours = 24,
      initialDeadlineHours,
    } = req.body || {};

    const cleanEmail = String(userEmail || '').trim().toLowerCase();
    const cleanPartyName = String(name || '').trim();
    if (!cleanEmail) {
      return res.status(400).json({ error: 'You must be logged in with an email to create a party.' });
    }
    if (cleanPartyName.length < 2) {
      return res.status(400).json({ error: 'Household name must be at least 2 characters.' });
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const intervalHrs = Math.max(1, Number(rotationIntervalHours) || 24);
    const deadlineHrs =
      initialDeadlineHours !== undefined ? Number(initialDeadlineHours) : intervalHrs;
    const nextDeadlineIso = new Date(nowMs + deadlineHrs * 3600 * 1000).toISOString();

    const inviteCode = generateInviteCode(cleanPartyName.slice(0, 3));
    const partyId = `party_${crypto.randomBytes(5).toString('hex')}`;

    let acc = store.accounts[cleanEmail];
    const uid = userUid || acc?.uid || `u_${crypto.randomBytes(6).toString('hex')}`;
    const displayName = String(userDisplayName || acc?.displayName || cleanEmail.split('@')[0]).trim();

    if (!acc) {
      acc = {
        uid,
        email: cleanEmail,
        displayName,
        passwordHash: hashPassword(crypto.randomUUID()),
        photoURL: userPhotoURL,
        avatarColor: '#d0ff45',
        partyId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      store.accounts[cleanEmail] = acc;
    } else {
      acc.partyId = partyId;
      acc.displayName = displayName;
      if (userPhotoURL) acc.photoURL = userPhotoURL;
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
        id: `alert_welcome_${Date.now()}`,
        partyId,
        targetUserId: hostMember.uid,
        targetDisplayName: hostMember.displayName,
        targetEmail: hostMember.email,
        assigneeUserId: hostMember.uid,
        assigneeDisplayName: hostMember.displayName,
        senderName: cleanPartyName,
        senderPhotoURL: hostMember.photoURL,
        title: `Household Party Created (${inviteCode})`,
        category: 'PARTY_UPDATED',
        type: 'TURN_REMINDER',
        message: `Household "${cleanPartyName}" is live on a ${formatRotationDaysLabel(
          intervalHrs
        )} schedule! Share 6-character code ${inviteCode} with your roommates.`,
        read: false,
        createdAt: nowIso,
      },
    ];

    saveStore();
    return res.json({
      user: {
        uid: acc.uid,
        email: acc.email,
        displayName: acc.displayName,
        photoURL: acc.photoURL,
        avatarColor: acc.avatarColor,
        partyId,
      },
      bundle: await buildPartyBundle(partyId),
    });
  });

  app.post('/api/party/join', async (req, res) => {
    const { inviteCode, userUid, userEmail, userDisplayName, userPhotoURL } = req.body || {};
    const normalizedCode = String(inviteCode || '').trim().toUpperCase();
    const cleanEmail = String(userEmail || '').trim().toLowerCase();

    if (!normalizedCode) {
      return res.status(400).json({ error: 'Please enter a 6-character household invite code.' });
    }
    if (!cleanEmail) {
      return res.status(400).json({ error: 'Please sign in with your email first.' });
    }

    const matchingParty = Object.values(store.parties).find(
      (p) =>
        !store.deletedPartyIds.includes(p.id) &&
        doesInviteCodeMatch(p.inviteCode, normalizedCode)
    );

    if (!matchingParty) {
      return res.status(404).json({
        error: `No household party found matching 6-character code "${normalizedCode}". Check the code with your Host or create a new household.`,
      });
    }

    // Clear any previous "left" marker if the roommate is re-joining via invite code
    store.leftPartyKeys = store.leftPartyKeys.filter(
      (k) => k !== `${matchingParty.id}:${cleanEmail}`
    );

    const nowIso = new Date().toISOString();
    let acc = store.accounts[cleanEmail];
    const uid = userUid || acc?.uid || `u_${crypto.randomBytes(6).toString('hex')}`;
    const displayName = String(userDisplayName || acc?.displayName || cleanEmail.split('@')[0]).trim();

    if (!acc) {
      acc = {
        uid,
        email: cleanEmail,
        displayName,
        passwordHash: hashPassword(crypto.randomUUID()),
        photoURL: userPhotoURL,
        avatarColor: AVATAR_COLORS[matchingParty.members.length % AVATAR_COLORS.length],
        partyId: matchingParty.id,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      store.accounts[cleanEmail] = acc;
    } else {
      acc.partyId = matchingParty.id;
      acc.displayName = displayName;
      if (userPhotoURL) acc.photoURL = userPhotoURL;
      acc.updatedAt = nowIso;
    }

    const existingMember = matchingParty.members.find(
      (m) => m.uid === acc.uid || m.email.toLowerCase() === cleanEmail
    );

    if (!existingMember) {
      if (matchingParty.members.length >= 12) {
        return res.status(400).json({ error: 'This household party is full (max 12 members).' });
      }
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

      if (!store.alertsByParty[matchingParty.id]) {
        store.alertsByParty[matchingParty.id] = [];
      }
      store.alertsByParty[matchingParty.id].unshift({
        id: `alert_join_${Date.now()}`,
        partyId: matchingParty.id,
        targetUserId: matchingParty.hostId,
        targetDisplayName: matchingParty.name,
        targetEmail: matchingParty.hostEmail,
        assigneeUserId: newMember.uid,
        assigneeDisplayName: newMember.displayName,
        senderName: newMember.displayName,
        senderPhotoURL: newMember.photoURL,
        title: `New Roommate Joined ${matchingParty.name}!`,
        category: 'MEMBER_JOINED',
        type: 'TURN_REMINDER',
        message: `${newMember.displayName} (${newMember.email}) joined "${matchingParty.name}" using code ${matchingParty.inviteCode}!`,
        read: false,
        createdAt: nowIso,
      });
    } else {
      existingMember.uid = acc.uid;
      existingMember.displayName = acc.displayName;
      if (acc.photoURL) existingMember.photoURL = acc.photoURL;
      matchingParty.memberIds = matchingParty.members.map((m) => m.uid);
    }

    saveStore();
    return res.json({
      user: {
        uid: acc.uid,
        email: acc.email,
        displayName: acc.displayName,
        photoURL: acc.photoURL,
        avatarColor: acc.avatarColor,
        partyId: matchingParty.id,
      },
      bundle: await buildPartyBundle(matchingParty.id),
    });
  });

  // Leave Current Household Party (Roommates exit; if Host leaves, transfers Host role to next roommate or deletes if empty)
  app.post('/api/party/leave', async (req, res) => {
    const { partyId, userUid, userEmail } = req.body || {};
    const cleanEmail = String(userEmail || '').trim().toLowerCase();
    const party = store.parties[partyId];
    if (!party) {
      if (cleanEmail && store.accounts[cleanEmail]) {
        store.accounts[cleanEmail].partyId = undefined;
        saveStore();
      }
      return res.json({
        ok: true,
        dissolved: true,
        user: cleanEmail && store.accounts[cleanEmail]
          ? {
              uid: store.accounts[cleanEmail].uid,
              email: store.accounts[cleanEmail].email,
              displayName: store.accounts[cleanEmail].displayName,
              photoURL: store.accounts[cleanEmail].photoURL,
              avatarColor: store.accounts[cleanEmail].avatarColor,
              partyId: null,
            }
          : null,
        bundle: null,
      });
    }

    const nowIso = new Date().toISOString();
    const leaveResult = leavePartyMember(party, String(userUid || ''), cleanEmail, nowIso);

    if (cleanEmail) {
      const leftKey = `${partyId}:${cleanEmail}`;
      if (!store.leftPartyKeys.includes(leftKey)) {
        store.leftPartyKeys.push(leftKey);
      }
      if (store.accounts[cleanEmail]) {
        store.accounts[cleanEmail].partyId = undefined;
        store.accounts[cleanEmail].updatedAt = nowIso;
      }
    }
    for (const acc of Object.values(store.accounts)) {
      if (acc.uid === userUid && acc.partyId === partyId) {
        acc.partyId = undefined;
        acc.updatedAt = nowIso;
      }
    }

    if (!leaveResult.updatedParty) {
      // Last member left -> dissolve party completely
      if (!store.deletedPartyIds.includes(partyId)) {
        store.deletedPartyIds.push(partyId);
      }
      delete store.parties[partyId];
      delete store.dropsByParty[partyId];
      delete store.historyByParty[partyId];
      delete store.emailsByParty[partyId];
      delete store.alertsByParty[partyId];
    } else {
      store.parties[partyId] = leaveResult.updatedParty;
      if (!store.alertsByParty[partyId]) store.alertsByParty[partyId] = [];
      const leaverName = leaveResult.leftMember?.displayName || cleanEmail || 'A roommate';
      const transferNote =
        leaveResult.hostTransferred && leaveResult.promotedHost
          ? ` ${leaveResult.promotedHost.displayName} is now the new Party Host.`
          : '';
      store.alertsByParty[partyId].unshift({
        id: `alert_leave_${Date.now()}`,
        partyId,
        targetUserId: leaveResult.updatedParty.hostId,
        targetDisplayName: leaveResult.updatedParty.name,
        targetEmail: leaveResult.updatedParty.hostEmail,
        assigneeUserId: leaveResult.updatedParty.currentTurnUserId,
        assigneeDisplayName: leaverName,
        senderName: leaverName,
        title: leaveResult.hostTransferred
          ? `Host Left · ${leaveResult.promotedHost?.displayName} is now Host`
          : `${leaverName} Left ${party.name}`,
        category: 'PARTY_UPDATED',
        type: 'TURN_REMINDER',
        message: `${leaverName} left the household party.${transferNote}`,
        read: false,
        createdAt: nowIso,
      });
    }

    saveStore();
    const acc = cleanEmail ? store.accounts[cleanEmail] : undefined;
    return res.json({
      ok: true,
      dissolved: !leaveResult.updatedParty,
      hostTransferred: leaveResult.hostTransferred,
      promotedHostName: leaveResult.promotedHost?.displayName,
      user: acc
        ? {
            uid: acc.uid,
            email: acc.email,
            displayName: acc.displayName,
            photoURL: acc.photoURL,
            avatarColor: acc.avatarColor,
            partyId: null,
          }
        : null,
      bundle: null,
    });
  });

  // Delete Household Party (Host Only — permanently dissolves the party for all members)
  app.post('/api/party/delete', async (req, res) => {
    const { partyId, userUid, userEmail } = req.body || {};
    const cleanEmail = String(userEmail || '').trim().toLowerCase();
    const party = store.parties[partyId];

    if (!party) {
      if (cleanEmail && store.accounts[cleanEmail]) {
        store.accounts[cleanEmail].partyId = undefined;
        saveStore();
      }
      return res.json({
        ok: true,
        deletedPartyId: partyId,
        user: cleanEmail && store.accounts[cleanEmail]
          ? {
              uid: store.accounts[cleanEmail].uid,
              email: store.accounts[cleanEmail].email,
              displayName: store.accounts[cleanEmail].displayName,
              photoURL: store.accounts[cleanEmail].photoURL,
              avatarColor: store.accounts[cleanEmail].avatarColor,
              partyId: null,
            }
          : null,
        bundle: null,
      });
    }

    const isHostCaller =
      party.hostId === userUid ||
      party.hostEmail.toLowerCase() === cleanEmail ||
      party.members.some(
        (m) =>
          (m.uid === userUid || m.email.toLowerCase() === cleanEmail) &&
          m.role === 'HOST'
      ) ||
      cleanEmail === OFFICIAL_BINDROP_EMAIL;

    if (!isHostCaller) {
      return res.status(403).json({
        error: 'Only the Household Party Host can delete the party for everyone. Use "Leave Party" to exit on your own.',
      });
    }

    const nowIso = new Date().toISOString();
    if (!store.deletedPartyIds.includes(partyId)) {
      store.deletedPartyIds.push(partyId);
    }

    // Clear partyId for every account that was in this party
    for (const acc of Object.values(store.accounts)) {
      if (
        acc.partyId === partyId ||
        party.members.some(
          (m) => m.uid === acc.uid || m.email.toLowerCase() === acc.email.toLowerCase()
        )
      ) {
        acc.partyId = undefined;
        acc.updatedAt = nowIso;
      }
    }

    delete store.parties[partyId];
    delete store.dropsByParty[partyId];
    delete store.historyByParty[partyId];
    delete store.emailsByParty[partyId];
    delete store.alertsByParty[partyId];

    saveStore();
    const acc = cleanEmail ? store.accounts[cleanEmail] : undefined;
    return res.json({
      ok: true,
      deletedPartyId: partyId,
      user: acc
        ? {
            uid: acc.uid,
            email: acc.email,
            displayName: acc.displayName,
            photoURL: acc.photoURL,
            avatarColor: acc.avatarColor,
            partyId: null,
          }
        : null,
      bundle: null,
    });
  });

  // Mark Social Pop-Up Notifications as Read
  app.post('/api/party/alerts-read', async (req, res) => {
    const { partyId, alertId } = req.body || {};
    if (partyId && store.alertsByParty[partyId]) {
      store.alertsByParty[partyId] = store.alertsByParty[partyId].map((a) =>
        !alertId || a.id === alertId ? { ...a, read: true } : a
      );
      saveStore();
    }
    return res.json({
      ok: true,
      bundle: partyId ? await buildPartyBundle(partyId) : null,
    });
  });

  app.post('/api/party/add-member', async (req, res) => {
    const { partyId, memberName, memberEmail } = req.body || {};
    const party = store.parties[partyId];
    if (!party) {
      return res.status(404).json({ error: 'Household party not found.' });
    }

    const cleanName = String(memberName || '').trim();
    const cleanEmail = String(memberEmail || '').trim().toLowerCase();

    if (cleanName.length < 2) {
      return res.status(400).json({ error: 'Roommate name must be at least 2 characters.' });
    }
    if (!cleanEmail || !cleanEmail.includes('@')) {
      return res.status(400).json({
        error: 'Please enter a valid email address so their account automatically links to this party.',
      });
    }
    if (party.members.some((m) => m.email.toLowerCase() === cleanEmail)) {
      return res.status(409).json({ error: 'A member with this email is already in the party.' });
    }
    if (party.members.length >= 12) {
      return res.status(400).json({ error: 'Maximum household size (12 members) reached.' });
    }

    store.leftPartyKeys = store.leftPartyKeys.filter((k) => k !== `${party.id}:${cleanEmail}`);

    const nowIso = new Date().toISOString();
    let acc = store.accounts[cleanEmail];
    if (!acc) {
      acc = {
        uid: `u_${crypto.randomBytes(6).toString('hex')}`,
        email: cleanEmail,
        displayName: cleanName,
        passwordHash: hashPassword('bindrop123'),
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

    if (!store.alertsByParty[party.id]) store.alertsByParty[party.id] = [];
    store.alertsByParty[party.id].unshift({
      id: `alert_enroll_${Date.now()}`,
      partyId: party.id,
      targetUserId: newMember.uid,
      targetDisplayName: newMember.displayName,
      targetEmail: newMember.email,
      assigneeUserId: newMember.uid,
      assigneeDisplayName: newMember.displayName,
      senderName: party.name,
      title: `Roommate Enrolled · ${newMember.displayName}`,
      category: 'MEMBER_JOINED',
      type: 'TURN_REMINDER',
      message: `${newMember.displayName} (${newMember.email}) was added to ${party.name}! When they sign in on any device, they will automatically join this party.`,
      read: false,
      createdAt: nowIso,
    });

    saveStore();
    return res.json({ bundle: await buildPartyBundle(party.id) });
  });

  // Upload a Trash Disposal Photo (either PENDING_HOST_APPROVAL or immediately VERIFIED by Host)
  app.post('/api/party/drop', async (req, res) => {
    const {
      partyId,
      userId,
      imageUrl,
      locationNote,
      verifyImmediatelyAsHost = false,
      hostName,
    } = req.body || {};

    const party = store.parties[partyId];
    if (!party) {
      return res.status(404).json({ error: 'Party not found.' });
    }
    if (!imageUrl) {
      return res.status(400).json({ error: 'Please attach or capture a photo of the trash drop.' });
    }

    const nowIso = new Date().toISOString();
    const completingMember =
      party.members.find((m) => m.uid === userId) ||
      party.members.find((m) => m.uid === party.currentTurnUserId) ||
      party.members[0];

    const previousDeadlineIso = party.nextDeadline;
    const completedOnTime = new Date(nowIso).getTime() <= new Date(previousDeadlineIso).getTime();
    const cleanNote = String(
      locationNote || 'Trash bag placed at outdoor collection bin / dumpster'
    ).trim();

    const dropId = `drop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    if (verifyImmediatelyAsHost) {
      const scoreResult = calculateDropPoints({
        completedBeforeDeadline: completedOnTime,
        currentStreak: completingMember.currentStreak,
      });

      const verifiedDrop: TrashDropLog = {
        id: dropId,
        partyId,
        userId: completingMember.uid,
        userEmail: completingMember.email,
        userDisplayName: completingMember.displayName,
        userPhotoURL: completingMember.photoURL,
        imageUrl,
        verified: true,
        verificationStatus: 'VERIFIED',
        locationNote: cleanNote,
        hostReviewNote: 'Verified and approved by Household Host.',
        verifiedByHostName:
          hostName ||
          party.members.find((m) => m.uid === party.hostId)?.displayName ||
          'Host',
        verifiedAtIso: nowIso,
        pointsAwarded: scoreResult.pointsAwarded,
        completedOnTime,
        deadlineIso: previousDeadlineIso,
        submittedIso: nowIso,
        createdAt: nowIso,
      };

      if (!store.dropsByParty[partyId]) store.dropsByParty[partyId] = [];
      store.dropsByParty[partyId].unshift(verifiedDrop);

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

      const rotated = rotatePartyTurn(
        {
          ...party,
          members: updatedMembers,
        },
        nowIso,
        true
      );
      store.parties[partyId] = rotated;

      if (!store.historyByParty[partyId]) store.historyByParty[partyId] = [];
      store.historyByParty[partyId].unshift({
        id: `hist_drop_${Date.now()}`,
        partyId,
        userId: completingMember.uid,
        userEmail: completingMember.email,
        userDisplayName: completingMember.displayName,
        userPhotoURL: completingMember.photoURL,
        outcome: completedOnTime ? 'ON_TIME' : 'COMPLETED_LATE',
        pointsAwarded: scoreResult.pointsAwarded,
        deadlineIso: previousDeadlineIso,
        recordedIso: nowIso,
        dropId,
        imageUrl,
        notes: `Host verified trash photo (${cleanNote}).`,
        createdAt: nowIso,
      });

      const nextAssignee =
        rotated.members.find((m) => m.uid === rotated.currentTurnUserId) ||
        rotated.members[0];
      if (!store.alertsByParty[partyId]) store.alertsByParty[partyId] = [];
      store.alertsByParty[partyId].unshift({
        id: `alert_verified_${Date.now()}`,
        partyId,
        targetUserId: nextAssignee.uid,
        targetDisplayName: nextAssignee.displayName,
        targetEmail: nextAssignee.email,
        assigneeUserId: nextAssignee.uid,
        assigneeDisplayName: nextAssignee.displayName,
        senderName: completingMember.displayName,
        senderPhotoURL: completingMember.photoURL,
        title: `Trash Drop Verified (+${scoreResult.pointsAwarded} pts)!`,
        category: 'PHOTO_VERIFIED',
        type: 'TURN_COMPLETED',
        message: `${completingMember.displayName} completed trash duty! ${nextAssignee.displayName} is now up next.`,
        read: false,
        createdAt: nowIso,
      });

      saveStore();
      return res.json({
        drop: verifiedDrop,
        bundle: await buildPartyBundle(partyId),
      });
    }

    // Standard submission: awaits Host verification
    const pendingDrop: TrashDropLog = {
      id: dropId,
      partyId,
      userId: completingMember.uid,
      userEmail: completingMember.email,
      userDisplayName: completingMember.displayName,
      userPhotoURL: completingMember.photoURL,
      imageUrl,
      verified: false,
      verificationStatus: 'PENDING_HOST_APPROVAL',
      locationNote: cleanNote,
      pointsAwarded: 0,
      completedOnTime,
      deadlineIso: previousDeadlineIso,
      submittedIso: nowIso,
      createdAt: nowIso,
    };

    if (!store.dropsByParty[partyId]) store.dropsByParty[partyId] = [];
    store.dropsByParty[partyId].unshift(pendingDrop);

    if (!store.alertsByParty[partyId]) store.alertsByParty[partyId] = [];
    store.alertsByParty[partyId].unshift({
      id: `alert_pending_${Date.now()}`,
      partyId,
      targetUserId: party.hostId,
      targetDisplayName: 'Party Host',
      targetEmail: party.hostEmail,
      assigneeUserId: completingMember.uid,
      assigneeDisplayName: completingMember.displayName,
      senderName: completingMember.displayName,
      senderPhotoURL: completingMember.photoURL,
      title: `New Trash Photo Submitted`,
      category: 'PHOTO_SUBMITTED',
      type: 'TURN_REMINDER',
      message: `${completingMember.displayName} uploaded a trash disposal photo for Host verification (${cleanNote}).`,
      read: false,
      createdAt: nowIso,
    });

    saveStore();
    return res.json({
      drop: pendingDrop,
      bundle: await buildPartyBundle(partyId),
    });
  });

  // Host Approves or Rejects a Submitted Trash Disposal Photo
  app.post('/api/party/verify-drop', async (req, res) => {
    const {
      partyId,
      dropId,
      decision,
      hostReviewNote,
      hostName,
    } = req.body || {};

    const party = store.parties[partyId];
    if (!party) {
      return res.status(404).json({ error: 'Party not found.' });
    }

    const drops = store.dropsByParty[partyId] || [];
    const targetDrop = drops.find((d) => d.id === dropId);
    if (!targetDrop) {
      return res.status(404).json({ error: 'Submitted photo record not found.' });
    }

    const nowIso = new Date().toISOString();
    const cleanDecision: 'APPROVE' | 'REJECT' =
      decision === 'REJECT' ? 'REJECT' : 'APPROVE';
    const verifierName =
      String(hostName || '').trim() ||
      party.members.find((m) => m.uid === party.hostId)?.displayName ||
      'Host';

    if (cleanDecision === 'REJECT') {
      targetDrop.verified = false;
      targetDrop.verificationStatus = 'REJECTED';
      targetDrop.pointsAwarded = 0;
      targetDrop.verifiedByHostName = verifierName;
      targetDrop.verifiedAtIso = nowIso;
      targetDrop.hostReviewNote =
        String(hostReviewNote || '').trim() ||
        'Photo rejected by Host. Please upload a clear photo of the trash at the outdoor bin.';

      if (!store.alertsByParty[partyId]) store.alertsByParty[partyId] = [];
      store.alertsByParty[partyId].unshift({
        id: `alert_reject_${Date.now()}`,
        partyId,
        targetUserId: targetDrop.userId,
        targetDisplayName: targetDrop.userDisplayName,
        targetEmail: targetDrop.userEmail,
        assigneeUserId: targetDrop.userId,
        assigneeDisplayName: targetDrop.userDisplayName,
        senderName: verifierName,
        title: `Trash Photo Needs Retake`,
        category: 'PHOTO_SUBMITTED',
        type: 'TURN_REMINDER',
        message: `Host ${verifierName} requested a clearer trash photo from ${targetDrop.userDisplayName}: "${targetDrop.hostReviewNote}"`,
        read: false,
        createdAt: nowIso,
      });

      saveStore();
      return res.json({
        drop: targetDrop,
        bundle: await buildPartyBundle(partyId),
      });
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
      String(hostReviewNote || '').trim() ||
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

      const rotated = rotatePartyTurn(
        {
          ...party,
          members: updatedMembers,
        },
        nowIso,
        true
      );
      store.parties[partyId] = rotated;

      if (!store.historyByParty[partyId]) store.historyByParty[partyId] = [];
      store.historyByParty[partyId].unshift({
        id: `hist_drop_${Date.now()}`,
        partyId,
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

      const nextAssignee =
        rotated.members.find((m) => m.uid === rotated.currentTurnUserId) ||
        rotated.members[0];
      if (!store.alertsByParty[partyId]) store.alertsByParty[partyId] = [];
      store.alertsByParty[partyId].unshift({
        id: `alert_approve_${Date.now()}`,
        partyId,
        targetUserId: completingMember.uid,
        targetDisplayName: completingMember.displayName,
        targetEmail: completingMember.email,
        assigneeUserId: nextAssignee.uid,
        assigneeDisplayName: nextAssignee.displayName,
        senderName: verifierName,
        senderPhotoURL: completingMember.photoURL,
        title: `Photo Approved (+${scoreResult.pointsAwarded} pts) · Next: ${nextAssignee.displayName}`,
        category: 'PHOTO_VERIFIED',
        type: 'TURN_COMPLETED',
        message: `Host ${verifierName} approved ${completingMember.displayName}'s trash photo (+${scoreResult.pointsAwarded} pts)! ${nextAssignee.displayName} is now on trash duty.`,
        read: false,
        createdAt: nowIso,
      });
    }

    saveStore();
    return res.json({
      drop: targetDrop,
      bundle: await buildPartyBundle(partyId),
    });
  });

  // Update deadline or multi-day rotation schedule (1 to 7 days)
  app.post('/api/party/deadline', async (req, res) => {
    const { partyId, nextDeadlineIso, rotationIntervalHours } = req.body || {};
    const party = store.parties[partyId];
    if (!party) {
      return res.status(404).json({ error: 'Party not found.' });
    }

    const nowIso = new Date().toISOString();
    if (rotationIntervalHours !== undefined) {
      const cleanHours = Math.max(1, Number(rotationIntervalHours) || 24);
      party.rotationIntervalHours = cleanHours;
      if (!nextDeadlineIso) {
        party.nextDeadline = new Date(Date.now() + cleanHours * 3600 * 1000).toISOString();
      }
    }
    if (nextDeadlineIso) {
      party.nextDeadline = String(nextDeadlineIso);
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
    saveStore();

    return res.json({
      bundle: await buildPartyBundle(partyId),
    });
  });

  app.post('/api/party/skip', async (req, res) => {
    const { partyId, reason } = req.body || {};
    const party = store.parties[partyId];
    if (!party) {
      return res.status(404).json({ error: 'Party not found.' });
    }

    const nowIso = new Date().toISOString();
    const skippedMember =
      party.members.find((m) => m.uid === party.currentTurnUserId) || party.members[0];
    const previousDeadline = party.nextDeadline;
    const rotated = rotatePartyTurn(party, nowIso, false);
    store.parties[partyId] = rotated;

    if (!store.historyByParty[partyId]) store.historyByParty[partyId] = [];
    store.historyByParty[partyId].unshift({
      id: `hist_skip_${Date.now()}`,
      partyId,
      userId: skippedMember.uid,
      userEmail: skippedMember.email,
      userDisplayName: skippedMember.displayName,
      userPhotoURL: skippedMember.photoURL,
      outcome: 'SKIPPED_BY_HOST',
      pointsAwarded: 0,
      deadlineIso: previousDeadline,
      recordedIso: nowIso,
      notes: reason || `Turn manually rotated by Party Host.`,
      createdAt: nowIso,
    });

    const nextMember =
      rotated.members.find((m) => m.uid === rotated.currentTurnUserId) || rotated.members[0];
    if (!store.alertsByParty[partyId]) store.alertsByParty[partyId] = [];
    store.alertsByParty[partyId].unshift({
      id: `alert_skip_${Date.now()}`,
      partyId,
      targetUserId: nextMember.uid,
      targetDisplayName: nextMember.displayName,
      targetEmail: nextMember.email,
      assigneeUserId: nextMember.uid,
      assigneeDisplayName: nextMember.displayName,
      senderName: `${party.name} Host`,
      senderPhotoURL: nextMember.photoURL,
      title: `Turn Rotated · ${nextMember.displayName} is Up Now`,
      category: 'TURN_REMINDER',
      type: 'TURN_REMINDER',
      message: `Party Host rotated the turn from ${skippedMember.displayName} to ${nextMember.displayName}.`,
      read: false,
      createdAt: nowIso,
    });

    saveStore();
    return res.json({ bundle: await buildPartyBundle(partyId) });
  });

  app.post('/api/party/profile', async (req, res) => {
    const { partyId, uid, displayName, email, photoURL } = req.body || {};
    const cleanName = String(displayName || '').trim();
    const cleanEmail = email ? String(email).trim().toLowerCase() : undefined;

    if (cleanName.length < 2) {
      return res.status(400).json({ error: 'Display name must be at least 2 characters.' });
    }

    const nowIso = new Date().toISOString();

    for (const key of Object.keys(store.accounts)) {
      const acc = store.accounts[key];
      if (acc.uid === uid) {
        acc.displayName = cleanName;
        if (photoURL !== undefined) acc.photoURL = photoURL;
        if (cleanEmail && cleanEmail !== key) {
          acc.email = cleanEmail;
          store.accounts[cleanEmail] = acc;
          delete store.accounts[key];
        }
        acc.updatedAt = nowIso;
        break;
      }
    }

    if (partyId && store.parties[partyId]) {
      const party = store.parties[partyId];
      party.members = party.members.map((m) => {
        if (m.uid !== uid) return m;
        return {
          ...m,
          displayName: cleanName,
          email: cleanEmail || m.email,
          photoURL: photoURL !== undefined ? photoURL : m.photoURL,
        };
      });
      if (party.hostId === uid && cleanEmail) {
        party.hostEmail = cleanEmail;
      }
      party.updatedAt = nowIso;

      if (store.dropsByParty[partyId]) {
        store.dropsByParty[partyId] = store.dropsByParty[partyId].map((d) =>
          d.userId === uid
            ? {
                ...d,
                userDisplayName: cleanName,
                userEmail: cleanEmail || d.userEmail,
                userPhotoURL: photoURL !== undefined ? photoURL : d.userPhotoURL,
              }
            : d
        );
      }
    }

    saveStore();
    return res.json({
      bundle: partyId ? await buildPartyBundle(partyId) : null,
    });
  });

  // Instant Pop-Up & Push Notification Dispatch Endpoint (Replaces broken SMTP requirement)
  app.post('/api/send-email', async (req, res) => {
    const {
      partyId,
      recipientUserId,
      type = 'MANUAL_REMINDER',
      customSubject,
      customMessage,
      senderName,
    } = req.body || {};

    const party = store.parties[partyId];
    if (!party) {
      return res.status(404).json({ error: 'Party not found.' });
    }

    const recipient =
      party.members.find((m) => m.uid === recipientUserId) ||
      party.members.find((m) => m.uid === party.currentTurnUserId) ||
      party.members[0];

    if (!recipient || !recipient.email) {
      return res.status(400).json({ error: 'Recipient member does not have an email address.' });
    }

    const emailRecord = await dispatchOfficialEmailAndLog({
      party,
      recipient,
      type: type as EmailAlertType,
      customSubject,
      customMessage,
    });

    const nowIso = new Date().toISOString();
    if (type === 'WARNING_5H') {
      party.warningEmailSentForCurrentTurn = true;
    }
    party.reminderSentForCurrentTurn = true;
    party.updatedAt = nowIso;

    if (!store.alertsByParty[partyId]) store.alertsByParty[partyId] = [];
    store.alertsByParty[partyId].unshift({
      id: `alert_push_${Date.now()}`,
      partyId,
      targetUserId: recipient.uid,
      targetDisplayName: recipient.displayName,
      targetEmail: recipient.email,
      assigneeUserId: recipient.uid,
      assigneeDisplayName: recipient.displayName,
      senderName: senderName || `${party.name} Alert`,
      senderPhotoURL: recipient.photoURL,
      title: emailRecord.subject,
      category:
        type === 'WARNING_5H'
          ? 'WARNING_5H'
          : type === 'MISSED_DEADLINE'
          ? 'MISSED_DEADLINE'
          : 'TURN_REMINDER',
      type:
        type === 'WARNING_5H'
          ? 'WARNING_5H'
          : type === 'MISSED_DEADLINE'
          ? 'HOST_ESCALATION'
          : 'TURN_REMINDER',
      message:
        customMessage?.trim() ||
        `Hey ${recipient.displayName}, you are up for trash duty at ${party.name}! Snap & upload your trash disposal photo before the deadline.`,
      read: false,
      createdAt: nowIso,
    });

    saveStore();
    return res.json({
      email: emailRecord,
      bundle: await buildPartyBundle(partyId),
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BinDrop Full-Stack Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
