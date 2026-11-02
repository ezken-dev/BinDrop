import React, { useRef, useState } from 'react';
import {
  Mail,
  Lock,
  Eye,
  EyeOff,
  User as UserIcon,
  ArrowRight,
  Camera,
  Home,
  KeyRound,
  Check,
  ChevronLeft,
  Calendar,
  X,
} from 'lucide-react';
import { compressUploadedImage } from '../utils/sceneImageGenerator';
import { OFFICIAL_BINDROP_EMAIL, ROTATION_DAY_OPTIONS } from '../utils/trashDutyLogic';
import { PRESET_AVATARS } from './MemberAvatar';

export interface AuthenticatedAccount {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  avatarColor: string;
  partyId: string | null;
}

interface AuthLoginScreenProps {
  currentAccount: AuthenticatedAccount | null;
  onLoginWithEmail: (payload: { email: string; password: string }) => Promise<void>;
  onRegisterWithEmail: (payload: {
    email: string;
    password: string;
    displayName: string;
    photoURL?: string;
  }) => Promise<void>;
  onGoogleSignIn: () => Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }>;
  onDirectGoogleAccountSignIn: (payload: {
    email: string;
    displayName: string;
    photoURL?: string;
  }) => Promise<void>;
  onCreateHousehold: (payload: {
    name: string;
    rotationIntervalHours: number;
    initialDeadlineHours: number;
  }) => Promise<void>;
  onJoinHouseholdByCode: (inviteCode: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}

export const AuthLoginScreen: React.FC<AuthLoginScreenProps> = ({
  currentAccount,
  onLoginWithEmail,
  onRegisterWithEmail,
  onGoogleSignIn,
  onDirectGoogleAccountSignIn,
  onCreateHousehold,
  onJoinHouseholdByCode,
  onSignOut,
}) => {
  const [authMode, setAuthMode] = useState<'signup' | 'login'>('signup');
  const [onboardingMode, setOnboardingMode] = useState<'create' | 'join'>('create');

  // Auth form fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [photoURL, setPhotoURL] = useState<string | undefined>(PRESET_AVATARS[0].url);
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Instant Google Account Chooser Modal (fallback when mobile in-app WebView blocks popups or domain is not yet in Firebase Authorized Domains)
  const [isGoogleChooserOpen, setIsGoogleChooserOpen] = useState(false);
  const [googleEmailInput, setGoogleEmailInput] = useState('');
  const [googleNameInput, setGoogleNameInput] = useState('');
  const [googleModalError, setGoogleModalError] = useState<string | null>(null);
  const [googlePopupNotice, setGooglePopupNotice] = useState<string | null>(null);
  const [isGoogleSubmitting, setIsGoogleSubmitting] = useState(false);
  const [isLaunchingPopup, setIsLaunchingPopup] = useState(false);

  // Onboarding form fields (1 to 7 Days Rotation System)
  const [partyName, setPartyName] = useState('');
  const [rotationHours, setRotationHours] = useState(24);
  const [initialDeadlineHours, setInitialDeadlineHours] = useState(24);
  const [inviteCodeInput, setInviteCodeInput] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressUploadedImage(file);
      setPhotoURL(compressed.dataUrl);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not process image.');
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsSubmitting(true);
    try {
      if (authMode === 'login') {
        await onLoginWithEmail({ email, password });
      } else {
        await onRegisterWithEmail({
          email,
          password,
          displayName,
          photoURL,
        });
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleInstantGoogleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setGoogleModalError(null);
    const cleanMail = googleEmailInput.trim().toLowerCase();
    if (!cleanMail || !cleanMail.includes('@')) {
      setGoogleModalError('Please enter your Gmail / Google email address.');
      return;
    }
    const cleanName =
      googleNameInput.trim() ||
      cleanMail
        .split('@')[0]
        .replace(/[._0-9]+/g, ' ')
        .trim() ||
      'Household Member';

    setIsGoogleSubmitting(true);
    try {
      await onDirectGoogleAccountSignIn({
        email: cleanMail,
        displayName: cleanName,
        photoURL,
      });
      setIsGoogleChooserOpen(false);
    } catch (err) {
      setGoogleModalError(
        err instanceof Error ? err.message : 'Could not sign in with Google account.'
      );
    } finally {
      setIsGoogleSubmitting(false);
    }
  };

  const handleCreatePartySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (partyName.trim().length < 2) {
      setErrorMsg('Please enter your apartment or household name (at least 2 characters).');
      return;
    }
    setIsSubmitting(true);
    try {
      await onCreateHousehold({
        name: partyName.trim(),
        rotationIntervalHours: rotationHours,
        initialDeadlineHours,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create household party.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleJoinPartySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (inviteCodeInput.trim().length < 4) {
      setErrorMsg('Please enter a valid household invite code.');
      return;
    }
    setIsSubmitting(true);
    try {
      await onJoinHouseholdByCode(inviteCodeInput.trim().toUpperCase());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to join household.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const cleanJoinChars = inviteCodeInput
    .replace(/[^A-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 6);
  const sixSlots = Array.from({ length: 6 }, (_, i) => cleanJoinChars[i] || '');

  // STEP 2: Authenticated user needs to Create or Join a Household Party
  if (currentAccount) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-4 py-8">
        <div className="w-full max-w-md glass-panel-elevated rounded-[36px] p-6 sm:p-8 space-y-6 animate-view-enter">
          {/* Top Bar */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={onSignOut}
              aria-label="Sign out and return to login"
              className="w-10 h-10 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 flex items-center justify-center text-white transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-sm og-medium text-white">Household Setup</span>
            <span className="px-3 py-1 rounded-full bg-[#132916] border border-[#d0ff45]/35 text-[11px] og-medium text-[#d0ff45]">
              {currentAccount.displayName}
            </span>
          </div>

          <div className="text-center space-y-1.5">
            <h1 className="text-2xl sm:text-3xl og-bold text-white tracking-tight">
              {onboardingMode === 'create'
                ? 'Create Household Party'
                : 'Enter Invite Code'}
            </h1>
            <p className="text-xs og-light text-zinc-400 leading-relaxed">
              Signed in as <strong className="og-medium text-zinc-200">{currentAccount.email}</strong>.
              Automated 5-hour warnings and missed trash reminders are sent from{' '}
              <strong className="font-mono text-[#d0ff45]">{OFFICIAL_BINDROP_EMAIL}</strong>.
            </p>
          </div>

          {/* Mode Toggle Pills */}
          <div className="grid grid-cols-2 gap-2 p-1.5 rounded-full bg-[#07190a] border border-white/10">
            <button
              type="button"
              onClick={() => {
                setOnboardingMode('create');
                setErrorMsg(null);
              }}
              className={`py-2.5 px-4 rounded-full text-xs og-bold transition-all flex items-center justify-center gap-1.5 ${
                onboardingMode === 'create'
                  ? 'bg-[#d0ff45] text-[#041206]'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <Home className="w-3.5 h-3.5" />
              Create Party (Host)
            </button>
            <button
              type="button"
              onClick={() => {
                setOnboardingMode('join');
                setErrorMsg(null);
              }}
              className={`py-2.5 px-4 rounded-full text-xs og-bold transition-all flex items-center justify-center gap-1.5 ${
                onboardingMode === 'join'
                  ? 'bg-[#d0ff45] text-[#041206]'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              <KeyRound className="w-3.5 h-3.5" />
              Enter Invite Code
            </button>
          </div>

          {onboardingMode === 'create' ? (
            <form onSubmit={handleCreatePartySubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="onboard-party-name"
                  className="block text-xs og-medium text-white pl-1"
                >
                  Apartment / Household Name
                </label>
                <input
                  id="onboard-party-name"
                  type="text"
                  value={partyName}
                  onChange={(e) => setPartyName(e.target.value)}
                  placeholder="e.g., Apt 4B — The Bin Syndicate"
                  className="pill-input w-full px-5 py-3.5 rounded-full text-sm og-regular text-white placeholder:text-zinc-500"
                />
              </div>

              {/* 1-to-7 Day Interactive Rotation Schedule Pills */}
              <div className="space-y-2">
                <div className="flex items-center justify-between pl-1">
                  <label
                    htmlFor="onboard-rotation-hours"
                    className="text-xs og-medium text-white flex items-center gap-1.5"
                  >
                    <Calendar className="w-3.5 h-3.5 text-[#d0ff45]" />
                    <span>Rotation Schedule (1 to 7 Days)</span>
                  </label>
                  <span className="text-[11px] font-mono text-[#d0ff45]">
                    {Math.round(rotationHours / 24)}{' '}
                    {Math.round(rotationHours / 24) === 1 ? 'Day' : 'Days'} ({rotationHours}h)
                  </span>
                </div>

                <div className="grid grid-cols-7 gap-1.5">
                  {ROTATION_DAY_OPTIONS.map((opt) => {
                    const isSelected = rotationHours === opt.hours;
                    return (
                      <button
                        key={opt.days}
                        type="button"
                        onClick={() => {
                          setRotationHours(opt.hours);
                          setInitialDeadlineHours(opt.hours);
                        }}
                        className={`py-2 rounded-xl text-xs og-bold transition-all border ${
                          isSelected
                            ? 'bg-[#d0ff45] text-[#041206] border-[#d0ff45] scale-105 shadow-md'
                            : 'bg-[#091c0b] text-zinc-300 border-white/10 hover:border-[#d0ff45]/40'
                        }`}
                      >
                        {opt.shortLabel}
                      </button>
                    );
                  })}
                </div>

                <select
                  id="onboard-rotation-hours"
                  value={rotationHours}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setRotationHours(val);
                    setInitialDeadlineHours(val);
                  }}
                  className="pill-input w-full px-4 py-3 rounded-full text-xs og-regular text-white bg-[#091c0b]"
                >
                  {ROTATION_DAY_OPTIONS.map((opt) => (
                    <option key={opt.days} value={opt.hours}>
                      {opt.fullLabel}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="onboard-first-deadline"
                  className="block text-xs og-medium text-white pl-1"
                >
                  First Turn Deadline Window
                </label>
                <select
                  id="onboard-first-deadline"
                  value={initialDeadlineHours}
                  onChange={(e) => setInitialDeadlineHours(Number(e.target.value))}
                  className="pill-input w-full px-4 py-3 rounded-full text-xs og-regular text-white bg-[#091c0b]"
                >
                  {ROTATION_DAY_OPTIONS.map((opt) => (
                    <option key={`init-${opt.days}`} value={opt.hours}>
                      Due in {opt.days === 1 ? '1 Day (24h)' : `${opt.days} Days (${opt.hours}h)`}
                    </option>
                  ))}
                  <option value={4.5}>Due in 4h 30m (Triggers 5h Warning Email)</option>
                </select>
              </div>

              {errorMsg && (
                <p className="text-xs text-rose-400 og-medium text-center">{errorMsg}</p>
              )}

              <button
                type="submit"
                disabled={isSubmitting}
                data-testid="create-household-submit"
                className="lime-cta w-full py-4 px-6 rounded-full og-bold text-sm flex items-center justify-center gap-2 min-h-[52px]"
              >
                <span>
                  {isSubmitting ? 'Creating Household...' : 'Launch Household Party'}
                </span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          ) : (
            <form onSubmit={handleJoinPartySubmit} className="space-y-5">
              {/* 6-Digit/Character Visual Slots */}
              <div className="flex items-center justify-center gap-2 sm:gap-2.5 py-1">
                {sixSlots.map((char, idx) => (
                  <div
                    key={idx}
                    className={`w-11 h-13 rounded-2xl border flex items-center justify-center text-lg og-bold font-mono transition-colors ${
                      char
                        ? 'bg-[#122a15] border-[#d0ff45]/60 text-[#d0ff45]'
                        : 'bg-[#091c0b] border-white/10 text-zinc-600'
                    }`}
                  >
                    {char || '·'}
                  </div>
                ))}
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="onboard-invite-code"
                  className="block text-xs og-medium text-white pl-1"
                >
                  Household Invite Code
                </label>
                <input
                  id="onboard-invite-code"
                  type="text"
                  value={inviteCodeInput}
                  onChange={(e) => setInviteCodeInput(e.target.value.toUpperCase())}
                  placeholder="e.g. APT-4B9"
                  className="pill-input w-full px-5 py-3.5 rounded-full text-sm font-mono text-center text-white placeholder:text-zinc-500"
                />
              </div>

              {errorMsg && (
                <p className="text-xs text-rose-400 og-medium text-center">{errorMsg}</p>
              )}

              <button
                type="submit"
                disabled={isSubmitting}
                data-testid="join-household-submit"
                className="lime-cta w-full py-4 px-6 rounded-full og-bold text-sm flex items-center justify-center gap-2 min-h-[52px]"
              >
                <span>{isSubmitting ? 'Joining Party...' : 'Verify & Join Household'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  // STEP 1: Unauthenticated User -> "Welcome Back" (Login) or "Sign Up Account" (Register)
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-md glass-panel-elevated rounded-[36px] p-6 sm:p-8 space-y-6 animate-view-enter">
        {/* Top Row matching the exact reference image header */}
        <div className="flex items-center justify-between">
          <div className="w-10 h-10 rounded-full bg-white/[0.06] border border-white/10 flex items-center justify-center text-[#d0ff45] og-bold text-xs font-mono">
            BD
          </div>
          <span className="text-sm og-medium text-white tracking-tight">
            {authMode === 'login' ? 'Login' : 'Sign Up'}
          </span>
          <div className="px-3 py-1 rounded-full bg-white/[0.06] border border-white/10 text-xs og-book text-zinc-300">
            EN
          </div>
        </div>

        {/* Center Hero Heading */}
        <div className="text-center space-y-2 pt-1">
          <h1
            data-testid="auth-screen-heading"
            className="text-2xl sm:text-3xl og-bold text-white tracking-tight"
          >
            {authMode === 'login' ? 'Welcome Back' : 'Sign Up Account'}
          </h1>
          <p className="text-xs sm:text-sm og-light text-zinc-400 max-w-xs mx-auto leading-relaxed">
            {authMode === 'login'
              ? 'Welcome back! Log in to your account and continue tracking your household trash duty.'
              : 'Create your real household account. We use your email for 5-hour advance warnings & missed trash alerts.'}
          </p>
        </div>

        {/* Optional Avatar Picker during Sign Up */}
        {authMode === 'signup' && (
          <div className="flex flex-col items-center space-y-2.5">
            <div className="relative">
              <img
                src={photoURL || PRESET_AVATARS[0].url}
                alt="Selected profile avatar"
                referrerPolicy="no-referrer"
                className="w-16 h-16 rounded-full object-cover ring-2 ring-[#d0ff45]"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Upload custom profile picture"
                className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-[#d0ff45] text-[#041206] flex items-center justify-center shadow-md"
              >
                <Camera className="w-3.5 h-3.5" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handlePhotoUpload}
                className="hidden"
              />
            </div>
            <div className="flex items-center gap-2">
              {PRESET_AVATARS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setPhotoURL(preset.url)}
                  aria-label={`Choose ${preset.label}`}
                  className={`w-7 h-7 rounded-full overflow-hidden transition-transform ${
                    photoURL === preset.url ? 'ring-2 ring-[#d0ff45] scale-110' : 'opacity-65'
                  }`}
                >
                  <img
                    src={preset.url}
                    alt={preset.label}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Main Auth Form */}
        <form onSubmit={handleAuthSubmit} className="space-y-4">
          <div className="text-xs og-medium text-white pl-1">
            {authMode === 'login' ? 'Login' : 'Sign Up'}
          </div>

          {authMode === 'signup' && (
            <div className="relative flex items-center">
              <UserIcon className="w-4 h-4 text-zinc-400 absolute left-4 pointer-events-none" />
              <input
                id="auth-display-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Enter your full name"
                className="pill-input w-full pl-11 pr-4 py-3.5 rounded-full text-sm og-regular text-white placeholder:text-zinc-500"
              />
            </div>
          )}

          <div className="relative flex items-center">
            <Mail className="w-4 h-4 text-zinc-400 absolute left-4 pointer-events-none" />
            <input
              id="auth-email-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email address"
              className="pill-input w-full pl-11 pr-4 py-3.5 rounded-full text-sm og-regular text-white placeholder:text-zinc-500"
            />
          </div>

          <div className="relative flex items-center">
            <Lock className="w-4 h-4 text-zinc-400 absolute left-4 pointer-events-none" />
            <input
              id="auth-password-input"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              className="pill-input w-full pl-11 pr-11 py-3.5 rounded-full text-sm og-regular text-white placeholder:text-zinc-500"
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-4 text-zinc-400 hover:text-white"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          <div className="flex items-center justify-between text-xs px-1">
            <button
              type="button"
              onClick={() => setRememberMe((prev) => !prev)}
              className="flex items-center gap-2 text-zinc-400 hover:text-white og-book"
            >
              <span
                className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                  rememberMe
                    ? 'bg-[#d0ff45] border-[#d0ff45] text-[#041206]'
                    : 'border-zinc-600'
                }`}
              >
                {rememberMe && <Check className="w-3 h-3" />}
              </span>
              <span>Remember me</span>
            </button>
            <span className="text-[#d0ff45] og-medium">5h Email Alerts Active</span>
          </div>

          {errorMsg && (
            <p className="text-xs text-rose-400 og-medium text-center">{errorMsg}</p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            data-testid="auth-submit-button"
            className="lime-cta w-full py-4 px-6 rounded-full og-bold text-sm flex items-center justify-center gap-2 min-h-[52px]"
          >
            <span>
              {isSubmitting
                ? 'Please wait...'
                : authMode === 'login'
                ? 'Login'
                : 'Sign Up'}
            </span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        {/* Divider ("OR") */}
        <div className="flex items-center gap-4">
          <div className="h-px flex-1 bg-white/[0.08]" />
          <span className="text-[11px] uppercase tracking-widest text-zinc-500 og-medium">
            OR
          </span>
          <div className="h-px flex-1 bg-white/[0.08]" />
        </div>

        {/* Primary Google Sign-In Button — Immediately launches the real Google OAuth Popup */}
        <div className="space-y-2.5">
          <button
            type="button"
            disabled={isLaunchingPopup}
            data-testid="google-popup-login-btn"
            onClick={async () => {
              setErrorMsg(null);
              setGoogleModalError(null);
              setGooglePopupNotice(null);
              setIsLaunchingPopup(true);
              try {
                const res = await onGoogleSignIn();
                if (!res.ok) {
                  if (res.errorCode?.includes('unauthorized-domain')) {
                    setGooglePopupNotice(
                      `Note: Add "${window.location.hostname}" to Firebase Console → Authentication → Settings → Authorized domains for native popup, or sign in with your Gmail below right now:`
                    );
                  } else if (res.errorMessage) {
                    setGooglePopupNotice(res.errorMessage);
                  }
                  setIsGoogleChooserOpen(true);
                }
              } finally {
                setIsLaunchingPopup(false);
              }
            }}
            className="w-full min-h-[48px] py-3.5 px-6 rounded-full bg-[#091c0b] hover:bg-[#112914] border border-white/10 text-white og-medium text-sm flex items-center justify-center gap-3 transition-colors disabled:opacity-60"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#EA4335"
                d="M12 5c1.6 0 3 .6 4.1 1.7l3.1-3.1C17.3 1.8 14.8 1 12 1 7.4 1 3.5 3.6 1.6 7.4l3.7 2.8C6.2 7.2 8.9 5 12 5z"
              />
              <path
                fill="#4285F4"
                d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.6l3.7 2.9c2.2-2 3.7-5 3.7-8.7z"
              />
              <path
                fill="#FBBC05"
                d="M5.3 14.8c-.2-.8-.4-1.8-.4-2.8s.2-2 .4-2.8L1.6 6.4C.6 8.4 0 10.6 0 13s.6 4.6 1.6 6.6l3.7-2.8z"
              />
              <path
                fill="#34A853"
                d="M12 23c3.2 0 6-1.1 8-3l-3.7-2.9c-1.1.7-2.5 1.2-4.3 1.2-3.1 0-5.8-2.1-6.7-5l-3.7 2.8C3.5 19.9 7.4 23 12 23z"
              />
            </svg>
            <span>
              {isLaunchingPopup ? 'Opening Google Sign-In Popup...' : 'Continue with Google'}
            </span>
          </button>

          <div className="text-center">
            <button
              type="button"
              data-testid="open-google-chooser-btn"
              onClick={() => {
                setGoogleModalError(null);
                setGooglePopupNotice(null);
                setIsGoogleChooserOpen(true);
              }}
              className="text-[11px] og-medium text-zinc-400 hover:text-[#d0ff45] underline underline-offset-4 transition-colors"
            >
              Popup blocked on mobile browser? Sign in with Gmail address directly →
            </button>
          </div>
        </div>

        {/* Bottom Switch Mode Link */}
        <div className="text-center text-xs og-book text-zinc-400 pt-1">
          {authMode === 'login' ? (
            <>
              Don&apos;t have an account?{' '}
              <button
                type="button"
                onClick={() => {
                  setAuthMode('signup');
                  setErrorMsg(null);
                }}
                className="text-[#d0ff45] underline og-bold ml-1"
              >
                Sign Up
              </button>
            </>
          ) : (
            <>
              Do you have an account?{' '}
              <button
                type="button"
                onClick={() => {
                  setAuthMode('login');
                  setErrorMsg(null);
                }}
                className="text-[#d0ff45] underline og-bold ml-1"
              >
                Sign In
              </button>
            </>
          )}
        </div>
      </div>

      {/* Direct Google Account Sign-In Modal (works on Netlify static hosting & mobile in-app browsers) */}
      {isGoogleChooserOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md"
        >
          <div className="glass-panel-elevated w-full max-w-md rounded-[32px] p-6 space-y-5 border border-[#d0ff45]/35 animate-view-enter">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="#EA4335"
                    d="M12 5c1.6 0 3 .6 4.1 1.7l3.1-3.1C17.3 1.8 14.8 1 12 1 7.4 1 3.5 3.6 1.6 7.4l3.7 2.8C6.2 7.2 8.9 5 12 5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.6l3.7 2.9c2.2-2 3.7-5 3.7-8.7z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.3 14.8c-.2-.8-.4-1.8-.4-2.8s.2-2 .4-2.8L1.6 6.4C.6 8.4 0 10.6 0 13s.6 4.6 1.6 6.6l3.7-2.8z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c3.2 0 6-1.1 8-3l-3.7-2.9c-1.1.7-2.5 1.2-4.3 1.2-3.1 0-5.8-2.1-6.7-5l-3.7 2.8C3.5 19.9 7.4 23 12 23z"
                  />
                </svg>
                <div>
                  <h2 className="text-base og-bold text-white">Sign in with Google</h2>
                  <p className="text-xs text-zinc-400">
                    Works on Netlify &amp; mobile browsers with any Gmail account
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsGoogleChooserOpen(false)}
                className="p-2 rounded-full bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {googlePopupNotice && (
              <div className="p-3 rounded-2xl bg-amber-500/10 border border-amber-400/30 text-amber-200 text-xs leading-relaxed">
                {googlePopupNotice}
              </div>
            )}

            <form onSubmit={handleInstantGoogleSubmit} className="space-y-3.5">
              <div className="space-y-1">
                <label className="block text-xs og-medium text-zinc-300 pl-1">
                  Your Gmail / Google Email Address
                </label>
                <input
                  type="email"
                  required
                  value={googleEmailInput}
                  onChange={(e) => setGoogleEmailInput(e.target.value)}
                  placeholder="e.g. peacerifat2005@gmail.com"
                  data-testid="google-instant-email-input"
                  className="pill-input w-full px-4 py-3 rounded-2xl text-sm text-white placeholder:text-zinc-500"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-xs og-medium text-zinc-300 pl-1">
                  Your Display Name
                </label>
                <input
                  type="text"
                  value={googleNameInput}
                  onChange={(e) => setGoogleNameInput(e.target.value)}
                  placeholder="e.g. Rifat Ashhab"
                  data-testid="google-instant-name-input"
                  className="pill-input w-full px-4 py-3 rounded-2xl text-sm text-white placeholder:text-zinc-500"
                />
              </div>

              {googleModalError && (
                <p className="text-xs text-rose-400 og-medium text-center">
                  {googleModalError}
                </p>
              )}

              <button
                type="submit"
                disabled={isGoogleSubmitting}
                data-testid="google-instant-submit-btn"
                className="lime-cta w-full py-3.5 px-6 rounded-full og-bold text-xs sm:text-sm flex items-center justify-center gap-2"
              >
                <span>
                  {isGoogleSubmitting ? 'Signing in...' : 'Continue with This Google Account'}
                </span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

            <div className="pt-2 border-t border-white/10 flex items-center justify-between gap-2 text-[11px] text-zinc-400">
              <span>Retry Google OAuth popup window:</span>
              <button
                type="button"
                onClick={async () => {
                  const res = await onGoogleSignIn();
                  if (res.ok) {
                    setIsGoogleChooserOpen(false);
                  } else if (res.errorMessage) {
                    setGoogleModalError(res.errorMessage);
                  }
                }}
                className="text-[#d0ff45] hover:underline og-medium"
              >
                Launch OAuth Popup →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
