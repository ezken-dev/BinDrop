/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Users,
  Clock,
  AlertTriangle,
  CheckCircle2,
  SkipForward,
  User as UserIcon,
  Flame,
  ArrowRight,
  Sparkles,
  Mail,
  ShieldCheck,
  Database,
  Calendar,
  XCircle,
  Send,
  X,
  Bell,
  BellRing,
  Check,
  Home,
  LayoutGrid,
  Trophy,
  Copy,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type User } from 'firebase/auth';
import {
  auth,
  googleSignIn,
  initAuth,
  signOutUser,
} from './firebase';
import { generateSimulatedTrashSceneDataUrl } from './utils/sceneImageGenerator';
import {
  evaluateDeadlineStatus,
  formatCountdown,
  formatDateTimeReadable,
  formatRotationDaysLabel,
  formatSixCharInviteCode,
  isFakeStubParty,
  OFFICIAL_BINDROP_EMAIL,
  OFFICIAL_BINDROP_NAME,
  ROTATION_DAY_OPTIONS,
  type EmailAlertType,
  type EmailDispatchLog,
  type HouseholdInvitation,
  type HouseholdMember,
  type OfficialMailerStatus,
  type PartyAlertItem,
  type PartyState,
  type TrashDropLog,
  type TurnHistoryRecord,
} from './utils/trashDutyLogic';
import { VisionScannerModal } from './components/VisionScannerModal';
import { PartyManagerView } from './components/PartyManagerModal';
import { ProfileAccountView } from './components/ProfileAccountModal';
import { AdminDashboardView } from './components/AdminDashboardView';
import {
  AuthLoginScreen,
  type AuthenticatedAccount,
} from './components/AuthLoginScreen';
import { MemberAvatar } from './components/MemberAvatar';
import { PushAlertsCard } from './components/PushAlertsCard';
import {
  InstallPwaBanner,
  InstallPwaHeaderButton,
} from './components/InstallPwaBanner';
import { apiFetch, getInitialCachedBundleForAccount } from './utils/apiClient';
import { chooseBestAvatar, setCachedMemberAvatar } from './utils/cloudPartySync';
import {
  autoSyncAndHealPushSubscription,
  registerBinDropServiceWorker,
} from './utils/pushClient';

type ActiveTab = 'hud' | 'admin' | 'party' | 'profile';

const SESSION_STORAGE_KEY = 'bindrop_authenticated_account_v4';
const SEEN_POPUP_IDS_KEY = 'bindrop_seen_popup_alerts_v4';

interface PartyBundlePayload {
  party: PartyState;
  drops: TrashDropLog[];
  history: TurnHistoryRecord[];
  emails: EmailDispatchLog[];
  alerts: PartyAlertItem[];
  partyInvitations?: HouseholdInvitation[];
  mailerStatus?: OfficialMailerStatus;
}

function playSocialNotificationChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    osc1.frequency.setValueAtTime(880, now + 0.09); // A5
    osc2.frequency.setValueAtTime(293.66, now);
    osc2.frequency.setValueAtTime(440, now + 0.09);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.14, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.34);
    osc2.stop(now + 0.34);
  } catch {
    // AudioContext may be blocked before user interaction
  }
}

function loadSeenPopupIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_POPUP_IDS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch {
    // ignore
  }
  return new Set();
}

function saveSeenPopupIds(ids: Set<string>) {
  try {
    const arr = Array.from(ids).slice(-120);
    localStorage.setItem(SEEN_POPUP_IDS_KEY, JSON.stringify(arr));
  } catch {
    // ignore
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('hud');
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [celebrationBanner, setCelebrationBanner] = useState<string | null>(null);
  const [isVerifyingDropId, setIsVerifyingDropId] = useState<string | null>(null);

  // Hydrate authenticated account synchronously on mount
  const [currentAccount, setCurrentAccount] = useState<AuthenticatedAccount | null>(() => {
    try {
      const saved = localStorage.getItem(SESSION_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as AuthenticatedAccount;
        if (parsed.partyId && parsed.partyId.startsWith('party_code_')) {
          parsed.partyId = null;
        }
        return parsed;
      }
    } catch {
      // ignore storage errors
    }
    return null;
  });

  // Hydrate cached party bundle synchronously on mount so pushing updates or reloading NEVER resets to "Create Household Party"
  const initialCachedBundle = useRef<PartyBundlePayload | null | undefined>(undefined);
  if (initialCachedBundle.current === undefined) {
    const candidate = getInitialCachedBundleForAccount(
      currentAccount?.email,
      currentAccount?.partyId
    );
    initialCachedBundle.current =
      candidate && candidate.party && !isFakeStubParty(candidate.party)
        ? candidate
        : null;
  }

  const [party, setParty] = useState<PartyState | null>(
    () => initialCachedBundle.current?.party || null
  );
  const [dropLogs, setDropLogs] = useState<TrashDropLog[]>(
    () => initialCachedBundle.current?.drops || []
  );
  const [historyLogs, setHistoryLogs] = useState<TurnHistoryRecord[]>(
    () => initialCachedBundle.current?.history || []
  );
  const [emailLogs, setEmailLogs] = useState<EmailDispatchLog[]>(
    () => initialCachedBundle.current?.emails || []
  );
  const [alerts, setAlerts] = useState<PartyAlertItem[]>(
    () => initialCachedBundle.current?.alerts || []
  );
  const [partyInvitations, setPartyInvitations] = useState<HouseholdInvitation[]>(
    () => initialCachedBundle.current?.partyInvitations || []
  );
  const [pendingInvitations, setPendingInvitations] = useState<HouseholdInvitation[]>([]);
  const [mailerStatus, setMailerStatus] = useState<OfficialMailerStatus | null>(
    () => initialCachedBundle.current?.mailerStatus || null
  );

  // Social Pop-Up Notification Banner, Notification Drawer & Streak Sheet state
  const [activePopupToast, setActivePopupToast] = useState<PartyAlertItem | null>(null);
  const [isNotifDrawerOpen, setIsNotifDrawerOpen] = useState(false);
  const [isStreakSheetOpen, setIsStreakSheetOpen] = useState(false);
  const seenPopupIdsRef = useRef<Set<string>>(loadSeenPopupIds());
  const sessionMutationEpochRef = useRef<number>(0);

  // HUD Pop-Up Notification Modal state
  const [hudEmailConfirmOpen, setHudEmailConfirmOpen] = useState(false);
  const [hudEmailSubject, setHudEmailSubject] = useState('');
  const [hudEmailBody, setHudEmailBody] = useState('');
  const [isSendingHudEmail, setIsSendingHudEmail] = useState(false);

  // Persist authenticated account session locally
  useEffect(() => {
    try {
      if (currentAccount) {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(currentAccount));
      } else {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      }
    } catch {
      // ignore
    }
  }, [currentAccount]);

  const showSocialPopupNotification = useCallback((alertItem: PartyAlertItem) => {
    setActivePopupToast(alertItem);
    playSocialNotificationChime();
  }, []);

  const syncIncomingInvitations = useCallback(
    (incoming?: HouseholdInvitation[]) => {
      if (!Array.isArray(incoming)) return;
      setPendingInvitations(incoming);
      const unseenInvite = incoming.find(
        (inv) => inv.status === 'PENDING' && !seenPopupIdsRef.current.has(inv.id)
      );
      if (unseenInvite) {
        seenPopupIdsRef.current.add(unseenInvite.id);
        saveSeenPopupIds(seenPopupIdsRef.current);
        showSocialPopupNotification({
          id: unseenInvite.id,
          partyId: unseenInvite.partyId,
          targetUserId: unseenInvite.invitedEmail,
          targetDisplayName: unseenInvite.invitedName,
          targetEmail: unseenInvite.invitedEmail,
          assigneeUserId: unseenInvite.hostId,
          assigneeDisplayName: unseenInvite.hostName,
          senderName: unseenInvite.hostName,
          senderPhotoURL: unseenInvite.hostPhotoURL,
          title: `📩 Household Invite from ${unseenInvite.hostName}!`,
          category: 'HOUSEHOLD_INVITE',
          type: 'TURN_REMINDER',
          message: `${unseenInvite.hostName} (${unseenInvite.hostEmail}) invited you to join "${unseenInvite.partyName}" (Code: ${unseenInvite.inviteCode}). Open the Invitations tab to accept!`,
          read: false,
          createdAt: unseenInvite.createdAt,
        });
      }
    },
    [showSocialPopupNotification]
  );

  const applyServerBundle = useCallback(
    (bundle: PartyBundlePayload | null, options?: { forceClearIfNull?: boolean }) => {
      if (!bundle || !bundle.party || isFakeStubParty(bundle.party)) {
        if (options?.forceClearIfNull || isFakeStubParty(bundle?.party)) {
          setParty(null);
          setDropLogs([]);
          setHistoryLogs([]);
          setEmailLogs([]);
          setAlerts([]);
          setPartyInvitations([]);
        }
        return;
      }
      const normalizedParty: PartyState = {
        ...bundle.party,
        inviteCode: formatSixCharInviteCode(bundle.party.inviteCode),
      };
      setParty(normalizedParty);
      setDropLogs(bundle.drops || []);
      setHistoryLogs(bundle.history || []);
      setEmailLogs(bundle.emails || []);
      setPartyInvitations(bundle.partyInvitations || []);

      const incomingAlerts = bundle.alerts || [];
      setAlerts(incomingAlerts);

      // Check for any newly arrived unread alert to trigger Facebook/Instagram-style pop-up banner
      const newestUnread = incomingAlerts.find(
        (a) => !a.read && !seenPopupIdsRef.current.has(a.id)
      );
      if (newestUnread) {
        seenPopupIdsRef.current.add(newestUnread.id);
        saveSeenPopupIds(seenPopupIdsRef.current);
        showSocialPopupNotification(newestUnread);
      }

      if (bundle.mailerStatus) {
        setMailerStatus(bundle.mailerStatus);
      }
    },
    [showSocialPopupNotification]
  );

  // Auto-dismiss floating social pop-up banner after 7.5 seconds
  useEffect(() => {
    if (!activePopupToast) return;
    const timer = setTimeout(() => {
      setActivePopupToast(null);
    }, 7500);
    return () => clearTimeout(timer);
  }, [activePopupToast]);

  // Register background Service Worker (/sw.js) and listen for incoming Web Push events
  useEffect(() => {
    registerBinDropServiceWorker().catch(() => {});
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === 'BINDROP_PUSH_RECEIVED' && event.data?.payload) {
        const p = event.data.payload;
        setActivePopupToast({
          id: p.tag || `push_${Date.now()}`,
          partyId: party?.id || 'party_push',
          targetUserId: currentAccount?.uid || 'u_self',
          targetDisplayName: currentAccount?.displayName || 'You',
          targetEmail: currentAccount?.email || OFFICIAL_BINDROP_EMAIL,
          assigneeUserId: currentAccount?.uid || 'u_self',
          assigneeDisplayName: currentAccount?.displayName || 'You',
          senderName: p.senderName || party?.name || 'BinDrop',
          title: p.title || 'BinDrop Household Alert',
          category: p.category || 'TURN_REMINDER',
          type: 'TURN_REMINDER',
          message: p.body || 'New household trash duty notification.',
          read: false,
          createdAt: new Date().toISOString(),
        });
        playSocialNotificationChime();
      }
    };

    navigator.serviceWorker.addEventListener('message', handleSwMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleSwMessage);
  }, [party?.id, party?.name, currentAccount?.uid, currentAccount?.displayName, currentAccount?.email]);

  // Automatically sync & self-heal background Web Push subscription when user logs in or switches party
  useEffect(() => {
    if (!currentAccount?.email) return;
    autoSyncAndHealPushSubscription({
      userEmail: currentAccount.email,
      userUid: currentAccount.uid,
      userDisplayName: currentAccount.displayName,
      partyId: party?.id || currentAccount.partyId || null,
    }).catch(() => {});
  }, [
    currentAccount?.email,
    currentAccount?.uid,
    currentAccount?.displayName,
    currentAccount?.partyId,
    party?.id,
  ]);

  // Cloud sync is handled by apiFetch + Dual-Engine Cloud Sync (cloudPartySync.ts)
  const syncPartyToFirestore = useCallback(
    async (
      _updatedParty: PartyState,
      _newDrop?: TrashDropLog,
      _newHistory?: TurnHistoryRecord
    ) => {
      // Handled by Dual-Engine Cloud Sync in apiFetch / cloudPartySync.ts
    },
    []
  );

  // Fetch initial session & poll every 5 seconds for 5-hour warnings, missed deadlines, and roommate photo uploads
  const refreshSessionState = useCallback(async () => {
    if (!currentAccount?.email) return;
    const requestEpoch = sessionMutationEpochRef.current;
    try {
      const { ok, data } = await apiFetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: currentAccount.email,
          partyId: currentAccount.partyId || party?.id || null,
          displayName: currentAccount.displayName,
          uid: currentAccount.uid,
          photoURL: currentAccount.photoURL,
        }),
      });
      // Discard stale poll responses if the user created, joined, left, or deleted a party while the request was in flight
      if (requestEpoch !== sessionMutationEpochRef.current) return;
      if (!ok || !data) return;
      if (data.user) {
        setCurrentAccount((prev) => {
          const bestPhoto = chooseBestAvatar(
            prev?.photoURL,
            data.user.photoURL,
            data.user.email || prev?.email
          );
          const mergedUser = {
            ...data.user,
            photoURL: bestPhoto || data.user.photoURL,
          };
          if (!prev) return mergedUser;
          if (
            prev.partyId !== mergedUser.partyId ||
            prev.displayName !== mergedUser.displayName ||
            prev.email !== mergedUser.email ||
            prev.photoURL !== mergedUser.photoURL
          ) {
            return mergedUser;
          }
          return prev;
        });
      }
      if (data.invitations) {
        syncIncomingInvitations(data.invitations);
      }
      if (data.bundle) {
        applyServerBundle(data.bundle);
      } else if (data.user && !data.user.partyId) {
        applyServerBundle(null, { forceClearIfNull: true });
      }
    } catch {
      // ignore transient network errors
    }
  }, [
    currentAccount?.email,
    currentAccount?.partyId,
    currentAccount?.displayName,
    currentAccount?.uid,
    currentAccount?.photoURL,
    party?.id,
    applyServerBundle,
    syncIncomingInvitations,
  ]);

  useEffect(() => {
    refreshSessionState();
    const poll = setInterval(() => {
      refreshSessionState();
    }, 5000);
    return () => clearInterval(poll);
  }, [refreshSessionState]);

  // 1-second live countdown ticker
  useEffect(() => {
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Client-side immediate trigger when turn crosses <= 5h warning or <= 0h overdue threshold
  useEffect(() => {
    if (!party) return;
    const evalStatus = evaluateDeadlineStatus(party, nowMs);
    if (
      evalStatus.shouldSendFiveHourWarningEmail ||
      evalStatus.shouldSendMissedDeadlineEmail
    ) {
      refreshSessionState();
    }
  }, [party, nowMs, refreshSessionState]);

  // Listen for Firebase Google Auth changes via initAuth()
  useEffect(() => {
    const unsubscribe = initAuth(async (user) => {
      setFirebaseUser(user);
      if (user && user.email) {
        try {
          const bestInitialPhoto = chooseBestAvatar(
            undefined,
            user.photoURL || undefined,
            user.email
          );
          const { ok, data } = await apiFetch('/api/auth/google-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              uid: user.uid,
              email: user.email,
              displayName: user.displayName || user.email.split('@')[0],
              photoURL: bestInitialPhoto,
            }),
          });
          if (ok && data?.user) {
            const resolvedPhoto = chooseBestAvatar(
              data.user.photoURL,
              bestInitialPhoto,
              user.email
            );
            setCurrentAccount((prev) => ({
              ...data.user,
              photoURL: chooseBestAvatar(prev?.photoURL, resolvedPhoto, user.email),
            }));
            if (data.invitations) {
              syncIncomingInvitations(data.invitations);
            }
            if (data.bundle) {
              applyServerBundle(data.bundle);
            }
          }
        } catch {
          // ignore
        }
      }
    });
    return () => unsubscribe();
  }, [applyServerBundle, syncIncomingInvitations]);

  // --- AUTHENTICATION HANDLERS ---
  const handleRegisterWithEmail = async (payload: {
    email: string;
    password: string;
    displayName: string;
    photoURL?: string;
  }) => {
    sessionMutationEpochRef.current += 1;
    const { ok, data } = await apiFetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!ok) {
      throw new Error(data?.error || 'Could not create account.');
    }
    sessionMutationEpochRef.current += 1;
    setCurrentAccount(data.user);
    if (data.invitations) syncIncomingInvitations(data.invitations);
    applyServerBundle(data.bundle, { forceClearIfNull: true });
  };

  const handleLoginWithEmail = async (payload: { email: string; password: string }) => {
    sessionMutationEpochRef.current += 1;
    const { ok, data } = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!ok) {
      throw new Error(data?.error || 'Invalid login credentials.');
    }
    sessionMutationEpochRef.current += 1;
    setCurrentAccount(data.user);
    if (data.invitations) syncIncomingInvitations(data.invitations);
    applyServerBundle(data.bundle, { forceClearIfNull: true });
  };

  const handleDirectGoogleAccountSignIn = async (payload: {
    email: string;
    displayName: string;
    photoURL?: string;
  }) => {
    setAuthError(null);
    sessionMutationEpochRef.current += 1;
    const { ok, data } = await apiFetch('/api/auth/google-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: payload.email.trim().toLowerCase(),
        displayName:
          payload.displayName.trim() || payload.email.trim().split('@')[0],
        photoURL: payload.photoURL || undefined,
      }),
    });
    if (!ok) {
      throw new Error(data?.error || 'Could not sign in with Google account.');
    }
    sessionMutationEpochRef.current += 1;
    setCurrentAccount(data.user);
    if (data.invitations) syncIncomingInvitations(data.invitations);
    applyServerBundle(data.bundle, { forceClearIfNull: true });
  };

  const handleGoogleSignIn = async (): Promise<{
    ok: boolean;
    errorCode?: string;
    errorMessage?: string;
  }> => {
    setAuthError(null);
    sessionMutationEpochRef.current += 1;
    try {
      const result = await googleSignIn();
      if (!result || !result.user) {
        return {
          ok: false,
          errorMessage: 'Google Sign-In popup did not return an account. Sign in with your Gmail address below:',
        };
      }
      const { user } = result;
      if (user && user.email) {
        const bestInitialPhoto = chooseBestAvatar(
          currentAccount?.photoURL,
          user.photoURL || undefined,
          user.email
        );
        const { ok, data } = await apiFetch('/api/auth/google-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || user.email.split('@')[0],
            photoURL: bestInitialPhoto,
          }),
        });
        if (ok && data?.user) {
          sessionMutationEpochRef.current += 1;
          setCurrentAccount({
            ...data.user,
            photoURL: chooseBestAvatar(data.user.photoURL, bestInitialPhoto, user.email),
          });
          if (data.invitations) syncIncomingInvitations(data.invitations);
          applyServerBundle(data.bundle, { forceClearIfNull: true });
          return { ok: true };
        }
      }
      return { ok: false, errorMessage: 'Could not sync Google profile.' };
    } catch (err: any) {
      const code = String(err?.code || '');
      const msg =
        err instanceof Error
          ? err.message
          : 'Google Sign-In popup was blocked by your browser. Enter your Gmail address below to continue:';
      return {
        ok: false,
        errorCode: code,
        errorMessage: msg,
      };
    }
  };

  const handleSignOut = async () => {
    sessionMutationEpochRef.current += 1;
    try {
      await signOutUser();
    } catch {
      // ignore
    }
    sessionMutationEpochRef.current += 1;
    setCurrentAccount(null);
    applyServerBundle(null, { forceClearIfNull: true });
    setActiveTab('hud');
  };

  // --- PARTY CREATION, INVITE CODE JOIN, LEAVE, DELETE & ROOMMATE ENROLLMENT ---
  const handleCreateHousehold = async (payload: {
    name: string;
    rotationIntervalHours: number;
    initialDeadlineHours?: number;
  }) => {
    if (!currentAccount) return;
    sessionMutationEpochRef.current += 1;
    const { ok, data } = await apiFetch('/api/party/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userUid: currentAccount.uid,
        userEmail: currentAccount.email,
        userDisplayName: currentAccount.displayName,
        userPhotoURL: currentAccount.photoURL,
        name: payload.name,
        rotationIntervalHours: payload.rotationIntervalHours,
        initialDeadlineHours: payload.initialDeadlineHours,
      }),
    });
    if (!ok) {
      throw new Error(data?.error || 'Failed to create household party.');
    }
    sessionMutationEpochRef.current += 1;
    setCurrentAccount(data.user);
    applyServerBundle(data.bundle);
    if (data.bundle?.party) {
      syncPartyToFirestore(data.bundle.party).catch(() => {});
    }
  };

  const handleJoinHouseholdByCode = async (inviteCode: string) => {
    if (!currentAccount) return;
    sessionMutationEpochRef.current += 1;
    const { ok, data } = await apiFetch('/api/party/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inviteCode,
        userUid: currentAccount.uid,
        userEmail: currentAccount.email,
        userDisplayName: currentAccount.displayName,
        userPhotoURL: currentAccount.photoURL,
      }),
    });
    if (!ok) {
      throw new Error(data?.error || 'Could not join household party.');
    }
    sessionMutationEpochRef.current += 1;
    setCurrentAccount(data.user);
    applyServerBundle(data.bundle);
  };

  const handleLeaveParty = async () => {
    if (!party || !currentAccount) return;
    sessionMutationEpochRef.current += 1;
    const targetPartyId = party.id;
    const { ok, data } = await apiFetch('/api/party/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId: targetPartyId,
        userId: currentAccount.uid,
        userEmail: currentAccount.email,
      }),
    });
    if (!ok) {
      throw new Error(data?.error || 'Could not leave household party.');
    }
    sessionMutationEpochRef.current += 1;
    setCurrentAccount((prev) => (prev ? { ...prev, partyId: null } : prev));
    applyServerBundle(null, { forceClearIfNull: true });
    setActiveTab('hud');
  };

  const handleDeleteParty = async () => {
    if (!party || !currentAccount) return;
    sessionMutationEpochRef.current += 1;
    const targetPartyId = party.id;
    const { ok, data } = await apiFetch('/api/party/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId: targetPartyId,
        userId: currentAccount.uid,
        userEmail: currentAccount.email,
      }),
    });
    if (!ok) {
      throw new Error(data?.error || 'Could not delete household party.');
    }
    sessionMutationEpochRef.current += 1;
    setCurrentAccount((prev) => (prev ? { ...prev, partyId: null } : prev));
    applyServerBundle(null, { forceClearIfNull: true });
    setActiveTab('hud');
  };

  const handleMarkAllAlertsRead = async () => {
    if (!party) return;
    setAlerts((prev) => prev.map((a) => ({ ...a, read: true })));
    await apiFetch('/api/party/alerts-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partyId: party.id }),
    });
  };

  const handleAcceptInvitation = async (invitation: HouseholdInvitation) => {
    if (!currentAccount) return;
    sessionMutationEpochRef.current += 1;
    const { ok, data } = await apiFetch('/api/party/respond-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invitationId: invitation.id,
        partyId: invitation.partyId,
        inviteCode: invitation.inviteCode,
        decision: 'ACCEPT',
        userUid: currentAccount.uid,
        userEmail: currentAccount.email,
        userDisplayName: currentAccount.displayName,
        userPhotoURL: currentAccount.photoURL,
      }),
    });
    if (!ok) {
      throw new Error(data?.error || 'Could not accept household invitation.');
    }
    sessionMutationEpochRef.current += 1;
    if (data.user) setCurrentAccount(data.user);
    if (data.invitations) setPendingInvitations(data.invitations);
    if (data.bundle) applyServerBundle(data.bundle);
  };

  const handleDeclineInvitation = async (invitation: HouseholdInvitation) => {
    if (!currentAccount) return;
    const { ok, data } = await apiFetch('/api/party/respond-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invitationId: invitation.id,
        partyId: invitation.partyId,
        inviteCode: invitation.inviteCode,
        decision: 'DECLINE',
        userEmail: currentAccount.email,
      }),
    });
    if (!ok) {
      throw new Error(data?.error || 'Could not decline household invitation.');
    }
    if (data.invitations) {
      setPendingInvitations(data.invitations);
    } else {
      setPendingInvitations((prev) => prev.filter((i) => i.id !== invitation.id));
    }
  };

  const handleAddRoommateWithEmail = async (payload: {
    memberName: string;
    memberEmail: string;
  }) => {
    if (!party) return;
    const { ok, data } = await apiFetch('/api/party/add-member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId: party.id,
        memberName: payload.memberName,
        memberEmail: payload.memberEmail,
      }),
    });
    if (!ok) {
      throw new Error(data?.error || 'Failed to send roommate invitation.');
    }
    applyServerBundle(data.bundle);
    if (data.bundle?.party) {
      syncPartyToFirestore(data.bundle.party).catch(() => {});
    }
  };

  // --- UPLOAD TRASH PHOTO FOR HOST VERIFICATION ---
  const handleUploadTrashPhoto = async (payload: {
    imageUrl: string;
    locationNote: string;
    verifyImmediatelyAsHost: boolean;
  }) => {
    if (!party) return;
    const activeTurnMember =
      party.members.find((m) => m.uid === party.currentTurnUserId) ||
      party.members[party.currentTurnIndex] ||
      party.members[0];

    // Attribute the photo upload to the currently logged-in user who is actually posting the photo
    const uploaderMember =
      (currentAccount &&
        party.members.find(
          (m) =>
            m.uid === currentAccount.uid ||
            m.email.toLowerCase() === currentAccount.email.toLowerCase()
        )) ||
      activeTurnMember;

    const uploaderName =
      currentAccount?.displayName || uploaderMember?.displayName || 'Roommate';

    const { ok, data } = await apiFetch('/api/party/drop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId: party.id,
        userId: uploaderMember.uid,
        userEmail: currentAccount?.email || uploaderMember.email,
        userDisplayName: uploaderName,
        userPhotoURL: currentAccount?.photoURL || uploaderMember.photoURL,
        imageUrl: payload.imageUrl,
        locationNote: payload.locationNote,
        verifyImmediatelyAsHost: payload.verifyImmediatelyAsHost,
        hostName: currentAccount?.displayName,
      }),
    });

    if (ok && data?.bundle) {
      applyServerBundle(data.bundle);
      const updatedParty: PartyState = data.bundle.party;

      if (payload.verifyImmediatelyAsHost) {
        const nextMember =
          updatedParty.members.find((m) => m.uid === updatedParty.currentTurnUserId) ||
          updatedParty.members[0];
        setCelebrationBanner(
          `Photo uploaded by ${uploaderName} & verified by Host (+${data.drop?.pointsAwarded || 100} pts)! Turn rotated to ${nextMember.displayName}.`
        );
      } else {
        setCelebrationBanner(
          `Trash photo uploaded by ${uploaderName}! Host (${party.hostEmail}) received an instant pop-up alert to verify.`
        );
      }
      setTimeout(() => setCelebrationBanner(null), 5500);

      syncPartyToFirestore(
        updatedParty,
        data.drop,
        data.bundle.history?.[0]
      ).catch(() => {});
    }
  };

  // --- HOST PHOTO VERIFICATION (APPROVE / REJECT) ---
  const handleHostVerifyDrop = async (params: {
    dropId: string;
    decision: 'APPROVE' | 'REJECT';
    hostReviewNote?: string;
  }) => {
    if (!party) return;
    setIsVerifyingDropId(params.dropId);
    try {
      const { ok, data } = await apiFetch('/api/party/verify-drop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partyId: party.id,
          dropId: params.dropId,
          decision: params.decision,
          hostReviewNote: params.hostReviewNote,
          hostName: currentAccount?.displayName || 'Host',
        }),
      });
      if (ok && data?.bundle) {
        applyServerBundle(data.bundle);
        const updatedParty: PartyState = data.bundle.party;
        const nextMember =
          updatedParty.members.find((m) => m.uid === updatedParty.currentTurnUserId) ||
          updatedParty.members[0];

        if (params.decision === 'APPROVE') {
          setCelebrationBanner(
            `Host verified ${data.drop?.userDisplayName || 'roommate'}'s trash photo (+${data.drop?.pointsAwarded || 100} pts)! Turn rotated to ${nextMember.displayName}.`
          );
        } else {
          setCelebrationBanner(
            `Host rejected ${data.drop?.userDisplayName || 'roommate'}'s photo. Turn remains active.`
          );
        }
        setTimeout(() => setCelebrationBanner(null), 5500);

        syncPartyToFirestore(
          updatedParty,
          data.drop,
          data.bundle.history?.[0]
        ).catch(() => {});
      }
    } finally {
      setIsVerifyingDropId(null);
    }
  };

  // --- POP-UP NOTIFICATION & DEADLINE / ROTATION DAYS HANDLERS ---
  const handleSaveAppPassword = async (
    appPassword: string
  ): Promise<{ ok: boolean; message: string; error?: string; flushedCount?: number }> => {
    const { ok, data } = await apiFetch('/api/official-email/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: appPassword,
        partyId: party?.id,
      }),
    });
    if (data?.status || data?.mailerStatus) {
      setMailerStatus(data.status || data.mailerStatus);
    }
    if (data?.bundle) {
      applyServerBundle(data.bundle);
    }
    const msg =
      data?.message || 'Live Social Pop-Up & Browser Push Notifications active!';
    setCelebrationBanner(msg);
    setTimeout(() => setCelebrationBanner(null), 5000);
    return {
      ok: Boolean(ok),
      message: msg,
      flushedCount: data?.flushedCount || 0,
    };
  };

  const handleSendEmailReminder = async (params: {
    recipientUserId: string;
    type: EmailAlertType;
    customSubject?: string;
    customMessage?: string;
  }): Promise<{ deliveredViaGmail: boolean; error?: string }> => {
    if (!party) return { deliveredViaGmail: false, error: 'Party not found.' };

    const { ok, data } = await apiFetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId: party.id,
        recipientUserId: params.recipientUserId,
        type: params.type,
        customSubject: params.customSubject,
        customMessage: params.customMessage,
      }),
    });
    if (data?.bundle) {
      applyServerBundle(data.bundle);
    }
    if (ok && data?.email) {
      const latestAlert: PartyAlertItem = data.bundle?.alerts?.[0] || {
        id: data.email.id,
        partyId: party.id,
        targetUserId: data.email.recipientUserId,
        targetDisplayName: data.email.toName,
        targetEmail: data.email.toEmail,
        assigneeUserId: data.email.recipientUserId,
        assigneeDisplayName: data.email.toName,
        senderName: currentAccount?.displayName || party.name,
        senderPhotoURL: currentAccount?.photoURL,
        title: data.email.subject,
        category:
          params.type === 'WARNING_5H'
            ? 'WARNING_5H'
            : params.type === 'MISSED_DEADLINE'
            ? 'MISSED_DEADLINE'
            : 'TURN_REMINDER',
        type:
          params.type === 'WARNING_5H'
            ? 'WARNING_5H'
            : params.type === 'MISSED_DEADLINE'
            ? 'MISSED_DEADLINE'
            : 'TURN_REMINDER',
        message: data.email.bodyText,
        read: false,
        createdAt: new Date().toISOString(),
      };
      seenPopupIdsRef.current.add(latestAlert.id);
      saveSeenPopupIds(seenPopupIdsRef.current);
      showSocialPopupNotification(latestAlert);

      setCelebrationBanner(
        `Instant Pop-Up Notification delivered to ${data.email.toName}: "${data.email.subject}"`
      );
      setTimeout(() => setCelebrationBanner(null), 5000);
      return { deliveredViaGmail: true };
    }
    return {
      deliveredViaGmail: false,
      error: data?.error || 'Could not send pop-up notification.',
    };
  };

  const handleUpdateTurnDeadline = async (nextDeadlineIso: string) => {
    if (!party) return;
    const { ok, data } = await apiFetch('/api/party/deadline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId: party.id,
        nextDeadlineIso,
        userId: currentAccount?.uid,
        userEmail: currentAccount?.email,
      }),
    });
    if (ok && data?.bundle) {
      applyServerBundle(data.bundle);
      syncPartyToFirestore(data.bundle.party).catch(() => {});
    }
  };

  const handleUpdateRotationIntervalHours = async (rotationIntervalHours: number) => {
    if (!party) return;
    const { ok, data } = await apiFetch('/api/party/deadline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId: party.id,
        rotationIntervalHours,
        userId: currentAccount?.uid,
        userEmail: currentAccount?.email,
      }),
    });
    if (ok && data?.bundle) {
      applyServerBundle(data.bundle);
      const days = Math.round(rotationIntervalHours / 24);
      setCelebrationBanner(
        `Rotation schedule updated to every ${days} ${days === 1 ? 'Day' : 'Days'} (${rotationIntervalHours}h)!`
      );
      setTimeout(() => setCelebrationBanner(null), 4000);
      syncPartyToFirestore(data.bundle.party).catch(() => {});
    }
  };

  const handleHostSkipTurn = async () => {
    if (!party) return;
    const { ok, data } = await apiFetch('/api/party/skip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId: party.id,
      }),
    });
    if (ok && data?.bundle) {
      applyServerBundle(data.bundle);
      syncPartyToFirestore(data.bundle.party).catch(() => {});
    }
  };

  const handleUpdateProfile = async (
    uid: string,
    updates: { displayName: string; email?: string; photoURL?: string }
  ) => {
    const targetEmail = (updates.email || currentAccount?.email || '').trim().toLowerCase();
    if (targetEmail && updates.photoURL) {
      setCachedMemberAvatar(targetEmail, updates.photoURL);
    }
    const { ok, data } = await apiFetch('/api/party/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId: party?.id,
        uid,
        displayName: updates.displayName,
        email: updates.email,
        photoURL: updates.photoURL,
      }),
    });
    if (!ok) {
      throw new Error(data?.error || 'Could not update profile.');
    }
    if (data?.bundle) {
      applyServerBundle(data.bundle);
    }
    setCurrentAccount((prev) =>
      prev
        ? {
            ...prev,
            displayName: updates.displayName.trim(),
            email: updates.email ? updates.email.trim().toLowerCase() : prev.email,
            photoURL: updates.photoURL !== undefined ? updates.photoURL : prev.photoURL,
          }
        : prev
    );
  };

  const socialPopupBannerElement = activePopupToast ? (
    <div
      role="status"
      aria-live="polite"
      data-testid="social-popup-notification-banner"
      className="fixed top-3 right-3 left-3 sm:top-5 sm:left-auto sm:right-5 sm:w-[420px] z-[130] animate-view-enter pointer-events-auto"
    >
      <div className="glass-panel-elevated rounded-[26px] p-4 border-2 border-[#d0ff45]/80 shadow-[0_24px_60px_rgba(0,0,0,0.92)] bg-[#061808]/95 backdrop-blur-xl flex items-start gap-3.5">
        <div className="relative shrink-0">
          <div className="w-11 h-11 rounded-full bg-[#132c16] border border-[#d0ff45]/50 flex items-center justify-center text-[#d0ff45] og-bold text-sm overflow-hidden">
            {activePopupToast.senderPhotoURL ? (
              <img
                src={activePopupToast.senderPhotoURL}
                alt={activePopupToast.senderName || 'BinDrop'}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            ) : (
              <BellRing className="w-5 h-5 text-[#d0ff45]" />
            )}
          </div>
          <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-[#d0ff45] text-[#041206] flex items-center justify-center text-[9px] og-bold shadow">
            ★
          </span>
        </div>

        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-[#d0ff45] og-bold">
              BinDrop Live Pop-Up · Just Now
            </span>
            <button
              type="button"
              onClick={() => setActivePopupToast(null)}
              aria-label="Dismiss notification"
              className="text-zinc-400 hover:text-white p-0.5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-xs sm:text-sm og-bold text-white leading-snug">
            {activePopupToast.title || `Trash Duty Alert · ${party?.name || 'BinDrop'}`}
          </p>
          <p className="text-xs text-zinc-200 leading-relaxed line-clamp-3">
            {activePopupToast.message}
          </p>
          {party && (
            <div className="pt-1.5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setActivePopupToast(null);
                  setIsScannerOpen(true);
                }}
                className="px-3 py-1 rounded-full bg-[#d0ff45] text-[#041206] text-[11px] og-bold"
              >
                Upload Photo
              </button>
              <button
                type="button"
                onClick={() => {
                  setActivePopupToast(null);
                  setIsNotifDrawerOpen(true);
                }}
                className="px-3 py-1 rounded-full bg-white/10 hover:bg-white/15 text-white text-[11px] og-medium"
              >
                Open Feed ({alerts.length})
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  ) : null;

  // --- GATED AUTH & ONBOARDING RENDER ---
  if (!currentAccount || !party) {
    return (
      <>
        {socialPopupBannerElement}
        <AuthLoginScreen
          currentAccount={currentAccount}
          pendingInvitations={pendingInvitations}
          onAcceptInvitation={handleAcceptInvitation}
          onDeclineInvitation={handleDeclineInvitation}
          onLoginWithEmail={handleLoginWithEmail}
          onRegisterWithEmail={handleRegisterWithEmail}
          onGoogleSignIn={handleGoogleSignIn}
          onDirectGoogleAccountSignIn={handleDirectGoogleAccountSignIn}
          onCreateHousehold={handleCreateHousehold}
          onJoinHouseholdByCode={handleJoinHouseholdByCode}
          onSignOut={handleSignOut}
        />
      </>
    );
  }

  // Derived active turn member, host, and current viewer
  const activeAssignee: HouseholdMember =
    party.members.find((m) => m.uid === party.currentTurnUserId) ||
    party.members[party.currentTurnIndex] ||
    party.members[0];

  const partyHost: HouseholdMember =
    party.members.find((m) => m.uid === party.hostId) || party.members[0];

  const activeViewer: HouseholdMember =
    party.members.find(
      (m) =>
        m.uid === currentAccount.uid ||
        m.email.toLowerCase() === currentAccount.email.toLowerCase()
    ) || partyHost;

  const isHostOrAdmin =
    activeViewer.role === 'HOST' ||
    party.hostId === currentAccount.uid ||
    currentAccount.email.toLowerCase() === OFFICIAL_BINDROP_EMAIL ||
    currentAccount.email.toLowerCase() === 'rabsraphel@gmail.com';

  const deadlineEvaluation = evaluateDeadlineStatus(party, nowMs);
  const countdown = formatCountdown(deadlineEvaluation.remainingMs);
  const pendingApprovalDrops = dropLogs.filter(
    (d) => d.verificationStatus === 'PENDING_HOST_APPROVAL'
  );
  const unreadAlertsCount = alerts.filter((a) => !a.read).length;
  const formattedPartyCode = formatSixCharInviteCode(party.inviteCode);

  // Format countdown in "14 hrs 32 mins" style matching the reference design
  const totalAbsMinutes = Math.max(
    0,
    Math.floor(Math.abs(deadlineEvaluation.remainingMs) / 60000)
  );
  const displayHrs = Math.floor(totalAbsMinutes / 60);
  const displayMins = totalAbsMinutes % 60;
  const minimalistCountdownText = countdown.isOverdue
    ? `Overdue by ${displayHrs} hrs ${displayMins} mins`
    : `${displayHrs} hrs ${displayMins} mins`;

  // Cycles Completed metric & SVG progress ring
  const cyclesCompletedValue =
    party.totalPartyDrops > 0
      ? party.totalPartyDrops
      : activeViewer.totalDrops > 0
      ? activeViewer.totalDrops
      : 0;
  const ringRadius = 38;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringProgressRatio =
    cyclesCompletedValue === 0
      ? 0.14
      : Math.min(0.95, Math.max(0.18, (cyclesCompletedValue % 20) / 20 || 0.72));
  const ringDashOffset = ringCircumference * (1 - ringProgressRatio);

  // Interactive Current Streak metrics, Milestone Progress & 5 Recent Turn Dots
  const currentStreakCount = activeViewer.currentStreak || 0;
  const bestStreakCount = Math.max(activeViewer.bestStreak || 0, currentStreakCount);
  const streakMilestones = [3, 5, 7, 10, 15, 25, 50];
  const nextStreakMilestone =
    streakMilestones.find((m) => m > currentStreakCount) ||
    Math.ceil((currentStreakCount + 1) / 10) * 10;
  const streakProgressPct = Math.min(
    100,
    Math.max(
      currentStreakCount > 0 ? 18 : 6,
      Math.round((currentStreakCount / nextStreakMilestone) * 100)
    )
  );
  const nextTurnPotentialPoints = 100 + currentStreakCount * 15;

  // Build 5 Turn Dots from real turn history + drop logs (viewer's turns first, falling back to party turns)
  const viewerHistoryRecords = historyLogs.filter(
    (h) =>
      h.userId === activeViewer.uid ||
      h.userEmail.toLowerCase() === activeViewer.email.toLowerCase()
  );
  const relevantHistoryForDots = (
    viewerHistoryRecords.length > 0 ? viewerHistoryRecords : historyLogs
  ).slice(0, 5);

  const recentTurnDots = Array.from({ length: 5 }, (_, idx) => {
    const rec = relevantHistoryForDots[4 - idx];
    if (rec) {
      if (rec.outcome === 'ON_TIME') {
        return {
          key: rec.id,
          status: 'ON_TIME' as const,
          label: `On-Time (+${rec.pointsAwarded} pts)`,
        };
      }
      if (rec.outcome === 'MISSED_DEADLINE' || rec.outcome === 'COMPLETED_LATE') {
        return {
          key: rec.id,
          status: 'MISSED' as const,
          label: rec.outcome === 'MISSED_DEADLINE' ? 'Missed Turn' : 'Completed Late',
        };
      }
      return {
        key: rec.id,
        status: 'SKIPPED' as const,
        label: 'Rotated by Host',
      };
    }
    // If no history record for this slot, light up slots up to currentStreakCount as ON_TIME
    const filledIndex = idx - (5 - Math.min(5, currentStreakCount));
    if (filledIndex >= 0 && currentStreakCount > 0) {
      return {
        key: `streak_slot_${idx}`,
        status: 'ON_TIME' as const,
        label: 'Verified Streak Turn',
      };
    }
    if (idx === 4 && pendingApprovalDrops.length > 0) {
      return {
        key: `pending_slot_${idx}`,
        status: 'PENDING' as const,
        label: 'Awaiting Host Verification',
      };
    }
    return {
      key: `empty_slot_${idx}`,
      status: 'UPCOMING' as const,
      label: 'Upcoming Turn Slot',
    };
  });

  const openHudFiveHourWarningModal = () => {
    const formattedDeadline = formatDateTimeReadable(party.nextDeadline).fullLabel;
    setHudEmailSubject(
      `⏰ 5-Hour Warning: ${activeAssignee.displayName}, trash turn due soon at ${party.name}!`
    );
    setHudEmailBody(
      `Hi ${activeAssignee.displayName}, less than 5 hours remain before your scheduled trash disposal deadline (${formattedDeadline}) for "${party.name}". Please take out the trash and upload your photo proof in BinDrop!`
    );
    setHudEmailConfirmOpen(true);
  };

  return (
    <div className="min-h-screen text-slate-100 pb-28 md:pb-14">
      {/* FACEBOOK / INSTAGRAM STYLE FLOATING SOCIAL POP-UP NOTIFICATION BANNER */}
      {socialPopupBannerElement}

      {/* Minimalist Top Bar */}
      <header className="sticky top-0 z-30 h-16 bg-[#061408]/85 backdrop-blur-xl border-b border-white/[0.06] px-5 sm:px-8 flex items-center justify-between max-w-5xl mx-auto">
        {/* Left: Clean BinDrop Wordmark */}
        <motion.a
          href="#top"
          whileTap={{ scale: 0.96 }}
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('hud');
          }}
          className="text-xl sm:text-2xl og-bold tracking-tight text-white font-display select-none"
        >
          BinDrop
        </motion.a>

        {/* Center (Desktop Only): Minimalist Pill Navigation with Sliding Indicator */}
        <nav
          aria-label="Primary Navigation"
          className="hidden md:flex items-center gap-1 p-1 rounded-full bg-[#0d1f10] border border-white/[0.08]"
        >
          {(
            [
              { id: 'hud', label: 'Duty HUD' },
              { id: 'party', label: 'Queue & Party' },
              {
                id: 'admin',
                label: 'Standings & DB',
                badge: pendingApprovalDrops.length,
              },
              { id: 'profile', label: 'Profile' },
            ] as const
          ).map((item) => {
            const isActive = activeTab === item.id;
            return (
              <motion.button
                key={item.id}
                type="button"
                whileTap={{ scale: 0.95 }}
                onClick={() => setActiveTab(item.id)}
                data-testid={
                  item.id === 'admin'
                    ? 'nav-admin-history'
                    : item.id === 'profile'
                    ? 'nav-profile'
                    : undefined
                }
                className={`relative px-4 py-1.5 rounded-full text-xs og-bold transition-colors ${
                  isActive ? 'text-[#051807]' : 'text-zinc-300 hover:text-white'
                }`}
              >
                {isActive && (
                  <motion.div
                    layoutId="desktop-nav-pill"
                    transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                    className="absolute inset-0 rounded-full bg-[#c8ff2e]"
                  />
                )}
                <span className="relative z-10 flex items-center gap-1.5">
                  {item.label}
                  {'badge' in item && item.badge > 0 && (
                    <span
                      className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                        isActive
                          ? 'bg-[#051807] text-[#c8ff2e]'
                          : 'bg-amber-400 text-[#051807]'
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </span>
              </motion.button>
            );
          })}
        </nav>

        {/* Right: App Install Helper + Notification Bell with Red Unread Dot */}
        <div className="flex items-center gap-2.5">
          <InstallPwaHeaderButton />

          <motion.button
            type="button"
            whileTap={{ scale: 0.9 }}
            data-testid="top-notification-bell-btn"
            onClick={() => {
              setIsNotifDrawerOpen((prev) => !prev);
              if (unreadAlertsCount > 0) {
                handleMarkAllAlertsRead();
              }
            }}
            aria-label="Open Notifications"
            className="relative w-10 h-10 rounded-full bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.08] flex items-center justify-center text-white transition-colors"
          >
            <Bell className="w-5 h-5 text-zinc-100" />
            <span
              className={`absolute top-2 right-2.5 w-2.5 h-2.5 rounded-full bg-rose-500 ring-2 ring-[#061408] ${
                unreadAlertsCount > 0 ? 'scale-100' : 'scale-90 opacity-90'
              }`}
            />
          </motion.button>
        </div>
      </header>

      {/* POP-UP NOTIFICATIONS DRAWER */}
      <AnimatePresence>
        {isNotifDrawerOpen && (
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Notifications Feed"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex justify-end"
          >
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 360, damping: 34 }}
              className="w-full max-w-md bg-[#071609] border-l border-white/10 h-full flex flex-col justify-between p-5 sm:p-6 space-y-4 overflow-y-auto"
            >
              <div className="space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-white/10">
                  <div className="flex items-center gap-2.5">
                    <BellRing className="w-5 h-5 text-[#c8ff2e]" />
                    <div>
                      <h2 className="text-base og-bold text-white">Notifications</h2>
                      <p className="text-[11px] text-zinc-400">
                        {party.name} · Code {formattedPartyCode}
                      </p>
                    </div>
                  </div>
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.9 }}
                    onClick={() => setIsNotifDrawerOpen(false)}
                    className="p-2 rounded-full bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </motion.button>
                </div>

                <InstallPwaBanner compact />

                <PushAlertsCard
                  userEmail={currentAccount.email}
                  userUid={currentAccount.uid}
                  userDisplayName={currentAccount.displayName}
                  partyId={party.id}
                  partyName={party.name}
                  onTriggerInAppBanner={(banner) => {
                    setIsNotifDrawerOpen(false);
                    showSocialPopupNotification({
                      id: `push_banner_${Date.now()}`,
                      partyId: party.id,
                      targetUserId: currentAccount.uid,
                      targetDisplayName: currentAccount.displayName,
                      targetEmail: currentAccount.email,
                      assigneeUserId: currentAccount.uid,
                      assigneeDisplayName: currentAccount.displayName,
                      senderName: banner.senderName,
                      senderPhotoURL: currentAccount.photoURL,
                      title: banner.title,
                      category: 'TURN_REMINDER',
                      type: 'TURN_REMINDER',
                      message: banner.message,
                      read: false,
                      createdAt: new Date().toISOString(),
                    });
                  }}
                />

                {/* Nudge Active Duty Member Action */}
                <div>
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.96 }}
                    onClick={async () => {
                      setIsNotifDrawerOpen(false);
                      await handleSendEmailReminder({
                        recipientUserId: activeAssignee.uid,
                        type: 'WARNING_5H',
                      });
                    }}
                    className="w-full py-2.5 px-4 rounded-2xl bg-white/10 hover:bg-white/15 text-[#c8ff2e] text-xs og-bold text-center flex items-center justify-center gap-2 transition-colors"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Send Turn Nudge to {activeAssignee.displayName}</span>
                  </motion.button>
                </div>

                {/* Live Alert Feed Items */}
                <div className="space-y-2.5 pt-1">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>Recent Activity ({alerts.length})</span>
                    {alerts.length > 0 && (
                      <button
                        type="button"
                        onClick={handleMarkAllAlertsRead}
                        className="text-[#c8ff2e] hover:underline og-medium flex items-center gap-1"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Mark all read</span>
                      </button>
                    )}
                  </div>

                  {alerts.length === 0 ? (
                    <div className="p-6 rounded-2xl bg-[#0b1b0d] border border-white/[0.06] text-center space-y-2">
                      <Bell className="w-6 h-6 text-[#c8ff2e] mx-auto" />
                      <p className="text-xs og-bold text-white">No Alerts Yet</p>
                      <p className="text-[11px] text-zinc-400">
                        Turn reminders, 5-hour warnings, and photo approvals appear here.
                      </p>
                    </div>
                  ) : (
                    alerts.map((item) => {
                      const dt = formatDateTimeReadable(item.createdAt);
                      const isUrgent = item.type === 'MISSED_DEADLINE';
                      return (
                        <motion.div
                          key={item.id}
                          whileTap={{ scale: 0.98 }}
                          onClick={() => showSocialPopupNotification(item)}
                          className={`p-3.5 rounded-2xl border transition-colors cursor-pointer ${
                            isUrgent
                              ? 'bg-rose-950/35 border-rose-500/40'
                              : 'bg-[#0b1b0d] border-white/10 hover:border-[#c8ff2e]/40'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-xs og-bold text-white">
                              {item.title || `Household Alert · ${item.assigneeDisplayName}`}
                            </p>
                            <span className="text-[10px] font-mono text-zinc-400 shrink-0">
                              {dt.timePart}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-300 mt-1 leading-relaxed">
                            {item.message}
                          </p>
                        </motion.div>
                      );
                    })
                  )}
                </div>
              </div>

              <motion.button
                type="button"
                whileTap={{ scale: 0.96 }}
                onClick={() => setIsNotifDrawerOpen(false)}
                className="w-full py-3 rounded-full bg-white/10 hover:bg-white/15 text-xs og-bold text-white"
              >
                Close
              </motion.button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Content Container (Mobile-focused column on phones, wider cards on desktop) */}
      <main className="relative z-10 max-w-md md:max-w-4xl mx-auto px-5 sm:px-8 pt-3 space-y-5">
        {authError && (
          <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs">
            {authError}
          </div>
        )}

        {celebrationBanner && (
          <div className="animate-celebration-burst p-3.5 rounded-full bg-[#c8ff2e] text-[#051807] og-bold text-xs sm:text-sm flex items-center justify-center gap-2 shadow-xl">
            <Sparkles className="w-4 h-4 shrink-0" />
            <span>{celebrationBanner}</span>
          </div>
        )}

        <AnimatePresence mode="wait">
          {/* TAB 1: MINIMALIST HOME DUTY HUD (Matches Reference Left Screen) */}
          {activeTab === 'hud' && (
            <motion.div
              key="tab-hud"
              initial={{ opacity: 0, y: 12, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.99 }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-4 sm:space-y-5"
            >
              {/* 1. Greeting Header Row ("Hello, <Name>" + Circular Lime-Ringed Avatar) */}
              <div className="flex items-center justify-between gap-4 pt-1">
                <div className="min-w-0">
                  <p className="text-base sm:text-lg text-zinc-400 og-regular leading-snug">
                    Hello,
                  </p>
                  <h1 className="text-3xl sm:text-4xl og-bold text-white tracking-tight truncate">
                    {activeViewer.displayName}
                  </h1>
                </div>

                <motion.button
                  type="button"
                  whileTap={{ scale: 0.92 }}
                  onClick={() => setActiveTab('profile')}
                  data-testid="top-profile-trigger"
                  aria-label="Open Profile"
                  className="rounded-full p-0.5 ring-2 ring-[#c8ff2e] shadow-[0_0_20px_rgba(200,255,46,0.22)] shrink-0"
                >
                  <MemberAvatar member={activeViewer} size="md" />
                </motion.button>
              </div>

              {/* Dedicated Android & iOS Browser Install Prompt (Auto-hides once installed) */}
              <InstallPwaBanner compact />

              {/* Compact Overdue Alert Strip (Only shown if turn is overdue) */}
              {(party.turnStatus === 'OVERDUE' ||
                deadlineEvaluation.status === 'OVERDUE') && (
                <div
                  data-testid="host-escalation-banner"
                  className="p-4 rounded-[24px] bg-rose-950/60 border border-rose-500/50 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs sm:text-sm og-bold text-white truncate">
                        Overdue Turn · {activeAssignee.displayName}
                      </p>
                      <p className="text-[11px] text-rose-200/80 truncate">
                        Upload trash photo now to rotate duty
                      </p>
                    </div>
                  </div>
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setIsScannerOpen(true)}
                    className="px-3.5 py-2 rounded-full bg-rose-500 text-slate-950 og-bold text-xs shrink-0"
                  >
                    Upload Now
                  </motion.button>
                </div>
              )}

              {/* Compact Pending Host Photo Verification Card (Only shown when a photo awaits Host review) */}
              {pendingApprovalDrops.length > 0 && (
                <div
                  data-testid="hud-pending-host-verification-card"
                  className="bento-stat-card rounded-[24px] p-4 border border-amber-400/45 space-y-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="px-2.5 py-0.5 rounded-full bg-amber-400 text-[#051807] text-[11px] og-bold">
                      {pendingApprovalDrops.length} Photo Awaiting Verification
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveTab('admin')}
                      className="text-xs og-medium text-[#c8ff2e] hover:underline"
                    >
                      View All →
                    </button>
                  </div>

                  {pendingApprovalDrops.slice(0, 2).map((drop) => (
                    <div
                      key={drop.id}
                      className="flex items-center justify-between gap-3 pt-1"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <img
                          src={
                            drop.imageUrl ||
                            generateSimulatedTrashSceneDataUrl({
                              memberName: drop.userDisplayName,
                              variant: 'valid_bag_in_bin',
                            })
                          }
                          alt={drop.userDisplayName}
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
                          className="w-12 h-12 rounded-2xl object-cover border border-white/15 shrink-0"
                        />
                        <div className="min-w-0">
                          <p className="text-xs sm:text-sm og-bold text-white truncate">
                            {drop.userDisplayName}
                          </p>
                          <p className="text-[11px] text-zinc-400 truncate">
                            {drop.locationNote}
                          </p>
                        </div>
                      </div>

                      {isHostOrAdmin ? (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <motion.button
                            type="button"
                            whileTap={{ scale: 0.94 }}
                            disabled={isVerifyingDropId === drop.id}
                            data-testid={`hud-approve-drop-${drop.id}`}
                            onClick={() =>
                              handleHostVerifyDrop({
                                dropId: drop.id,
                                decision: 'APPROVE',
                              })
                            }
                            className="px-3 py-1.5 rounded-full bg-[#c8ff2e] text-[#051807] text-xs og-bold"
                          >
                            Approve
                          </motion.button>
                          <motion.button
                            type="button"
                            whileTap={{ scale: 0.94 }}
                            disabled={isVerifyingDropId === drop.id}
                            data-testid={`hud-reject-drop-${drop.id}`}
                            onClick={() =>
                              handleHostVerifyDrop({
                                dropId: drop.id,
                                decision: 'REJECT',
                              })
                            }
                            className="px-2.5 py-1.5 rounded-full bg-rose-500/20 text-rose-300 text-xs og-medium"
                          >
                            Reject
                          </motion.button>
                        </div>
                      ) : (
                        <span className="text-[11px] font-mono text-amber-300 shrink-0">
                          Pending Host
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Responsive Main Grid: Mobile Single Stack, Desktop Wider 2-Column Layout */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-4 sm:gap-5 items-stretch">
                {/* Left Column on Desktop (7 cols) / Top on Mobile: Duty HUD Hero Card */}
                <div className="md:col-span-7 flex flex-col justify-between gap-4 sm:gap-5">
                  <motion.div
                    whileTap={{ scale: 0.99 }}
                    onClick={() => setActiveTab('party')}
                    className="duty-hud-card rounded-[26px] p-5 sm:p-6 cursor-pointer space-y-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-lg sm:text-xl og-bold text-white tracking-tight">
                        Duty HUD
                      </h2>
                      <span className="px-3 py-1 rounded-full bg-[#2e4015]/90 border border-[#c8ff2e]/40 text-[#c8ff2e] text-xs og-medium">
                        Trash Duty
                      </span>
                    </div>

                    <div className="space-y-0.5">
                      <p className="text-xs sm:text-sm text-zinc-300/90 og-regular">
                        Next collection in:
                      </p>
                      <div
                        data-testid="turn-countdown-timer"
                        className={`text-3xl sm:text-4xl og-bold tracking-tight tabular-nums ${
                          countdown.isOverdue ? 'text-rose-400' : 'text-[#efc96b]'
                        }`}
                      >
                        {minimalistCountdownText}
                      </div>
                    </div>

                    <div className="pt-2 border-t border-white/[0.08] flex items-center justify-between text-xs text-zinc-300/90">
                      <span className="truncate">
                        On duty:{' '}
                        <strong
                          data-testid="active-turn-assignee"
                          className="text-white og-bold"
                        >
                          {activeAssignee.displayName}
                        </strong>
                      </span>
                      <span className="font-mono text-[#c8ff2e] shrink-0">
                        Code: {formattedPartyCode}
                      </span>
                    </div>
                  </motion.div>

                  {/* Upload Action Card on Desktop (Shown here on md+, and below Bento on mobile) */}
                  <div className="hidden md:flex bento-stat-card rounded-[28px] p-6 flex-col items-center justify-center gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-[#c8ff2e]/20 border border-[#c8ff2e]/50 shadow-[0_0_28px_rgba(200,255,46,0.35)] flex items-center justify-center text-[#c8ff2e]">
                      <svg
                        className="w-6 h-6"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 6h18" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                    </div>

                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.96 }}
                      onClick={() => setIsScannerOpen(true)}
                      className="lime-cta w-full py-4 px-6 rounded-full og-bold text-base flex items-center justify-center gap-2.5 min-h-[54px]"
                    >
                      <Camera className="w-5 h-5" />
                      <span>Upload Trash Photo</span>
                    </motion.button>
                  </div>
                </div>

                {/* Right Column on Desktop (5 cols) / Middle on Mobile: 2-Column Bento Stats Row */}
                <div className="md:col-span-5 flex flex-col justify-between gap-4 sm:gap-5">
                  <div className="grid grid-cols-2 gap-3.5 sm:gap-4">
                    {/* Left Bento Card: Cycles Completed (Circular SVG Progress Ring) */}
                    <motion.div
                      whileTap={{ scale: 0.97 }}
                      onClick={() => setActiveTab('admin')}
                      className="bento-stat-card rounded-[26px] p-4 sm:p-5 flex flex-col justify-between min-h-[178px] sm:min-h-[196px] cursor-pointer"
                    >
                      <span className="text-xs sm:text-sm og-medium text-zinc-200">
                        Cycles Completed
                      </span>

                      <div className="relative w-24 h-24 sm:w-28 sm:h-28 mx-auto my-auto flex items-center justify-center">
                        <svg
                          className="w-full h-full -rotate-90"
                          viewBox="0 0 96 96"
                        >
                          <circle
                            cx="48"
                            cy="48"
                            r={ringRadius}
                            fill="none"
                            stroke="rgba(255, 255, 255, 0.08)"
                            strokeWidth="8"
                          />
                          <motion.circle
                            cx="48"
                            cy="48"
                            r={ringRadius}
                            fill="none"
                            stroke="#c8ff2e"
                            strokeWidth="8"
                            strokeLinecap="round"
                            strokeDasharray={ringCircumference}
                            initial={{ strokeDashoffset: ringCircumference }}
                            animate={{ strokeDashoffset: ringDashOffset }}
                            transition={{
                              duration: 0.75,
                              ease: [0.22, 1, 0.36, 1],
                            }}
                          />
                        </svg>
                        <span className="absolute text-2xl sm:text-3xl og-bold text-white tabular-nums">
                          {cyclesCompletedValue}
                        </span>
                      </div>
                    </motion.div>

                    {/* Right Bento Card: Current Streak (Interactive Flame Counter + Milestone Progress + Turn Dots) */}
                    <motion.div
                      whileTap={{ scale: 0.96 }}
                      onClick={() => setIsStreakSheetOpen(true)}
                      data-testid="hud-current-streak-card"
                      className="bento-stat-card rounded-[26px] p-4 sm:p-5 flex flex-col justify-between min-h-[178px] sm:min-h-[196px] cursor-pointer overflow-hidden"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs sm:text-sm og-medium text-zinc-200">
                          Current Streak
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-[#c8ff2e]/15 border border-[#c8ff2e]/30 text-[10px] font-mono og-bold text-[#c8ff2e]">
                          Best {bestStreakCount}x
                        </span>
                      </div>

                      {/* Center Interactive Flame Counter */}
                      <div className="flex items-center gap-3 my-auto py-1">
                        <motion.div
                          key={currentStreakCount}
                          initial={{ scale: 0.85, rotate: -8 }}
                          animate={{ scale: 1, rotate: 0 }}
                          transition={{ type: 'spring', stiffness: 420, damping: 22 }}
                          className={`w-12 h-12 sm:w-13 sm:h-13 rounded-2xl flex items-center justify-center shrink-0 border ${
                            currentStreakCount > 0
                              ? 'bg-[#c8ff2e]/20 border-[#c8ff2e]/55 text-[#c8ff2e] shadow-[0_0_24px_rgba(200,255,46,0.28)]'
                              : 'bg-white/[0.05] border-white/10 text-zinc-400'
                          }`}
                        >
                          <Flame
                            className={`w-6 h-6 ${
                              currentStreakCount > 0 ? 'fill-[#c8ff2e]/30 text-[#c8ff2e]' : ''
                            }`}
                          />
                        </motion.div>

                        <div className="min-w-0">
                          <div className="flex items-baseline gap-1">
                            <span
                              data-testid="hud-streak-counter-value"
                              className="text-2xl sm:text-3xl og-bold text-white tabular-nums leading-none"
                            >
                              {currentStreakCount}
                            </span>
                            <span className="text-xs font-mono og-bold text-[#c8ff2e]">
                              {currentStreakCount === 1 ? 'turn' : 'turns'}
                            </span>
                          </div>
                          <p className="text-[11px] text-zinc-400 truncate mt-1">
                            {currentStreakCount > 0
                              ? `+${currentStreakCount * 15} streak bonus pts`
                              : 'Complete on time to ignite'}
                          </p>
                        </div>
                      </div>

                      {/* Milestone Progress Bar + 5 Recent Turn Dots */}
                      <div className="space-y-2 pt-1">
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                            <span>Milestone Goal</span>
                            <span className="text-[#c8ff2e] og-bold">
                              {currentStreakCount}/{nextStreakMilestone}x
                            </span>
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
                            <motion.div
                              initial={{ width: 0 }}
                              animate={{ width: `${streakProgressPct}%` }}
                              transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
                              className="h-full rounded-full bg-[#c8ff2e]"
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-0.5">
                          <div className="flex items-center gap-1.5">
                            {recentTurnDots.map((dot) => (
                              <span
                                key={dot.key}
                                title={dot.label}
                                className={`w-2.5 h-2.5 rounded-full transition-all ${
                                  dot.status === 'ON_TIME'
                                    ? 'bg-[#c8ff2e] shadow-[0_0_8px_rgba(200,255,46,0.65)]'
                                    : dot.status === 'PENDING'
                                    ? 'bg-amber-400'
                                    : dot.status === 'MISSED'
                                    ? 'bg-rose-400'
                                    : 'bg-white/15'
                                }`}
                              />
                            ))}
                          </div>
                          <span className="text-[10px] text-zinc-400 og-medium">
                            Details →
                          </span>
                        </div>
                      </div>
                    </motion.div>
                  </div>

                  {/* Desktop Quick Household Queue & Invite Code Card (Visible on md+ wider layout) */}
                  <div className="hidden md:flex bento-stat-card rounded-[26px] p-5 flex-col justify-between gap-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm og-bold text-white">{party.name}</p>
                        <p className="text-xs text-zinc-400">
                          {party.members.length} members ·{' '}
                          {formatRotationDaysLabel(party.rotationIntervalHours)}
                        </p>
                      </div>
                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.95 }}
                        onClick={() => {
                          navigator.clipboard?.writeText(formattedPartyCode).catch(() => {});
                          setCelebrationBanner(`Copied 6-Char Invite Code: ${formattedPartyCode}`);
                          setTimeout(() => setCelebrationBanner(null), 2500);
                        }}
                        className="px-3 py-1.5 rounded-full bg-[#162a18] border border-[#c8ff2e]/35 text-xs font-mono og-bold text-[#c8ff2e] flex items-center gap-1.5"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        <span>{formattedPartyCode}</span>
                      </motion.button>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-white/[0.06] text-xs">
                      <button
                        type="button"
                        onClick={() => setActiveTab('party')}
                        className="text-zinc-300 hover:text-white og-medium"
                      >
                        Manage Queue &amp; Invites →
                      </button>
                      <button
                        type="button"
                        onClick={openHudFiveHourWarningModal}
                        className="text-[#c8ff2e] hover:underline og-medium"
                      >
                        Nudge Duty
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* 3. Mobile Upload Action Card (Matches Reference Bottom Card above Dock) */}
              <div className="md:hidden bento-stat-card rounded-[28px] p-5 flex flex-col items-center justify-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-[#c8ff2e]/20 border border-[#c8ff2e]/50 shadow-[0_0_28px_rgba(200,255,46,0.35)] flex items-center justify-center text-[#c8ff2e]">
                  <svg
                    className="w-6 h-6"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 6h18" />
                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                </div>

                <motion.button
                  type="button"
                  whileTap={{ scale: 0.96 }}
                  onClick={() => setIsScannerOpen(true)}
                  data-testid="hud-open-photo-modal-btn"
                  className="lime-cta w-full py-4 px-6 rounded-full og-bold text-base flex items-center justify-center gap-2.5 min-h-[54px]"
                >
                  <Camera className="w-5 h-5" />
                  <span>Upload Trash Photo</span>
                </motion.button>
              </div>
            </motion.div>
          )}

          {/* TAB 2: STANDINGS, HOST PHOTO VERIFICATION & HISTORY (Trophy Icon) */}
          {activeTab === 'admin' && (
            <motion.div
              key="tab-admin"
              initial={{ opacity: 0, y: 12, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.99 }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            >
              <AdminDashboardView
                party={party}
                dropLogs={dropLogs}
                historyLogs={historyLogs}
                emailLogs={emailLogs}
                nowMs={nowMs}
                isHostOrAdmin={isHostOrAdmin}
                mailerStatus={mailerStatus}
                onSaveAppPassword={handleSaveAppPassword}
                onSendEmailReminder={handleSendEmailReminder}
                onHostVerifyDrop={({ dropId, decision, hostNote }) =>
                  handleHostVerifyDrop({ dropId, decision, hostReviewNote: hostNote })
                }
                onUpdateTurnDeadline={handleUpdateTurnDeadline}
                onOpenScanner={() => setIsScannerOpen(true)}
              />
            </motion.div>
          )}

          {/* TAB 3: QUEUE, 6-CHAR INVITE CODE & PARTY SETUP (Grid Icon) */}
          {activeTab === 'party' && (
            <motion.div
              key="tab-party"
              initial={{ opacity: 0, y: 12, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.99 }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            >
              <PartyManagerView
                party={party}
                currentUserId={activeViewer.uid}
                isHostOrAdmin={isHostOrAdmin}
                partyInvitations={partyInvitations}
                onCreateParty={handleCreateHousehold}
                onJoinExistingPartyByCode={handleJoinHouseholdByCode}
                onAddRoommateWithEmail={handleAddRoommateWithEmail}
                onUpdateRotationIntervalHours={handleUpdateRotationIntervalHours}
                onHostSkipTurn={handleHostSkipTurn}
                onNudgeActiveAssignee={openHudFiveHourWarningModal}
                onLeaveParty={handleLeaveParty}
                onDeleteParty={handleDeleteParty}
              />
            </motion.div>
          )}

          {/* TAB 4: PROFILE, PUSH ALERTS & APP INSTALL (User Icon) */}
          {activeTab === 'profile' && (
            <motion.div
              key="tab-profile"
              initial={{ opacity: 0, y: 12, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.99 }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            >
              <ProfileAccountView
                activeViewer={activeViewer}
                partyId={party.id}
                partyName={party.name}
                firebaseUser={firebaseUser}
                onUpdateProfile={handleUpdateProfile}
                onGoogleSignIn={handleGoogleSignIn}
                onSignOut={handleSignOut}
                onBackToHud={() => setActiveTab('hud')}
                onTriggerInAppBanner={(banner) => {
                  showSocialPopupNotification({
                    id: `profile_push_banner_${Date.now()}`,
                    partyId: party.id,
                    targetUserId: currentAccount.uid,
                    targetDisplayName: currentAccount.displayName,
                    targetEmail: currentAccount.email,
                    assigneeUserId: currentAccount.uid,
                    assigneeDisplayName: currentAccount.displayName,
                    senderName: banner.senderName,
                    senderPhotoURL: currentAccount.photoURL,
                    title: banner.title,
                    category: 'TURN_REMINDER',
                    type: 'TURN_REMINDER',
                    message: banner.message,
                    read: false,
                    createdAt: new Date().toISOString(),
                  });
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* HUD Instant Pop-Up Notification Modal */}
      <AnimatePresence>
        {hudEmailConfirmOpen && (
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md"
          >
            <motion.div
              initial={{ scale: 0.95, y: 14 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 14 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="glass-panel-elevated w-full max-w-lg rounded-[32px] p-6 space-y-4 border border-[#c8ff2e]/35 max-h-[92vh] overflow-y-auto"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-xs font-mono text-[#c8ff2e]">
                    Live Pop-Up &amp; Push Alert · {party.name}
                  </span>
                  <h3 className="text-lg og-bold text-white mt-0.5">
                    Send Pop-Up Alert to {activeAssignee.displayName}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setHudEmailConfirmOpen(false)}
                  className="p-2 rounded-full bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-1">
                <label className="block text-xs og-medium text-zinc-300">Pop-Up Title</label>
                <input
                  type="text"
                  value={hudEmailSubject}
                  onChange={(e) => setHudEmailSubject(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#07190a] border border-white/15 text-xs text-white focus:outline-none focus:border-[#c8ff2e]"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-xs og-medium text-zinc-300">Pop-Up Message</label>
                <textarea
                  rows={4}
                  value={hudEmailBody}
                  onChange={(e) => setHudEmailBody(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#07190a] border border-white/15 text-xs text-white font-sans focus:outline-none focus:border-[#c8ff2e]"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setHudEmailConfirmOpen(false)}
                  className="px-4 py-2.5 rounded-full bg-white/5 hover:bg-white/10 text-xs og-medium text-zinc-300"
                >
                  Cancel
                </button>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.96 }}
                  disabled={isSendingHudEmail}
                  data-testid="confirm-hud-send-email-btn"
                  onClick={async () => {
                    setIsSendingHudEmail(true);
                    try {
                      const result = await handleSendEmailReminder({
                        recipientUserId: activeAssignee.uid,
                        type: 'WARNING_5H',
                        customSubject: hudEmailSubject,
                        customMessage: hudEmailBody,
                      });
                      if (result.deliveredViaGmail) {
                        setHudEmailConfirmOpen(false);
                      } else if (result.error) {
                        setAuthError(result.error);
                      }
                    } finally {
                      setIsSendingHudEmail(false);
                    }
                  }}
                  className="lime-cta px-5 py-2.5 rounded-full text-xs og-bold flex items-center gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>
                    {isSendingHudEmail
                      ? 'Sending...'
                      : `Send Pop-Up to ${activeAssignee.displayName}`}
                  </span>
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* INTERACTIVE STREAK BREAKDOWN SHEET MODAL */}
      <AnimatePresence>
        {isStreakSheetOpen && (
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Current Streak Breakdown"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsStreakSheetOpen(false)}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/80 backdrop-blur-md"
          >
            <motion.div
              initial={{ y: 48, scale: 0.97 }}
              animate={{ y: 0, scale: 1 }}
              exit={{ y: 48, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              onClick={(e) => e.stopPropagation()}
              data-testid="streak-breakdown-sheet"
              className="w-full max-w-lg rounded-t-[32px] sm:rounded-[32px] bg-[#091a0b] border border-white/12 p-6 space-y-5 max-h-[88vh] overflow-y-auto shadow-[0_24px_70px_rgba(0,0,0,0.92)]"
            >
              {/* Top Header */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-2xl bg-[#c8ff2e]/20 border border-[#c8ff2e]/50 flex items-center justify-center text-[#c8ff2e] shrink-0">
                    <Flame className="w-6 h-6 fill-[#c8ff2e]/30" />
                  </div>
                  <div>
                    <span className="text-[11px] font-mono uppercase tracking-wider text-[#c8ff2e] og-bold">
                      {activeViewer.displayName} · Streak Breakdown
                    </span>
                    <h3 className="text-xl og-bold text-white">
                      {currentStreakCount} Turn On-Time Streak
                    </h3>
                  </div>
                </div>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.9 }}
                  onClick={() => setIsStreakSheetOpen(false)}
                  aria-label="Close Streak Sheet"
                  className="p-2 rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-zinc-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </motion.button>
              </div>

              {/* 4-Stat KPI Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="p-3.5 rounded-2xl bg-[#0f2412] border border-[#c8ff2e]/30">
                  <span className="text-[10px] font-mono uppercase text-zinc-400 block">
                    Current Streak
                  </span>
                  <span className="text-lg og-bold text-[#c8ff2e] font-mono tabular-nums mt-0.5 block">
                    {currentStreakCount}x
                  </span>
                </div>
                <div className="p-3.5 rounded-2xl bg-white/[0.04] border border-white/[0.08]">
                  <span className="text-[10px] font-mono uppercase text-zinc-400 block">
                    Best Streak
                  </span>
                  <span className="text-lg og-bold text-white font-mono tabular-nums mt-0.5 block">
                    {bestStreakCount}x
                  </span>
                </div>
                <div className="p-3.5 rounded-2xl bg-white/[0.04] border border-white/[0.08]">
                  <span className="text-[10px] font-mono uppercase text-zinc-400 block">
                    On-Time Rate
                  </span>
                  <span className="text-lg og-bold text-white font-mono tabular-nums mt-0.5 block">
                    {activeViewer.onTimeRate}%
                  </span>
                </div>
                <div className="p-3.5 rounded-2xl bg-white/[0.04] border border-white/[0.08]">
                  <span className="text-[10px] font-mono uppercase text-zinc-400 block">
                    Total Points
                  </span>
                  <span className="text-lg og-bold text-[#c8ff2e] font-mono tabular-nums mt-0.5 block">
                    {activeViewer.points}
                  </span>
                </div>
              </div>

              {/* Milestone Progress & Bonus Multiplier Card */}
              <div className="p-4 rounded-2xl bg-[#0d2010] border border-white/10 space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="og-bold text-white">
                    Next Milestone: {nextStreakMilestone}x Streak
                  </span>
                  <span className="font-mono text-[#c8ff2e] og-bold">
                    +{nextTurnPotentialPoints} pts on next on-time drop
                  </span>
                </div>
                <div className="w-full h-2 rounded-full bg-black/40 overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${streakProgressPct}%` }}
                    transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                    className="h-full rounded-full bg-[#c8ff2e]"
                  />
                </div>
                <p className="text-[11px] text-zinc-400">
                  Every verified on-time trash drop awards <strong className="text-white">+100 base pts</strong> plus <strong className="text-[#c8ff2e]">+15 pts per consecutive streak turn</strong>.
                </p>
              </div>

              {/* Recent Turns Timeline */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="og-bold text-white">Recent Turn Activity</span>
                  <span className="text-zinc-400 font-mono">
                    {historyLogs.length} logged turns
                  </span>
                </div>

                {historyLogs.length === 0 ? (
                  <div className="p-5 rounded-2xl bg-white/[0.03] border border-white/[0.07] text-center space-y-1.5">
                    <p className="text-xs og-bold text-white">No Turns Logged Yet</p>
                    <p className="text-[11px] text-zinc-400">
                      Upload a trash disposal photo before the deadline to start your streak!
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                    {historyLogs.slice(0, 6).map((rec) => {
                      const dt = formatDateTimeReadable(rec.recordedIso);
                      const isOnTime = rec.outcome === 'ON_TIME';
                      const isMissed =
                        rec.outcome === 'MISSED_DEADLINE' ||
                        rec.outcome === 'COMPLETED_LATE';
                      return (
                        <div
                          key={rec.id}
                          className="p-3 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-between gap-3"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span
                              className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                                isOnTime
                                  ? 'bg-[#c8ff2e]'
                                  : isMissed
                                  ? 'bg-rose-400'
                                  : 'bg-zinc-500'
                              }`}
                            />
                            <div className="min-w-0">
                              <p className="text-xs og-bold text-white truncate">
                                {rec.userDisplayName}
                              </p>
                              <p className="text-[11px] text-zinc-400 font-mono truncate">
                                {dt.datePart} · {dt.timePart}
                              </p>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <span
                              className={`text-xs font-mono og-bold ${
                                isOnTime
                                  ? 'text-[#c8ff2e]'
                                  : isMissed
                                  ? 'text-rose-400'
                                  : 'text-zinc-400'
                              }`}
                            >
                              {isOnTime
                                ? `+${rec.pointsAwarded} pts`
                                : isMissed
                                ? 'Missed'
                                : 'Skipped'}
                            </span>
                            <span className="block text-[10px] text-zinc-400 font-mono">
                              {rec.outcome.replace(/_/g, ' ')}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.96 }}
                  onClick={() => {
                    setIsStreakSheetOpen(false);
                    setActiveTab('admin');
                  }}
                  className="py-3 px-4 rounded-full bg-white/[0.08] hover:bg-white/[0.14] text-xs og-bold text-white"
                >
                  Full Standings
                </motion.button>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.96 }}
                  onClick={() => {
                    setIsStreakSheetOpen(false);
                    setIsScannerOpen(true);
                  }}
                  className="lime-cta py-3 px-4 rounded-full text-xs og-bold flex items-center justify-center gap-1.5"
                >
                  <Camera className="w-4 h-4" />
                  <span>Upload Photo</span>
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 5-SLOT MINIMALIST MOBILE BOTTOM NAVIGATION DOCK (Matches Reference Image) */}
      <nav
        aria-label="Mobile Navigation"
        className="md:hidden fixed bottom-0 inset-x-0 z-30 h-20 bg-[#0d1c0f]/95 backdrop-blur-2xl border-t border-white/[0.08] px-6 flex items-center justify-between"
      >
        {/* Slot 1: Home (Duty HUD) */}
        <motion.button
          type="button"
          whileTap={{ scale: 0.88 }}
          onClick={() => setActiveTab('hud')}
          aria-label="Home Duty HUD"
          className="relative h-full w-14 flex flex-col items-center justify-center"
        >
          {activeTab === 'hud' && (
            <motion.div
              layoutId="mobile-dock-top-bar"
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              className="absolute top-0 w-10 h-[3px] rounded-full bg-[#c8ff2e]"
            />
          )}
          <Home
            className={`w-6 h-6 transition-colors ${
              activeTab === 'hud' ? 'text-[#c8ff2e]' : 'text-zinc-500'
            }`}
          />
          {activeTab === 'hud' && (
            <span className="w-1.5 h-1.5 rounded-full bg-[#c8ff2e] mt-1.5" />
          )}
        </motion.button>

        {/* Slot 2: Queue & Household Party (4-Square Grid Icon) */}
        <motion.button
          type="button"
          whileTap={{ scale: 0.88 }}
          onClick={() => setActiveTab('party')}
          aria-label="Household Queue and Invite Code"
          className="relative h-full w-14 flex flex-col items-center justify-center"
        >
          {activeTab === 'party' && (
            <motion.div
              layoutId="mobile-dock-top-bar"
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              className="absolute top-0 w-10 h-[3px] rounded-full bg-[#c8ff2e]"
            />
          )}
          <LayoutGrid
            className={`w-6 h-6 transition-colors ${
              activeTab === 'party' ? 'text-[#c8ff2e]' : 'text-zinc-500'
            }`}
          />
          {activeTab === 'party' && (
            <span className="w-1.5 h-1.5 rounded-full bg-[#c8ff2e] mt-1.5" />
          )}
        </motion.button>

        {/* Slot 3: Raised Center Circular Lime Camera CTA */}
        <div className="relative -top-5 flex items-center justify-center">
          <motion.button
            type="button"
            whileTap={{ scale: 0.9 }}
            onClick={() => setIsScannerOpen(true)}
            aria-label="Open Duty Photo Upload Camera"
            className="w-15 h-15 rounded-full bg-[#c8ff2e] text-[#051807] border-[5px] border-[#061408] shadow-[0_8px_28px_rgba(200,255,46,0.45)] flex items-center justify-center"
          >
            <Camera className="w-6 h-6 stroke-[2.3]" />
          </motion.button>
        </div>

        {/* Slot 4: Standings & Photo History (Trophy Icon) */}
        <motion.button
          type="button"
          whileTap={{ scale: 0.88 }}
          onClick={() => setActiveTab('admin')}
          aria-label="Standings and Photo Verification"
          className="relative h-full w-14 flex flex-col items-center justify-center"
        >
          {activeTab === 'admin' && (
            <motion.div
              layoutId="mobile-dock-top-bar"
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              className="absolute top-0 w-10 h-[3px] rounded-full bg-[#c8ff2e]"
            />
          )}
          <Trophy
            className={`w-6 h-6 transition-colors ${
              activeTab === 'admin' ? 'text-[#c8ff2e]' : 'text-zinc-500'
            }`}
          />
          {pendingApprovalDrops.length > 0 && (
            <span className="absolute top-3.5 right-2.5 w-2.5 h-2.5 rounded-full bg-amber-400 ring-2 ring-[#0d1c0f]" />
          )}
          {activeTab === 'admin' && (
            <span className="w-1.5 h-1.5 rounded-full bg-[#c8ff2e] mt-1.5" />
          )}
        </motion.button>

        {/* Slot 5: Profile & Settings (User Icon) */}
        <motion.button
          type="button"
          whileTap={{ scale: 0.88 }}
          onClick={() => setActiveTab('profile')}
          aria-label="Profile and Settings"
          className="relative h-full w-14 flex flex-col items-center justify-center"
        >
          {activeTab === 'profile' && (
            <motion.div
              layoutId="mobile-dock-top-bar"
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              className="absolute top-0 w-10 h-[3px] rounded-full bg-[#c8ff2e]"
            />
          )}
          <UserIcon
            className={`w-6 h-6 transition-colors ${
              activeTab === 'profile' ? 'text-[#c8ff2e]' : 'text-zinc-500'
            }`}
          />
          {activeTab === 'profile' && (
            <span className="w-1.5 h-1.5 rounded-full bg-[#c8ff2e] mt-1.5" />
          )}
        </motion.button>
      </nav>

      {/* Full-Screen Duty Photo Upload Camera Viewfinder Modal */}
      <VisionScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        activeAssignee={
          (currentAccount &&
            party.members.find(
              (m) =>
                m.uid === currentAccount.uid ||
                m.email.toLowerCase() === currentAccount.email.toLowerCase()
            )) ||
          activeAssignee
        }
        isOverdue={countdown.isOverdue}
        isHostOrAdmin={isHostOrAdmin}
        rotationIntervalHours={party.rotationIntervalHours}
        onSubmitTrashPhoto={handleUploadTrashPhoto}
      />
    </div>
  );
}
