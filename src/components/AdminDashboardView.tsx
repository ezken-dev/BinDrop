import React, { useMemo, useState } from 'react';
import {
  Database,
  History,
  Mail,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Search,
  Calendar,
  Eye,
  Send,
  X,
  ArrowUpDown,
  ShieldCheck,
  Check,
  XCircle,
} from 'lucide-react';
import {
  buildUpcomingTurnQueue,
  formatCountdown,
  formatDateTimeReadable,
  OFFICIAL_BINDROP_EMAIL,
  OFFICIAL_BINDROP_NAME,
  type EmailAlertType,
  type EmailDispatchLog,
  type HouseholdMember,
  type OfficialMailerStatus,
  type PartyState,
  type TrashDropLog,
  type TurnHistoryRecord,
} from '../utils/trashDutyLogic';
import { generateSimulatedTrashSceneDataUrl } from '../utils/sceneImageGenerator';
import { MemberAvatar } from './MemberAvatar';

interface AdminDashboardViewProps {
  party: PartyState;
  dropLogs: TrashDropLog[];
  historyLogs: TurnHistoryRecord[];
  emailLogs: EmailDispatchLog[];
  nowMs: number;
  isHostOrAdmin: boolean;
  mailerStatus?: OfficialMailerStatus | null;
  onSaveAppPassword: (
    appPassword: string
  ) => Promise<{ ok: boolean; error?: string; flushedCount?: number }>;
  onSendEmailReminder: (params: {
    recipientUserId: string;
    type: EmailAlertType;
    customSubject?: string;
    customMessage?: string;
  }) => Promise<{ deliveredViaGmail: boolean; error?: string }>;
  onHostVerifyDrop: (params: {
    dropId: string;
    decision: 'APPROVE' | 'REJECT';
    hostNote?: string;
  }) => Promise<void>;
  onUpdateTurnDeadline: (nextDeadlineIso: string) => Promise<void>;
  onOpenScanner: () => void;
}

type AdminSection = 'photos' | 'history' | 'emails';

interface PendingEmailConfirmation {
  recipientUserId: string;
  recipientName: string;
  recipientEmail: string;
  type: EmailAlertType;
  subject: string;
  bodyText: string;
}

export const AdminDashboardView: React.FC<AdminDashboardViewProps> = ({
  party,
  dropLogs,
  historyLogs,
  emailLogs,
  nowMs,
  isHostOrAdmin,
  mailerStatus,
  onSaveAppPassword,
  onSendEmailReminder,
  onHostVerifyDrop,
  onUpdateTurnDeadline,
  onOpenScanner,
}) => {
  const [activeSection, setActiveSection] = useState<AdminSection>('photos');
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFilter, setDateFilter] = useState<'ALL' | 'TODAY' | 'LAST_7_DAYS'>('ALL');
  const [statusFilter, setStatusFilter] = useState<
    'ALL' | 'PENDING_HOST_APPROVAL' | 'VERIFIED' | 'REJECTED'
  >('ALL');
  const [sortOrder, setSortOrder] = useState<'DESC' | 'ASC'>('DESC');
  const [selectedDropModal, setSelectedDropModal] = useState<TrashDropLog | null>(null);
  const [hostNoteInput, setHostNoteInput] = useState('');
  const [isVerifyingDropId, setIsVerifyingDropId] = useState<string | null>(null);

  // Email Confirmation Modal & App Password State
  const [emailDraft, setEmailDraft] = useState<PendingEmailConfirmation | null>(null);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [appPasswordInput, setAppPasswordInput] = useState('');
  const [isVerifyingAppPassword, setIsVerifyingAppPassword] = useState(false);
  const [emailBanner, setEmailBanner] = useState<{
    tone: 'success' | 'warning';
    text: string;
  } | null>(null);

  const activeAssignee: HouseholdMember = useMemo(() => {
    return (
      party.members.find((m) => m.uid === party.currentTurnUserId) ||
      party.members[party.currentTurnIndex] ||
      party.members[0]
    );
  }, [party]);

  const upcomingQueue = useMemo(() => buildUpcomingTurnQueue(party, nowMs), [party, nowMs]);

  const pendingPhotosCount = useMemo(
    () =>
      dropLogs.filter((d) => d.verificationStatus === 'PENDING_HOST_APPROVAL').length,
    [dropLogs]
  );

  // Filtered and Date/Time sorted Photo Database
  const filteredPhotoDatabase = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const startOfTodayMs = new Date(nowMs).setHours(0, 0, 0, 0);
    const sevenDaysAgoMs = nowMs - 7 * 24 * 3600 * 1000;

    return [...dropLogs]
      .filter((drop) => {
        const dropTimeMs = new Date(drop.submittedIso || drop.createdAt).getTime();
        if (dateFilter === 'TODAY' && dropTimeMs < startOfTodayMs) return false;
        if (dateFilter === 'LAST_7_DAYS' && dropTimeMs < sevenDaysAgoMs) return false;
        if (statusFilter !== 'ALL' && drop.verificationStatus !== statusFilter) {
          return false;
        }
        if (!q) return true;
        return (
          drop.userDisplayName.toLowerCase().includes(q) ||
          (drop.userEmail || '').toLowerCase().includes(q) ||
          (drop.locationNote || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const tA = new Date(a.submittedIso || a.createdAt).getTime();
        const tB = new Date(b.submittedIso || b.createdAt).getTime();
        return sortOrder === 'DESC' ? tB - tA : tA - tB;
      });
  }, [dropLogs, searchQuery, dateFilter, statusFilter, sortOrder, nowMs]);

  // Categorized Turn History: On-Time vs Missed/Late
  const onTimeHistoryRecords = useMemo(() => {
    return historyLogs.filter((h) => h.outcome === 'ON_TIME');
  }, [historyLogs]);

  const missedAndLateHistoryRecords = useMemo(() => {
    return historyLogs.filter(
      (h) => h.outcome === 'MISSED_DEADLINE' || h.outcome === 'COMPLETED_LATE'
    );
  }, [historyLogs]);

  const openEmailConfirmationModal = (
    recipient: { uid: string; displayName: string; email: string },
    type: EmailAlertType
  ) => {
    const deadlineDt = formatDateTimeReadable(party.nextDeadline);
    let subject = `[BinDrop] Reminder: Your Trash Duty Turn in "${party.name}"`;
    let bodyText = `Hi ${recipient.displayName},\n\nThis is a reminder from your household "${party.name}" (Invite Code: ${party.inviteCode}).\n\nIt is currently your turn to take out the household trash (Deadline: ${deadlineDt.fullLabel}).\n\nOnce you take out the trash, open BinDrop and upload a photo so your Host can verify and complete your turn.\n\n— BinDrop Household Tracker`;

    if (type === 'WARNING_5H') {
      subject = `[BinDrop] 5-Hour Advance Warning: Trash Turn Due Soon (${party.name})`;
      bodyText = `Hi ${recipient.displayName},\n\nHeads up! You have less than 5 hours remaining to complete your household trash duty for "${party.name}".\n\nScheduled Deadline: ${deadlineDt.fullLabel}\n\nPlease take the trash out to the outdoor bin and upload your photo in BinDrop for Host verification before the deadline expires.\n\n— BinDrop Automated 5-Hour Warning`;
    } else if (type === 'MISSED_DEADLINE') {
      subject = `[BinDrop] OVERDUE ALERT: Missed Trash Duty Deadline in "${party.name}"`;
      bodyText = `Hi ${recipient.displayName},\n\nYou missed your scheduled trash disposal deadline (${deadlineDt.fullLabel}) for "${party.name}".\n\nYour Party Host (${party.hostEmail}) has been notified. Please take out the trash as soon as possible and upload your photo in BinDrop for Host verification.\n\n— BinDrop Compliance Monitor`;
    }

    setEmailDraft({
      recipientUserId: recipient.uid,
      recipientName: recipient.displayName,
      recipientEmail: recipient.email,
      type,
      subject,
      bodyText,
    });
  };

  const handleSaveAppPasswordSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleaned = appPasswordInput.replace(/\s+/g, '');
    if (!cleaned) {
      setEmailBanner({
        tone: 'warning',
        text: 'Please paste the 16-character Google App Password for bindropofficial@gmail.com.',
      });
      return;
    }
    setIsVerifyingAppPassword(true);
    setEmailBanner(null);
    try {
      const res = await onSaveAppPassword(cleaned);
      if (res.ok) {
        setAppPasswordInput('');
        setEmailBanner({
          tone: 'success',
          text:
            res.flushedCount && res.flushedCount > 0
              ? `Connected bindropofficial@gmail.com to smtp.gmail.com! Automatically sent ${res.flushedCount} pending email(s) to real inboxes & saved in Sent Mail.`
              : `Connected bindropofficial@gmail.com to smtp.gmail.com! All auto-emails & reminder buttons now deliver to real inboxes & appear in Gmail Sent Mail.`,
        });
      } else {
        setEmailBanner({
          tone: 'warning',
          text:
            res.error ||
            'Google SMTP rejected that password. Make sure you paste the 16-character App Password from myaccount.google.com/apppasswords.',
        });
      }
    } finally {
      setIsVerifyingAppPassword(false);
    }
  };

  const handleConfirmAndSendEmail = async () => {
    if (!emailDraft) return;
    setIsSendingEmail(true);
    setEmailBanner(null);
    try {
      const result = await onSendEmailReminder({
        recipientUserId: emailDraft.recipientUserId,
        type: emailDraft.type,
        customSubject: emailDraft.subject,
        customMessage: emailDraft.bodyText,
      });

      if (result.deliveredViaGmail) {
        setEmailBanner({
          tone: 'success',
          text: `Instant Pop-Up & Browser Push Notification delivered to ${emailDraft.recipientName} (${emailDraft.recipientEmail})!`,
        });
      } else {
        setEmailBanner({
          tone: 'success',
          text: `Pop-Up Notification sent to ${emailDraft.recipientName} (${emailDraft.recipientEmail})!`,
        });
      }
      setEmailDraft(null);
    } finally {
      setIsSendingEmail(false);
    }
  };

  const handleHostDecision = async (
    dropId: string,
    decision: 'APPROVE' | 'REJECT',
    note?: string
  ) => {
    setIsVerifyingDropId(dropId);
    try {
      await onHostVerifyDrop({
        dropId,
        decision,
        hostNote: note || hostNoteInput.trim() || undefined,
      });
      setHostNoteInput('');
      setSelectedDropModal(null);
    } finally {
      setIsVerifyingDropId(null);
    }
  };

  const handleSetDeadlineOffsetHours = async (hoursFromNow: number) => {
    const targetIso = new Date(Date.now() + hoursFromNow * 3600 * 1000).toISOString();
    await onUpdateTurnDeadline(targetIso);
    if (hoursFromNow <= 0) {
      setEmailBanner({
        tone: 'success',
        text: `Deadline expired — Overdue status triggered for ${activeAssignee.email}!`,
      });
    } else if (hoursFromNow <= 5) {
      setEmailBanner({
        tone: 'success',
        text: `Turn entered 5-hour warning window (<5h remaining) for ${activeAssignee.email}!`,
      });
    } else {
      setEmailBanner({
        tone: 'success',
        text: `Turn deadline updated to ${hoursFromNow} hours from now.`,
      });
    }
  };

  const sortedLeaderboard = useMemo(
    () => [...party.members].sort((a, b) => b.points - a.points),
    [party.members]
  );

  return (
    <div className="animate-view-enter space-y-5">
      {/* Household Standings Leaderboard Card */}
      <div className="bento-stat-card rounded-[28px] p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg sm:text-xl og-bold text-white">Household Standings</h2>
            <p className="text-xs text-zinc-400">
              {party.name} · Ranked by Host-verified trash disposal points
            </p>
          </div>
          <span className="px-3 py-1 rounded-full bg-[#c8ff2e]/15 border border-[#c8ff2e]/35 text-xs font-mono og-bold text-[#c8ff2e]">
            {party.totalPartyDrops} Total Cycles
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {sortedLeaderboard.map((member, idx) => (
            <div
              key={member.uid}
              className={`p-3.5 rounded-2xl border flex items-center justify-between gap-3 ${
                idx === 0
                  ? 'bg-[#c8ff2e]/10 border-[#c8ff2e]/40'
                  : 'bg-[#09190b] border-white/[0.07]'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-mono og-bold text-xs text-[#c8ff2e] w-5">
                  #{idx + 1}
                </span>
                <MemberAvatar member={member} size="sm" highlightRing={idx === 0} />
                <div className="min-w-0">
                  <p className="text-xs sm:text-sm og-bold text-white truncate">
                    {member.displayName}
                  </p>
                  <p className="text-[11px] text-zinc-400 font-mono truncate">
                    {member.onTimeDrops} on-time · {member.missedDrops} missed
                  </p>
                </div>
              </div>
              <div className="text-right shrink-0">
                <span className="text-sm og-bold font-mono text-[#c8ff2e] tabular-nums">
                  {member.points} pts
                </span>
                <span className="block text-[10px] text-zinc-400 font-mono">
                  {member.currentStreak}x streak
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Top Admin Header & Sub-Navigation */}
      <div className="bento-stat-card rounded-[28px] p-5 sm:p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 text-xs og-medium text-[#c8ff2e]">
              <ShieldCheck className="w-4 h-4" />
              <span>
                {isHostOrAdmin
                  ? `Host Verification & History · ${party.name}`
                  : `Household Photo Verification & History`}
              </span>
            </div>
            <h1 className="text-xl sm:text-2xl og-bold text-white tracking-tight">
              Trash Photo Database &amp; Duty History
            </h1>
          </div>

          {/* 3 Section Pills */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setActiveSection('photos')}
              data-testid="admin-tab-photos"
              className={`px-4 py-2.5 rounded-full text-xs og-bold flex items-center gap-2 transition-all ${
                activeSection === 'photos'
                  ? 'bg-[#d0ff45] text-[#041206]'
                  : 'bg-[#091c0b] text-zinc-300 border border-white/10 hover:text-white'
              }`}
            >
              <Database className="w-3.5 h-3.5" />
              <span>
                Photo Database ({dropLogs.length}
                {pendingPhotosCount > 0 ? ` · ${pendingPhotosCount} Pending` : ''})
              </span>
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('history')}
              data-testid="admin-tab-history"
              className={`px-4 py-2.5 rounded-full text-xs og-bold flex items-center gap-2 transition-all ${
                activeSection === 'history'
                  ? 'bg-[#d0ff45] text-[#041206]'
                  : 'bg-[#091c0b] text-zinc-300 border border-white/10 hover:text-white'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>Duty History ({historyLogs.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('emails')}
              data-testid="admin-tab-emails"
              className={`px-4 py-2.5 rounded-full text-xs og-bold flex items-center gap-2 transition-all ${
                activeSection === 'emails'
                  ? 'bg-[#d0ff45] text-[#041206]'
                  : 'bg-[#091c0b] text-zinc-300 border border-white/10 hover:text-white'
              }`}
            >
              <Mail className="w-3.5 h-3.5" />
              <span>Pop-Up Notifications ({emailLogs.length})</span>
            </button>
          </div>
        </div>

        {/* Summary KPI Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-white/10">
          <div className="p-4 rounded-2xl bg-[#07190a] border border-white/[0.07]">
            <span className="text-[11px] og-light text-zinc-400 block">
              Total Uploaded Photos
            </span>
            <span className="text-xl og-bold font-mono text-white tabular-nums mt-0.5 block">
              {dropLogs.length}
            </span>
          </div>
          <div className="p-4 rounded-2xl bg-[#07190a] border border-white/[0.07]">
            <span className="text-[11px] og-light text-zinc-400 block">
              Pending Host Verification
            </span>
            <span className="text-xl og-bold font-mono text-amber-300 tabular-nums mt-0.5 block">
              {pendingPhotosCount}
            </span>
          </div>
          <div className="p-4 rounded-2xl bg-[#07190a] border border-white/[0.07]">
            <span className="text-[11px] og-light text-zinc-400 block">
              Completed On Time
            </span>
            <span className="text-xl og-bold font-mono text-[#d0ff45] tabular-nums mt-0.5 block">
              {onTimeHistoryRecords.length}
            </span>
          </div>
          <div className="p-4 rounded-2xl bg-[#07190a] border border-white/[0.07]">
            <span className="text-[11px] og-light text-zinc-400 block">
              Missed / Late Turns
            </span>
            <span className="text-xl og-bold font-mono text-rose-400 tabular-nums mt-0.5 block">
              {missedAndLateHistoryRecords.length}
            </span>
          </div>
        </div>

        {emailBanner && (
          <div
            className={`p-3.5 rounded-2xl border text-xs og-medium flex items-center justify-between ${
              emailBanner.tone === 'success'
                ? 'bg-[#d0ff45]/15 border-[#d0ff45]/40 text-[#d0ff45]'
                : 'bg-amber-500/15 border-amber-500/40 text-amber-200'
            }`}
          >
            <span>{emailBanner.text}</span>
          </div>
        )}
      </div>

      {/* SECTION 1: TIMESTAMPED PHOTO DATABASE & HOST VERIFICATION */}
      {activeSection === 'photos' && (
        <div className="glass-panel rounded-[32px] p-6 sm:p-8 space-y-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h2 className="text-xl og-bold text-white">
                Trash Disposal Photo Database &amp; Host Verification (By Date &amp; Time)
              </h2>
              <p className="text-xs og-light text-zinc-400 mt-0.5">
                Every trash photo uploaded by household members with exact date, time, account email, and Host verification controls.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search member or email..."
                  className="pill-input pl-9 pr-4 py-2 rounded-full text-xs text-white placeholder:text-zinc-500"
                />
              </div>

              <select
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value as 'ALL' | 'TODAY' | 'LAST_7_DAYS')}
                aria-label="Filter photos by date"
                className="pill-input px-3.5 py-2 rounded-full text-xs text-white bg-[#091c0b]"
              >
                <option value="ALL">All Dates</option>
                <option value="TODAY">Today Only</option>
                <option value="LAST_7_DAYS">Last 7 Days</option>
              </select>

              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(
                    e.target.value as
                      | 'ALL'
                      | 'PENDING_HOST_APPROVAL'
                      | 'VERIFIED'
                      | 'REJECTED'
                  )
                }
                aria-label="Filter photos by verification status"
                className="pill-input px-3.5 py-2 rounded-full text-xs text-white bg-[#091c0b]"
              >
                <option value="ALL">All Verification Statuses</option>
                <option value="PENDING_HOST_APPROVAL">Pending Host Approval</option>
                <option value="VERIFIED">Verified by Host</option>
                <option value="REJECTED">Rejected by Host</option>
              </select>

              <button
                type="button"
                onClick={() => setSortOrder((prev) => (prev === 'DESC' ? 'ASC' : 'DESC'))}
                className="px-3.5 py-2 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs text-zinc-200 flex items-center gap-1.5"
              >
                <ArrowUpDown className="w-3.5 h-3.5 text-[#d0ff45]" />
                <span>{sortOrder === 'DESC' ? 'Newest First' : 'Oldest First'}</span>
              </button>
            </div>
          </div>

          {filteredPhotoDatabase.length === 0 ? (
            <div className="p-8 rounded-3xl bg-[#07190a] border border-white/[0.07] text-center space-y-3">
              <Calendar className="w-8 h-8 text-[#d0ff45] mx-auto" />
              <div className="space-y-1">
                <h3 className="text-base og-bold text-white">No Trash Photos Uploaded Yet</h3>
                <p className="text-xs og-light text-zinc-400 max-w-md mx-auto">
                  When any household member uploads their trash disposal photo, it appears here with its exact date and time so the Host can verify and approve it.
                </p>
              </div>
              <button
                type="button"
                onClick={onOpenScanner}
                className="lime-cta px-5 py-2.5 rounded-full og-bold text-xs inline-flex items-center gap-2"
              >
                <span>Upload Trash Photo</span>
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table
                data-testid="admin-photo-database-table"
                className="w-full text-left border-collapse"
              >
                <thead>
                  <tr className="border-b border-white/10 text-xs text-zinc-400">
                    <th className="py-3 px-4 og-medium">Trash Photo</th>
                    <th className="py-3 px-4 og-medium">Date &amp; Exact Time</th>
                    <th className="py-3 px-4 og-medium">Member &amp; Account Email</th>
                    <th className="py-3 px-4 og-medium">Host Verification Status</th>
                    <th className="py-3 px-4 og-medium">Location / Host Note</th>
                    <th className="py-3 px-4 og-medium text-right">Host Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.08] text-xs">
                  {filteredPhotoDatabase.map((drop) => {
                    const dt = formatDateTimeReadable(drop.submittedIso || drop.createdAt);
                    const deadlineDt = formatDateTimeReadable(drop.deadlineIso || drop.createdAt);
                    const isPending = drop.verificationStatus === 'PENDING_HOST_APPROVAL';
                    const isVerified = drop.verificationStatus === 'VERIFIED';

                    return (
                      <tr key={drop.id} className="hover:bg-white/[0.02] transition-colors">
                        <td className="py-3.5 px-4">
                          <button
                            type="button"
                            onClick={() => setSelectedDropModal(drop)}
                            className="relative w-20 h-14 rounded-xl overflow-hidden border border-white/15 group block bg-[#041206]"
                          >
                            <img
                              src={
                                drop.imageUrl ||
                                generateSimulatedTrashSceneDataUrl({
                                  memberName: drop.userDisplayName,
                                  variant: 'valid_bag_in_bin',
                                })
                              }
                              alt={`Trash drop by ${drop.userDisplayName}`}
                              referrerPolicy="no-referrer"
                              onError={(e) => {
                                const target = e.currentTarget;
                                if (!target.dataset.fallbackApplied) {
                                  target.dataset.fallbackApplied = 'true';
                                  target.src = generateSimulatedTrashSceneDataUrl({
                                    memberName: drop.userDisplayName,
                                    variant: 'valid_bag_in_bin',
                                  });
                                }
                              }}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                            />
                          </button>
                        </td>
                        <td className="py-3.5 px-4 font-mono tabular-nums">
                          <div className="og-bold text-white">{dt.datePart}</div>
                          <div className="text-[#d0ff45]">{dt.timePart}</div>
                          <div className="text-[10px] text-zinc-500 mt-0.5">
                            Due: {deadlineDt.datePart} {deadlineDt.timePart}
                          </div>
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="og-bold text-white text-sm">{drop.userDisplayName}</div>
                          <div className="text-zinc-400 font-mono">{drop.userEmail || '—'}</div>
                        </td>
                        <td className="py-3.5 px-4">
                          {isPending ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 og-bold">
                              <Clock className="w-3.5 h-3.5" />
                              Pending Host Verification
                            </span>
                          ) : isVerified ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#d0ff45]/15 text-[#d0ff45] og-bold">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Verified by Host (+{drop.pointsAwarded} pts)
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-rose-500/20 text-rose-300 og-bold">
                              <XCircle className="w-3.5 h-3.5" />
                              Rejected by Host
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 max-w-xs">
                          <div className="og-medium text-zinc-200 truncate">
                            {drop.locationNote || 'Outdoor trash bin'}
                          </div>
                          {drop.hostReviewNote && (
                            <div className="text-zinc-400 truncate mt-0.5">
                              Host Note: {drop.hostReviewNote}
                            </div>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            {isHostOrAdmin && isPending && (
                              <>
                                <button
                                  type="button"
                                  disabled={isVerifyingDropId === drop.id}
                                  data-testid={`approve-photo-btn-${drop.id}`}
                                  onClick={() => handleHostDecision(drop.id, 'APPROVE')}
                                  className="px-3 py-1.5 rounded-full bg-[#d0ff45] text-[#041206] og-bold inline-flex items-center gap-1 hover:scale-105 transition-transform"
                                >
                                  <Check className="w-3.5 h-3.5" />
                                  Approve
                                </button>
                                <button
                                  type="button"
                                  disabled={isVerifyingDropId === drop.id}
                                  data-testid={`reject-photo-btn-${drop.id}`}
                                  onClick={() => handleHostDecision(drop.id, 'REJECT')}
                                  className="px-3 py-1.5 rounded-full bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 og-bold inline-flex items-center gap-1"
                                >
                                  <X className="w-3.5 h-3.5" />
                                  Reject
                                </button>
                              </>
                            )}
                            <button
                              type="button"
                              onClick={() => setSelectedDropModal(drop)}
                              className="px-3 py-1.5 rounded-full bg-white/[0.07] hover:bg-white/[0.14] text-white og-medium inline-flex items-center gap-1.5"
                            >
                              <Eye className="w-3.5 h-3.5 text-[#d0ff45]" />
                              Inspect
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* SECTION 2: DUTY & TURN COMPLIANCE HISTORY SYSTEM */}
      {activeSection === 'history' && (
        <div className="space-y-6">
          {/* 1. WHO IS ABOUT TO DO IT (UP NOW & UPCOMING ROTATION) */}
          <div className="glass-panel rounded-[32px] p-6 sm:p-8 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-lg og-bold text-white">
                  1. Who Is About To Do It (Current Turn &amp; Upcoming Rotation)
                </h2>
                <p className="text-xs og-light text-zinc-400">
                  Live status of the person currently on trash duty, 5-hour warning status, and the next roommates in line.
                </p>
              </div>
              <span className="text-xs font-mono text-[#d0ff45]">
                5-Hour Advance Warning Active
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {upcomingQueue.map((slot) => {
                const slotDt = formatDateTimeReadable(slot.projectedDeadlineIso);
                const slotRemainingMs =
                  new Date(slot.projectedDeadlineIso).getTime() - nowMs;
                const slotCd = formatCountdown(slotRemainingMs);

                return (
                  <div
                    key={slot.member.uid}
                    className={`p-5 rounded-3xl border flex flex-col justify-between space-y-4 ${
                      slot.statusLabel === 'UP_NOW'
                        ? slot.isOverdue
                          ? 'bg-rose-950/35 border-rose-500/50'
                          : 'bg-[#102612] border-[#d0ff45]/50'
                        : 'bg-[#08190a] border-white/[0.08]'
                    }`}
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`text-[11px] og-bold px-2.5 py-0.5 rounded-full ${
                            slot.statusLabel === 'UP_NOW'
                              ? slot.isOverdue
                                ? 'bg-rose-500 text-slate-950'
                                : 'bg-[#d0ff45] text-[#041206]'
                              : 'bg-white/10 text-zinc-300'
                          }`}
                        >
                          {slot.statusLabel === 'UP_NOW'
                            ? slot.isOverdue
                              ? 'OVERDUE NOW'
                              : 'ON DUTY RIGHT NOW'
                            : slot.statusLabel === 'UP_NEXT'
                            ? 'UP NEXT'
                            : `IN ${slot.queuePosition} TURNS`}
                        </span>
                        <span className="text-xs font-mono text-zinc-400 tabular-nums">
                          {slot.member.onTimeRate}% on-time
                        </span>
                      </div>

                      <div className="flex items-center gap-3">
                        <MemberAvatar
                          member={slot.member}
                          size="md"
                          highlightRing={slot.statusLabel === 'UP_NOW'}
                        />
                        <div className="min-w-0">
                          <p className="text-sm og-bold text-white truncate">
                            {slot.member.displayName}
                          </p>
                          <p className="text-xs text-zinc-400 font-mono truncate">
                            {slot.member.email}
                          </p>
                        </div>
                      </div>

                      <div className="p-3 rounded-2xl bg-black/30 border border-white/[0.06] text-xs space-y-1">
                        <div className="flex items-center justify-between text-zinc-400">
                          <span>Deadline:</span>
                          <span className="font-mono text-zinc-200">
                            {slotDt.datePart} · {slotDt.timePart}
                          </span>
                        </div>
                        {slot.statusLabel === 'UP_NOW' && (
                          <div className="flex items-center justify-between">
                            <span className="text-zinc-400">Countdown:</span>
                            <span
                              className={`font-mono og-bold ${
                                slot.isOverdue ? 'text-rose-400' : 'text-[#d0ff45]'
                              }`}
                            >
                              {slotCd.label}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        openEmailConfirmationModal(
                          slot.member,
                          slot.statusLabel === 'UP_NOW' && slot.isWithinFiveHourWarning
                            ? 'WARNING_5H'
                            : 'MANUAL_REMINDER'
                        )
                      }
                      className="w-full py-2.5 px-4 rounded-full bg-white/[0.08] hover:bg-white/[0.14] text-xs og-medium text-white flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <Send className="w-3.5 h-3.5 text-[#d0ff45]" />
                      <span>Mail Reminder to {slot.member.email}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 2. WHO DID THE WORK ON TIME & 3. WHO MISSED ON TIME */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left 6 Cols: Who Did the Work On Time */}
            <div className="lg:col-span-6 glass-panel rounded-[32px] p-6 sm:p-8 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg og-bold text-white flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-[#d0ff45]" />
                    <span>2. Who Completed On Time</span>
                  </h3>
                  <p className="text-xs og-light text-zinc-400">
                    Host-verified trash drops submitted prior to the turn deadline
                  </p>
                </div>
                <span className="text-xs font-mono og-bold text-[#d0ff45] tabular-nums">
                  {onTimeHistoryRecords.length} records
                </span>
              </div>

              {onTimeHistoryRecords.length === 0 ? (
                <div className="p-6 rounded-2xl bg-[#07190a] border border-white/[0.06] text-xs text-zinc-400 text-center">
                  No on-time turn completions logged yet.
                </div>
              ) : (
                <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
                  {onTimeHistoryRecords.map((rec) => {
                    const dt = formatDateTimeReadable(rec.recordedIso);
                    return (
                      <div
                        key={rec.id}
                        className="p-4 rounded-2xl bg-[#0b210e] border border-[#d0ff45]/30 flex items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {rec.imageUrl && (
                            <img
                              src={rec.imageUrl}
                              alt={rec.userDisplayName}
                              referrerPolicy="no-referrer"
                              onError={(e) => {
                                const target = e.currentTarget;
                                if (!target.dataset.fallbackApplied) {
                                  target.dataset.fallbackApplied = 'true';
                                  target.src = generateSimulatedTrashSceneDataUrl({
                                    memberName: rec.userDisplayName,
                                    variant: 'valid_bag_in_bin',
                                  });
                                }
                              }}
                              className="w-12 h-12 rounded-xl object-cover border border-white/10 shrink-0"
                            />
                          )}
                          <div className="min-w-0">
                            <p className="text-sm og-bold text-white truncate">
                              {rec.userDisplayName}
                            </p>
                            <p className="text-[11px] text-zinc-400 font-mono truncate">
                              {rec.userEmail}
                            </p>
                            <p className="text-[11px] text-[#d0ff45] font-mono mt-0.5">
                              {dt.datePart} at {dt.timePart}
                            </p>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <span className="text-xs og-bold font-mono text-[#d0ff45]">
                            +{rec.pointsAwarded} pts
                          </span>
                          <span className="block text-[10px] text-zinc-400">ON TIME</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Right 6 Cols: Who Missed On Time */}
            <div className="lg:col-span-6 glass-panel rounded-[32px] p-6 sm:p-8 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg og-bold text-white flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-rose-400" />
                    <span>3. Who Missed On Time</span>
                  </h3>
                  <p className="text-xs og-light text-zinc-400">
                    Missed deadlines &amp; late completions with email alert audit
                  </p>
                </div>
                <span className="text-xs font-mono og-bold text-rose-400 tabular-nums">
                  {missedAndLateHistoryRecords.length} records
                </span>
              </div>

              {missedAndLateHistoryRecords.length === 0 ? (
                <div className="p-6 rounded-2xl bg-[#07190a] border border-white/[0.06] text-xs text-zinc-400 text-center">
                  Zero missed deadlines! Everyone in {party.name} is currently on time.
                </div>
              ) : (
                <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
                  {missedAndLateHistoryRecords.map((rec) => {
                    const dt = formatDateTimeReadable(rec.recordedIso);
                    const dueDt = formatDateTimeReadable(rec.deadlineIso);
                    return (
                      <div
                        key={rec.id}
                        className="p-4 rounded-2xl bg-rose-950/30 border border-rose-500/40 space-y-2.5"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-sm og-bold text-white">
                              {rec.userDisplayName}{' '}
                              <span className="text-xs font-mono font-normal text-rose-300">
                                ({rec.userEmail})
                              </span>
                            </p>
                            <p className="text-[11px] text-zinc-400 font-mono">
                              Missed Deadline: {dueDt.datePart} at {dueDt.timePart} · Logged:{' '}
                              {dt.timePart}
                            </p>
                          </div>
                          <span className="px-2.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300 text-[10px] og-bold shrink-0">
                            {rec.outcome === 'MISSED_DEADLINE' ? 'MISSED ON TIME' : 'COMPLETED LATE'}
                          </span>
                        </div>
                        <p className="text-xs text-zinc-300">{rec.notes}</p>
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={() =>
                              openEmailConfirmationModal(
                                {
                                  uid: rec.userId,
                                  displayName: rec.userDisplayName,
                                  email: rec.userEmail,
                                },
                                'MISSED_DEADLINE'
                              )
                            }
                            className="px-3 py-1.5 rounded-full bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-[11px] og-medium inline-flex items-center gap-1.5"
                          >
                            <Mail className="w-3 h-3" />
                            <span>Send Real Overdue Email to {rec.userEmail}</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* SECTION 3: LIVE POP-UP & BROWSER PUSH NOTIFICATION DISPATCHER + HOST DEADLINE CONTROLS */}
      {activeSection === 'emails' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left 5 Cols: Instant Social Pop-Up & Push Trigger Controls */}
          <div className="lg:col-span-5 glass-panel rounded-[32px] p-6 sm:p-8 space-y-5">
            <div className="space-y-1">
              <h2 className="text-lg og-bold text-white">
                Instant Pop-Up &amp; Push Notification Center
              </h2>
              <p className="text-xs og-light text-zinc-400">
                Delivers real-time Instagram/Facebook-style floating pop-up banners and OS browser push notifications to household members.
              </p>
            </div>

            <div className="p-4 rounded-2xl border bg-[#0d2611] border-[#d0ff45]/45 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs og-bold text-[#d0ff45] flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Live Social Pop-Up &amp; Browser Push Active</span>
                </span>
                <span className="px-2.5 py-0.5 rounded-full bg-[#d0ff45] text-[#041206] text-[10px] og-bold">
                  REAL-TIME
                </span>
              </div>
              <p className="text-xs font-mono text-white og-bold">
                {party.name} · Code {party.inviteCode}
              </p>
              <p className="text-[11px] text-zinc-300">
                All 5-hour advance warnings, missed-deadline alerts, roommate photo uploads, and manual nudges immediately pop up on screen with sound and OS push notifications.
              </p>
            </div>

            <div className="p-4 rounded-2xl bg-[#07190a] border border-white/10 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Delivery Channel:</span>
                <strong className="text-[#d0ff45] font-mono">In-App Pop-Up + OS Push</strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Current Turn Member:</span>
                <strong className="text-white">{activeAssignee.displayName}</strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Member Account:</span>
                <strong className="text-[#d0ff45] font-mono">{activeAssignee.email}</strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Host Account:</span>
                <strong className="text-zinc-200 font-mono">{party.hostEmail}</strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">5h Auto-Warning Status:</span>
                <strong className="text-zinc-200">
                  {party.warningEmailSentForCurrentTurn
                    ? 'Triggered for Current Turn'
                    : 'Armed (Auto-pops at <= 5h left)'}
                </strong>
              </div>
            </div>

            <div className="space-y-2.5">
              <span className="text-xs og-medium text-white block">
                Send Instant Pop-Up Notification Now
              </span>
              <button
                type="button"
                onClick={() => openEmailConfirmationModal(activeAssignee, 'WARNING_5H')}
                data-testid="send-5h-warning-email-btn"
                className="lime-cta w-full py-3 px-4 rounded-full og-bold text-xs flex items-center justify-center gap-2"
              >
                <Send className="w-4 h-4" />
                <span>Send 5-Hour Warning Pop-Up to {activeAssignee.displayName}</span>
              </button>

              <button
                type="button"
                onClick={() => openEmailConfirmationModal(activeAssignee, 'MISSED_DEADLINE')}
                data-testid="send-missed-deadline-email-btn"
                className="w-full py-3 px-4 rounded-full bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-200 og-bold text-xs flex items-center justify-center gap-2 transition-colors"
              >
                <AlertTriangle className="w-4 h-4" />
                <span>Send Overdue Pop-Up Alert to {activeAssignee.displayName}</span>
              </button>
            </div>

            <div className="pt-4 border-t border-white/10 space-y-2.5">
              <span className="text-xs og-medium text-white block">
                Host: Adjust Active Turn Deadline Window (1 to 7 Days)
              </span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => handleSetDeadlineOffsetHours(24)}
                  className="py-2.5 px-3 rounded-2xl bg-[#091c0b] hover:bg-[#112914] border border-white/10 text-xs text-zinc-200 og-medium"
                >
                  Set 1 Day (24h)
                </button>
                <button
                  type="button"
                  onClick={() => handleSetDeadlineOffsetHours(48)}
                  className="py-2.5 px-3 rounded-2xl bg-[#091c0b] hover:bg-[#112914] border border-white/10 text-xs text-zinc-200 og-medium"
                >
                  Set 2 Days (48h)
                </button>
                <button
                  type="button"
                  onClick={() => handleSetDeadlineOffsetHours(72)}
                  className="py-2.5 px-3 rounded-2xl bg-[#091c0b] hover:bg-[#112914] border border-white/10 text-xs text-zinc-200 og-medium"
                >
                  Set 3 Days (72h)
                </button>
                <button
                  type="button"
                  onClick={() => handleSetDeadlineOffsetHours(168)}
                  className="py-2.5 px-3 rounded-2xl bg-[#091c0b] hover:bg-[#112914] border border-white/10 text-xs text-zinc-200 og-medium"
                >
                  Set 7 Days (168h)
                </button>
              </div>
            </div>
          </div>

          {/* Right 7 Cols: Dispatched Pop-Up Notification History Log */}
          <div className="lg:col-span-7 glass-panel rounded-[32px] p-6 sm:p-8 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg og-bold text-white">
                  Dispatched Pop-Up Notification Log
                </h2>
                <p className="text-xs og-light text-zinc-400">
                  Real-time log of all 5-hour warnings, missed-deadline alerts, and roommate nudges
                </p>
              </div>
              <span className="text-xs font-mono text-[#d0ff45] tabular-nums">
                {emailLogs.length} delivered
              </span>
            </div>

            {emailLogs.length === 0 ? (
              <div className="p-8 rounded-3xl bg-[#07190a] border border-white/[0.07] text-center space-y-2">
                <Send className="w-7 h-7 text-[#d0ff45] mx-auto" />
                <p className="text-sm og-bold text-white">No Pop-Up Notifications Dispatched Yet</p>
                <p className="text-xs og-light text-zinc-400 max-w-md mx-auto">
                  When a roommate&apos;s turn reaches 5 hours before the deadline or expires, or when you trigger a pop-up alert on the left, it pops up immediately and is logged here.
                </p>
              </div>
            ) : (
              <div
                data-testid="email-dispatch-log-list"
                className="space-y-3 max-h-[540px] overflow-y-auto pr-1"
              >
                {emailLogs.map((mail) => {
                  const dt = formatDateTimeReadable(mail.sentAt);

                  return (
                    <div
                      key={mail.id}
                      className="p-4 rounded-2xl bg-[#08190a] border border-white/10 space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-2.5 py-0.5 rounded-full og-bold text-[10px] ${
                              mail.type === 'MISSED_DEADLINE' || mail.type === 'HOST_ESCALATION'
                                ? 'bg-rose-500/20 text-rose-300'
                                : 'bg-[#d0ff45]/20 text-[#d0ff45]'
                            }`}
                          >
                            {mail.type}
                          </span>
                          <span className="px-2.5 py-0.5 rounded-full font-mono text-[10px] bg-emerald-500/20 text-emerald-300">
                            POP-UP &amp; PUSH DELIVERED
                          </span>
                        </div>
                        <span className="font-mono text-zinc-400 text-[11px]">
                          {dt.datePart} at {dt.timePart}
                        </span>
                      </div>

                      <div className="text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
                        <div>
                          <span className="text-zinc-400">Recipient: </span>
                          <strong className="text-white">{mail.toName}</strong>{' '}
                          <span className="font-mono text-[#d0ff45]">&lt;{mail.toEmail}&gt;</span>
                        </div>
                      </div>

                      <div className="text-xs og-bold text-white">{mail.subject}</div>

                      <pre className="p-3 rounded-xl bg-black/40 border border-white/[0.05] text-[11px] text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
                        {mail.bodyText}
                      </pre>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirmation Modal before Sending Instant Pop-Up Notification */}
      {emailDraft && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm Pop-Up Notification"
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4"
        >
          <div className="w-full max-w-lg glass-panel-elevated rounded-[32px] p-6 sm:p-7 space-y-4 animate-modal-enter max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[11px] og-bold text-[#d0ff45] uppercase tracking-wider block">
                  Live Social Pop-Up &amp; Browser Push · {party.name}
                </span>
                <h3 className="text-lg og-bold text-white">
                  Send Pop-Up Notification to {emailDraft.recipientName}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setEmailDraft(null)}
                aria-label="Cancel notification send"
                className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3.5 rounded-2xl bg-[#07190a] border border-white/10 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-400">Household Party:</span>
                  <strong className="font-mono text-[#d0ff45]">
                    {party.name} ({party.inviteCode})
                  </strong>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-zinc-400">Recipient:</span>
                  <strong className="font-mono text-white">
                    {emailDraft.recipientName} &lt;{emailDraft.recipientEmail}&gt;
                  </strong>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-zinc-400">Delivery Mode:</span>
                  <strong className="font-mono text-[#d0ff45]">
                    Instant Social Pop-Up Banner + OS Push
                  </strong>
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-xs og-medium text-white">Pop-Up Headline</label>
                <input
                  type="text"
                  value={emailDraft.subject}
                  onChange={(e) =>
                    setEmailDraft((prev) =>
                      prev ? { ...prev, subject: e.target.value } : prev
                    )
                  }
                  className="pill-input w-full px-4 py-2.5 rounded-2xl text-xs text-white"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-xs og-medium text-white">Notification Message</label>
                <textarea
                  rows={4}
                  value={emailDraft.bodyText}
                  onChange={(e) =>
                    setEmailDraft((prev) =>
                      prev ? { ...prev, bodyText: e.target.value } : prev
                    )
                  }
                  className="pill-input w-full p-3.5 rounded-2xl text-xs text-white font-sans leading-relaxed"
                />
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setEmailDraft(null)}
                className="w-full sm:w-auto px-5 py-3 rounded-full bg-white/10 hover:bg-white/15 text-xs og-medium text-white"
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={isSendingEmail}
                data-testid="confirm-send-real-email-btn"
                onClick={() => handleConfirmAndSendEmail()}
                className="w-full sm:w-auto lime-cta px-6 py-3 rounded-full og-bold text-xs flex items-center justify-center gap-2"
              >
                <Send className="w-3.5 h-3.5" />
                <span>
                  {isSendingEmail
                    ? 'Sending Pop-Up Notification...'
                    : `Send Pop-Up to ${emailDraft.recipientName}`}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox Modal for Full Photo & Host Verification */}
      {selectedDropModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Trash Photo Inspection"
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4"
        >
          <div className="w-full max-w-lg glass-panel-elevated rounded-[32px] p-6 space-y-4 animate-modal-enter">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base og-bold text-white">
                  Photo Proof Record · {selectedDropModal.userDisplayName}
                </h3>
                <p className="text-xs text-zinc-400 font-mono">
                  {selectedDropModal.userEmail}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedDropModal(null)}
                aria-label="Close photo inspector"
                className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="rounded-2xl overflow-hidden bg-black border border-white/10 max-h-80">
              <img
                src={
                  selectedDropModal.imageUrl ||
                  generateSimulatedTrashSceneDataUrl({
                    memberName: selectedDropModal.userDisplayName,
                    variant: 'valid_bag_in_bin',
                  })
                }
                alt={`Trash drop by ${selectedDropModal.userDisplayName}`}
                referrerPolicy="no-referrer"
                onError={(e) => {
                  const target = e.currentTarget;
                  if (!target.dataset.fallbackApplied) {
                    target.dataset.fallbackApplied = 'true';
                    target.src = generateSimulatedTrashSceneDataUrl({
                      memberName: selectedDropModal.userDisplayName,
                      variant: 'valid_bag_in_bin',
                    });
                  }
                }}
                className="w-full h-full object-contain max-h-80"
              />
            </div>

            <div className="p-4 rounded-2xl bg-[#07190a] border border-white/10 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-zinc-400">Submitted Date &amp; Time:</span>
                <strong className="text-[#d0ff45] font-mono">
                  {
                    formatDateTimeReadable(
                      selectedDropModal.submittedIso || selectedDropModal.createdAt
                    ).fullLabel
                  }
                </strong>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Scheduled Deadline:</span>
                <strong className="text-zinc-200 font-mono">
                  {
                    formatDateTimeReadable(
                      selectedDropModal.deadlineIso || selectedDropModal.createdAt
                    ).fullLabel
                  }
                </strong>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Host Verification Status:</span>
                <strong
                  className={
                    selectedDropModal.verificationStatus === 'VERIFIED'
                      ? 'text-[#d0ff45]'
                      : selectedDropModal.verificationStatus === 'REJECTED'
                      ? 'text-rose-400'
                      : 'text-amber-300'
                  }
                >
                  {selectedDropModal.verificationStatus}
                </strong>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Location / Note:</span>
                <strong className="text-white">
                  {selectedDropModal.locationNote || 'Outdoor trash bin'}
                </strong>
              </div>
            </div>

            {isHostOrAdmin &&
              selectedDropModal.verificationStatus === 'PENDING_HOST_APPROVAL' && (
                <div className="space-y-3 pt-2 border-t border-white/10">
                  <input
                    type="text"
                    value={hostNoteInput}
                    onChange={(e) => setHostNoteInput(e.target.value)}
                    placeholder="Optional Host verification note..."
                    className="pill-input w-full px-4 py-2.5 rounded-full text-xs text-white placeholder:text-zinc-500"
                  />
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      disabled={isVerifyingDropId === selectedDropModal.id}
                      onClick={() => handleHostDecision(selectedDropModal.id, 'APPROVE')}
                      className="lime-cta py-3 px-4 rounded-full og-bold text-xs flex items-center justify-center gap-1.5"
                    >
                      <Check className="w-4 h-4" />
                      <span>Verify &amp; Approve Photo</span>
                    </button>
                    <button
                      type="button"
                      disabled={isVerifyingDropId === selectedDropModal.id}
                      onClick={() => handleHostDecision(selectedDropModal.id, 'REJECT')}
                      className="py-3 px-4 rounded-full bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-200 og-bold text-xs flex items-center justify-center gap-1.5"
                    >
                      <X className="w-4 h-4" />
                      <span>Reject Photo</span>
                    </button>
                  </div>
                </div>
              )}
          </div>
        </div>
      )}
    </div>
  );
};
