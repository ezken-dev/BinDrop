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
  officialEmailConfig: OfficialEmailConfig;
}

const AVATAR_COLORS = ['#d0ff45', '#34d399', '#38bdf8', '#facc15', '#fb7185', '#a78bfa'];

function formatSmtpErrorExplanation(rawError: unknown, currentPassword: string): string {
  const rawMsg = rawError instanceof Error ? rawError.message : String(rawError || 'Unknown SMTP error');
  if (rawMsg.includes('535') || rawMsg.toLowerCase().includes('username and password not accepted')) {
    const isRegularPass = currentPassword === 'EzKen_2005' || currentPassword.length !== 16;
    return isRegularPass
      ? `Google SMTP (smtp.gmail.com) rejected regular login password "${currentPassword}" with Error 535-5.7.8. Google blocks regular Gmail passwords from sending mail via SMTP — you must generate a 16-character Google App Password in bindropofficial@gmail.com (myaccount.google.com/apppasswords) and paste it below.`
      : `Google SMTP (smtp.gmail.com) rejected the password with Error 535-5.7.8. Please verify that 2-Step Verification is enabled on bindropofficial@gmail.com and paste the exact 16-character Google App Password from myaccount.google.com/apppasswords.`;
  }
  return `Google SMTP error for ${OFFICIAL_BINDROP_EMAIL}: ${rawMsg}`;
}

function getMailerStatusSnapshot(): OfficialMailerStatus {
  const cfg = store.officialEmailConfig;
  const cleanNoSpaces = (cfg.password || '').replace(/\s+/g, '');
  const usingAppPassword =
    cleanNoSpaces.length === 16 && cfg.password !== 'EzKen_2005';
  const masked =
    cfg.password === 'EzKen_2005'
      ? 'EzKen_2005 (Regular Login Password — Blocked by Google SMTP 535-5.7.8)'
      : `${cleanNoSpaces.slice(0, 4)} •••• •••• ${cleanNoSpaces.slice(-4)} (16-char App Password)`;

  return {
    email: OFFICIAL_BINDROP_EMAIL,
    smtpVerified: Boolean(cfg.smtpVerified),
    usingAppPassword,
    maskedCredential: masked,
    lastError: cfg.lastError,
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
      return {
        accounts: parsed.accounts || {},
        parties: parsed.parties || {},
        dropsByParty: parsed.dropsByParty || {},
        historyByParty: parsed.historyByParty || {},
        emailsByParty: parsed.emailsByParty || {},
        alertsByParty: parsed.alertsByParty || {},
        officialEmailConfig: existingCfg
          ? {
              email: DEFAULT_OFFICIAL_EMAIL,
              password: existingCfg.password || DEFAULT_OFFICIAL_PASS,
              smtpVerified: Boolean(existingCfg.smtpVerified),
              lastError: existingCfg.lastError,
              updatedAt: existingCfg.updatedAt || new Date().toISOString(),
            }
          : {
              email: DEFAULT_OFFICIAL_EMAIL,
              password: DEFAULT_OFFICIAL_PASS,
              smtpVerified: false,
              lastError:
                'Google SMTP (smtp.gmail.com) rejects regular Gmail password "EzKen_2005" with Error 535-5.7.8. Paste a 16-character Google App Password for bindropofficial@gmail.com to send real emails.',
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
    officialEmailConfig: {
      email: DEFAULT_OFFICIAL_EMAIL,
      password: DEFAULT_OFFICIAL_PASS,
      smtpVerified: false,
      lastError:
        'Google SMTP (smtp.gmail.com) rejects regular Gmail password "EzKen_2005" with Error 535-5.7.8. Paste a 16-character Google App Password for bindropofficial@gmail.com to send real emails.',
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
    const explanation = formatSmtpErrorExplanation(smtpError, rawPass);
    store.officialEmailConfig.smtpVerified = false;
    store.officialEmailConfig.lastError = explanation;
    store.officialEmailConfig.updatedAt = new Date().toISOString();
    saveStore();

    return {
      deliveryStatus: 'FAILED_NEEDS_APP_PASSWORD',
      messageId: '',
      transportInfo: explanation,
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

  const sendResult = await sendViaBindropOfficialAccount({
    toEmail: params.recipient.email,
    toName: params.recipient.displayName,
    subject,
    bodyText,
    htmlBody,
  });

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
        type: 'WARNING_5H',
        message: `Auto 5-Hour Warning sent from ${OFFICIAL_BINDROP_EMAIL} to ${assignee.email}: Less than 5 hours left before trash deadline!`,
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
        notes: `Missed deadline on time. Automated reminder email dispatched from ${OFFICIAL_BINDROP_EMAIL} to ${assignee.email} and Host ${host?.email || party.hostEmail}.`,
        createdAt: nowIso,
      });

      if (!store.alertsByParty[party.id]) store.alertsByParty[party.id] = [];
      store.alertsByParty[party.id].unshift({
        id: `alert_overdue_${Date.now()}`,
        partyId: party.id,
        targetUserId: host ? host.uid : assignee.uid,
        targetDisplayName: host ? `${host.displayName} (Host)` : assignee.displayName,
        targetEmail: assignee.email,
        assigneeUserId: assignee.uid,
        assigneeDisplayName: assignee.displayName,
        type: 'HOST_ESCALATION',
        message: `MISSED DEADLINE: ${assignee.displayName} (${assignee.email}) missed their trash turn! Automated reminder mailed from ${OFFICIAL_BINDROP_EMAIL} to ${assignee.email} and Host ${host?.email || ''}.`,
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

  // Check initial SMTP status in background on startup
  verifyOfficialSmtpConnection().catch(() => {
    // non-blocking
  });

  // Background 10-second automated deadline & email monitor using bindropofficial@gmail.com
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
      service: 'BinDrop Real-Time Backend & Official Email Dispatcher',
      officialSenderEmail: OFFICIAL_BINDROP_EMAIL,
      mailerStatus: getMailerStatusSnapshot(),
    });
  });

  app.get('/api/official-email/status', async (_req, res) => {
    await verifyOfficialSmtpConnection();
    return res.json({
      ok: true,
      mailerStatus: getMailerStatusSnapshot(),
    });
  });

  // Endpoint to verify & save the 16-character Google App Password for bindropofficial@gmail.com
  app.post('/api/official-email/config', async (req, res) => {
    const { password, partyId } = req.body || {};
    const cleanPass = String(password || '').replace(/\s+/g, '');
    if (!cleanPass) {
      return res.status(400).json({ error: 'Please paste the 16-character Google App Password for bindropofficial@gmail.com.' });
    }

    const verifyRes = await verifyOfficialSmtpConnection(cleanPass);
    if (!verifyRes.ok) {
      return res.status(400).json({
        ok: false,
        error: verifyRes.error,
        mailerStatus: getMailerStatusSnapshot(),
      });
    }

    // Automatically retry any previously blocked emails for this party now that SMTP is verified
    let flushedCount = 0;
    if (partyId && store.emailsByParty[partyId]) {
      const party = store.parties[partyId];
      for (const mail of store.emailsByParty[partyId]) {
        if (mail.deliveryStatus === 'FAILED_NEEDS_APP_PASSWORD' && party) {
          const retryResult = await sendViaBindropOfficialAccount({
            toEmail: mail.toEmail,
            toName: mail.toName,
            subject: mail.subject,
            bodyText: mail.bodyText,
            htmlBody: `<div style="font-family: sans-serif; white-space: pre-line;">${mail.bodyText}</div>`,
          });
          mail.deliveryStatus = retryResult.deliveryStatus;
          mail.transportInfo = retryResult.transportInfo;
          mail.gmailMessageId = retryResult.messageId || undefined;
          mail.sentAt = new Date().toISOString();
          if (retryResult.deliveryStatus === 'SENT_VIA_SMTP') {
            flushedCount += 1;
          }
        }
      }
      saveStore();
    }

    return res.json({
      ok: true,
      flushedCount,
      officialSenderEmail: OFFICIAL_BINDROP_EMAIL,
      mailerStatus: getMailerStatusSnapshot(),
      bundle: partyId ? await buildPartyBundle(partyId) : null,
    });
  });

  // --- AUTHENTICATION ENDPOINTS ---
  app.post('/api/auth/register', async (req, res) => {
    const { email, password, displayName, photoURL } = req.body || {};
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

    if (store.accounts[cleanEmail]) {
      return res.status(409).json({
        error: 'An account with this email already exists. Please switch to Login.',
      });
    }

    const nowIso = new Date().toISOString();
    const uid = `u_${crypto.randomBytes(6).toString('hex')}`;
    const avatarColor = AVATAR_COLORS[Object.keys(store.accounts).length % AVATAR_COLORS.length];

    const newAccount: StoredUserAccount = {
      uid,
      email: cleanEmail,
      displayName: cleanName,
      passwordHash: hashPassword(rawPass),
      photoURL: photoURL || undefined,
      avatarColor,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    store.accounts[cleanEmail] = newAccount;
    saveStore();

    const bundle = newAccount.partyId ? await buildPartyBundle(newAccount.partyId) : null;
    return res.json({
      user: {
        uid: newAccount.uid,
        email: newAccount.email,
        displayName: newAccount.displayName,
        photoURL: newAccount.photoURL,
        avatarColor: newAccount.avatarColor,
        partyId: newAccount.partyId || null,
      },
      bundle,
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const rawPass = String(password || '');

    if (!cleanEmail || !rawPass) {
      return res.status(400).json({ error: 'Please enter both your email address and password.' });
    }

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

    const existing = store.accounts[cleanEmail];
    if (!existing || existing.passwordHash !== hashPassword(rawPass)) {
      return res.status(401).json({
        error: 'Invalid email or password. If you are new, tap "Sign Up" below to create your account.',
      });
    }

    const bundle = existing.partyId ? await buildPartyBundle(existing.partyId) : null;
    return res.json({
      user: {
        uid: existing.uid,
        email: existing.email,
        displayName: existing.displayName,
        photoURL: existing.photoURL,
        avatarColor: existing.avatarColor,
        partyId: existing.partyId || null,
      },
      bundle,
    });
  });

  app.post('/api/auth/google-sync', async (req, res) => {
    const { uid, email, displayName, photoURL } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      return res.status(400).json({ error: 'Please enter a valid Google email address.' });
    }

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
    saveStore();

    const bundle = account.partyId ? await buildPartyBundle(account.partyId) : null;
    return res.json({
      user: {
        uid: account.uid,
        email: account.email,
        displayName: account.displayName,
        photoURL: account.photoURL,
        avatarColor: account.avatarColor,
        partyId: account.partyId || null,
      },
      bundle,
    });
  });

  app.get('/api/session', async (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    const partyId = String(req.query.partyId || '').trim();

    if (email && store.accounts[email]) {
      const acc = store.accounts[email];
      const targetPartyId = acc.partyId || partyId;
      const bundle = targetPartyId ? await buildPartyBundle(targetPartyId) : null;
      return res.json({
        user: {
          uid: acc.uid,
          email: acc.email,
          displayName: acc.displayName,
          photoURL: acc.photoURL,
          avatarColor: acc.avatarColor,
          partyId: acc.partyId || null,
        },
        bundle,
      });
    }

    if (partyId && store.parties[partyId]) {
      return res.json({
        user: null,
        bundle: await buildPartyBundle(partyId),
      });
    }

    return res.json({ user: null, bundle: null });
  });

  // --- HOUSEHOLD PARTY CREATION & INVITE CODE JOINING ---
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
        type: 'TURN_REMINDER',
        message: `Household "${cleanPartyName}" launched on a ${formatRotationDaysLabel(
          intervalHrs
        )} schedule! Official auto-emailing active via ${OFFICIAL_BINDROP_EMAIL}.`,
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
      return res.status(400).json({ error: 'Please enter a household invite code.' });
    }
    if (!cleanEmail) {
      return res.status(400).json({ error: 'Please sign in with your email first.' });
    }

    const matchingParty = Object.values(store.parties).find(
      (p) =>
        p.inviteCode.toUpperCase() === normalizedCode ||
        p.inviteCode.replace(/[^A-Z0-9]/g, '') === normalizedCode.replace(/[^A-Z0-9]/g, '')
    );

    if (!matchingParty) {
      return res.status(404).json({
        error: `No household party found matching invite code "${normalizedCode}". Check the code with your Host or create a new household.`,
      });
    }

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
        error: 'Please enter a valid email address so they receive 5-hour warnings and missed-turn emails.',
      });
    }
    if (party.members.some((m) => m.email.toLowerCase() === cleanEmail)) {
      return res.status(409).json({ error: 'A member with this email is already in the party.' });
    }
    if (party.members.length >= 12) {
      return res.status(400).json({ error: 'Maximum household size (12 members) reached.' });
    }

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

  // Official Email Dispatch Endpoint — exclusively sends from bindropofficial@gmail.com
  app.post('/api/send-email', async (req, res) => {
    const {
      partyId,
      recipientUserId,
      type = 'MANUAL_REMINDER',
      customSubject,
      customMessage,
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
      id: `alert_mail_${Date.now()}`,
      partyId,
      targetUserId: recipient.uid,
      targetDisplayName: recipient.displayName,
      targetEmail: recipient.email,
      assigneeUserId: recipient.uid,
      assigneeDisplayName: recipient.displayName,
      type: type === 'WARNING_5H' ? 'WARNING_5H' : 'TURN_REMINDER',
      message: `Email sent from ${OFFICIAL_BINDROP_EMAIL} to ${recipient.email}: "${emailRecord.subject}"`,
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
