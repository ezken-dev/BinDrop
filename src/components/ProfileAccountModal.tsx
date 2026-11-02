import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  User as UserIcon,
  Mail,
  ArrowRight,
  Check,
  LogOut,
  ChevronLeft,
  CheckCircle2,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import {
  OFFICIAL_BINDROP_EMAIL,
  type HouseholdMember,
} from '../utils/trashDutyLogic';
import { compressUploadedImage } from '../utils/sceneImageGenerator';
import { MemberAvatar, PRESET_AVATARS } from './MemberAvatar';

interface ProfileAccountViewProps {
  activeViewer: HouseholdMember;
  firebaseUser: User | null;
  onUpdateProfile: (
    uid: string,
    updates: { displayName: string; email?: string; photoURL?: string }
  ) => Promise<void>;
  onGoogleSignIn: () => Promise<unknown>;
  onSignOut: () => Promise<void>;
  onBackToHud: () => void;
}

export const ProfileAccountView: React.FC<ProfileAccountViewProps> = ({
  activeViewer,
  onUpdateProfile,
  onSignOut,
  onBackToHud,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [displayNameInput, setDisplayNameInput] = useState(activeViewer.displayName);
  const [emailInput, setEmailInput] = useState(activeViewer.email || '');
  const [photoPreview, setPhotoPreview] = useState<string | undefined>(activeViewer.photoURL);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);

  useEffect(() => {
    setDisplayNameInput(activeViewer.displayName);
    setEmailInput(activeViewer.email || '');
    setPhotoPreview(activeViewer.photoURL);
    setStatusMessage(null);
    setErrorMessage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeViewer.uid]);

  const handlePhotoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMessage(null);
    setStatusMessage(null);
    setIsUploadingPhoto(true);
    try {
      const compressed = await compressUploadedImage(file);
      setPhotoPreview(compressed.dataUrl);
      setStatusMessage('Photo ready — tap Save Profile to apply across your party.');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to process profile picture.');
    } finally {
      setIsUploadingPhoto(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);

    const trimmedName = displayNameInput.trim();
    const trimmedEmail = emailInput.trim().toLowerCase();

    if (trimmedName.length < 2) {
      setErrorMessage('Please enter a name with at least 2 characters.');
      return;
    }
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setErrorMessage('Please enter a valid email address for 5-hour warnings & turn alerts.');
      return;
    }

    try {
      await onUpdateProfile(activeViewer.uid, {
        displayName: trimmedName,
        email: trimmedEmail,
        photoURL: photoPreview,
      });
      setStatusMessage(
        `Profile updated! Your name, photo, and notification email (${trimmedEmail}) are saved.`
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to update profile.');
    }
  };

  return (
    <div className="animate-view-enter max-w-xl mx-auto space-y-6">
      <div className="glass-panel-elevated rounded-[32px] p-6 sm:p-8 space-y-6">
        {/* Top Row: Circular Back Button + Centered Title + Role Pill */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onBackToHud}
            aria-label="Back to Duty HUD"
            className="w-11 h-11 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 flex items-center justify-center text-white transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <span className="text-sm og-medium text-white tracking-tight">
            Account &amp; Profile
          </span>
          <div className="px-3.5 py-1.5 rounded-full bg-[#132916] border border-[#d0ff45]/35 text-xs og-bold text-[#d0ff45]">
            {activeViewer.role}
          </div>
        </div>

        {/* Center Hero Heading */}
        <div className="text-center space-y-2 pt-1">
          <h1 className="text-2xl sm:text-3xl og-bold text-white tracking-tight">
            {activeViewer.displayName}
          </h1>
          <p className="text-xs sm:text-sm og-light text-zinc-400 max-w-sm mx-auto leading-relaxed">
            Update your profile picture, display name, or notification email address used for 5-hour warnings and missed trash reminders.
          </p>
        </div>

        {/* Interactive Avatar Upload Centerpiece */}
        <div className="flex flex-col items-center space-y-4">
          <div className="relative group">
            <MemberAvatar
              member={{
                displayName: displayNameInput || activeViewer.displayName,
                photoURL: photoPreview,
                avatarColor: activeViewer.avatarColor,
              }}
              size="xl"
              highlightRing
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Upload custom profile picture"
              className="absolute -bottom-1 -right-1 w-9 h-9 rounded-full bg-[#d0ff45] text-[#041206] flex items-center justify-center shadow-lg hover:scale-105 transition-transform"
            >
              <Camera className="w-4 h-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handlePhotoFileChange}
              className="hidden"
              aria-label="Profile picture file input"
            />
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 rounded-full bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 text-xs og-medium text-white flex items-center gap-1.5 transition-colors"
            >
              <Camera className="w-3.5 h-3.5 text-[#d0ff45]" />
              {isUploadingPhoto ? 'Processing Photo...' : 'Upload Photo from Phone'}
            </button>
          </div>

          {/* Quick-Pick Illustrated Avatars */}
          <div className="pt-1 text-center space-y-2">
            <span className="text-[11px] og-light text-zinc-400 block">
              Or choose a quick neon avatar
            </span>
            <div className="flex items-center justify-center gap-2.5">
              {PRESET_AVATARS.map((preset) => {
                const isSelected = photoPreview === preset.url;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setPhotoPreview(preset.url)}
                    aria-label={`Select ${preset.label} avatar`}
                    className={`w-10 h-10 rounded-full overflow-hidden transition-transform ${
                      isSelected
                        ? 'ring-2 ring-[#d0ff45] scale-110'
                        : 'opacity-75 hover:opacity-100 hover:scale-105'
                    }`}
                  >
                    <img
                      src={preset.url}
                      alt={preset.label}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Profile Edit Form */}
        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="profile-display-name"
              className="block text-xs og-medium text-white pl-1"
            >
              Display Name
            </label>
            <div className="relative flex items-center">
              <UserIcon className="w-4 h-4 text-zinc-400 absolute left-4 pointer-events-none" />
              <input
                id="profile-display-name"
                type="text"
                value={displayNameInput}
                onChange={(e) => setDisplayNameInput(e.target.value)}
                placeholder="Enter your display name"
                className="pill-input w-full pl-11 pr-4 py-3.5 rounded-full text-sm og-regular text-white placeholder:text-zinc-500"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="profile-email-address"
              className="block text-xs og-medium text-white pl-1"
            >
              Notification Email (For 5-Hour Warnings &amp; Missed Trash Alerts)
            </label>
            <div className="relative flex items-center">
              <Mail className="w-4 h-4 text-zinc-400 absolute left-4 pointer-events-none" />
              <input
                id="profile-email-address"
                type="email"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="Enter your email address"
                className="pill-input w-full pl-11 pr-4 py-3.5 rounded-full text-sm og-regular text-white placeholder:text-zinc-500"
              />
            </div>
          </div>

          {errorMessage && (
            <p className="text-xs text-rose-400 og-medium text-center">{errorMessage}</p>
          )}
          {statusMessage && (
            <p
              data-testid="profile-save-confirmation"
              className="text-xs text-[#d0ff45] og-medium text-center flex items-center justify-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              {statusMessage}
            </p>
          )}

          <button
            type="submit"
            className="lime-cta w-full py-3.5 px-6 rounded-full og-bold text-sm flex items-center justify-center gap-2 min-h-[48px]"
          >
            <span>Save Profile</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        {/* Divider ("OFFICIAL EMAIL SYSTEM & SESSION") */}
        <div className="flex items-center gap-4">
          <div className="h-px flex-1 bg-white/[0.08]" />
          <span className="text-[11px] uppercase tracking-widest text-zinc-500 og-medium">
            OFFICIAL EMAIL &amp; SESSION
          </span>
          <div className="h-px flex-1 bg-white/[0.08]" />
        </div>

        {/* Integrated Official Email Sender & Sign Out */}
        <div className="space-y-3">
          <div className="p-4 rounded-2xl bg-[#0e2612] border border-[#d0ff45]/40 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <CheckCircle2 className="w-5 h-5 text-[#d0ff45] shrink-0" />
              <div className="min-w-0">
                <p className="text-xs text-[#d0ff45] og-bold">
                  Official BinDrop Mailer Integrated
                </p>
                <p className="text-xs text-zinc-300 font-mono truncate">
                  Sender: {OFFICIAL_BINDROP_EMAIL}
                </p>
              </div>
            </div>
            <span className="px-3 py-1 rounded-full bg-[#d0ff45] text-[#041206] text-[10px] og-bold shrink-0">
              ACTIVE
            </span>
          </div>

          <div className="p-4 rounded-2xl bg-[#07190a] border border-white/10 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-[#d0ff45] og-medium">Signed In Account</p>
              <p className="text-xs text-zinc-300 font-mono truncate">{activeViewer.email}</p>
            </div>
            <button
              type="button"
              onClick={onSignOut}
              data-testid="sign-out-button"
              className="px-4 py-2 rounded-full bg-white/[0.08] hover:bg-white/[0.14] text-xs og-medium text-white flex items-center gap-1.5 shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
