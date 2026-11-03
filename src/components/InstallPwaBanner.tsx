import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Download,
  ExternalLink,
  MoreVertical,
  PlusSquare,
  Share,
  Smartphone,
  Sparkles,
  X,
} from 'lucide-react';
import { getMobilePushEnvironment } from '../utils/pushClient';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

declare global {
  interface Window {
    __bindropDeferredPwaPrompt?: BeforeInstallPromptEvent | null;
  }
}

// Capture beforeinstallprompt as early as module load so Android Chrome never misses it
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__bindropDeferredPwaPrompt = e as BeforeInstallPromptEvent;
    window.dispatchEvent(new CustomEvent('bindrop-pwa-prompt-ready'));
  });
  window.addEventListener('appinstalled', () => {
    window.__bindropDeferredPwaPrompt = null;
    window.dispatchEvent(new CustomEvent('bindrop-pwa-installed'));
  });
}

export const InstallPwaBanner: React.FC<{
  compact?: boolean;
}> = ({ compact = false }) => {
  const [env, setEnv] = useState(() => getMobilePushEnvironment());
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(
    () => (typeof window !== 'undefined' ? window.__bindropDeferredPwaPrompt || null : null)
  );
  const [activeGuideModal, setActiveGuideModal] = useState<'ANDROID' | 'IOS' | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installSuccess, setInstallSuccess] = useState(false);

  useEffect(() => {
    const syncState = () => {
      setEnv(getMobilePushEnvironment());
      setDeferredPrompt(window.__bindropDeferredPwaPrompt || null);
    };

    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      const promptEvent = e as BeforeInstallPromptEvent;
      window.__bindropDeferredPwaPrompt = promptEvent;
      setDeferredPrompt(promptEvent);
    };

    const handleInstalled = () => {
      window.__bindropDeferredPwaPrompt = null;
      setDeferredPrompt(null);
      setInstallSuccess(true);
      setActiveGuideModal(null);
      setEnv(getMobilePushEnvironment());
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('bindrop-pwa-prompt-ready', syncState);
    window.addEventListener('bindrop-pwa-installed', handleInstalled);
    window.addEventListener('appinstalled', handleInstalled);
    window.addEventListener('focus', syncState);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('bindrop-pwa-prompt-ready', syncState);
      window.removeEventListener('bindrop-pwa-installed', handleInstalled);
      window.removeEventListener('appinstalled', handleInstalled);
      window.removeEventListener('focus', syncState);
    };
  }, []);

  // If already running as an installed standalone Home Screen app, hide browser install prompt
  if (env.isStandalone && !installSuccess) {
    return null;
  }

  const handleAndroidInstallClick = async () => {
    const promptToUse = deferredPrompt || window.__bindropDeferredPwaPrompt;
    if (promptToUse) {
      try {
        await promptToUse.prompt();
        const choice = await promptToUse.userChoice;
        if (choice.outcome === 'accepted') {
          window.__bindropDeferredPwaPrompt = null;
          setDeferredPrompt(null);
          setInstallSuccess(true);
          return;
        }
      } catch {
        // Fall through to visual Android install modal if browser blocks direct prompt
      }
    }
    setActiveGuideModal('ANDROID');
  };

  const handleIosInstallClick = () => {
    setActiveGuideModal('IOS');
  };

  const detectedPlatformLabel = env.isAndroid
    ? 'Android Browser Detected'
    : env.isIOS
    ? 'iPhone / iOS Browser Detected'
    : 'Web Browser Detected';

  return (
    <>
      {!dismissed && (
        <div
          className={`relative overflow-hidden rounded-2xl border border-[#d0ff45]/35 bg-gradient-to-r from-[#0e2613]/95 via-[#0a1c0e]/95 to-[#08150b]/95 shadow-[0_14px_38px_rgba(0,0,0,0.5)] transition-all ${
            compact ? 'p-3.5 sm:p-4' : 'p-4 sm:p-5'
          }`}
        >
          <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-[#d0ff45]/10 blur-2xl" />

          <div className="flex flex-col gap-3.5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3.5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#d0ff45]/40 bg-[#d0ff45]/15 text-[#d0ff45] shadow-[0_0_20px_rgba(208,255,69,0.2)]">
                <Smartphone className="h-5 w-5" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-md border border-[#d0ff45]/40 bg-[#d0ff45]/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#d0ff45]">
                    <Sparkles className="h-3 w-3" />
                    {detectedPlatformLabel}
                  </span>
                  <span className="text-[11px] font-semibold text-amber-300">
                    • Install App for Proper Use & Lock-Screen Alerts
                  </span>
                </div>

                <h3 className="mt-1 text-sm font-black text-white sm:text-base">
                  {env.isAndroid
                    ? 'You are using BinDrop in an Android browser — Install the Android App for proper use'
                    : env.isIOS
                    ? 'You are using BinDrop in Safari — Install the iOS App to your Home Screen for proper use'
                    : 'Install the BinDrop App on Android or iOS for proper use'}
                </h3>

                <p className="mt-0.5 text-xs leading-relaxed text-slate-300">
                  Installing BinDrop as an app enables{' '}
                  <strong className="text-[#d0ff45]">
                    lock-screen push notifications even when your phone is locked
                  </strong>
                  , instant roommate party sync, and full-screen trash duty controls.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
              {/* Dedicated Android Install Button */}
              <button
                type="button"
                onClick={handleAndroidInstallClick}
                className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-xs font-black transition active:scale-[0.99] ${
                  env.isAndroid || !env.isIOS
                    ? 'bg-[#d0ff45] text-[#050e07] shadow-[0_0_22px_rgba(208,255,69,0.3)] hover:bg-[#dcff69]'
                    : 'border border-[#d0ff45]/35 bg-[#112615] text-[#d0ff45] hover:bg-[#17331d]'
                }`}
              >
                <Download className="h-4 w-4" />
                <span>Install for Android</span>
              </button>

              {/* Dedicated iOS Install Button */}
              <button
                type="button"
                onClick={handleIosInstallClick}
                className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-xs font-black transition active:scale-[0.99] ${
                  env.isIOS
                    ? 'bg-[#d0ff45] text-[#050e07] shadow-[0_0_22px_rgba(208,255,69,0.3)] hover:bg-[#dcff69]'
                    : 'border border-white/15 bg-white/5 text-white hover:border-[#d0ff45]/40 hover:bg-white/10'
                }`}
              >
                <Share className="h-3.5 w-3.5 text-[#d0ff45] group-hover:text-white" />
                <span>Install for iOS (iPhone)</span>
              </button>

              <button
                type="button"
                onClick={() => setDismissed(true)}
                title="Hide banner"
                className="rounded-lg border border-white/10 bg-black/25 p-2 text-slate-400 transition hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {installSuccess && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-300">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-[#d0ff45]" />
              <span>
                BinDrop App installed! Open BinDrop from your Home Screen and flip &ldquo;Turn on
                Alerts&rdquo; ON.
              </span>
            </div>
          )}
        </div>
      )}

      {/* Step-by-Step Android & iOS Install Modal */}
      {activeGuideModal && (
        <PwaInstallGuideModal
          mode={activeGuideModal}
          hasNativeAndroidPrompt={Boolean(deferredPrompt || window.__bindropDeferredPwaPrompt)}
          onTriggerNativeAndroidPrompt={async () => {
            const p = deferredPrompt || window.__bindropDeferredPwaPrompt;
            if (p) {
              await p.prompt();
              const choice = await p.userChoice;
              if (choice.outcome === 'accepted') {
                window.__bindropDeferredPwaPrompt = null;
                setDeferredPrompt(null);
                setInstallSuccess(true);
                setActiveGuideModal(null);
              }
            }
          }}
          onSwitchMode={(m) => setActiveGuideModal(m)}
          onClose={() => setActiveGuideModal(null)}
        />
      )}
    </>
  );
};

/**
 * Compact header button for the top navigation bar so users on Android or iOS browsers
 * always have a 1-tap "Install App" button even if they closed the banner.
 */
export const InstallPwaHeaderButton: React.FC = () => {
  const [env, setEnv] = useState(() => getMobilePushEnvironment());
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(
    () => (typeof window !== 'undefined' ? window.__bindropDeferredPwaPrompt || null : null)
  );
  const [activeGuideModal, setActiveGuideModal] = useState<'ANDROID' | 'IOS' | null>(null);

  useEffect(() => {
    const syncState = () => {
      setEnv(getMobilePushEnvironment());
      setDeferredPrompt(window.__bindropDeferredPwaPrompt || null);
    };
    window.addEventListener('beforeinstallprompt', syncState);
    window.addEventListener('bindrop-pwa-prompt-ready', syncState);
    window.addEventListener('bindrop-pwa-installed', syncState);
    window.addEventListener('appinstalled', syncState);
    return () => {
      window.removeEventListener('beforeinstallprompt', syncState);
      window.removeEventListener('bindrop-pwa-prompt-ready', syncState);
      window.removeEventListener('bindrop-pwa-installed', syncState);
      window.removeEventListener('appinstalled', syncState);
    };
  }, []);

  if (env.isStandalone) {
    return null;
  }

  const handleClick = async () => {
    if (env.isIOS) {
      setActiveGuideModal('IOS');
      return;
    }
    const p = deferredPrompt || window.__bindropDeferredPwaPrompt;
    if (p) {
      try {
        await p.prompt();
        const choice = await p.userChoice;
        if (choice.outcome === 'accepted') {
          window.__bindropDeferredPwaPrompt = null;
          setDeferredPrompt(null);
          return;
        }
      } catch {
        // fall through
      }
    }
    setActiveGuideModal(env.isAndroid ? 'ANDROID' : 'ANDROID');
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className="inline-flex items-center gap-1.5 rounded-xl border border-[#d0ff45]/45 bg-[#d0ff45]/15 px-3 py-2 text-xs font-extrabold text-[#d0ff45] transition hover:bg-[#d0ff45]/25"
        title="Install BinDrop App on Android or iOS for lock-screen notifications"
      >
        <Download className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">
          {env.isIOS ? 'Install iOS App' : env.isAndroid ? 'Install Android App' : 'Install App'}
        </span>
        <span className="sm:hidden">Install</span>
      </button>

      {activeGuideModal && (
        <PwaInstallGuideModal
          mode={activeGuideModal}
          hasNativeAndroidPrompt={Boolean(deferredPrompt || window.__bindropDeferredPwaPrompt)}
          onTriggerNativeAndroidPrompt={async () => {
            const p = deferredPrompt || window.__bindropDeferredPwaPrompt;
            if (p) {
              await p.prompt();
              const choice = await p.userChoice;
              if (choice.outcome === 'accepted') {
                window.__bindropDeferredPwaPrompt = null;
                setDeferredPrompt(null);
                setActiveGuideModal(null);
              }
            }
          }}
          onSwitchMode={(m) => setActiveGuideModal(m)}
          onClose={() => setActiveGuideModal(null)}
        />
      )}
    </>
  );
};

const PwaInstallGuideModal: React.FC<{
  mode: 'ANDROID' | 'IOS';
  hasNativeAndroidPrompt: boolean;
  onTriggerNativeAndroidPrompt: () => Promise<void>;
  onSwitchMode: (mode: 'ANDROID' | 'IOS') => void;
  onClose: () => void;
}> = ({
  mode,
  hasNativeAndroidPrompt,
  onTriggerNativeAndroidPrompt,
  onSwitchMode,
  onClose,
}) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md">
      <div className="w-full max-w-md rounded-2xl border border-[#24482a] bg-[#08150b] p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#d0ff45]/40 bg-[#d0ff45]/15 text-[#d0ff45]">
              <Smartphone className="h-5 w-5" />
            </div>
            <div>
              <span className="text-[10px] font-bold uppercase tracking-widest text-[#d0ff45]">
                Official App Installation
              </span>
              <h3 className="text-lg font-black text-white">
                {mode === 'ANDROID'
                  ? 'Install BinDrop on Android'
                  : 'Install BinDrop on iPhone / iOS'}
              </h3>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-400 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Platform Switcher Tabs */}
        <div className="mt-4 grid grid-cols-2 gap-1.5 rounded-xl border border-[#1d3921] bg-[#040c06] p-1">
          <button
            type="button"
            onClick={() => onSwitchMode('ANDROID')}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-extrabold transition ${
              mode === 'ANDROID'
                ? 'bg-[#d0ff45] text-[#050e07]'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Download className="h-3.5 w-3.5" />
            Android Install
          </button>
          <button
            type="button"
            onClick={() => onSwitchMode('IOS')}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-extrabold transition ${
              mode === 'IOS'
                ? 'bg-[#d0ff45] text-[#050e07]'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Share className="h-3.5 w-3.5" />
            iPhone / iOS Install
          </button>
        </div>

        {mode === 'ANDROID' ? (
          <div className="mt-4 space-y-3">
            <p className="text-xs leading-relaxed text-slate-300">
              Install BinDrop on your Android phone to get{' '}
              <strong className="text-white">
                native lock-screen notifications, background turn alerts, and 1-tap Home Screen
                access
              </strong>
              :
            </p>

            {hasNativeAndroidPrompt && (
              <button
                type="button"
                onClick={onTriggerNativeAndroidPrompt}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#d0ff45] py-3 text-xs font-black text-[#050e07] shadow-[0_0_24px_rgba(208,255,69,0.3)] transition hover:bg-[#dcff69]"
              >
                <Download className="h-4 w-4" />
                Tap Here for Instant 1-Click Android Install
              </button>
            )}

            <div className="space-y-2.5">
              <div className="flex items-start gap-3 rounded-xl border border-[#1d3921] bg-[#0b1d0f] p-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#d0ff45]/20 text-xs font-black text-[#d0ff45]">
                  1
                </div>
                <div className="text-xs text-slate-200">
                  <p className="font-bold text-white">Tap the Browser Menu (⋮) in Chrome</p>
                  <p className="mt-0.5 text-slate-400">
                    Tap the{' '}
                    <span className="inline-flex items-center gap-0.5 text-[#d0ff45]">
                      <MoreVertical className="h-3 w-3" /> three dots
                    </span>{' '}
                    in the top-right corner of Chrome (or bottom bar on Samsung Internet).
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-xl border border-[#1d3921] bg-[#0b1d0f] p-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#d0ff45]/20 text-xs font-black text-[#d0ff45]">
                  2
                </div>
                <div className="text-xs text-slate-200">
                  <p className="font-bold text-white">
                    Select &ldquo;Install app&rdquo; or &ldquo;Add to Home screen&rdquo;
                  </p>
                  <p className="mt-0.5 text-slate-400">
                    Confirm by tapping <strong className="text-white">Install</strong> in the popup
                    dialog.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-xl border border-[#1d3921] bg-[#0b1d0f] p-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#d0ff45]/20 text-xs font-black text-[#d0ff45]">
                  3
                </div>
                <div className="text-xs text-slate-200">
                  <p className="font-bold text-white">
                    Open BinDrop from your Home Screen &amp; Turn On Alerts
                  </p>
                  <p className="mt-0.5 text-slate-400">
                    Launch the installed BinDrop app icon and flip{' '}
                    <strong className="text-[#d0ff45]">Turn on Alerts</strong> ON.
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <p className="text-xs leading-relaxed text-slate-300">
              Apple requires iPhones and iPads (iOS 16.4+) to add BinDrop to the Home Screen before{' '}
              <strong className="text-white">Instagram-style lock-screen push notifications</strong>{' '}
              can be enabled:
            </p>

            <div className="space-y-2.5">
              <div className="flex items-start gap-3 rounded-xl border border-[#1d3921] bg-[#0b1d0f] p-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#d0ff45]/20 text-xs font-black text-[#d0ff45]">
                  1
                </div>
                <div className="text-xs text-slate-200">
                  <p className="font-bold text-white">Tap the Share Button in Safari</p>
                  <p className="mt-0.5 text-slate-400">
                    Tap the{' '}
                    <span className="inline-flex items-center gap-1 font-semibold text-[#d0ff45]">
                      <Share className="h-3 w-3" /> Share
                    </span>{' '}
                    icon at the bottom center of your iPhone Safari toolbar.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-xl border border-[#1d3921] bg-[#0b1d0f] p-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#d0ff45]/20 text-xs font-black text-[#d0ff45]">
                  2
                </div>
                <div className="text-xs text-slate-200">
                  <p className="font-bold text-white">Select &ldquo;Add to Home Screen&rdquo;</p>
                  <p className="mt-0.5 text-slate-400">
                    Scroll down the Share sheet, tap{' '}
                    <span className="inline-flex items-center gap-1 font-semibold text-[#d0ff45]">
                      <PlusSquare className="h-3 w-3" /> Add to Home Screen
                    </span>
                    , then tap <strong className="text-white">Add</strong> in the top-right corner.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-xl border border-[#1d3921] bg-[#0b1d0f] p-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#d0ff45]/20 text-xs font-black text-[#d0ff45]">
                  3
                </div>
                <div className="text-xs text-slate-200">
                  <p className="font-bold text-white">
                    Open BinDrop from your Home Screen &amp; Flip &ldquo;Turn on Alerts&rdquo;
                  </p>
                  <p className="mt-0.5 text-slate-400">
                    Open the new{' '}
                    <span className="inline-flex items-center gap-1 font-semibold text-[#d0ff45]">
                      <ExternalLink className="h-3 w-3" /> BinDrop
                    </span>{' '}
                    app icon on your Home Screen and toggle{' '}
                    <strong className="text-[#d0ff45]">Turn on Alerts</strong> ON.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full rounded-xl border border-[#d0ff45]/40 bg-[#d0ff45]/15 py-2.5 text-xs font-extrabold text-[#d0ff45] transition hover:bg-[#d0ff45]/25"
        >
          Got It
        </button>
      </div>
    </div>
  );
};
