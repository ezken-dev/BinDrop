/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
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
} from 'lucide-react';
import { type User } from 'firebase/auth';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  auth,
  db,
  googleSignIn,
  initAuth,
  signOutUser,
} from './firebase';
import {
  evaluateDeadlineStatus,
  formatCountdown,
  formatDateTimeReadable,
  formatRotationDaysLabel,
  OFFICIAL_BINDROP_EMAIL,
  OFFICIAL_BINDROP_NAME,
  ROTATION_DAY_OPTIONS,
  type EmailAlertType,
  type EmailDispatchLog,
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
import { apiFetch } from './utils/apiClient';

type ActiveTab = 'hud' | 'admin' | 'party' | 'profile';

const SESSION_STORAGE_KEY = 'bindrop_authenticated_account_v4';

interface PartyBundlePayload {
  party: PartyState;
  drops: TrashDropLog[];
  history: TurnHistoryRecord[];
  emails: EmailDispatchLog[];
  alerts: PartyAlertItem[];
  mailerStatus?: OfficialMailerStatus;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('hud');
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [celebrationBanner, setCelebrationBanner] = useState<string | null>(null);
  const [isVerifyingDropId, setIsVerifyingDropId] = useState<string | null>(null);
  const [mailerStatus, setMailerStatus] = useState<OfficialMailerStatus | null>(null);
  const [hudAppPasswordInput, setHudAppPasswordInput] = useState('');
  const [isSavingHudAppPassword, setIsSavingHudAppPassword] = useState(false);

  // HUD Email Confirmation Modal state
  const [hudEmailConfirmOpen, setHudEmailConfirmOpen] = useState(false);
  const [hudEmailSubject, setHudEmailSubject] = useState('');
  const [hudEmailBody, setHudEmailBody] = useState('');
  const [isSendingHudEmail, setIsSendingHudEmail] = useState(false);

  const [currentAccount, setCurrentAccount] = useState<AuthenticatedAccount | null>(() => {
    try {
      const saved = localStorage.getItem(SESSION_STORAGE_KEY);
      if (saved) return JSON.parse(saved) as AuthenticatedAccount;
    } catch {
      // ignore storage errors
    }
    return null;
  });

  const [party, setParty] = useState<PartyState | null>(null);
  const [dropLogs, setDropLogs] = useState<TrashDropLog[]>([]);
  const [historyLogs, setHistoryLogs] = useState<TurnHistoryRecord[]>([]);
  const [emailLogs, setEmailLogs] = useState<EmailDispatchLog[]>([]);
  const [, setAlerts] = useState<PartyAlertItem[]>([]);

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

  const applyServerBundle = useCallback((bundle: PartyBundlePayload | null) => {
    if (!bundle || !bundle.party) {
      setParty(null);
      setDropLogs([]);
      setHistoryLogs([]);
      setEmailLogs([]);
      setAlerts([]);
      return;
    }
    setParty(bundle.party);
    setDropLogs(bundle.drops || []);
    setHistoryLogs(bundle.history || []);
    setEmailLogs(bundle.emails || []);
    setAlerts(bundle.alerts || []);
    if (bundle.mailerStatus) {
      setMailerStatus(bundle.mailerStatus);
    }
  }, []);

  // Sync with Firebase Firestore when Firebase Auth user is active
  const syncPartyToFirestore = useCallback(
    async (
      updatedParty: PartyState,
      newDrop?: TrashDropLog,
      newHistory?: TurnHistoryRecord
    ) => {
      if (!auth.currentUser) return;
      const uid = auth.currentUser.uid;
      try {
        await setDoc(
          doc(db, 'parties', updatedParty.id),
          {
            id: updatedParty.id,
            name: updatedParty.name,
            inviteCode: updatedParty.inviteCode,
            hostId: updatedParty.hostId,
            memberIds: updatedParty.memberIds,
            currentTurnIndex: updatedParty.currentTurnIndex,
            currentTurnUserId: updatedParty.currentTurnUserId,
            turnStatus: updatedParty.turnStatus,
            nextDeadline: updatedParty.nextDeadline,
            rotationIntervalHours: updatedParty.rotationIntervalHours,
            warningEmailSentForCurrentTurn: Boolean(
              updatedParty.warningEmailSentForCurrentTurn
            ),
            missedEmailSentForCurrentTurn: Boolean(
              updatedParty.missedEmailSentForCurrentTurn
            ),
            hostAlertedForCurrentTurn: Boolean(updatedParty.hostAlertedForCurrentTurn),
            totalPartyDrops: updatedParty.totalPartyDrops,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );

        if (newDrop && newDrop.userId === uid) {
          await setDoc(doc(db, 'parties', updatedParty.id, 'drops', newDrop.id), {
            id: newDrop.id,
            partyId: updatedParty.id,
            userId: uid,
            userDisplayName: newDrop.userDisplayName,
            imageUrl: newDrop.imageUrl,
            verified: newDrop.verified,
            verificationStatus: newDrop.verificationStatus,
            locationNote: newDrop.locationNote,
            pointsAwarded: newDrop.pointsAwarded,
            completedOnTime: newDrop.completedOnTime,
            deadlineIso: newDrop.deadlineIso,
            submittedIso: newDrop.submittedIso,
            createdAt: serverTimestamp(),
          });
        }

        if (newHistory) {
          await setDoc(doc(db, 'parties', updatedParty.id, 'history', newHistory.id), {
            id: newHistory.id,
            partyId: updatedParty.id,
            userId: newHistory.userId,
            userDisplayName: newHistory.userDisplayName,
            outcome: newHistory.outcome,
            pointsAwarded: newHistory.pointsAwarded,
            deadlineIso: newHistory.deadlineIso,
            recordedIso: newHistory.recordedIso,
            notes: newHistory.notes,
            createdAt: serverTimestamp(),
          });
        }
      } catch {
        // Non-blocking if user is signed in via email/password session without Google token
      }
    },
    []
  );

  // Fetch initial session & poll every 6 seconds for 5-hour warnings, missed deadlines, and roommate photo uploads
  const refreshSessionState = useCallback(async () => {
    if (!currentAccount?.email) return;
    try {
      const params = new URLSearchParams({
        email: currentAccount.email,
        ...(currentAccount.partyId ? { partyId: currentAccount.partyId } : {}),
      });
      const { ok, data } = await apiFetch(`/api/session?${params.toString()}`);
      if (!ok || !data) return;
      if (data.user) {
        setCurrentAccount((prev) => {
          if (!prev) return data.user;
          if (
            prev.partyId !== data.user.partyId ||
            prev.displayName !== data.user.displayName ||
            prev.email !== data.user.email
          ) {
            return data.user;
          }
          return prev;
        });
      }
      if (data.bundle) {
        applyServerBundle(data.bundle);
      }
    } catch {
      // ignore transient network errors
    }
  }, [currentAccount?.email, currentAccount?.partyId, applyServerBundle]);

  useEffect(() => {
    refreshSessionState();
    const poll = setInterval(() => {
      refreshSessionState();
    }, 6000);
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
          const { ok, data } = await apiFetch('/api/auth/google-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              uid: user.uid,
              email: user.email,
              displayName: user.displayName || user.email.split('@')[0],
              photoURL: user.photoURL || undefined,
            }),
          });
          if (ok && data?.user) {
            setCurrentAccount(data.user);
            if (data.bundle) {
              applyServerBundle(data.bundle);
            }
          }

          await setDoc(
            doc(db, 'users', user.uid),
            {
              uid: user.uid,
              displayName: user.displayName || user.email.split('@')[0],
              photoURL: user.photoURL || '',
              totalDrops: 0,
              onTimeDrops: 0,
              missedDrops: 0,
              points: 0,
              currentStreak: 0,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );

          await setDoc(
            doc(db, 'users', user.uid, 'private', 'info'),
            {
              email: user.email,
              notificationsEnabled: true,
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
        } catch {
          // ignore
        }
      }
    });
    return () => unsubscribe();
  }, [applyServerBundle]);

  // --- AUTHENTICATION HANDLERS ---
  const handleRegisterWithEmail = async (payload: {
    email: string;
    password: string;
    displayName: string;
    photoURL?: string;
  }) => {
    const { ok, data } = await apiFetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!ok) {
      throw new Error(data?.error || 'Could not create account.');
    }
    setCurrentAccount(data.user);
    applyServerBundle(data.bundle);
  };

  const handleLoginWithEmail = async (payload: { email: string; password: string }) => {
    const { ok, data } = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!ok) {
      throw new Error(data?.error || 'Invalid login credentials.');
    }
    setCurrentAccount(data.user);
    applyServerBundle(data.bundle);
  };

  const handleDirectGoogleAccountSignIn = async (payload: {
    email: string;
    displayName: string;
    photoURL?: string;
  }) => {
    setAuthError(null);
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
    setCurrentAccount(data.user);
    applyServerBundle(data.bundle);
  };

  const handleGoogleSignIn = async (): Promise<{
    ok: boolean;
    errorCode?: string;
    errorMessage?: string;
  }> => {
    setAuthError(null);
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
        const { ok, data } = await apiFetch('/api/auth/google-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || user.email.split('@')[0],
            photoURL: user.photoURL || undefined,
          }),
        });
        if (ok && data?.user) {
          setCurrentAccount(data.user);
          applyServerBundle(data.bundle);
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
    try {
      await signOutUser();
    } catch {
      // ignore
    }
    setCurrentAccount(null);
    applyServerBundle(null);
    setActiveTab('hud');
  };

  // --- PARTY CREATION, INVITE CODE JOIN & ROOMMATE ENROLLMENT ---
  const handleCreateHousehold = async (payload: {
    name: string;
    rotationIntervalHours: number;
    initialDeadlineHours?: number;
  }) => {
    if (!currentAccount) return;
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
    setCurrentAccount(data.user);
    applyServerBundle(data.bundle);
    if (data.bundle?.party) {
      await syncPartyToFirestore(data.bundle.party);
    }
  };

  const handleJoinHouseholdByCode = async (inviteCode: string) => {
    if (!currentAccount) return;
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
    setCurrentAccount(data.user);
    applyServerBundle(data.bundle);
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
      throw new Error(data?.error || 'Failed to add roommate.');
    }
    applyServerBundle(data.bundle);
    if (data.bundle?.party) {
      await syncPartyToFirestore(data.bundle.party);
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

    const { ok, data } = await apiFetch('/api/party/drop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId: party.id,
        userId: activeTurnMember.uid,
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
          `Photo uploaded & verified by Host (+${data.drop?.pointsAwarded || 100} pts)! Turn rotated to ${nextMember.displayName}.`
        );
      } else {
        setCelebrationBanner(
          `Trash photo uploaded by ${activeTurnMember.displayName}! Waiting for Host (${party.hostEmail}) to verify and approve.`
        );
      }
      setTimeout(() => setCelebrationBanner(null), 5500);

      await syncPartyToFirestore(
        updatedParty,
        data.drop,
        data.bundle.history?.[0]
      );
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
        await syncPartyToFirestore(updatedParty, data.drop, data.bundle.history?.[0]);
      }
    } finally {
      setIsVerifyingDropId(null);
    }
  };

  // --- EMAIL REMINDER & DEADLINE / ROTATION DAYS HANDLERS ---
  // Exclusively uses official BinDrop sender account: bindropofficial@gmail.com
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
    if (ok && data?.ok) {
      const msg =
        data.message || `Verified smtp.gmail.com for ${OFFICIAL_BINDROP_EMAIL}!`;
      setCelebrationBanner(msg);
      setTimeout(() => setCelebrationBanner(null), 6500);
      return {
        ok: true,
        message: msg,
        flushedCount: data.flushedCount || 0,
      };
    }
    const errText =
      data?.error ||
      'Google SMTP rejected this password. Make sure it is a 16-character Google App Password from myaccount.google.com/apppasswords.';
    return {
      ok: false,
      message: errText,
      error: errText,
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
      const actuallyDelivered = data.email.deliveryStatus === 'SENT_VIA_SMTP';
      if (actuallyDelivered) {
        setCelebrationBanner(
          `Delivered via Gmail SMTP from ${OFFICIAL_BINDROP_EMAIL} to ${data.email.toEmail}: "${data.email.subject}"`
        );
        setTimeout(() => setCelebrationBanner(null), 5500);
        return { deliveredViaGmail: true };
      } else {
        const smtpErr =
          data.email.errorDetail ||
          `Google SMTP (smtp.gmail.com) rejected the normal login password (EzKen_2005) with Error 535-5.7.8. Paste the 16-character Google App Password for ${OFFICIAL_BINDROP_EMAIL} in Admin → Real Email System so Gmail delivers it.`;
        return { deliveredViaGmail: false, error: smtpErr };
      }
    }
    return { deliveredViaGmail: false, error: data?.error || 'Could not send email.' };
  };

  const handleUpdateTurnDeadline = async (nextDeadlineIso: string) => {
    if (!party) return;
    const { ok, data } = await apiFetch('/api/party/deadline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId: party.id,
        nextDeadlineIso,
      }),
    });
    if (ok && data?.bundle) {
      applyServerBundle(data.bundle);
      await syncPartyToFirestore(data.bundle.party);
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
      }),
    });
    if (ok && data?.bundle) {
      applyServerBundle(data.bundle);
      const days = Math.round(rotationIntervalHours / 24);
      setCelebrationBanner(
        `Rotation schedule updated to every ${days} ${days === 1 ? 'Day' : 'Days'} (${rotationIntervalHours}h)!`
      );
      setTimeout(() => setCelebrationBanner(null), 4000);
      await syncPartyToFirestore(data.bundle.party);
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
      await syncPartyToFirestore(data.bundle.party);
    }
  };

  const handleUpdateProfile = async (
    uid: string,
    updates: { displayName: string; email?: string; photoURL?: string }
  ) => {
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

  // --- GATED AUTH & ONBOARDING RENDER ---
  if (!currentAccount || !party) {
    return (
      <AuthLoginScreen
        currentAccount={currentAccount}
        onLoginWithEmail={handleLoginWithEmail}
        onRegisterWithEmail={handleRegisterWithEmail}
        onGoogleSignIn={handleGoogleSignIn}
        onDirectGoogleAccountSignIn={handleDirectGoogleAccountSignIn}
        onCreateHousehold={handleCreateHousehold}
        onJoinHouseholdByCode={handleJoinHouseholdByCode}
        onSignOut={handleSignOut}
      />
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
  const sortedLeaderboard = [...party.members].sort((a, b) => b.points - a.points);
  const pendingApprovalDrops = dropLogs.filter(
    (d) => d.verificationStatus === 'PENDING_HOST_APPROVAL'
  );

  const openHudFiveHourWarningModal = () => {
    const formattedDeadline = formatDateTimeReadable(party.nextDeadline).fullLabel;
    setHudEmailSubject(
      `[BinDrop 5-Hour Warning] ${activeAssignee.displayName}, less than 5 hours left for your trash turn at ${party.name}`
    );
    setHudEmailBody(
      `Hi ${activeAssignee.displayName} (${activeAssignee.email}),\n\nThis is a 5-hour advance warning from ${OFFICIAL_BINDROP_NAME} (${OFFICIAL_BINDROP_EMAIL}) for "${party.name}".\n\nYour scheduled trash disposal deadline is ${formattedDeadline}.\n\nPlease take the household trash out to the outdoor bin/dumpster and upload your photo in BinDrop so the Host (${partyHost.email}) can verify your turn.\n\n— ${OFFICIAL_BINDROP_NAME} (${OFFICIAL_BINDROP_EMAIL})`
    );
    setHudEmailConfirmOpen(true);
  };

  return (
    <div className="min-h-screen text-slate-100 pb-20 md:pb-12">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 h-14 glass-panel border-b border-white/[0.08] px-4 sm:px-8 flex items-center justify-between gap-8">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('hud');
          }}
          className="text-xl og-bold tracking-tight text-white font-display whitespace-nowrap shrink-0"
        >
          BinDrop
        </a>

        {/* Zone 2: 4 concise single-line text navigation links */}
        <nav
          aria-label="Primary Navigation"
          className="hidden md:flex items-center gap-6 text-sm og-medium text-zinc-400"
        >
          <button
            type="button"
            onClick={() => setActiveTab('hud')}
            className={`transition-colors whitespace-nowrap shrink-0 underline-offset-8 ${
              activeTab === 'hud' ? 'text-[#d0ff45] underline og-bold' : 'hover:text-white'
            }`}
          >
            Duty HUD
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('admin')}
            data-testid="nav-admin-history"
            className={`transition-colors whitespace-nowrap shrink-0 underline-offset-8 ${
              activeTab === 'admin'
                ? 'text-[#d0ff45] underline og-bold'
                : 'hover:text-white'
            }`}
          >
            Admin &amp; History
            {pendingApprovalDrops.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-amber-400 text-[#041206] text-[10px] og-bold">
                {pendingApprovalDrops.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('party')}
            className={`transition-colors whitespace-nowrap shrink-0 underline-offset-8 ${
              activeTab === 'party' ? 'text-[#d0ff45] underline og-bold' : 'hover:text-white'
            }`}
          >
            Party Setup
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('profile')}
            data-testid="nav-profile"
            className={`transition-colors whitespace-nowrap shrink-0 underline-offset-8 ${
              activeTab === 'profile'
                ? 'text-[#d0ff45] underline og-bold'
                : 'hover:text-white'
            }`}
          >
            Profile
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setIsScannerOpen(true)}
            className="lime-cta px-4 py-2 text-xs og-bold rounded-full whitespace-nowrap shrink-0"
          >
            Upload Trash Photo
          </button>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="relative z-10 max-w-6xl mx-auto px-4 sm:px-8 pt-5 space-y-6">
        {/* Household Context & Active Profile Strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-white/[0.08] text-xs og-book text-zinc-400">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-white og-bold">{party.name}</span>
            <span aria-hidden="true">·</span>
            <span>
              Invite Code: <strong className="font-mono text-[#d0ff45]">{party.inviteCode}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Cycle:{' '}
              <strong className="text-zinc-200">
                {formatRotationDaysLabel(party.rotationIntervalHours)}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Mailer:{' '}
              <strong className="font-mono text-[#d0ff45]">{OFFICIAL_BINDROP_EMAIL}</strong>
            </span>
          </div>

          <button
            type="button"
            onClick={() => setActiveTab('profile')}
            data-testid="top-profile-trigger"
            className="flex items-center gap-2.5 text-zinc-200 hover:text-[#d0ff45] transition-colors"
          >
            <MemberAvatar member={activeViewer} size="sm" highlightRing />
            <span className="og-medium">{activeViewer.displayName}</span>
            <span className="text-zinc-500 font-mono">({activeViewer.email})</span>
          </button>
        </div>

        {authError && (
          <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs">
            {authError}
          </div>
        )}

        {celebrationBanner && (
          <div className="animate-celebration-burst p-4 rounded-full bg-[#d0ff45] text-[#041206] og-bold text-xs sm:text-sm flex items-center justify-center gap-2 shadow-xl">
            <Sparkles className="w-4 h-4 shrink-0" />
            <span>{celebrationBanner}</span>
          </div>
        )}

        {/* TAB 1: DUTY HUD */}
        {activeTab === 'hud' && (
          <div className="animate-view-enter space-y-6">
            {/* Overdue Host Escalation Banner */}
            {(party.turnStatus === 'OVERDUE' || deadlineEvaluation.status === 'OVERDUE') && (
              <div
                data-testid="host-escalation-banner"
                className="animate-view-enter p-5 rounded-[28px] bg-rose-950/55 border border-rose-500/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div className="flex items-start gap-3.5">
                  <AlertTriangle className="w-6 h-6 text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <h2 className="text-base og-bold text-white">
                      Missed Trash Deadline — Reminder Mailed from {OFFICIAL_BINDROP_EMAIL} to{' '}
                      {activeAssignee.email} &amp; Host {partyHost.email}
                    </h2>
                    <p className="text-xs og-light text-rose-200/90 mt-1">
                      {activeAssignee.displayName} missed the scheduled trash deadline. An overdue
                      email notification was dispatched from{' '}
                      <strong className="font-mono">{OFFICIAL_BINDROP_EMAIL}</strong> to{' '}
                      <strong className="font-mono">{activeAssignee.email}</strong> and logged in
                      the Host Admin History Database.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setIsScannerOpen(true)}
                    className="px-4 py-2.5 rounded-full bg-rose-500 hover:bg-rose-400 text-slate-950 og-bold text-xs whitespace-nowrap"
                  >
                    Upload Late Photo (60 pts)
                  </button>
                  {isHostOrAdmin && (
                    <button
                      type="button"
                      onClick={handleHostSkipTurn}
                      className="px-4 py-2.5 rounded-full bg-white/10 hover:bg-white/15 text-white og-medium text-xs whitespace-nowrap"
                    >
                      Host: Rotate Next
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* 5-Hour Advance Warning Banner */}
            {deadlineEvaluation.status === 'DUE_SOON' && (
              <div className="animate-view-enter p-4 rounded-[24px] bg-[#142a15] border border-[#d0ff45]/45 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Mail className="w-5 h-5 text-[#d0ff45] shrink-0" />
                  <div className="text-xs">
                    <p className="og-bold text-white">
                      5-Hour Warning Window Active — Automated Warning Mailed from{' '}
                      <span className="font-mono text-[#d0ff45]">{OFFICIAL_BINDROP_EMAIL}</span> to{' '}
                      <span className="text-[#d0ff45] font-mono">{activeAssignee.email}</span>
                    </p>
                    <p className="og-light text-zinc-300 mt-0.5">
                      Less than 5 hours remain before this turn expires. Upload your trash photo on
                      time to keep your streak!
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('admin')}
                  className="text-xs og-bold text-[#d0ff45] underline whitespace-nowrap shrink-0"
                >
                  View Sent Email →
                </button>
              </div>
            )}

            {/* Pending Host Photo Verification Banner (whenever photos await Host approval) */}
            {pendingApprovalDrops.length > 0 && (
              <div
                data-testid="hud-pending-host-verification-card"
                className="glass-panel-elevated rounded-[28px] p-5 border border-amber-400/45 space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="px-2.5 py-1 rounded-full bg-amber-400 text-[#041206] text-xs og-bold">
                      {pendingApprovalDrops.length} Pending Host Verification
                    </span>
                    <h2 className="text-sm sm:text-base og-bold text-white">
                      Submitted Trash Disposal Photo(s) Awaiting Host Review
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('admin')}
                    className="text-xs og-bold text-[#d0ff45] hover:underline"
                  >
                    Open Full Admin Review Queue →
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {pendingApprovalDrops.map((drop) => {
                    const dt = formatDateTimeReadable(drop.submittedIso || drop.createdAt);
                    return (
                      <div
                        key={drop.id}
                        className="p-4 rounded-2xl bg-[#07190a] border border-amber-400/30 flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between"
                      >
                        <div className="flex items-center gap-3.5 min-w-0">
                          <img
                            src={drop.imageUrl}
                            alt={`Submitted by ${drop.userDisplayName}`}
                            referrerPolicy="no-referrer"
                            className="w-20 h-20 rounded-xl object-cover border border-white/15 shrink-0"
                          />
                          <div className="min-w-0 space-y-1">
                            <p className="text-sm og-bold text-white truncate">
                              {drop.userDisplayName}
                            </p>
                            <p className="text-[11px] font-mono text-zinc-400 truncate">
                              {dt.datePart} · {dt.timePart}
                            </p>
                            <p className="text-xs text-zinc-300 truncate">{drop.locationNote}</p>
                          </div>
                        </div>

                        {isHostOrAdmin ? (
                          <div className="flex sm:flex-col gap-2 w-full sm:w-auto shrink-0">
                            <button
                              type="button"
                              disabled={isVerifyingDropId === drop.id}
                              data-testid={`hud-approve-drop-${drop.id}`}
                              onClick={() =>
                                handleHostVerifyDrop({
                                  dropId: drop.id,
                                  decision: 'APPROVE',
                                })
                              }
                              className="flex-1 px-3.5 py-2 rounded-xl bg-[#d0ff45] hover:bg-[#dcff6b] text-[#041206] text-xs og-bold flex items-center justify-center gap-1.5 whitespace-nowrap"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Verify &amp; Approve</span>
                            </button>
                            <button
                              type="button"
                              disabled={isVerifyingDropId === drop.id}
                              data-testid={`hud-reject-drop-${drop.id}`}
                              onClick={() =>
                                handleHostVerifyDrop({
                                  dropId: drop.id,
                                  decision: 'REJECT',
                                })
                              }
                              className="px-3.5 py-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/35 text-rose-300 text-xs og-medium flex items-center justify-center gap-1.5 whitespace-nowrap"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              <span>Reject</span>
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs font-mono text-amber-300 shrink-0">
                            Waiting for Host {partyHost.displayName}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Primary 2-Column Split: Active Turn HUD + Rotation Queue */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
              {/* Left 7 Columns: Active Turn Command Card */}
              <div className="lg:col-span-7 glass-panel-elevated rounded-[32px] p-6 sm:p-8 flex flex-col justify-between space-y-6">
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs og-book text-zinc-400">
                    <span>
                      Turn #{party.currentTurnIndex + 1} of {party.members.length} ·{' '}
                      {party.turnStatus === 'OVERDUE' ||
                      deadlineEvaluation.status === 'OVERDUE' ? (
                        <strong className="text-rose-400 og-bold">OVERDUE (EMAIL SENT)</strong>
                      ) : deadlineEvaluation.status === 'DUE_SOON' ? (
                        <strong className="text-[#d0ff45] og-bold">5-HOUR WARNING ACTIVE</strong>
                      ) : (
                        <strong className="text-[#d0ff45] og-bold">ACTIVE DUTY</strong>
                      )}
                    </span>
                    <span className="font-mono tabular-nums">
                      Cycle: {formatRotationDaysLabel(party.rotationIntervalHours)} · Verified Drops:{' '}
                      {party.totalPartyDrops}
                    </span>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                      <MemberAvatar member={activeAssignee} size="lg" highlightRing />
                      <div className="space-y-1">
                        <p className="text-xs og-light text-zinc-400">Roommate On Trash Duty</p>
                        <h1
                          data-testid="active-turn-assignee"
                          className="text-2xl sm:text-3xl og-bold text-white tracking-tight"
                        >
                          {activeAssignee.displayName}
                        </h1>
                        <p className="text-xs text-[#d0ff45] font-mono">
                          {activeAssignee.email}
                        </p>
                        <p className="text-xs text-zinc-300 font-mono tabular-nums">
                          {activeAssignee.points} pts · {activeAssignee.totalDrops} verified drops ·{' '}
                          {activeAssignee.currentStreak}x streak
                        </p>
                      </div>
                    </div>

                    {/* Countdown Timer Readout */}
                    <div className="text-left sm:text-right">
                      <span className="text-[11px] og-light text-zinc-400 flex items-center sm:justify-end gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-[#d0ff45]" />
                        {countdown.isOverdue ? 'Time Past Deadline' : 'Turn Deadline Countdown'}
                      </span>
                      <div
                        data-testid="turn-countdown-timer"
                        className={`text-2xl sm:text-3xl og-bold font-mono tabular-nums mt-1 ${
                          countdown.isOverdue ? 'text-rose-400' : 'text-[#d0ff45]'
                        }`}
                      >
                        {countdown.isOverdue ? '-' : ''}
                        {countdown.hours}:{countdown.minutes}:{countdown.seconds}
                      </div>
                      <span className="text-[11px] og-light text-zinc-400 block mt-0.5">
                        Auto-mails from {OFFICIAL_BINDROP_EMAIL} to {activeAssignee.email}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Primary Pill CTA */}
                <div className="pt-5 border-t border-white/10 space-y-4">
                  <div className="space-y-1">
                    <h2 className="text-sm og-medium text-white">
                      Photo Proof &amp; Host Verification
                    </h2>
                    <p className="text-xs og-light text-zinc-400">
                      Snap or upload a photo of the trash bag at the outdoor bin/dumpster. Once the
                      Party Host verifies the photo, points are awarded and the turn rotates to the
                      next roommate.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => setIsScannerOpen(true)}
                    data-testid="hud-open-photo-modal-btn"
                    className="lime-cta w-full py-4 px-6 rounded-full og-bold text-sm flex items-center justify-center gap-2 min-h-[52px]"
                  >
                    <Camera className="w-4 h-4" />
                    <span>Snap &amp; Upload Trash Disposal Photo</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>

                {/* Real Email Reminder & Host Action Bar */}
                <div className="pt-4 border-t border-white/10 flex flex-wrap items-center justify-between gap-2.5">
                  <button
                    type="button"
                    onClick={openHudFiveHourWarningModal}
                    data-testid="hud-mail-warning-btn"
                    className="min-h-[42px] px-4 py-2 rounded-full bg-[#091c0b] hover:bg-[#112914] border border-white/10 text-xs og-medium text-zinc-200 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Mail className="w-3.5 h-3.5 text-[#d0ff45]" />
                    Mail 5h Warning to {activeAssignee.email}
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('admin')}
                    className="min-h-[42px] px-4 py-2 rounded-full bg-[#091c0b] hover:bg-[#112914] border border-[#d0ff45]/30 text-xs og-medium text-[#d0ff45] flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Database className="w-3.5 h-3.5" />
                    Open Admin Photo DB &amp; History
                  </button>

                  {isHostOrAdmin && (
                    <button
                      type="button"
                      onClick={handleHostSkipTurn}
                      className="min-h-[42px] px-4 py-2 rounded-full bg-[#091c0b] hover:bg-[#112914] border border-white/10 text-xs og-medium text-zinc-300 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                    >
                      <SkipForward className="w-3.5 h-3.5" />
                      Host: Rotate Turn
                    </button>
                  )}
                </div>
              </div>

              {/* Right 5 Columns: Household Rotation Queue + 1-to-7 Day Schedule Switcher */}
              <div className="lg:col-span-5 glass-panel rounded-[32px] p-6 flex flex-col justify-between space-y-5">
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="text-base og-bold text-white">Turn Rotation Queue</h2>
                      <p className="text-xs og-light text-zinc-400">
                        Household accounts &amp; turn order
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveTab('party')}
                      className="text-xs og-bold text-[#d0ff45] hover:underline whitespace-nowrap shrink-0"
                    >
                      + Add Roommate
                    </button>
                  </div>

                  <div className="divide-y divide-white/[0.08]">
                    {party.members.map((member, index) => {
                      const offset =
                        (index - party.currentTurnIndex + party.members.length) %
                        party.members.length;
                      const isUpNow = offset === 0;
                      const isUpNext = offset === 1;

                      return (
                        <div
                          key={member.uid}
                          className={`py-3 px-3 rounded-2xl transition-colors ${
                            isUpNow ? 'bg-[#d0ff45]/10' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0">
                              <MemberAvatar member={member} size="sm" highlightRing={isUpNow} />
                              <div className="min-w-0">
                                <p className="text-sm og-bold text-white truncate">
                                  {member.displayName}{' '}
                                  {member.role === 'HOST' && (
                                    <span className="text-xs og-book text-[#d0ff45]">
                                      · Host
                                    </span>
                                  )}
                                </p>
                                <p className="text-[11px] text-zinc-400 font-mono truncate">
                                  {member.email}
                                </p>
                                <p className="text-[11px] text-zinc-500 font-mono tabular-nums">
                                  {member.points} pts · {member.onTimeDrops} on-time ·{' '}
                                  {member.missedDrops} missed
                                </p>
                              </div>
                            </div>

                            <div className="text-right shrink-0">
                              {isUpNow ? (
                                <span className="text-xs og-bold text-[#d0ff45]">Up Now</span>
                              ) : isUpNext ? (
                                <span className="text-xs og-medium text-zinc-200">Up Next</span>
                              ) : (
                                <span className="text-xs font-mono text-zinc-500 tabular-nums">
                                  In {offset} turns
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 1-to-7 Day Rotation Selector directly on the Queue Card */}
                <div className="pt-3 border-t border-white/[0.08] space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="inline-flex items-center gap-1.5 og-medium text-zinc-300">
                      <Calendar className="w-3.5 h-3.5 text-[#d0ff45]" />
                      <span>Rotation Cycle (1 to 7 Days):</span>
                    </span>
                    <span
                      data-testid="active-rotation-days-label"
                      className="font-mono og-bold text-[#d0ff45]"
                    >
                      {formatRotationDaysLabel(party.rotationIntervalHours)}
                    </span>
                  </div>

                  <div className="grid grid-cols-7 gap-1.5">
                    {ROTATION_DAY_OPTIONS.map((opt) => {
                      const isSelected = party.rotationIntervalHours === opt.hours;
                      return (
                        <button
                          key={opt.days}
                          type="button"
                          data-testid={`hud-rotation-day-${opt.days}`}
                          onClick={() => handleUpdateRotationIntervalHours(opt.hours)}
                          className={`py-1.5 rounded-xl text-xs og-bold transition-all border ${
                            isSelected
                              ? 'bg-[#d0ff45] text-[#041206] border-[#d0ff45] scale-105'
                              : 'bg-[#091c0b] text-zinc-300 border-white/10 hover:border-[#d0ff45]/40'
                          }`}
                        >
                          {opt.shortLabel}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom 2-Column Grid: Household Standings & Recent Timestamped Photos */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Household Leaderboard Snapshot (5 cols) */}
              <div className="lg:col-span-5 glass-panel rounded-[32px] p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-base og-bold text-white">Household Standings</h2>
                    <p className="text-xs og-light text-zinc-400">
                      Ranked by Host-verified trash disposal points
                    </p>
                  </div>
                </div>

                <div className="space-y-2.5">
                  {sortedLeaderboard.map((member, idx) => (
                    <div
                      key={member.uid}
                      className="p-3.5 rounded-2xl bg-[#08190a] border border-white/[0.07]"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="font-mono og-bold text-xs text-zinc-400 w-5">
                            #{idx + 1}
                          </span>
                          <MemberAvatar member={member} size="sm" />
                          <div className="min-w-0">
                            <p className="text-xs og-bold text-white truncate">
                              {member.displayName}
                            </p>
                            <p className="text-[11px] text-zinc-400 font-mono truncate">
                              {member.onTimeDrops} on-time · {member.missedDrops} missed
                            </p>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <span className="text-sm og-bold font-mono text-[#d0ff45] tabular-nums">
                            {member.points} pts
                          </span>
                          <span className="block text-[10px] text-zinc-400 font-mono flex items-center justify-end gap-1">
                            <Flame className="w-3 h-3 text-[#d0ff45]" />
                            {member.currentStreak}x
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recent Proof-of-Work Drops with Date, Time & Host Verification Status (7 cols) */}
              <div className="lg:col-span-7 glass-panel rounded-[32px] p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-base og-bold text-white">
                      Latest Timestamped Trash Photos
                    </h2>
                    <p className="text-xs og-light text-zinc-400">
                      Saved in Firebase &amp; Host Admin Database by exact date and time
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('admin')}
                    className="text-xs og-bold text-[#d0ff45] hover:underline whitespace-nowrap shrink-0"
                  >
                    Open Full Admin DB ({dropLogs.length}) →
                  </button>
                </div>

                {dropLogs.length === 0 ? (
                  <div className="p-8 rounded-2xl bg-[#08190a] border border-white/[0.08] text-center space-y-3">
                    <Camera className="w-7 h-7 text-[#d0ff45] mx-auto" />
                    <p className="text-sm og-bold text-white">
                      No Trash Photos Submitted Yet
                    </p>
                    <p className="text-xs og-light text-zinc-400 max-w-sm mx-auto">
                      Tap &ldquo;Snap &amp; Upload Trash Disposal Photo&rdquo; to upload a photo for
                      Host verification and record it in the timestamped database.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {dropLogs.slice(0, 4).map((drop) => {
                      const dt = formatDateTimeReadable(drop.submittedIso || drop.createdAt);
                      return (
                        <div
                          key={drop.id}
                          className="rounded-2xl overflow-hidden bg-[#08190a] border border-white/[0.08] flex flex-col justify-between"
                        >
                          <div className="relative h-36 bg-[#041206]">
                            <img
                              src={drop.imageUrl}
                              alt={`Trash drop by ${drop.userDisplayName}`}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                            <div className="absolute top-2.5 right-2.5">
                              {drop.verificationStatus === 'VERIFIED' ? (
                                <span className="px-2.5 py-1 rounded-full bg-[#d0ff45] text-[#041206] text-[10px] og-bold">
                                  Host Verified
                                </span>
                              ) : drop.verificationStatus === 'REJECTED' ? (
                                <span className="px-2.5 py-1 rounded-full bg-rose-500 text-white text-[10px] og-bold">
                                  Rejected
                                </span>
                              ) : (
                                <span className="px-2.5 py-1 rounded-full bg-amber-400 text-[#041206] text-[10px] og-bold">
                                  Pending Host Review
                                </span>
                              )}
                            </div>
                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/45 to-transparent p-3 flex items-center justify-between text-xs">
                              <span className="og-bold text-white">
                                {drop.userDisplayName}
                              </span>
                              <span className="font-mono og-bold text-[#d0ff45] tabular-nums">
                                {drop.verificationStatus === 'VERIFIED'
                                  ? `+${drop.pointsAwarded} pts`
                                  : 'Awaiting Host'}
                              </span>
                            </div>
                          </div>
                          <div className="p-3.5 space-y-2">
                            <div className="flex items-center justify-between text-[11px] text-zinc-400 font-mono tabular-nums">
                              <span className="flex items-center gap-1 text-[#d0ff45]">
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                {dt.datePart} · {dt.timePart}
                              </span>
                              <span>{drop.completedOnTime ? 'On-Time' : 'Late'}</span>
                            </div>
                            <p className="text-xs og-medium text-zinc-200 truncate">
                              {drop.locationNote}
                            </p>
                            {isHostOrAdmin &&
                              drop.verificationStatus === 'PENDING_HOST_APPROVAL' && (
                                <div className="flex items-center gap-2 pt-1">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleHostVerifyDrop({
                                        dropId: drop.id,
                                        decision: 'APPROVE',
                                      })
                                    }
                                    className="flex-1 py-1.5 rounded-lg bg-[#d0ff45] text-[#041206] text-xs og-bold"
                                  >
                                    Approve
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleHostVerifyDrop({
                                        dropId: drop.id,
                                        decision: 'REJECT',
                                      })
                                    }
                                    className="py-1.5 px-2.5 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs og-medium"
                                  >
                                    Reject
                                  </button>
                                </div>
                              )}
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

        {/* TAB 2: HOST ADMIN VIEW & COMPLIANCE HISTORY DATABASE */}
        {activeTab === 'admin' && (
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
        )}

        {/* TAB 3: PARTY SETUP & ROOMMATE ENROLLMENT */}
        {activeTab === 'party' && (
          <PartyManagerView
            party={party}
            currentUserId={activeViewer.uid}
            onCreateParty={handleCreateHousehold}
            onJoinExistingPartyByCode={handleJoinHouseholdByCode}
            onAddRoommateWithEmail={handleAddRoommateWithEmail}
            onUpdateRotationIntervalHours={handleUpdateRotationIntervalHours}
          />
        )}

        {/* TAB 4: PROFILE & GMAIL DELIVERY SETTINGS */}
        {activeTab === 'profile' && (
          <ProfileAccountView
            activeViewer={activeViewer}
            firebaseUser={firebaseUser}
            onUpdateProfile={handleUpdateProfile}
            onGoogleSignIn={handleGoogleSignIn}
            onSignOut={handleSignOut}
            onBackToHud={() => setActiveTab('hud')}
          />
        )}
      </main>

      {/* HUD Email Confirmation Modal */}
      {hudEmailConfirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md"
        >
          <div className="glass-panel-elevated w-full max-w-lg rounded-[32px] p-6 space-y-4 border border-[#d0ff45]/35 max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="text-xs font-mono text-[#d0ff45]">
                  Official Outbound Mailer · {OFFICIAL_BINDROP_EMAIL}
                </span>
                <h3 className="text-lg og-bold text-white mt-0.5">
                  Send 5-Hour Warning Email to {activeAssignee.displayName}
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

            <div className="p-3.5 rounded-2xl bg-[#07190a] border border-white/10 text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Official Sender (From):</span>
                <span className="font-mono text-[#d0ff45] og-bold">
                  {OFFICIAL_BINDROP_NAME} &lt;{OFFICIAL_BINDROP_EMAIL}&gt;
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Recipient (To):</span>
                <span className="font-mono text-white og-bold">
                  {activeAssignee.displayName} &lt;{activeAssignee.email}&gt;
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Gmail SMTP Status:</span>
                {mailerStatus?.smtpVerified ? (
                  <span className="font-mono text-[#d0ff45] og-bold">
                    VERIFIED (Saves to Sent folder)
                  </span>
                ) : (
                  <span className="font-mono text-amber-300 og-bold">
                    NEEDS 16-CHAR GOOGLE APP PASSWORD
                  </span>
                )}
              </div>
            </div>

            {!mailerStatus?.smtpVerified && (
              <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-400/35 space-y-2.5 text-xs">
                <p className="text-amber-200 og-bold">
                  Why your Gmail Sent folder was empty: Google SMTP (smtp.gmail.com) blocks regular login passwords (<code className="text-white">EzKen_2005</code>) with Error 535-5.7.8.
                </p>
                <p className="text-zinc-300 leading-relaxed">
                  Open{' '}
                  <a
                    href="https://myaccount.google.com/apppasswords"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#d0ff45] underline og-semibold"
                  >
                    myaccount.google.com/apppasswords
                  </a>{' '}
                  while signed into <span className="text-white og-semibold">{OFFICIAL_BINDROP_EMAIL}</span>, create a 16-character App Password, and paste it here:
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={hudAppPasswordInput}
                    onChange={(e) => setHudAppPasswordInput(e.target.value)}
                    placeholder="xxxx xxxx xxxx xxxx (16-char Google App Password)"
                    className="flex-1 px-3 py-2 rounded-xl bg-[#07190a] border border-amber-400/40 text-xs text-white font-mono focus:outline-none focus:border-[#d0ff45]"
                  />
                  <button
                    type="button"
                    disabled={isSavingHudAppPassword || !hudAppPasswordInput.trim()}
                    onClick={async () => {
                      setIsSavingHudAppPassword(true);
                      try {
                        const res = await handleSaveAppPassword(hudAppPasswordInput);
                        if (res.ok) {
                          setHudAppPasswordInput('');
                        } else {
                          setAuthError(res.message);
                        }
                      } finally {
                        setIsSavingHudAppPassword(false);
                      }
                    }}
                    className="lime-cta px-4 py-2 rounded-xl text-xs og-bold whitespace-nowrap disabled:opacity-50"
                  >
                    {isSavingHudAppPassword ? 'Verifying...' : 'Verify App Password'}
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-1">
              <label className="block text-xs og-medium text-zinc-300">Subject</label>
              <input
                type="text"
                value={hudEmailSubject}
                onChange={(e) => setHudEmailSubject(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#07190a] border border-white/15 text-xs text-white focus:outline-none focus:border-[#d0ff45]"
              />
            </div>

            <div className="space-y-1">
              <label className="block text-xs og-medium text-zinc-300">Message Body</label>
              <textarea
                rows={5}
                value={hudEmailBody}
                onChange={(e) => setHudEmailBody(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#07190a] border border-white/15 text-xs text-white font-mono focus:outline-none focus:border-[#d0ff45]"
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
              <button
                type="button"
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
                    ? 'Sending from bindropofficial@gmail.com...'
                    : `Send from ${OFFICIAL_BINDROP_EMAIL}`}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Bottom Navigation Bar */}
      <nav
        aria-label="Mobile Navigation"
        className="md:hidden fixed bottom-0 inset-x-0 z-30 h-16 glass-panel border-t border-white/10 px-2 flex items-center justify-around"
      >
        <button
          type="button"
          onClick={() => setActiveTab('hud')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-xl text-xs og-medium ${
            activeTab === 'hud' ? 'text-[#d0ff45]' : 'text-zinc-400'
          }`}
        >
          <Camera className="w-4 h-4" />
          <span>Duty HUD</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('admin')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-xl text-xs og-medium ${
            activeTab === 'admin' ? 'text-[#d0ff45]' : 'text-zinc-400'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>Admin DB</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('party')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-xl text-xs og-medium ${
            activeTab === 'party' ? 'text-[#d0ff45]' : 'text-zinc-400'
          }`}
        >
          <Users className="w-4 h-4" />
          <span>Party</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('profile')}
          className={`flex flex-col items-center gap-1 py-1 px-3 rounded-xl text-xs og-medium ${
            activeTab === 'profile' ? 'text-[#d0ff45]' : 'text-zinc-400'
          }`}
        >
          <UserIcon className="w-4 h-4" />
          <span>Profile</span>
        </button>
      </nav>

      {/* Trash Disposal Photo Upload Modal (For Host Verification) */}
      <VisionScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        activeAssignee={activeAssignee}
        isOverdue={countdown.isOverdue}
        isHostOrAdmin={isHostOrAdmin}
        onSubmitTrashPhoto={handleUploadTrashPhoto}
      />
    </div>
  );
}
