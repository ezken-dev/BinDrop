import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUpcomingTurnQueue,
  calculateDropPoints,
  doesInviteCodeMatch,
  encodeGmailRawMessage,
  evaluateDeadlineStatus,
  formatCountdown,
  formatRotationDaysLabel,
  formatSixCharInviteCode,
  generateInviteCode,
  leavePartyMember,
  normalizeInviteCode,
  ROTATION_DAY_OPTIONS,
  rotatePartyTurn,
  updateMemberProfile,
  validateInviteCode,
  type PartyState,
} from './trashDutyLogic.ts';

test('ROTATION_DAY_OPTIONS covers 1 day through 7 days and formats labels cleanly', () => {
  assert.equal(ROTATION_DAY_OPTIONS.length, 7);
  assert.equal(ROTATION_DAY_OPTIONS[0].days, 1);
  assert.equal(ROTATION_DAY_OPTIONS[0].hours, 24);
  assert.equal(ROTATION_DAY_OPTIONS[6].days, 7);
  assert.equal(ROTATION_DAY_OPTIONS[6].hours, 168);
  assert.equal(formatRotationDaysLabel(24), 'Every 1 Day (24h)');
  assert.equal(formatRotationDaysLabel(72), 'Every 3 Days (72h)');
  assert.equal(formatRotationDaysLabel(168), 'Every 7 Days (168h)');
});

test('encodeGmailRawMessage builds base64url encoded RFC 2822 message for Gmail API', () => {
  const raw = encodeGmailRawMessage({
    fromEmail: 'host@bindrop.io',
    fromName: 'BinDrop Host',
    toEmail: 'roommate@gmail.com',
    toName: 'Jordan Lee',
    subject: '5-Hour Warning: Your Trash Turn',
    bodyText: 'Hi Jordan, your trash turn is due in 5 hours.',
  });
  assert.equal(typeof raw, 'string');
  assert.equal(raw.includes('+'), false);
  assert.equal(raw.includes('/'), false);
  assert.equal(raw.includes('='), false);

  const decoded = Buffer.from(
    raw.replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  ).toString('utf-8');
  assert.equal(decoded.includes('To: "Jordan Lee" <roommate@gmail.com>'), true);
  assert.equal(decoded.includes('Subject: 5-Hour Warning: Your Trash Turn'), true);
  assert.equal(decoded.includes('Hi Jordan, your trash turn is due in 5 hours.'), true);
});

test('generateInviteCode and validateInviteCode handle 6-character household invite codes matching the 6 UI boxes', () => {
  const code = generateInviteCode('APT', 0.42);
  assert.match(code, /^APT-[A-Z0-9]{3}$/);
  assert.equal(normalizeInviteCode(code).length, 6);
  assert.equal(validateInviteCode(code), true);
  assert.equal(validateInviteCode('bin-9k2'), true);
  assert.equal(doesInviteCodeMatch(code, code.toLowerCase().replace('-', '')), true);
  assert.equal(doesInviteCodeMatch('BIN-7X4K', 'BIN-7X4'), true);
  assert.equal(formatSixCharInviteCode('BIN-7X4K'), 'BIN-7X4');
  assert.equal(validateInviteCode('x'), false);
});

test('calculateDropPoints awards streak bonuses for on-time drops and penalizes late drops', () => {
  const onTime = calculateDropPoints({
    completedBeforeDeadline: true,
    currentStreak: 2,
  });
  assert.equal(onTime.nextStreak, 3);
  assert.equal(onTime.pointsAwarded, 100 + 45);

  const late = calculateDropPoints({
    completedBeforeDeadline: false,
    currentStreak: 4,
  });
  assert.equal(late.nextStreak, 0);
  assert.equal(late.pointsAwarded, 60);
});

test('rotatePartyTurn advances turn index, resets 5-hour warning and missed-email flags, and sets next deadline using multi-day interval', () => {
  const initialParty: PartyState = {
    id: 'party_1',
    name: 'Emerald Loft 4B',
    inviteCode: 'APT-4B9X',
    hostId: 'u_1',
    hostEmail: 'alex@bindrop.io',
    memberIds: ['u_1', 'u_2', 'u_3'],
    members: [
      {
        uid: 'u_1',
        email: 'alex@bindrop.io',
        displayName: 'Alex (Host)',
        avatarColor: '#c6ff00',
        role: 'HOST',
        totalDrops: 3,
        onTimeDrops: 3,
        missedDrops: 0,
        points: 340,
        currentStreak: 2,
        onTimeRate: 100,
      },
      {
        uid: 'u_2',
        email: 'maya@bindrop.io',
        displayName: 'Maya',
        avatarColor: '#10b981',
        role: 'MEMBER',
        totalDrops: 2,
        onTimeDrops: 2,
        missedDrops: 0,
        points: 220,
        currentStreak: 1,
        onTimeRate: 100,
      },
      {
        uid: 'u_3',
        email: 'jordan@bindrop.io',
        displayName: 'Jordan',
        avatarColor: '#06b6d4',
        role: 'MEMBER',
        totalDrops: 1,
        onTimeDrops: 1,
        missedDrops: 1,
        points: 100,
        currentStreak: 0,
        onTimeRate: 50,
      },
    ],
    currentTurnIndex: 0,
    currentTurnUserId: 'u_1',
    turnStatus: 'OVERDUE',
    nextDeadline: '2026-05-01T10:00:00.000Z',
    rotationIntervalHours: 72, // 3 Days
    warningEmailSentForCurrentTurn: true,
    missedEmailSentForCurrentTurn: true,
    hostAlertedForCurrentTurn: true,
    reminderSentForCurrentTurn: true,
    totalPartyDrops: 6,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };

  const rotated = rotatePartyTurn(initialParty, '2026-05-01T12:00:00.000Z');
  assert.equal(rotated.currentTurnIndex, 1);
  assert.equal(rotated.currentTurnUserId, 'u_2');
  assert.equal(rotated.turnStatus, 'PENDING');
  assert.equal(rotated.warningEmailSentForCurrentTurn, false);
  assert.equal(rotated.missedEmailSentForCurrentTurn, false);
  assert.equal(rotated.hostAlertedForCurrentTurn, false);
  assert.equal(rotated.totalPartyDrops, 7);
  assert.equal(rotated.nextDeadline, '2026-05-04T12:00:00.000Z');
});

test('evaluateDeadlineStatus triggers 5-hour warning email at <= 5 hours and missed deadline email at <= 0', () => {
  const deadlineIso = '2026-05-01T18:00:00.000Z';
  const deadlineMs = new Date(deadlineIso).getTime();

  const onTrack = evaluateDeadlineStatus(
    {
      nextDeadline: deadlineIso,
      warningEmailSentForCurrentTurn: false,
      missedEmailSentForCurrentTurn: false,
      reminderSentForCurrentTurn: false,
      hostAlertedForCurrentTurn: false,
    },
    deadlineMs - 7 * 3600 * 1000
  );
  assert.equal(onTrack.status, 'ON_TRACK');
  assert.equal(onTrack.shouldSendFiveHourWarningEmail, false);

  const dueSoon = evaluateDeadlineStatus(
    {
      nextDeadline: deadlineIso,
      warningEmailSentForCurrentTurn: false,
      missedEmailSentForCurrentTurn: false,
      reminderSentForCurrentTurn: false,
      hostAlertedForCurrentTurn: false,
    },
    deadlineMs - 4.5 * 3600 * 1000
  );
  assert.equal(dueSoon.status, 'DUE_SOON');
  assert.equal(dueSoon.shouldSendFiveHourWarningEmail, true);
  assert.equal(dueSoon.shouldSendMissedDeadlineEmail, false);

  const overdue = evaluateDeadlineStatus(
    {
      nextDeadline: deadlineIso,
      warningEmailSentForCurrentTurn: true,
      missedEmailSentForCurrentTurn: false,
      reminderSentForCurrentTurn: true,
      hostAlertedForCurrentTurn: false,
    },
    deadlineMs + 600 * 1000
  );
  assert.equal(overdue.status, 'OVERDUE');
  assert.equal(overdue.shouldSendMissedDeadlineEmail, true);
  assert.equal(overdue.shouldAlertHost, true);

  const multiDay = formatCountdown(75 * 3600 * 1000);
  assert.equal(multiDay.days, 3);
  assert.equal(multiDay.label.includes('3d'), true);
});

test('buildUpcomingTurnQueue and updateMemberProfile work cleanly', () => {
  const baseParty: PartyState = {
    id: 'party_1',
    name: 'Emerald Loft 4B',
    inviteCode: 'APT-4B9X',
    hostId: 'u_1',
    hostEmail: 'alex@bindrop.io',
    memberIds: ['u_1', 'u_2'],
    members: [
      {
        uid: 'u_1',
        email: 'alex@bindrop.io',
        displayName: 'Alex Rivera',
        avatarColor: '#c6ff00',
        role: 'HOST',
        totalDrops: 3,
        onTimeDrops: 3,
        missedDrops: 0,
        points: 340,
        currentStreak: 2,
        onTimeRate: 100,
      },
      {
        uid: 'u_2',
        email: 'maya@bindrop.io',
        displayName: 'Maya Chen',
        avatarColor: '#10b981',
        role: 'MEMBER',
        totalDrops: 2,
        onTimeDrops: 2,
        missedDrops: 0,
        points: 220,
        currentStreak: 1,
        onTimeRate: 100,
      },
    ],
    currentTurnIndex: 0,
    currentTurnUserId: 'u_1',
    turnStatus: 'PENDING',
    nextDeadline: '2026-05-01T18:00:00.000Z',
    rotationIntervalHours: 24,
    warningEmailSentForCurrentTurn: false,
    missedEmailSentForCurrentTurn: false,
    hostAlertedForCurrentTurn: false,
    reminderSentForCurrentTurn: false,
    totalPartyDrops: 5,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };

  const queue = buildUpcomingTurnQueue(
    baseParty,
    new Date('2026-05-01T14:00:00.000Z').getTime()
  );
  assert.equal(queue.length, 2);
  assert.equal(queue[0].statusLabel, 'UP_NOW');
  assert.equal(queue[0].isWithinFiveHourWarning, true);
  assert.equal(queue[1].statusLabel, 'UP_NEXT');

  const updated = updateMemberProfile(
    baseParty,
    'u_1',
    {
      displayName: 'Alex R. Prime',
      email: 'alex.prime@gmail.com',
      photoURL: 'data:image/jpeg;base64,abc',
    },
    '2026-05-01T15:00:00.000Z'
  );
  assert.equal(updated.members[0].displayName, 'Alex R. Prime');
  assert.equal(updated.members[0].email, 'alex.prime@gmail.com');
  assert.equal(updated.hostEmail, 'alex.prime@gmail.com');

  // Host leaves party -> transfers Host role to next roommate Maya
  const hostLeftResult = leavePartyMember(
    baseParty,
    'u_1',
    'alex@bindrop.io',
    '2026-05-01T16:00:00.000Z'
  );
  assert.equal(hostLeftResult.hostTransferred, true);
  assert.equal(hostLeftResult.updatedParty?.members.length, 1);
  assert.equal(hostLeftResult.updatedParty?.hostId, 'u_2');
  assert.equal(hostLeftResult.updatedParty?.hostEmail, 'maya@bindrop.io');
  assert.equal(hostLeftResult.updatedParty?.members[0].role, 'HOST');

  // Last remaining member leaves -> party is dissolved (null)
  const lastLeftResult = leavePartyMember(
    hostLeftResult.updatedParty!,
    'u_2',
    'maya@bindrop.io'
  );
  assert.equal(lastLeftResult.updatedParty, null);
});

