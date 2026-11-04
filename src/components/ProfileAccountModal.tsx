import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  User as UserIcon,
  Mail,
  ArrowRight,
  Check,
  LogOut,
  ChevronLeft,
} from 'lucide-react';
import { motion } from 'motion/react';
import type { User } from 'firebase/auth';
import { type HouseholdMember } from '../utils/trashDutyLogic';
import { compressAvatarImage } from '../utils/sceneImageGenerator';
import { MemberAvatar, PRESET_AVATARS } from './MemberAvatar';
import { PushAlertsCard } from './PushAlertsCard';
import { InstallPwaBanner } from './InstallPwaBanner';

interface ProfileAccountViewProps {
  activeViewer: HouseholdMember;
  partyId?: string;
  partyName?: string;
  firebaseUser: User | null;
  onUpdateProfile: (
    uid: string,
    updates: { displayName: string; email?: string; photoURL?: string }
  ) => Promise<void>;
  onGoogleSignIn: () => Promise<unknown>;
  onSignOut: () => Promise<void>;
  onBackToHud: () => void;
  onTriggerInAppBanner?: (banner: {
    title: string;
    message: string;
    senderName: string;
  }) => void;
}

export const ProfileAccountView: React.FC<ProfileAccountViewProps> = ({
  activeViewer,
  partyId = 'party_default',
  partyName = 'BinDrop',
  onUpdateProfile,
  onSignOut,
  onBackToHud,
  onTriggerInAppBanner,
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
  }, [activeViewer.uid, activeViewer.displayName, activeViewer.email, activeViewer.photoURL]);

  const handlePhotoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMessage(null);
    setStatusMessage(null);
    setIsUploadingPhoto(true);
    try {
      const compressed = await compressAvatarImage(file);
      setPhotoPreview(compressed.dataUrl);
      setStatusMessage('Photo ready — tap Save Profile to sync across all household devices.');
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
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
      className="max-w-xl mx-auto space-y-5"
    >
      {/* Dedicated App Install Banner for Android & iOS */}
      <InstallPwaBanner compact />

      {/* Lock-Screen Push Notification Settings Card */}
      <PushAlertsCard
        userEmail={activeViewer.email}
        userUid={activeViewer.uid}
        userDisplayName={activeViewer.displayName}
        partyId={partyId}
        partyName={partyName}
        compact
        onTriggerInAppBanner={onTriggerInAppBanner}
      />

      <div className="bento-stat-card rounded-[28px] p-6 sm:p-8 space-y-6">
        {/* Top Row: Circular Back Button + Centered Title + Role Pill */}
        <div className="flex items-center justify-between">
          <motion.button
            type="button"
            whileTap={{ scale: 0.92 }}
            onClick={onBackToHud}
            aria-label="Back to Duty HUD"
            className="w-10 h-10 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 flex items-center justify-center text-white transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </motion.button>
          <span className="text-sm og-medium text-white tracking-tight">
            Account &amp; Profile
          </span>
          <div className="px-3.5 py-1 rounded-full bg-[#182c1a] border border-[#c8ff2e]/35 text-xs og-bold text-[#c8ff2e]">
            {activeViewer.role}
          </div>
        </div>

        {/* Interactive Avatar Upload Centerpiece */}
        <div className="flex flex-col items-center space-y-3.5">
          <div className="relative">
            <MemberAvatar
              member={{
                displayName: displayNameInput || activeViewer.displayName,
                photoURL: photoPreview,
                avatarColor: activeViewer.avatarColor,
              }}
              size="xl"
              highlightRing
            />
            <motion.button
              type="button"
              whileTap={{ scale: 0.9 }}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Upload custom profile picture"
              className="absolute -bottom-1 -right-1 w-9 h-9 rounded-full bg-[#c8ff2e] text-[#051807] flex items-center justify-center shadow-lg"
            >
              <Camera className="w-4 h-4" />
            </motion.button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handlePhotoFileChange}
              className="hidden"
              aria-label="Profile picture file input"
            />
          </div>

          <div className="text-center">
            <h1 className="text-xl sm:text-2xl og-bold text-white tracking-tight">
              {activeViewer.displayName}
            </h1>
            <p className="text-xs text-zinc-400 font-mono">{activeViewer.email}</p>
          </div>

          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 rounded-full bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 text-xs og-medium text-white flex items-center gap-1.5"
          >
            <Camera className="w-3.5 h-3.5 text-[#c8ff2e]" />
            <span>{isUploadingPhoto ? 'Processing Photo...' : 'Change Avatar Photo'}</span>
          </motion.button>

          {/* Quick-Pick Illustrated Avatars */}
          <div className="flex items-center justify-center gap-2 pt-1">
            {PRESET_AVATARS.map((preset) => {
              const isSelected = photoPreview === preset.url;
              return (
                <motion.button
                  key={preset.id}
                  type="button"
                  whileTap={{ scale: 0.9 }}
                  onClick={() => setPhotoPreview(preset.url)}
                  aria-label={`Select ${preset.label} avatar`}
                  className={`w-9 h-9 rounded-full overflow-hidden transition-transform ${
                    isSelected
                      ? 'ring-2 ring-[#c8ff2e] scale-110'
                      : 'opacity-70 hover:opacity-100'
                  }`}
                >
                  <img
                    src={preset.url}
                    alt={preset.label}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </motion.button>
              );
            })}
          </div>
        </div>

        {/* Profile Edit Form */}
        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="profile-display-name"
              className="block text-xs og-medium text-zinc-300 pl-1"
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
                className="pill-input w-full pl-11 pr-4 py-3 rounded-full text-sm text-white placeholder:text-zinc-500"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="profile-email-address"
              className="block text-xs og-medium text-zinc-300 pl-1"
            >
              Notification Email
            </label>
            <div className="relative flex items-center">
              <Mail className="w-4 h-4 text-zinc-400 absolute left-4 pointer-events-none" />
              <input
                id="profile-email-address"
                type="email"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="Enter your email address"
                className="pill-input w-full pl-11 pr-4 py-3 rounded-full text-sm text-white placeholder:text-zinc-500"
              />
            </div>
          </div>

          {errorMessage && (
            <p className="text-xs text-rose-400 og-medium text-center">{errorMessage}</p>
          )}
          {statusMessage && (
            <p
              data-testid="profile-save-confirmation"
              className="text-xs text-[#c8ff2e] og-medium text-center flex items-center justify-center gap-1.5"
            >
              <Check className="w-4 h-4" />
              {statusMessage}
            </p>
          )}

          <motion.button
            type="submit"
            whileTap={{ scale: 0.96 }}
            className="lime-cta w-full py-3.5 px-6 rounded-full og-bold text-sm flex items-center justify-center gap-2 min-h-[48px]"
          >
            <span>Save Profile</span>
            <ArrowRight className="w-4 h-4" />
          </motion.button>
        </form>

        {/* Sign Out Row */}
        <div className="pt-4 border-t border-white/[0.08] flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-[#c8ff2e] og-medium">Signed In Account</p>
            <p className="text-xs text-zinc-400 font-mono truncate">{activeViewer.email}</p>
          </div>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            onClick={onSignOut}
            data-testid="sign-out-button"
            className="px-4 py-2.5 rounded-full bg-white/[0.08] hover:bg-white/[0.14] text-xs og-medium text-white flex items-center gap-1.5 shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
};
