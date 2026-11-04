import React, { useEffect, useState } from 'react';
import {
  Bell,
  BellRing,
  CheckCircle2,
  PlusSquare,
  Share,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import {
  getMobilePushEnvironment,
  getSavedLocalPushState,
  subscribeUserToBackgroundPush,
  unsubscribeUserFromBackgroundPush,
  type MobilePushEnvironment,
} from '../utils/pushClient';

interface PushAlertsCardProps {
  userEmail: string;
  userUid?: string;
  userDisplayName?: string;
  partyId?: string | null;
  partyName?: string;
  compact?: boolean;
  onTriggerInAppBanner?: (alert: {
    title: string;
    message: string;
    senderName: string;
    category: string;
  }) => void;
}

export const PushAlertsCard: React.FC<PushAlertsCardProps> = ({
  userEmail,
  userUid,
  userDisplayName,
  partyId,
  partyName,
  compact = false,
  onTriggerInAppBanner,
}) => {
  const [env, setEnv] = useState<MobilePushEnvironment>(() => getMobilePushEnvironment());
  const [alertsEnabled, setAlertsEnabled] = useState<boolean>(() => {
    const saved = getSavedLocalPushState();
    const currentEnv = getMobilePushEnvironment();
    return saved.enabled && currentEnv.permission === 'granted';
  });
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showIosGuideModal, setShowIosGuideModal] = useState(false);

  useEffect(() => {
    const refreshEnv = () => {
      const nextEnv = getMobilePushEnvironment();
      setEnv(nextEnv);
      const saved = getSavedLocalPushState();
      setAlertsEnabled(saved.enabled && nextEnv.permission === 'granted');
    };
    refreshEnv();
    window.addEventListener('focus', refreshEnv);
    return () => window.removeEventListener('focus', refreshEnv);
  }, []);

  const handleToggleAlerts = async () => {
    setErrorMessage(null);
    setStatusMessage(null);

    const currentEnv = getMobilePushEnvironment();
    setEnv(currentEnv);

    // Crucial Mobile Rule #1: iOS "Home Screen" Rule
    if (currentEnv.iosNeedsHomeScreenInstall) {
      setShowIosGuideModal(true);
      setErrorMessage(
        'On iPhone, add BinDrop to your Home Screen first (Share → Add to Home Screen) so iOS allows lock-screen notifications.'
      );
      return;
    }

    setBusy(true);
    try {
      if (alertsEnabled) {
        await unsubscribeUserFromBackgroundPush({ userEmail });
        setAlertsEnabled(false);
        setStatusMessage('Background lock-screen alerts paused on this device.');
      } else {
        const result = await subscribeUserToBackgroundPush({
          userEmail,
          userUid,
          userDisplayName,
          partyId,
        });
        const updatedEnv = getMobilePushEnvironment();
        setEnv(updatedEnv);

        if (!result.ok) {
          setAlertsEnabled(false);
          if (result.iosHomeScreenRequired) {
            setShowIosGuideModal(true);
          }
          setErrorMessage(result.error || 'Could not enable background alerts.');
        } else {
          setAlertsEnabled(true);
          setStatusMessage(
            'Lock-screen & banner alerts are now active for all household events!'
          );
          if (onTriggerInAppBanner) {
            onTriggerInAppBanner({
              title: '🔔 Lock-Screen Push Alerts Active!',
              message: `Background notifications enabled for ${
                userDisplayName || userEmail
              }. You'll get alerts even when BinDrop is closed.`,
              senderName: partyName || 'BinDrop Alerts',
              category: 'TURN_REMINDER',
            });
          }
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`rounded-2xl border border-[#d0ff45]/25 bg-[#0a1f0d]/95 ${
        compact ? 'p-3' : 'p-3.5'
      } shadow-[0_8px_28px_rgba(0,0,0,0.45)]`}
    >
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
              alertsEnabled
                ? 'bg-[#d0ff45]/20 border-[#d0ff45]/50 text-[#d0ff45]'
                : 'bg-white/5 border-white/15 text-zinc-300'
            }`}
          >
            {alertsEnabled ? <BellRing className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-bold text-white tracking-tight">
                Turn on Alerts
              </span>
              <span
                className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md ${
                  alertsEnabled
                    ? 'bg-[#d0ff45]/20 text-[#d0ff45] border border-[#d0ff45]/40'
                    : env.iosNeedsHomeScreenInstall
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-400/40'
                    : 'bg-white/10 text-zinc-400'
                }`}
              >
                {alertsEnabled
                  ? 'Lock-Screen Active'
                  : env.iosNeedsHomeScreenInstall
                  ? 'Add to Home Screen'
                  : 'Off'}
              </span>
            </div>
            <p className="text-[11px] text-zinc-400 leading-snug truncate">
              {env.iosNeedsHomeScreenInstall
                ? 'Install to iPhone Home Screen to unlock push alerts'
                : 'Get lock-screen & banner alerts for turns & deadlines'}
            </p>
          </div>
        </div>

        {/* Interactive User-Action Toggle Switch */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            role="switch"
            aria-checked={alertsEnabled}
            aria-label="Turn on Alerts"
            disabled={busy || env.iosNeedsHomeScreenInstall}
            onClick={handleToggleAlerts}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-200 border cursor-pointer ${
              env.iosNeedsHomeScreenInstall
                ? 'bg-zinc-800/80 border-amber-400/30 opacity-60 cursor-not-allowed'
                : alertsEnabled
                ? 'bg-[#d0ff45] border-[#d0ff45]'
                : 'bg-zinc-800 border-white/20 hover:border-white/35'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full transition-transform duration-200 shadow ${
                alertsEnabled
                  ? 'translate-x-6 bg-[#051407]'
                  : 'translate-x-1 bg-zinc-300'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Crucial Mobile Rule #1: iOS "Add to Home Screen" Requirement Banner */}
      {(env.iosNeedsHomeScreenInstall || showIosGuideModal) && (
        <div className="mt-2.5 rounded-xl border border-amber-400/35 bg-amber-500/10 p-2.5 text-[11px] text-amber-100">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="font-bold text-amber-300 flex items-center gap-1.5">
              <Smartphone className="w-3.5 h-3.5 shrink-0" />
              iPhone / iOS Home Screen Rule Required
            </span>
            {!env.iosNeedsHomeScreenInstall && (
              <button
                type="button"
                onClick={() => setShowIosGuideModal(false)}
                className="text-[10px] text-zinc-400 hover:text-white"
              >
                Hide
              </button>
            )}
          </div>
          <p className="text-[10px] text-amber-200/90 leading-relaxed mb-2">
            Apple requires web apps on iPhone (iOS 16.4+) to be added to your Home Screen before the{' '}
            <strong>Turn on Alerts</strong> switch can unlock lock-screen notifications:
          </p>
          <div className="grid grid-cols-1 gap-1.5 text-[10px] bg-black/35 rounded-lg p-2 border border-white/10">
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 rounded-full bg-[#d0ff45] text-[#051407] font-bold flex items-center justify-center shrink-0 text-[9px]">
                1
              </span>
              <span className="flex items-center gap-1 flex-wrap">
                Tap the Safari <strong>Share</strong> button <Share className="w-3 h-3 text-[#d0ff45] inline" /> at the bottom
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 rounded-full bg-[#d0ff45] text-[#051407] font-bold flex items-center justify-center shrink-0 text-[9px]">
                2
              </span>
              <span className="flex items-center gap-1 flex-wrap">
                Select <strong>&ldquo;Add to Home Screen&rdquo;</strong>{' '}
                <PlusSquare className="w-3 h-3 text-[#d0ff45] inline" />
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 rounded-full bg-[#d0ff45] text-[#051407] font-bold flex items-center justify-center shrink-0 text-[9px]">
                3
              </span>
              <span>
                Open <strong>BinDrop</strong> from your Home Screen &amp; flip{' '}
                <strong className="text-[#d0ff45]">Turn on Alerts</strong>!
              </span>
            </div>
          </div>
        </div>
      )}

      {!env.iosNeedsHomeScreenInstall && !showIosGuideModal && (
        <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-zinc-400">
          <span className="flex items-center gap-1 truncate">
            <Sparkles className="w-3 h-3 text-[#d0ff45] shrink-0" />
            All turn alerts, 5h warnings, photo drops &amp; invites
          </span>
          <button
            type="button"
            onClick={() => setShowIosGuideModal(true)}
            className="text-[10px] text-zinc-400 hover:text-[#d0ff45] underline shrink-0 cursor-pointer"
          >
            iPhone Setup Guide
          </button>
        </div>
      )}

      {statusMessage && (
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-[#d0ff45] bg-[#d0ff45]/10 border border-[#d0ff45]/30 rounded-lg px-2.5 py-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>{statusMessage}</span>
        </div>
      )}

      {errorMessage && (
        <div className="mt-2 text-[10px] text-rose-300 bg-rose-500/15 border border-rose-400/30 rounded-lg px-2.5 py-1.5">
          {errorMessage}
        </div>
      )}
    </div>
  );
};
