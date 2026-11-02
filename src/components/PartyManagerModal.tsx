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
} from 'lucide-react';
import {
  formatRotationDaysLabel,
  ROTATION_DAY_OPTIONS,
  validateInviteCode,
  type HouseholdMember,
  type PartyState,
} from '../utils/trashDutyLogic';
import { MemberAvatar } from './MemberAvatar';

interface PartyManagerViewProps {
  party: PartyState;
  currentUserId: string;
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
}

export const PartyManagerView: React.FC<PartyManagerViewProps> = ({
  party,
  currentUserId,
  onCreateParty,
  onJoinExistingPartyByCode,
  onAddRoommateWithEmail,
  onUpdateRotationIntervalHours,
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

  const handleCopyInviteCode = () => {
    navigator.clipboard?.writeText(party.inviteCode).catch(() => {});
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
        'Enter a valid email address so they receive 5-hour warnings & missed trash emails.'
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
        `Added ${cleanName} (${cleanEmail}) to the party rotation! Email reminders enabled.`
      );
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Could not add roommate.');
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
      setJoinError('Enter a valid invite code (4–16 uppercase characters).');
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

  const sixCharSlots = party.inviteCode
    .replace(/[^A-Z0-9]/g, '')
    .padEnd(6, '0')
    .slice(0, 6)
    .split('');

  return (
    <div className="animate-view-enter space-y-6">
      {/* Active Household 1-to-7 Day Rotation Schedule Bar */}
      <div className="glass-panel rounded-[28px] p-5 sm:p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 text-xs og-medium text-[#d0ff45]">
            <Calendar className="w-4 h-4" />
            <span>Active Household Rotation Cycle (1 to 7 Days)</span>
          </div>
          <h3 className="text-lg og-bold text-white">
            Current Schedule: {formatRotationDaysLabel(party.rotationIntervalHours)}
          </h3>
          <p className="text-xs og-light text-zinc-400">
            Select how many days each roommate has for their trash turn before rotating (1 Day up to 7 Days).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {ROTATION_DAY_OPTIONS.map((opt) => {
            const isActive = party.rotationIntervalHours === opt.hours;
            return (
              <button
                key={opt.days}
                type="button"
                data-testid={`party-rotation-day-${opt.days}`}
                onClick={() => handleChangePartyRotationDays(opt.hours)}
                className={`px-3.5 py-2 rounded-2xl text-xs og-bold transition-all border ${
                  isActive
                    ? 'bg-[#d0ff45] text-[#041206] border-[#d0ff45] scale-105 shadow-md'
                    : 'bg-[#081a0a] text-zinc-300 border-white/10 hover:border-[#d0ff45]/40 hover:text-white'
                }`}
              >
                {opt.days} {opt.days === 1 ? 'Day' : 'Days'}
              </button>
            );
          })}
        </div>
      </div>

      {rotationBanner && (
        <div className="p-3.5 rounded-2xl bg-[#d0ff45]/15 border border-[#d0ff45]/40 text-[#d0ff45] text-xs og-medium text-center">
          {rotationBanner}
        </div>
      )}

      {/* Top 2-Column Split: 6-Slot Invite Code Showcase + Add Roommate by Email */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left 6 Cols: 6-Box Invite Code Showcase */}
        <div className="lg:col-span-6 glass-panel-elevated rounded-[32px] p-6 sm:p-8 flex flex-col justify-between space-y-6 text-center">
          <div className="flex items-center justify-between text-xs og-book text-zinc-400">
            <span>
              {party.members.length} Registered Members ·{' '}
              {formatRotationDaysLabel(party.rotationIntervalHours)}
            </span>
            <span className="font-mono text-[#d0ff45]">Host: {party.hostEmail}</span>
          </div>

          <div className="space-y-2">
            <p className="text-xs og-light text-zinc-400">
              Share this 6-Character Household Invite Code with your roommates
            </p>
            <h2 className="text-2xl sm:text-3xl og-bold text-white tracking-tight">
              {party.name}
            </h2>
            <p
              data-testid="active-invite-code"
              className="text-sm font-mono og-bold text-[#d0ff45]"
            >
              {party.inviteCode}
            </p>
          </div>

          {/* 6-Digit/Char Rounded Code Boxes */}
          <div className="flex items-center justify-center gap-2 sm:gap-3 py-2">
            {sixCharSlots.map((char, index) => (
              <div
                key={`${char}-${index}`}
                className="animate-tile-pop w-11 h-13 sm:w-12 sm:h-14 rounded-2xl bg-[#091c0b] border border-white/10 flex items-center justify-center text-lg sm:text-xl og-bold font-mono text-white shadow-inner"
              >
                {char}
              </div>
            ))}
          </div>

          <p className="text-xs og-light text-zinc-400">
            Roommates can log into their own account and enter{' '}
            <span className="text-[#d0ff45] font-mono og-bold">{party.inviteCode}</span> to
            join this household party.
          </p>

          <button
            type="button"
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
                <span>Copy Invite Code ({party.inviteCode})</span>
              </>
            )}
          </button>
        </div>

        {/* Right 6 Cols: Enroll Roommate with Account Email */}
        <form
          onSubmit={handleAddRoommateSubmit}
          className="lg:col-span-6 glass-panel rounded-[32px] p-6 sm:p-8 flex flex-col justify-between space-y-6"
        >
          <div className="space-y-2 text-center sm:text-left">
            <div className="inline-flex items-center gap-2 text-xs og-medium text-[#d0ff45]">
              <UserPlus className="w-4 h-4" />
              <span>Enroll Roommate Account &amp; Email</span>
            </div>
            <h3 className="text-2xl og-bold text-white tracking-tight">
              Add Roommate to Rotation
            </h3>
            <p className="text-xs sm:text-sm og-light text-zinc-400 leading-relaxed">
              Register a roommate with their real email address so BinDrop automatically mails them a 5-hour advance warning and missed-deadline reminder on their turn.
            </p>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="join-member-name"
                className="block text-xs og-medium text-white pl-1"
              >
                Roommate Display Name
              </label>
              <input
                id="join-member-name"
                type="text"
                value={roommateName}
                onChange={(e) => setRoommateName(e.target.value)}
                placeholder="e.g. Jordan Lee"
                className="pill-input w-full px-5 py-3.5 rounded-full text-sm og-regular text-white placeholder:text-zinc-500"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="join-member-email"
                className="block text-xs og-medium text-white pl-1"
              >
                Roommate Account Email (For 5h Warning &amp; Missed Turn Emails)
              </label>
              <div className="relative flex items-center">
                <Mail className="w-4 h-4 text-zinc-400 absolute left-4 pointer-events-none" />
                <input
                  id="join-member-email"
                  type="email"
                  value={roommateEmail}
                  onChange={(e) => setRoommateEmail(e.target.value)}
                  placeholder="e.g. jordan@gmail.com"
                  className="pill-input w-full pl-11 pr-5 py-3.5 rounded-full text-sm og-regular text-white placeholder:text-zinc-500"
                />
              </div>
            </div>
          </div>

          {addError && <p className="text-xs text-rose-400 og-medium">{addError}</p>}
          {addSuccess && <p className="text-xs text-[#d0ff45] og-medium">{addSuccess}</p>}

          <button
            type="submit"
            disabled={isAdding}
            data-testid="add-roommate-submit"
            className="lime-cta w-full py-3.5 px-6 rounded-full og-bold text-sm flex items-center justify-center gap-2 min-h-[48px]"
          >
            <span>{isAdding ? 'Adding Roommate...' : 'Add Roommate to Party'}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>
      </div>

      {/* Bottom 2-Column Split: Registered Household Roster + Switch/Create Household */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Registered Household Roster */}
        <div className="lg:col-span-7 glass-panel rounded-[32px] p-6 sm:p-8 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg og-bold text-white">Registered Household Roster</h3>
              <p className="text-xs og-light text-zinc-400">
                Real member accounts &amp; email addresses enrolled in this party
              </p>
            </div>
            <Users className="w-5 h-5 text-[#d0ff45]" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {party.members.map((member: HouseholdMember, idx: number) => {
              const isMe = member.uid === currentUserId;
              const isCurrentTurn = member.uid === party.currentTurnUserId;
              return (
                <div
                  key={member.uid}
                  className={`p-3.5 rounded-2xl border flex items-center justify-between gap-3 ${
                    isCurrentTurn
                      ? 'bg-[#d0ff45]/12 border-[#d0ff45]/50 text-white'
                      : 'bg-[#08190a] border-white/[0.07] text-zinc-300'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <MemberAvatar member={member} size="md" highlightRing={isCurrentTurn} />
                    <div className="min-w-0">
                      <p className="text-sm og-bold text-white truncate">
                        {member.displayName} {isMe && '(You)'}
                      </p>
                      <p className="text-[11px] text-zinc-400 font-mono truncate">
                        {member.email}
                      </p>
                      <p className="text-[11px] text-zinc-400 font-mono tabular-nums mt-0.5">
                        #{idx + 1} · {member.role} · {member.points} pts · {member.onTimeDrops}{' '}
                        on-time
                      </p>
                    </div>
                  </div>
                  {isCurrentTurn && (
                    <span className="text-[11px] og-bold text-[#d0ff45] shrink-0">
                      Up Now
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Join Another Party by Invite Code OR Create New Household */}
        <div className="lg:col-span-5 glass-panel rounded-[32px] p-6 sm:p-8 flex flex-col justify-between space-y-6">
          <form onSubmit={handleJoinByCodeSubmit} className="space-y-3">
            <div className="inline-flex items-center gap-1.5 text-xs og-medium text-[#d0ff45]">
              <KeyRound className="w-4 h-4" />
              <span>Join Another Household by Code</span>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={joinCodeInput}
                onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                placeholder="Enter 6-char invite code"
                className="pill-input flex-1 px-4 py-3 rounded-full text-xs font-mono text-white placeholder:text-zinc-500"
              />
              <button
                type="submit"
                className="px-4 py-3 rounded-full bg-[#d0ff45] text-[#041206] og-bold text-xs shrink-0"
              >
                Join
              </button>
            </div>
            {joinError && <p className="text-xs text-rose-400">{joinError}</p>}
            {joinSuccess && <p className="text-xs text-[#d0ff45]">{joinSuccess}</p>}
          </form>

          <div className="h-px bg-white/10" />

          <form onSubmit={handleCreateSubmit} className="space-y-3.5">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1.5 text-xs og-medium text-[#d0ff45]">
                <Home className="w-4 h-4" />
                <span>Create a New Household Party</span>
              </div>
              <p className="text-xs og-light text-zinc-400">
                Start a fresh household party as Host and choose a 1 to 7 day rotation cycle.
              </p>
            </div>

            <input
              id="new-party-name"
              type="text"
              value={newPartyName}
              onChange={(e) => setNewPartyName(e.target.value)}
              placeholder="e.g., Skyview Loft 12A"
              className="pill-input w-full px-5 py-3 rounded-full text-xs og-regular text-white placeholder:text-zinc-500"
            />

            <select
              id="rotation-interval-select"
              value={rotationHours}
              onChange={(e) => setRotationHours(Number(e.target.value))}
              aria-label="Turn Deadline Schedule"
              className="pill-input w-full px-5 py-3 rounded-full text-xs og-regular text-white bg-[#091c0b]"
            >
              {ROTATION_DAY_OPTIONS.map((opt) => (
                <option key={opt.days} value={opt.hours}>
                  {opt.fullLabel}
                </option>
              ))}
            </select>

            {createError && <p className="text-xs text-rose-400 og-medium">{createError}</p>}
            {createSuccess && (
              <p className="text-xs text-[#d0ff45] og-medium">{createSuccess}</p>
            )}

            <button
              type="submit"
              className="w-full min-h-[44px] py-3 px-6 rounded-full bg-white/[0.08] hover:bg-white/[0.14] border border-white/10 text-white og-bold text-xs flex items-center justify-center gap-2 transition-colors"
            >
              <Plus className="w-4 h-4 text-[#d0ff45]" />
              <span>Create New Party</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
