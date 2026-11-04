import React, { useState } from 'react';
import {
  Users,
  Plus,
  UserPlus,
  Copy,
  Check,
  ArrowRight,
  Home,
  Mail,
  KeyRound,
  Calendar,
  LogOut,
  Trash2,
  AlertTriangle,
  SkipForward,
  BellRing,
} from 'lucide-react';
import { motion } from 'motion/react';
import {
  formatRotationDaysLabel,
  formatSixCharInviteCode,
  ROTATION_DAY_OPTIONS,
  validateInviteCode,
  type HouseholdInvitation,
  type HouseholdMember,
  type PartyState,
} from '../utils/trashDutyLogic';
import { MemberAvatar } from './MemberAvatar';

interface PartyManagerViewProps {
  party: PartyState;
  currentUserId: string;
  isHostOrAdmin?: boolean;
  partyInvitations?: HouseholdInvitation[];
  onCreateParty: (newParty: {
    name: string;
    rotationIntervalHours: number;
  }) => Promise<void>;
  onJoinExistingPartyByCode: (inviteCode: string) => Promise<void>;
  onAddRoommateWithEmail: (payload: {
    memberName: string;
    memberEmail: string;
  }) => Promise<void>;
  onUpdateRotationIntervalHours: (hours: number) => Promise<void>;
  onHostSkipTurn?: () => Promise<void>;
  onNudgeActiveAssignee?: () => void;
  onLeaveParty?: () => Promise<void>;
  onDeleteParty?: () => Promise<void>;
}

export const PartyManagerView: React.FC<PartyManagerViewProps> = ({
  party,
  currentUserId,
  isHostOrAdmin = false,
  partyInvitations = [],
  onCreateParty,
  onJoinExistingPartyByCode,
  onAddRoommateWithEmail,
  onUpdateRotationIntervalHours,
  onHostSkipTurn,
  onNudgeActiveAssignee,
  onLeaveParty,
  onDeleteParty,
}) => {
  const [copiedCode, setCopiedCode] = useState(false);

  // Add Roommate (Name + Real Email)
  const [roommateName, setRoommateName] = useState('');
  const [roommateEmail, setRoommateEmail] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  // Join Another Household by Invite Code
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinSuccess, setJoinSuccess] = useState<string | null>(null);

  // Create New Household Party (1 to 7 Days)
  const [newPartyName, setNewPartyName] = useState('');
  const [rotationHours, setRotationHours] = useState(24);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [rotationBanner, setRotationBanner] = useState<string | null>(null);

  // Leave / Delete Party Confirmation States
  const [confirmAction, setConfirmAction] = useState<'leave' | 'delete' | null>(null);
  const [isActionPending, setIsActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const formattedInviteCode = formatSixCharInviteCode(party.inviteCode);

  const handleCopyInviteCode = () => {
    navigator.clipboard?.writeText(formattedInviteCode).catch(() => {});
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleChangePartyRotationDays = async (hours: number) => {
    await onUpdateRotationIntervalHours(hours);
    const days = Math.round(hours / 24);
    setRotationBanner(
      `Updated ${party.name} rotation schedule to every ${days} ${days === 1 ? 'Day' : 'Days'} (${hours}h)!`
    );
    setTimeout(() => setRotationBanner(null), 4000);
  };

  const handleAddRoommateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);
    setAddSuccess(null);

    const cleanName = roommateName.trim();
    const cleanEmail = roommateEmail.trim().toLowerCase();

    if (cleanName.length < 2) {
      setAddError('Enter roommate display name (at least 2 characters).');
      return;
    }
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setAddError(
        'Enter a valid email address so their account automatically syncs with this party.'
      );
      return;
    }

    setIsAdding(true);
    try {
      await onAddRoommateWithEmail({
        memberName: cleanName,
        memberEmail: cleanEmail,
      });
      setRoommateName('');
      setRoommateEmail('');
      setAddSuccess(
        `Sent Household Invitation to ${cleanName} (${cleanEmail})! It now appears in their Invitations tab.`
      );
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Could not send roommate invitation.');
    } finally {
      setIsAdding(false);
    }
  };

  const handleJoinByCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setJoinError(null);
    setJoinSuccess(null);

    const normalizedCode = joinCodeInput.trim().toUpperCase();
    if (!validateInviteCode(normalizedCode)) {
      setJoinError('Enter a valid 6-character invite code (e.g. BIN-7X4).');
      return;
    }

    try {
      await onJoinExistingPartyByCode(normalizedCode);
      setJoinCodeInput('');
      setJoinSuccess(`Joined household with invite code ${normalizedCode}!`);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Failed to join party.');
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    setCreateSuccess(null);

    const trimmed = newPartyName.trim();
    if (trimmed.length < 2) {
      setCreateError('Please enter a household name with at least 2 characters.');
      return;
    }

    try {
      await onCreateParty({
        name: trimmed,
        rotationIntervalHours: rotationHours,
      });
      setNewPartyName('');
      setCreateSuccess(`Created "${trimmed}" as Party Host!`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create party.');
    }
  };

  const handleExecuteLeaveParty = async () => {
    if (!onLeaveParty) return;
    setActionError(null);
    setIsActionPending(true);
    try {
      await onLeaveParty();
      setConfirmAction(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not leave household party.');
    } finally {
      setIsActionPending(false);
    }
  };

  const handleExecuteDeleteParty = async () => {
    if (!onDeleteParty) return;
    setActionError(null);
    setIsActionPending(true);
    try {
      await onDeleteParty();
      setConfirmAction(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not delete household party.');
    } finally {
      setIsActionPending(false);
    }
  };

  const sixCharSlots = formattedInviteCode
    .replace(/[^A-Z0-9]/g, '')
    .padEnd(6, '0')
    .slice(0, 6)
    .split('');

  const nextRoommateForHostTransfer = party.members.find((m) => m.uid !== currentUserId);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
      className="space-y-5"
    >
      {/* 1. Turn Rotation Queue & 1-7 Day Cycle Card */}
      <div className="bento-stat-card rounded-[28px] p-5 sm:p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg sm:text-xl og-bold text-white">Turn Rotation Queue</h2>
            <p className="text-xs text-zinc-400">
              {party.name} · {party.members.length} Roommates
            </p>
          </div>

          <div className="flex items-center gap-2">
            {onNudgeActiveAssignee && (
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                onClick={onNudgeActiveAssignee}
                data-testid="hud-mail-warning-btn"
                className="px-3.5 py-2 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs og-medium text-zinc-200 flex items-center gap-1.5"
              >
                <BellRing className="w-3.5 h-3.5 text-[#c8ff2e]" />
                <span>Nudge Duty</span>
              </motion.button>
            )}
            {isHostOrAdmin && onHostSkipTurn && (
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                onClick={onHostSkipTurn}
                className="px-3.5 py-2 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs og-medium text-zinc-200 flex items-center gap-1.5"
              >
                <SkipForward className="w-3.5 h-3.5 text-[#c8ff2e]" />
                <span>Rotate Turn</span>
              </motion.button>
            )}
          </div>
        </div>

        <div className="space-y-2.5">
          {party.members.map((member: HouseholdMember, index: number) => {
            const offset =
              (index - party.currentTurnIndex + party.members.length) %
              party.members.length;
            const isUpNow = offset === 0;
            const isUpNext = offset === 1;
            const isMe = member.uid === currentUserId;

            return (
              <div
                key={member.uid}
                className={`p-3.5 rounded-2xl border flex items-center justify-between gap-3 transition-colors ${
                  isUpNow
                    ? 'bg-[#c8ff2e]/12 border-[#c8ff2e]/40'
                    : 'bg-[#0a180c] border-white/[0.06]'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <MemberAvatar member={member} size="md" highlightRing={isUpNow} />
                  <div className="min-w-0">
                    <p className="text-sm og-bold text-white truncate">
                      {member.displayName} {isMe && '(You)'}{' '}
                      {member.role === 'HOST' && (
                        <span className="text-xs og-book text-[#c8ff2e]">· Host</span>
                      )}
                    </p>
                    <p className="text-[11px] text-zinc-400 font-mono truncate">
                      {member.email}
                    </p>
                    <p className="text-[11px] text-zinc-500 font-mono tabular-nums">
                      {member.points} pts · {member.onTimeDrops} on-time · {member.missedDrops} missed
                    </p>
                  </div>
                </div>

                <div className="text-right shrink-0">
                  {isUpNow ? (
                    <span className="px-3 py-1 rounded-full bg-[#c8ff2e] text-[#051807] text-xs og-bold">
                      Up Now
                    </span>
                  ) : isUpNext ? (
                    <span className="text-xs og-medium text-zinc-300">Up Next</span>
                  ) : (
                    <span className="text-xs font-mono text-zinc-500 tabular-nums">
                      In {offset} turns
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* 1-to-7 Day Cycle Selector */}
        <div className="pt-4 border-t border-white/[0.08] space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="inline-flex items-center gap-1.5 og-medium text-zinc-300">
              <Calendar className="w-3.5 h-3.5 text-[#c8ff2e]" />
              <span>Rotation Cycle (1 to 7 Days):</span>
            </span>
            <span
              data-testid="active-rotation-days-label"
              className="font-mono og-bold text-[#c8ff2e]"
            >
              {formatRotationDaysLabel(party.rotationIntervalHours)}
            </span>
          </div>

          <div className="grid grid-cols-7 gap-1.5">
            {ROTATION_DAY_OPTIONS.map((opt) => {
              const isSelected = party.rotationIntervalHours === opt.hours;
              return (
                <motion.button
                  key={opt.days}
                  type="button"
                  whileTap={{ scale: 0.93 }}
                  data-testid={`party-rotation-day-${opt.days}`}
                  onClick={() => handleChangePartyRotationDays(opt.hours)}
                  className={`py-2 rounded-xl text-xs og-bold transition-colors border ${
                    isSelected
                      ? 'bg-[#c8ff2e] text-[#051807] border-[#c8ff2e]'
                      : 'bg-[#09190b] text-zinc-300 border-white/10 hover:border-[#c8ff2e]/40'
                  }`}
                >
                  {opt.shortLabel}
                </motion.button>
              );
            })}
          </div>
        </div>
      </div>

      {rotationBanner && (
        <div className="p-3.5 rounded-2xl bg-[#c8ff2e]/15 border border-[#c8ff2e]/40 text-[#c8ff2e] text-xs og-medium text-center">
          {rotationBanner}
        </div>
      )}

      {/* 2. Top 2-Column Split: 6-Slot Invite Code Showcase + Invite Roommate by Email */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* Left 6 Cols: 6-Box Invite Code Showcase */}
        <div className="lg:col-span-6 bento-stat-card rounded-[28px] p-5 sm:p-6 flex flex-col justify-between space-y-5 text-center">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>6-Character Invite Code</span>
            <span className="font-mono text-[#c8ff2e]">Host: {party.hostEmail}</span>
          </div>

          <div className="space-y-1">
            <h3 className="text-xl sm:text-2xl og-bold text-white tracking-tight">
              {party.name}
            </h3>
            <p
              data-testid="active-invite-code"
              className="text-xs font-mono og-bold text-[#c8ff2e]"
            >
              {formattedInviteCode}
            </p>
          </div>

          {/* 6-Digit/Char Rounded Code Boxes (3 chars + hyphen + 3 chars) */}
          <div className="flex items-center justify-center gap-1.5 sm:gap-2 py-1">
            {sixCharSlots.map((char, index) => (
              <React.Fragment key={`${char}-${index}`}>
                {index === 3 && (
                  <span className="text-zinc-500 font-mono og-bold text-base select-none">
                    -
                  </span>
                )}
                <div className="w-10 h-12 sm:w-11 sm:h-13 rounded-2xl bg-[#09190b] border border-[#c8ff2e]/35 flex items-center justify-center text-base sm:text-lg og-bold font-mono text-[#c8ff2e]">
                  {char}
                </div>
              </React.Fragment>
            ))}
          </div>

          <p className="text-xs text-zinc-400">
            Roommates can enter{' '}
            <span className="text-[#c8ff2e] font-mono og-bold">{formattedInviteCode}</span>{' '}
            on their phone or PC to join this household immediately.
          </p>

          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={handleCopyInviteCode}
            className="lime-cta w-full py-3.5 px-6 rounded-full og-bold text-sm flex items-center justify-center gap-2 min-h-[48px]"
          >
            {copiedCode ? (
              <>
                <Check className="w-4 h-4" />
                <span>Invite Code Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                <span>Copy Code ({formattedInviteCode})</span>
              </>
            )}
          </motion.button>
        </div>

        {/* Right 6 Cols: Invite Roommate with Account Email */}
        <form
          onSubmit={handleAddRoommateSubmit}
          className="lg:col-span-6 bento-stat-card rounded-[28px] p-5 sm:p-6 flex flex-col justify-between space-y-4"
        >
          <div className="space-y-1">
            <div className="inline-flex items-center gap-1.5 text-xs og-medium text-[#c8ff2e]">
              <UserPlus className="w-4 h-4" />
              <span>Direct Email Invite</span>
            </div>
            <h3 className="text-xl og-bold text-white tracking-tight">
              Invite Roommate by Email
            </h3>
            <p className="text-xs text-zinc-400">
              Sends a one-tap invite card directly to their Invitations tab.
            </p>
          </div>

          <div className="space-y-3">
            <input
              id="join-member-name"
              type="text"
              value={roommateName}
              onChange={(e) => setRoommateName(e.target.value)}
              placeholder="Roommate display name (e.g. Jordan)"
              className="pill-input w-full px-4 py-3 rounded-full text-xs sm:text-sm text-white placeholder:text-zinc-500"
            />

            <div className="relative flex items-center">
              <Mail className="w-4 h-4 text-zinc-400 absolute left-4 pointer-events-none" />
              <input
                id="join-member-email"
                type="email"
                value={roommateEmail}
                onChange={(e) => setRoommateEmail(e.target.value)}
                placeholder="Roommate email (e.g. jordan@gmail.com)"
                className="pill-input w-full pl-11 pr-4 py-3 rounded-full text-xs sm:text-sm text-white placeholder:text-zinc-500"
              />
            </div>
          </div>

          {addError && <p className="text-xs text-rose-400 og-medium">{addError}</p>}
          {addSuccess && <p className="text-xs text-[#c8ff2e] og-medium">{addSuccess}</p>}

          {partyInvitations.length > 0 && (
            <div className="p-3 rounded-2xl bg-[#071809] border border-white/10 space-y-1.5">
              <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-400">
                Sent Invitations ({partyInvitations.length})
              </p>
              <div className="space-y-1 max-h-24 overflow-y-auto pr-1">
                {partyInvitations.map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between gap-2 text-xs py-1 px-2 rounded-xl bg-white/[0.03]"
                  >
                    <div className="min-w-0 truncate">
                      <span className="og-medium text-white">{inv.invitedName}</span>{' '}
                      <span className="text-zinc-400 font-mono text-[11px]">({inv.invitedEmail})</span>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded-md text-[10px] font-mono og-bold shrink-0 ${
                        inv.status === 'ACCEPTED'
                          ? 'bg-[#c8ff2e]/20 text-[#c8ff2e]'
                          : inv.status === 'DECLINED'
                          ? 'bg-rose-500/20 text-rose-300'
                          : 'bg-amber-400/20 text-amber-300'
                      }`}
                    >
                      {inv.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <motion.button
            type="submit"
            whileTap={{ scale: 0.96 }}
            disabled={isAdding}
            data-testid="add-roommate-submit"
            className="lime-cta w-full py-3.5 px-6 rounded-full og-bold text-sm flex items-center justify-center gap-2 min-h-[48px]"
          >
            <span>{isAdding ? 'Sending Invitation...' : 'Send Household Invitation'}</span>
            <ArrowRight className="w-4 h-4" />
          </motion.button>
        </form>
      </div>

      {/* 3. Switch / Create / Leave / Delete Household Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-6 bento-stat-card rounded-[28px] p-5 sm:p-6 space-y-4">
          <form onSubmit={handleJoinByCodeSubmit} className="space-y-2.5">
            <div className="inline-flex items-center gap-1.5 text-xs og-medium text-[#c8ff2e]">
              <KeyRound className="w-4 h-4" />
              <span>Join Another Household by 6-Char Code</span>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                maxLength={8}
                value={joinCodeInput}
                onChange={(e) => {
                  const cleaned = e.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, '')
                    .slice(0, 6);
                  const formatted =
                    cleaned.length > 3
                      ? `${cleaned.slice(0, 3)}-${cleaned.slice(3, 6)}`
                      : cleaned;
                  setJoinCodeInput(formatted);
                }}
                placeholder="e.g. BIN-7X4"
                data-testid="party-switch-join-code-input"
                className="pill-input flex-1 px-4 py-2.5 rounded-full text-xs font-mono text-white placeholder:text-zinc-500"
              />
              <motion.button
                type="submit"
                whileTap={{ scale: 0.95 }}
                data-testid="party-switch-join-btn"
                className="px-5 py-2.5 rounded-full bg-[#c8ff2e] text-[#051807] og-bold text-xs shrink-0"
              >
                Join
              </motion.button>
            </div>
            {joinError && <p className="text-xs text-rose-400">{joinError}</p>}
            {joinSuccess && <p className="text-xs text-[#c8ff2e]">{joinSuccess}</p>}
          </form>

          <div className="h-px bg-white/10" />

          <form onSubmit={handleCreateSubmit} className="space-y-3">
            <div className="inline-flex items-center gap-1.5 text-xs og-medium text-[#c8ff2e]">
              <Home className="w-4 h-4" />
              <span>Create a New Household Party</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                id="new-party-name"
                type="text"
                value={newPartyName}
                onChange={(e) => setNewPartyName(e.target.value)}
                placeholder="New household name..."
                className="pill-input w-full px-4 py-2.5 rounded-full text-xs text-white placeholder:text-zinc-500"
              />
              <select
                id="rotation-interval-select"
                value={rotationHours}
                onChange={(e) => setRotationHours(Number(e.target.value))}
                aria-label="Turn Deadline Schedule"
                className="pill-input w-full px-4 py-2.5 rounded-full text-xs text-white bg-[#09190b]"
              >
                {ROTATION_DAY_OPTIONS.map((opt) => (
                  <option key={opt.days} value={opt.hours}>
                    {opt.fullLabel}
                  </option>
                ))}
              </select>
            </div>
            {createError && <p className="text-xs text-rose-400 og-medium">{createError}</p>}
            {createSuccess && (
              <p className="text-xs text-[#c8ff2e] og-medium">{createSuccess}</p>
            )}
            <motion.button
              type="submit"
              whileTap={{ scale: 0.96 }}
              className="w-full py-2.5 px-5 rounded-full bg-white/[0.08] hover:bg-white/[0.14] border border-white/10 text-white og-bold text-xs flex items-center justify-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5 text-[#c8ff2e]" />
              <span>Create New Party</span>
            </motion.button>
          </form>
        </div>

        {/* Leave or Delete Party Card */}
        <div className="lg:col-span-6 bento-stat-card rounded-[28px] p-5 sm:p-6 flex flex-col justify-between space-y-4">
          <div className="space-y-1.5">
            <div className="inline-flex items-center gap-1.5 text-xs og-medium text-amber-300">
              <AlertTriangle className="w-4 h-4" />
              <span>Party Membership</span>
            </div>
            <h3 className="text-lg og-bold text-white">
              Leave or Delete &ldquo;{party.name}&rdquo;
            </h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              {isHostOrAdmin
                ? nextRoommateForHostTransfer
                  ? `Leaving transfers Host role to ${nextRoommateForHostTransfer.displayName}, or you can delete this party for everyone.`
                  : 'You are the only member. Leaving or deleting closes this party.'
                : 'Leaving removes your account from this household rotation.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {onLeaveParty && (
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                data-testid="leave-party-trigger-btn"
                onClick={() => {
                  setActionError(null);
                  setConfirmAction('leave');
                }}
                className="px-4 py-2.5 rounded-full bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/40 text-amber-200 og-bold text-xs flex items-center gap-1.5"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>
                  {isHostOrAdmin && nextRoommateForHostTransfer
                    ? 'Leave & Transfer Host'
                    : 'Leave Party'}
                </span>
              </motion.button>
            )}

            {isHostOrAdmin && onDeleteParty && (
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                data-testid="delete-party-trigger-btn"
                onClick={() => {
                  setActionError(null);
                  setConfirmAction('delete');
                }}
                className="px-4 py-2.5 rounded-full bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/50 text-rose-200 og-bold text-xs flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete Party</span>
              </motion.button>
            )}
          </div>

          {actionError && <p className="text-xs text-rose-400 og-medium">{actionError}</p>}

          {confirmAction === 'leave' && (
            <div
              data-testid="confirm-leave-party-panel"
              className="p-3.5 rounded-2xl bg-amber-950/40 border border-amber-400/45 flex items-center justify-between gap-3 animate-view-enter"
            >
              <span className="text-xs og-bold text-white">
                Confirm leaving &ldquo;{party.name}&rdquo;?
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setConfirmAction(null)}
                  className="px-3 py-1.5 rounded-full bg-white/10 text-xs text-white"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isActionPending}
                  data-testid="confirm-leave-party-btn"
                  onClick={handleExecuteLeaveParty}
                  className="px-3.5 py-1.5 rounded-full bg-amber-400 text-[#041206] text-xs og-bold"
                >
                  {isActionPending ? 'Leaving...' : 'Yes, Leave'}
                </button>
              </div>
            </div>
          )}

          {confirmAction === 'delete' && (
            <div
              data-testid="confirm-delete-party-panel"
              className="p-3.5 rounded-2xl bg-rose-950/50 border border-rose-500/50 flex items-center justify-between gap-3 animate-view-enter"
            >
              <span className="text-xs og-bold text-white">
                Delete &ldquo;{party.name}&rdquo; for all?
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setConfirmAction(null)}
                  className="px-3 py-1.5 rounded-full bg-white/10 text-xs text-white"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isActionPending}
                  data-testid="confirm-delete-party-btn"
                  onClick={handleExecuteDeleteParty}
                  className="px-3.5 py-1.5 rounded-full bg-rose-500 text-slate-950 text-xs og-bold"
                >
                  {isActionPending ? 'Deleting...' : 'Yes, Delete'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
};
