export type TurnStatus = 'PENDING' | 'OVERDUE' | 'COMPLETED';

export type TurnOutcome =
  | 'ON_TIME'
  | 'COMPLETED_LATE'
  | 'MISSED_DEADLINE'
  | 'SKIPPED_BY_HOST';

export type EmailAlertType =
  | 'WARNING_5H'
  | 'MISSED_DEADLINE'
  | 'HOST_ESCALATION'
  | 'MANUAL_REMINDER';

export type PhotoVerificationStatus =
  | 'PENDING_HOST_APPROVAL'
  | 'VERIFIED'
  | 'REJECTED';

export interface HouseholdMember {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  avatarColor: string;
  role: 'HOST' | 'MEMBER';
  totalDrops: number;
  onTimeDrops: number;
  missedDrops: number;
  points: number;
  currentStreak: number;
  bestStreak?: number;
  onTimeRate: number;
  joinedAt?: string;
}

export interface PartyState {
  id: string;
  name: string;
  inviteCode: string;
  hostId: string;
  hostEmail: string;
  memberIds: string[];
  members: HouseholdMember[];
  currentTurnIndex: number;
  currentTurnUserId: string;
  turnStatus: TurnStatus;
  nextDeadline: string; // ISO string
  rotationIntervalHours: number; // 24 (1d), 48 (2d), 72 (3d) ... up to 168 (7d)
  warningEmailSentForCurrentTurn: boolean;
  missedEmailSentForCurrentTurn: boolean;
  hostAlertedForCurrentTurn: boolean;
  reminderSentForCurrentTurn: boolean;
  totalPartyDrops: number;
  createdAt: string;
  updatedAt: string;
}

export interface TrashDropLog {
  id: string;
  partyId: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
  userPhotoURL?: string;
  imageUrl: string;
  locationNote: string;
  verificationStatus: PhotoVerificationStatus;
  verified: boolean;
  hostReviewNote?: string;
  verifiedByHostName?: string;
  verifiedAtIso?: string;
  pointsAwarded: number;
  completedOnTime: boolean;
  deadlineIso: string;
  submittedIso: string;
  createdAt: string;
}

export interface TurnHistoryRecord {
  id: string;
  partyId: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
  userPhotoURL?: string;
  outcome: TurnOutcome;
  pointsAwarded: number;
  deadlineIso: string;
  recordedIso: string;
  dropId?: string;
  imageUrl?: string;
  notes: string;
  createdAt: string;
}

export const OFFICIAL_BINDROP_EMAIL = 'bindropofficial@gmail.com';
export const OFFICIAL_BINDROP_NAME = 'BinDrop Official';

export interface OfficialMailerStatus {
  email: string;
  smtpVerified: boolean;
  usingAppPassword: boolean;
  maskedCredential: string;
  lastError?: string;
  checkedAt: string;
}

export interface EmailDispatchLog {
  id: string;
  partyId: string;
  recipientUserId: string;
  fromEmail: string;
  toEmail: string;
  toName: string;
  subject: string;
  bodyText: string;
  type: EmailAlertType;
  sentAt: string;
  deliveryStatus:
    | 'PUSH_NOTIFICATION_SENT'
    | 'SENT_VIA_SMTP'
    | 'FAILED_NEEDS_APP_PASSWORD'
    | 'SENT_FROM_BINDROP_OFFICIAL'
    | 'SENT_VIA_GMAIL_API'
    | 'QUEUED_NEEDS_GMAIL_AUTH'
    | 'FAILED';
  gmailMessageId?: string;
  transportInfo: string;
}

export interface PartyAlertItem {
  id: string;
  partyId: string;
  targetUserId: string;
  targetDisplayName: string;
  targetEmail?: string;
  assigneeUserId: string;
  assigneeDisplayName: string;
  senderName?: string;
  senderPhotoURL?: string;
  title?: string;
  category?:
    | 'WARNING_5H'
    | 'MISSED_DEADLINE'
    | 'TURN_REMINDER'
    | 'PHOTO_SUBMITTED'
    | 'PHOTO_VERIFIED'
    | 'MEMBER_JOINED'
    | 'PARTY_UPDATED';
  type:
    | 'WARNING_5H'
    | 'MISSED_DEADLINE'
    | 'TURN_REMINDER'
    | 'HOST_ESCALATION'
    | 'TURN_COMPLETED';
  message: string;
  read: boolean;
  createdAt: string;
}

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

export interface RotationDayOption {
  days: number;
  hours: number;
  shortLabel: string;
  fullLabel: string;
}

export const ROTATION_DAY_OPTIONS: RotationDayOption[] = [
  { days: 1, hours: 24, shortLabel: '1 Day', fullLabel: 'Every 1 Day (24h)' },
  { days: 2, hours: 48, shortLabel: '2 Days', fullLabel: 'Every 2 Days (48h)' },
  { days: 3, hours: 72, shortLabel: '3 Days', fullLabel: 'Every 3 Days (72h)' },
  { days: 4, hours: 96, shortLabel: '4 Days', fullLabel: 'Every 4 Days (96h)' },
  { days: 5, hours: 120, shortLabel: '5 Days', fullLabel: 'Every 5 Days (120h)' },
  { days: 6, hours: 144, shortLabel: '6 Days', fullLabel: 'Every 6 Days (144h)' },
  { days: 7, hours: 168, shortLabel: '7 Days', fullLabel: 'Every 7 Days (168h)' },
];

export function formatRotationDaysLabel(hours: number): string {
  const days = Math.round((hours / 24) * 10) / 10;
  if (days === 1) return 'Every 1 Day (24h)';
  if (Number.isInteger(days) && days >= 1 && days <= 7) {
    return `Every ${days} Days (${hours}h)`;
  }
  return `Every ${hours}h`;
}

/**
 * Generates an RFC 2822 base64url-encoded MIME email string for the Gmail API
 * (`POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`).
 */
export function encodeGmailRawMessage(params: {
  fromEmail?: string;
  fromName?: string;
  toEmail: string;
  toName?: string;
  subject: string;
  bodyText: string;
}): string {
  const cleanSubject = params.subject.replace(/[\r\n]+/g, ' ').trim();
  const toHeader = params.toName
    ? `"${params.toName.replace(/"/g, '')}" <${params.toEmail.trim()}>`
    : params.toEmail.trim();
  const headers: string[] = [];
  if (params.fromEmail) {
    const fromHeader = params.fromName
      ? `"${params.fromName.replace(/"/g, '')}" <${params.fromEmail.trim()}>`
      : params.fromEmail.trim();
    headers.push(`From: ${fromHeader}`);
  }
  headers.push(`To: ${toHeader}`);
  headers.push(`Subject: ${cleanSubject}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('');
  headers.push(params.bodyText);

  const mimeString = headers.join('\r\n');
  // Base64url encode in UTF-8 safe manner (works in both Node and Browser)
  const utf8Bytes = new TextEncoder().encode(mimeString);
  let binary = '';
  for (let i = 0; i < utf8Bytes.length; i++) {
    binary += String.fromCharCode(utf8Bytes[i]);
  }
  const base64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(mimeString, 'utf-8').toString('base64');

  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Strips non-alphanumeric characters and uppercases for exact 6-slot comparison.
 */
export function normalizeInviteCode(code: string): string {
  return String(code || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

/**
 * Formats an invite code into a clean 6-character `XXX-XXX` representation
 * so that all 6 alphanumeric characters match the 6 visual boxes in the UI.
 */
export function formatSixCharInviteCode(code: string): string {
  const raw = normalizeInviteCode(code);
  if (raw.length < 6) {
    const padded = raw.padEnd(6, 'X');
    return `${padded.slice(0, 3)}-${padded.slice(3, 6)}`;
  }
  return `${raw.slice(0, 3)}-${raw.slice(3, 6)}`;
}

/**
 * Compares a party's invite code against a user's entered code.
 * Supports 6-character codes (`XXX-XXX` / `XXXXXX`) and legacy 7-character codes
 * (including when a roommate enters the first 6 characters shown in the 6 boxes).
 */
export function doesInviteCodeMatch(partyInviteCode: string, inputCode: string): boolean {
  const normParty = normalizeInviteCode(partyInviteCode);
  const normInput = normalizeInviteCode(inputCode);
  if (!normParty || !normInput || normInput.length < 4) return false;
  if (normParty === normInput) return true;
  if (normParty.slice(0, 6) === normInput.slice(0, 6) && normInput.length >= 6) {
    return true;
  }
  return false;
}

/**
 * Generates a unique, human-friendly 6-character household invite code (e.g. "BIN-7X4")
 * matching the 6 visual character boxes in the UI (3-char prefix + 3-char suffix).
 */
export function generateInviteCode(prefix = 'BIN', randomValue = Math.random()): string {
  const rawPrefix = prefix.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const cleanPrefix = (rawPrefix + 'BIN').slice(0, 3);
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let suffix = '';
  let seed = Math.floor(randomValue * 1_000_000) + 1337;
  for (let i = 0; i < 3; i++) {
    suffix += alphabet[seed % alphabet.length];
    seed = Math.floor(seed / alphabet.length) + (i + 1) * 19;
  }
  return `${cleanPrefix}-${suffix}`;
}

export function validateInviteCode(code: string): boolean {
  const clean = normalizeInviteCode(code);
  return clean.length >= 4 && clean.length <= 12;
}

/**
 * Calculates points awarded for a host-verified trash drop.
 */
export function calculateDropPoints(params: {
  completedBeforeDeadline: boolean;
  currentStreak: number;
}): {
  pointsAwarded: number;
  nextStreak: number;
  breakdown: { base: number; streakBonus: number };
} {
  const { completedBeforeDeadline, currentStreak } = params;
  const base = completedBeforeDeadline ? 100 : 60;
  const nextStreak = completedBeforeDeadline ? currentStreak + 1 : 0;
  const streakBonus = completedBeforeDeadline ? Math.min(nextStreak * 15, 75) : 0;
  return {
    pointsAwarded: base + streakBonus,
    nextStreak,
    breakdown: { base, streakBonus },
  };
}

/**
 * Rotates the turn to the next member in the party and resets per-turn email flags.
 */
export function rotatePartyTurn(
  party: PartyState,
  nowIso: string = new Date().toISOString(),
  incrementDrops = true
): PartyState {
  if (party.members.length === 0) {
    return party;
  }
  const nextIndex = (party.currentTurnIndex + 1) % party.members.length;
  const nextMember = party.members[nextIndex];
  const nowMs = new Date(nowIso).getTime();
  const nextDeadlineMs = nowMs + party.rotationIntervalHours * 60 * 60 * 1000;

  return {
    ...party,
    currentTurnIndex: nextIndex,
    currentTurnUserId: nextMember.uid,
    turnStatus: 'PENDING',
    nextDeadline: new Date(nextDeadlineMs).toISOString(),
    warningEmailSentForCurrentTurn: false,
    missedEmailSentForCurrentTurn: false,
    hostAlertedForCurrentTurn: false,
    reminderSentForCurrentTurn: false,
    totalPartyDrops: incrementDrops ? party.totalPartyDrops + 1 : party.totalPartyDrops,
    updatedAt: nowIso,
  };
}

export interface DeadlineEvaluation {
  status: 'ON_TRACK' | 'DUE_SOON' | 'OVERDUE';
  remainingMs: number;
  remainingHours: number;
  shouldSendFiveHourWarningEmail: boolean;
  shouldSendMissedDeadlineEmail: boolean;
  shouldSendAssigneeReminder: boolean;
  shouldAlertHost: boolean;
}

/**
 * Evaluates current deadline status relative to `nowMs`.
 * Triggers a 5-hour warning email when <= 5 hours remain,
 * and triggers a missed-deadline email + host escalation when <= 0ms remain.
 */
export function evaluateDeadlineStatus(
  party: Pick<
    PartyState,
    | 'nextDeadline'
    | 'warningEmailSentForCurrentTurn'
    | 'missedEmailSentForCurrentTurn'
    | 'reminderSentForCurrentTurn'
    | 'hostAlertedForCurrentTurn'
  >,
  nowMs: number = Date.now(),
  warningWindowMs: number = FIVE_HOURS_MS
): DeadlineEvaluation {
  const deadlineMs = new Date(party.nextDeadline).getTime();
  const remainingMs = deadlineMs - nowMs;
  const remainingHours = Number((remainingMs / (1000 * 60 * 60)).toFixed(2));

  if (remainingMs <= 0) {
    return {
      status: 'OVERDUE',
      remainingMs,
      remainingHours,
      shouldSendFiveHourWarningEmail: false,
      shouldSendMissedDeadlineEmail: !party.missedEmailSentForCurrentTurn,
      shouldSendAssigneeReminder: !party.reminderSentForCurrentTurn,
      shouldAlertHost: !party.hostAlertedForCurrentTurn,
    };
  }

  if (remainingMs <= warningWindowMs) {
    return {
      status: 'DUE_SOON',
      remainingMs,
      remainingHours,
      shouldSendFiveHourWarningEmail: !party.warningEmailSentForCurrentTurn,
      shouldSendMissedDeadlineEmail: false,
      shouldSendAssigneeReminder: !party.reminderSentForCurrentTurn,
      shouldAlertHost: false,
    };
  }

  return {
    status: 'ON_TRACK',
    remainingMs,
    remainingHours,
    shouldSendFiveHourWarningEmail: false,
    shouldSendMissedDeadlineEmail: false,
    shouldSendAssigneeReminder: false,
    shouldAlertHost: false,
  };
}

export function formatCountdown(remainingMs: number): {
  isOverdue: boolean;
  days: number;
  hours: string;
  minutes: string;
  seconds: string;
  label: string;
} {
  const isOverdue = remainingMs < 0;
  const absSeconds = Math.floor(Math.abs(remainingMs) / 1000);
  const totalHours = Math.floor(absSeconds / 3600);
  const days = Math.floor(totalHours / 24);
  const minutes = Math.floor((absSeconds % 3600) / 60);
  const seconds = absSeconds % 60;

  const hStr = String(totalHours).padStart(2, '0');
  const mStr = String(minutes).padStart(2, '0');
  const sStr = String(seconds).padStart(2, '0');

  return {
    isOverdue,
    days,
    hours: hStr,
    minutes: mStr,
    seconds: sStr,
    label: isOverdue
      ? `Overdue by ${hStr}:${mStr}:${sStr}`
      : days >= 1
      ? `${days}d ${totalHours % 24}h ${mStr}m left`
      : `${hStr}:${mStr}:${sStr} remaining`,
  };
}

export function formatDateTimeReadable(iso: string): {
  datePart: string;
  timePart: string;
  fullLabel: string;
} {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { datePart: 'Unknown Date', timePart: '--:--', fullLabel: iso };
  }
  const datePart = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const timePart = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  return {
    datePart,
    timePart,
    fullLabel: `${datePart} at ${timePart}`,
  };
}

export interface UpcomingQueueSlot {
  member: HouseholdMember;
  queuePosition: number;
  statusLabel: 'UP_NOW' | 'UP_NEXT' | 'SCHEDULED';
  projectedDeadlineIso: string;
  isWithinFiveHourWarning: boolean;
  isOverdue: boolean;
}

export function buildUpcomingTurnQueue(
  party: PartyState,
  nowMs: number = Date.now()
): UpcomingQueueSlot[] {
  const count = party.members.length;
  if (count === 0) return [];

  const activeDeadlineMs = new Date(party.nextDeadline).getTime();
  const intervalMs = party.rotationIntervalHours * 60 * 60 * 1000;

  return Array.from({ length: count }, (_, offset) => {
    const idx = (party.currentTurnIndex + offset) % count;
    const member = party.members[idx];
    const projectedMs = activeDeadlineMs + offset * intervalMs;
    const remainingMs = projectedMs - nowMs;

    return {
      member,
      queuePosition: offset,
      statusLabel: offset === 0 ? 'UP_NOW' : offset === 1 ? 'UP_NEXT' : 'SCHEDULED',
      projectedDeadlineIso: new Date(projectedMs).toISOString(),
      isWithinFiveHourWarning:
        offset === 0 && remainingMs > 0 && remainingMs <= FIVE_HOURS_MS,
      isOverdue: offset === 0 && remainingMs <= 0,
    };
  });
}

export function updateMemberProfile(
  party: PartyState,
  uid: string,
  updates: { displayName: string; email?: string; photoURL?: string },
  nowIso: string = new Date().toISOString()
): PartyState {
  const cleanName = updates.displayName.trim();
  if (!cleanName) {
    return party;
  }
  const cleanEmail = updates.email?.trim().toLowerCase();
  const nextMembers = party.members.map((member) => {
    if (member.uid !== uid) return member;
    return {
      ...member,
      displayName: cleanName,
      email: cleanEmail || member.email,
      photoURL: updates.photoURL !== undefined ? updates.photoURL : member.photoURL,
    };
  });

  return {
    ...party,
    hostEmail:
      party.hostId === uid && cleanEmail ? cleanEmail : party.hostEmail,
    members: nextMembers,
    updatedAt: nowIso,
  };
}

/**
 * Removes a member from a household party.
 * - If no members remain, returns `updatedParty: null` (party is dissolved).
 * - If the leaving member was the Host, automatically transfers the `HOST` role
 *   to the next remaining roommate in line (`remainingMembers[0]`).
 * - Preserves or advances the active turn cleanly.
 */
export function leavePartyMember(
  party: PartyState,
  userId: string,
  userEmail?: string,
  nowIso: string = new Date().toISOString()
): {
  updatedParty: PartyState | null;
  dissolved: boolean;
  leftMember?: HouseholdMember;
  removedMember?: HouseholdMember;
  promotedHost?: HouseholdMember;
  newHost?: HouseholdMember;
  hostTransferred: boolean;
} {
  const cleanEmail = (userEmail || '').trim().toLowerCase();
  const leavingIndex = party.members.findIndex(
    (m) => m.uid === userId || (cleanEmail && m.email.toLowerCase() === cleanEmail)
  );
  if (leavingIndex === -1) {
    return { updatedParty: party, dissolved: false, hostTransferred: false };
  }

  const leftMember = party.members[leavingIndex];
  const remainingMembers = party.members
    .filter((_, idx) => idx !== leavingIndex)
    .map((m) => ({ ...m }));

  if (remainingMembers.length === 0) {
    return {
      updatedParty: null,
      dissolved: true,
      leftMember,
      removedMember: leftMember,
      hostTransferred: false,
    };
  }

  const wasHost = Boolean(
    party.hostId === leftMember.uid ||
      leftMember.role === 'HOST' ||
      (cleanEmail && party.hostEmail.toLowerCase() === cleanEmail)
  );

  let nextHostId = party.hostId;
  let nextHostEmail = party.hostEmail;
  let promotedHost: HouseholdMember | undefined;

  if (wasHost) {
    remainingMembers[0].role = 'HOST';
    nextHostId = remainingMembers[0].uid;
    nextHostEmail = remainingMembers[0].email;
    promotedHost = remainingMembers[0];
  }

  const wasCurrentTurn =
    party.currentTurnUserId === leftMember.uid || party.currentTurnIndex === leavingIndex;

  let nextTurnIndex = 0;
  let nextTurnUserId = remainingMembers[0].uid;

  if (wasCurrentTurn) {
    nextTurnIndex = leavingIndex % remainingMembers.length;
    nextTurnUserId = remainingMembers[nextTurnIndex].uid;
  } else {
    const activeIdx = remainingMembers.findIndex(
      (m) => m.uid === party.currentTurnUserId
    );
    nextTurnIndex = activeIdx >= 0 ? activeIdx : 0;
    nextTurnUserId = remainingMembers[nextTurnIndex].uid;
  }

  const updatedParty: PartyState = {
    ...party,
    inviteCode: formatSixCharInviteCode(party.inviteCode),
    hostId: nextHostId,
    hostEmail: nextHostEmail,
    memberIds: remainingMembers.map((m) => m.uid),
    members: remainingMembers,
    currentTurnIndex: nextTurnIndex,
    currentTurnUserId: nextTurnUserId,
    ...(wasCurrentTurn
      ? {
          turnStatus: 'PENDING' as TurnStatus,
          warningEmailSentForCurrentTurn: false,
          missedEmailSentForCurrentTurn: false,
          hostAlertedForCurrentTurn: false,
          reminderSentForCurrentTurn: false,
        }
      : {}),
    updatedAt: nowIso,
  };

  return {
    updatedParty,
    dissolved: false,
    leftMember,
    removedMember: leftMember,
    promotedHost,
    newHost: promotedHost,
    hostTransferred: wasHost,
  };
}

