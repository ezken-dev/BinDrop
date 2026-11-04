import React, { useEffect, useState } from 'react';
import {
  Download,
  Smartphone,
  Share,
  PlusSquare,
  CheckCircle2,
  X,
  MoreVertical,
  BellRing,
  Sparkles,
  ExternalLink,
  ShieldAlert,
} from 'lucide-react';
import { isIosDevice, isStandalonePwa } from '../utils/pushClient';

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

let globalDeferredPrompt: BeforeInstallPromptEvent | null =
  typeof window !== 'undefined' && window.__bindropDeferredPwaPrompt
    ? window.__bindropDeferredPwaPrompt
    : null;
const promptListeners = new Set<(prompt: BeforeInstallPromptEvent | null) => void>();

function notifyPromptListeners(prompt: BeforeInstallPromptEvent | null) {
  globalDeferredPrompt = prompt;
  if (typeof window !== 'undefined') {
    window.__bindropDeferredPwaPrompt = prompt;
  }
  for (const listener of promptListeners) {
    listener(prompt);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    notifyPromptListeners(e as BeforeInstallPromptEvent);
  });

  window.addEventListener('bindrop-pwa-prompt-ready', () => {
    if (window.__bindropDeferredPwaPrompt) {
      notifyPromptListeners(window.__bindropDeferredPwaPrompt);
    }
  });

  window.addEventListener('appinstalled', () => {
    notifyPromptListeners(null);
  });
}

export function isAndroidDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent || '');
}

export function isVivoOrOemAndroidDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /vivo|V2\d{3}|iQOO|RMX|OPPO|CPH|MI |Redmi|POCO/i.test(navigator.userAgent || '');
}

export async function detectBraveBrowser(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  try {
    const navAny = navigator as any;
    if (navAny.brave && typeof navAny.brave.isBrave === 'function') {
      return Boolean(await navAny.brave.isBrave());
    }
  } catch {
    // ignore
  }
  return /Brave/i.test(navigator.userAgent || '');
}

export function buildAndroidChromeIntentUrl(): string {
  if (typeof window === 'undefined') return 'https://bindrop.netlify.app';
  const hostAndPath = `${window.location.host}${window.location.pathname}${window.location.search}`;
  return `intent://${hostAndPath}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(
    window.location.href
  )};end`;
}

interface InstallPwaBannerProps {
  compact?: boolean;
}

export const InstallPwaBanner: React.FC<InstallPwaBannerProps> = ({ compact = false }) => {
  const [standalone, setStandalone] = useState<boolean>(() => isStandalonePwa());
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(
    () =>
      (typeof window !== 'undefined' && window.__bindropDeferredPwaPrompt) ||
      globalDeferredPrompt
  );
  const [showGuideModal, setShowGuideModal] = useState(false);
  const [dismissedInSession, setDismissedInSession] = useState(false);
  const [justInstalled, setJustInstalled] = useState(false);
  const [isBrave, setIsBrave] = useState(false);

  const isIos = isIosDevice();
  const isAndroid = isAndroidDevice();
  const isVivoOem = isVivoOrOemAndroidDevice();

  useEffect(() => {
    setStandalone(isStandalonePwa());
    detectBraveBrowser().then(setIsBrave).catch(() => {});

    if (typeof window !== 'undefined' && window.__bindropDeferredPwaPrompt) {
      setDeferredPrompt(window.__bindropDeferredPwaPrompt);
    }

    const handlePromptChange = (prompt: BeforeInstallPromptEvent | null) => {
      setDeferredPrompt(prompt);
    };
    promptListeners.add(handlePromptChange);

    const handleInstalled = () => {
      setJustInstalled(true);
      setStandalone(true);
      setShowGuideModal(false);
    };
    window.addEventListener('appinstalled', handleInstalled);

    const mediaQuery = window.matchMedia
      ? window.matchMedia('(display-mode: standalone)')
      : null;
    const handleMediaChange = () => {
      setStandalone(isStandalonePwa());
    };
    mediaQuery?.addEventListener?.('change', handleMediaChange);

    return () => {
      promptListeners.delete(handlePromptChange);
      window.removeEventListener('appinstalled', handleInstalled);
      mediaQuery?.removeEventListener?.('change', handleMediaChange);
    };
  }, []);

  if (standalone || justInstalled || dismissedInSession) {
    return null;
  }

  const handleInstallClick = async () => {
    const promptToUse =
      deferredPrompt ||
      (typeof window !== 'undefined' ? window.__bindropDeferredPwaPrompt : null);

    if (promptToUse) {
      try {
        await promptToUse.prompt();
        const choice = await promptToUse.userChoice;
        if (choice.outcome === 'accepted') {
          notifyPromptListeners(null);
          setJustInstalled(true);
          return;
        }
      } catch {
        // Fall back to guide modal if browser blocked prompt
      }
    }
    setShowGuideModal(true);
  };

  const platformLabel = isIos
    ? 'Install BinDrop on iPhone / iPad'
    : isAndroid
    ? isBrave || isVivoOem
      ? 'Install Native BinDrop App (Vivo / Brave / Android)'
      : 'Install BinDrop App on Android'
    : 'Install BinDrop App';

  const platformButtonLabel = isIos
    ? 'Install on iPhone'
    : isAndroid
    ? deferredPrompt
      ? 'Install Android App Now'
      : 'Install Android App'
    : 'Install App';

  const chromeIntentUrl = buildAndroidChromeIntentUrl();

  return (
    <>
      <div
        data-testid="install-pwa-banner"
        className={`rounded-[26px] border border-[#d0ff45]/50 bg-gradient-to-r from-[#0b240e] via-[#0e2d13] to-[#081b0b] shadow-[0_14px_40px_rgba(0,0,0,0.55)] ${
          compact ? 'p-3.5' : 'p-4 sm:p-5'
        } transition-all`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3.5">
          <div className="flex items-start sm:items-center gap-3.5 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-[#d0ff45] text-[#041206] flex items-center justify-center shrink-0 shadow-[0_0_24px_rgba(208,255,69,0.35)]">
              <Smartphone className="w-5 h-5" />
            </div>

            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full bg-[#d0ff45]/20 text-[#d0ff45] og-bold">
                  {isIos
                    ? 'iOS Web App'
                    : isAndroid
                    ? isBrave
                      ? 'Brave / Android Native App'
                      : 'Android WebAPK'
                    : 'Standalone App'}
                </span>
                <span className="text-xs sm:text-sm og-bold text-white truncate">
                  {platformLabel}
                </span>
              </div>
              <p className="text-[11px] sm:text-xs text-zinc-300 leading-relaxed">
                {isIos
                  ? 'Running in browser mode. Add BinDrop to your iPhone Home Screen to unlock lock-screen push alerts & full-screen HUD.'
                  : isAndroid && (isBrave || isVivoOem)
                  ? 'Using Brave or Vivo? Tap "Install Android App" or "Open in Chrome" to install the real BinDrop APK with the BinDrop splash icon (no Brave logo).'
                  : isAndroid
                  ? 'Running in browser mode. Install BinDrop on your Android phone for instant lock-screen push notifications and 1-tap access.'
                  : 'Install BinDrop on your device for native lock-screen notifications and instant full-screen access.'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleInstallClick}
              data-testid="install-pwa-cta-btn"
              className="flex-1 sm:flex-initial px-4 py-2.5 rounded-full bg-[#d0ff45] hover:bg-[#dcff69] text-[#041206] text-xs og-bold flex items-center justify-center gap-1.5 shadow-[0_0_20px_rgba(208,255,69,0.28)] transition-transform active:scale-95 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{platformButtonLabel}</span>
            </button>

            {isAndroid && (isBrave || isVivoOem || !deferredPrompt) && (
              <a
                href={chromeIntentUrl}
                data-testid="open-in-chrome-install-link"
                className="px-3.5 py-2.5 rounded-full bg-white/10 hover:bg-white/15 border border-[#d0ff45]/40 text-[#d0ff45] text-xs og-bold flex items-center justify-center gap-1.5 whitespace-nowrap"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Open in Chrome (True App Icon)</span>
              </a>
            )}

            <button
              type="button"
              onClick={() => setDismissedInSession(true)}
              aria-label="Hide install prompt for now"
              className="p-2 rounded-full bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {showGuideModal && (
        <InstallPwaGuideModal
          isIos={isIos}
          isAndroid={isAndroid}
          isBrave={isBrave}
          isVivoOem={isVivoOem}
          deferredPrompt={deferredPrompt}
          onTriggerNativePrompt={async () => {
            if (!deferredPrompt) return;
            await deferredPrompt.prompt();
            const choice = await deferredPrompt.userChoice;
            if (choice.outcome === 'accepted') {
              notifyPromptListeners(null);
              setShowGuideModal(false);
            }
          }}
          onClose={() => setShowGuideModal(false)}
        />
      )}
    </>
  );
};

/**
 * Compact header pill button so users can also install from the top bar at any time
 * when browsing in Safari, Chrome, Brave, or Vivo Browser.
 */
export const InstallPwaHeaderButton: React.FC = () => {
  const [standalone, setStandalone] = useState<boolean>(() => isStandalonePwa());
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(
    () =>
      (typeof window !== 'undefined' && window.__bindropDeferredPwaPrompt) ||
      globalDeferredPrompt
  );
  const [showGuideModal, setShowGuideModal] = useState(false);
  const [isBrave, setIsBrave] = useState(false);

  const isIos = isIosDevice();
  const isAndroid = isAndroidDevice();
  const isVivoOem = isVivoOrOemAndroidDevice();

  useEffect(() => {
    setStandalone(isStandalonePwa());
    detectBraveBrowser().then(setIsBrave).catch(() => {});

    const handlePromptChange = (prompt: BeforeInstallPromptEvent | null) => {
      setDeferredPrompt(prompt);
    };
    promptListeners.add(handlePromptChange);

    const handleInstalled = () => {
      setStandalone(true);
      setShowGuideModal(false);
    };
    window.addEventListener('appinstalled', handleInstalled);

    return () => {
      promptListeners.delete(handlePromptChange);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

  if (standalone) return null;

  const handleClick = async () => {
    const promptToUse =
      deferredPrompt ||
      (typeof window !== 'undefined' ? window.__bindropDeferredPwaPrompt : null);

    if (promptToUse) {
      try {
        await promptToUse.prompt();
        const choice = await promptToUse.userChoice;
        if (choice.outcome === 'accepted') {
          notifyPromptListeners(null);
          return;
        }
      } catch {
        // Fall back to guide modal
      }
    }
    setShowGuideModal(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        data-testid="header-install-app-btn"
        className="px-3 py-1.5 rounded-full bg-[#102913] hover:bg-[#17391b] border border-[#d0ff45]/50 text-[#d0ff45] text-xs og-bold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
      >
        <Download className="w-3.5 h-3.5" />
        <span>
          {isIos ? 'Install on iOS' : isAndroid ? 'Install Android' : 'Install App'}
        </span>
      </button>

      {showGuideModal && (
        <InstallPwaGuideModal
          isIos={isIos}
          isAndroid={isAndroid}
          isBrave={isBrave}
          isVivoOem={isVivoOem}
          deferredPrompt={deferredPrompt}
          onTriggerNativePrompt={async () => {
            if (!deferredPrompt) return;
            await deferredPrompt.prompt();
            const choice = await deferredPrompt.userChoice;
            if (choice.outcome === 'accepted') {
              notifyPromptListeners(null);
              setShowGuideModal(false);
            }
          }}
          onClose={() => setShowGuideModal(false)}
        />
      )}
    </>
  );
};

interface InstallPwaGuideModalProps {
  isIos: boolean;
  isAndroid: boolean;
  isBrave: boolean;
  isVivoOem: boolean;
  deferredPrompt: BeforeInstallPromptEvent | null;
  onTriggerNativePrompt: () => Promise<void>;
  onClose: () => void;
}

const InstallPwaGuideModal: React.FC<InstallPwaGuideModalProps> = ({
  isIos,
  isAndroid,
  isBrave,
  isVivoOem,
  deferredPrompt,
  onTriggerNativePrompt,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'android' | 'ios'>(
    isIos ? 'ios' : 'android'
  );

  const chromeIntentUrl = buildAndroidChromeIntentUrl();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Install BinDrop App Guide"
      className="fixed inset-0 z-[150] bg-black/80 backdrop-blur-md flex items-center justify-center p-4"
    >
      <div className="w-full max-w-md glass-panel-elevated rounded-[32px] p-6 border border-[#d0ff45]/45 space-y-5 animate-modal-enter max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-[#d0ff45] text-[#041206] flex items-center justify-center shrink-0">
              <Download className="w-5 h-5" />
            </div>
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-[#d0ff45] og-bold block">
                Full-Screen App + Lock-Screen Alerts
              </span>
              <h3 className="text-lg og-bold text-white">
                Install BinDrop on Your Phone
              </h3>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close install guide"
            className="p-2 rounded-full bg-white/10 hover:bg-white/15 text-zinc-300 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Platform Switcher Tabs */}
        <div className="grid grid-cols-2 gap-2 p-1 rounded-2xl bg-[#061408] border border-white/10">
          <button
            type="button"
            onClick={() => setActiveTab('android')}
            className={`py-2 px-3 rounded-xl text-xs og-bold transition-all flex items-center justify-center gap-1.5 ${
              activeTab === 'android'
                ? 'bg-[#d0ff45] text-[#041206]'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>Android (Samsung / Vivo)</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('ios')}
            className={`py-2 px-3 rounded-xl text-xs og-bold transition-all flex items-center justify-center gap-1.5 ${
              activeTab === 'ios'
                ? 'bg-[#d0ff45] text-[#041206]'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Share className="w-3.5 h-3.5" />
            <span>iPhone / iPad (iOS)</span>
          </button>
        </div>

        {activeTab === 'android' ? (
          <div className="space-y-4">
            {deferredPrompt && (
              <div className="p-4 rounded-2xl bg-[#0e2a12] border border-[#d0ff45]/50 space-y-3">
                <p className="text-xs text-zinc-200 leading-relaxed">
                  Your Android browser is ready for 1-tap native app installation:
                </p>
                <button
                  type="button"
                  onClick={onTriggerNativePrompt}
                  className="w-full py-3 px-4 rounded-full bg-[#d0ff45] text-[#041206] text-xs og-bold flex items-center justify-center gap-2 shadow-lg"
                >
                  <Download className="w-4 h-4" />
                  <span>Install BinDrop App Now</span>
                </button>
              </div>
            )}

            {/* Special Vivo & Brave Browser Fix Card */}
            <div className="p-4 rounded-2xl bg-[#102614] border border-[#d0ff45]/40 space-y-3">
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="w-4 h-4 text-[#d0ff45] shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-xs og-bold text-white">
                    Using Brave Browser or a Vivo / Xiaomi Phone?
                  </p>
                  <p className="text-[11px] text-zinc-300 leading-relaxed">
                    Brave Browser disables Google Play&apos;s native WebAPK builder by default (which causes it to show the <strong className="text-white">Brave logo</strong> when opening). To install the <strong className="text-[#d0ff45]">real standalone BinDrop app with the BinDrop splash icon</strong>:
                  </p>
                </div>
              </div>

              {isAndroid && (
                <a
                  href={chromeIntentUrl}
                  className="w-full py-3 px-4 rounded-full bg-[#d0ff45] hover:bg-[#dcff69] text-[#041206] text-xs og-bold flex items-center justify-center gap-2 shadow-md transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  <span>1-Tap: Open in Google Chrome for True App Install</span>
                </a>
              )}

              {(isVivoOem || isBrave || isAndroid) && (
                <div className="p-3 rounded-xl bg-black/35 border border-white/10 text-[11px] text-zinc-300 space-y-1.5">
                  <p className="og-bold text-[#d0ff45]">
                    Vivo OriginOS / FuntouchOS Permission Tip:
                  </p>
                  <p>
                    If the icon does not appear on your Vivo home screen after tapping Install, open{' '}
                    <strong className="text-white">
                      Settings → Apps → Chrome (or Brave) → Permissions
                    </strong>{' '}
                    and turn ON{' '}
                    <strong className="text-[#d0ff45]">&ldquo;Home screen shortcuts&rdquo;</strong>.
                  </p>
                </div>
              )}
            </div>

            <div className="p-4 rounded-2xl bg-[#07190a] border border-white/10 space-y-3.5 text-xs text-zinc-200">
              <p className="text-xs og-bold text-[#d0ff45] flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                <span>How to Install as a Native App (No Browser Logo):</span>
              </p>

              <div className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-[#d0ff45] text-[#041206] og-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                  1
                </span>
                <div>
                  <p className="og-bold text-white flex items-center gap-1.5">
                    Tap the Browser Menu{' '}
                    <MoreVertical className="w-3.5 h-3.5 text-[#d0ff45] inline" />
                  </p>
                  <p className="text-zinc-400 text-[11px] mt-0.5">
                    In Chrome or Brave, tap the 3-dots menu in the top-right (or bottom-right in Brave).
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-[#d0ff45] text-[#041206] og-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                  2
                </span>
                <div>
                  <p className="og-bold text-white flex items-center gap-1.5">
                    Select &ldquo;Install app&rdquo; (NOT just &ldquo;Add to Home screen&rdquo;)
                  </p>
                  <p className="text-zinc-400 text-[11px] mt-0.5">
                    Choosing <strong className="text-white">&ldquo;Install app&rdquo;</strong> compiles the native BinDrop package with the BinDrop splash screen.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-[#d0ff45] text-[#041206] og-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                  3
                </span>
                <div>
                  <p className="og-bold text-white flex items-center gap-1.5">
                    Open BinDrop &amp; Enable Lock-Screen Alerts{' '}
                    <BellRing className="w-3.5 h-3.5 text-[#d0ff45] inline" />
                  </p>
                  <p className="text-zinc-400 text-[11px] mt-0.5">
                    Launch BinDrop from your app drawer and toggle ON &ldquo;Turn on Alerts&rdquo;.
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 rounded-2xl bg-[#07190a] border border-white/10 space-y-3.5 text-xs text-zinc-200">
            <p className="text-xs og-bold text-[#d0ff45] flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              <span>How to Install on iPhone / iPad (Safari):</span>
            </p>

            <div className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-full bg-[#d0ff45] text-[#041206] og-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                1
              </span>
              <div>
                <p className="og-bold text-white flex items-center gap-1.5">
                  Tap the Safari <Share className="w-3.5 h-3.5 text-[#d0ff45] inline" /> Share Button
                </p>
                <p className="text-zinc-400 text-[11px] mt-0.5">
                  Located in the bottom toolbar of Safari on your iPhone.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-full bg-[#d0ff45] text-[#041206] og-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                2
              </span>
              <div>
                <p className="og-bold text-white flex items-center gap-1.5">
                  Tap &ldquo;Add to Home Screen&rdquo;{' '}
                  <PlusSquare className="w-3.5 h-3.5 text-[#d0ff45] inline" />
                </p>
                <p className="text-zinc-400 text-[11px] mt-0.5">
                  Scroll down the Share sheet and tap &ldquo;Add to Home Screen&rdquo;, then tap &ldquo;Add&rdquo;.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-full bg-[#d0ff45] text-[#041206] og-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                3
              </span>
              <div>
                <p className="og-bold text-white flex items-center gap-1.5">
                  Open BinDrop from Home Screen{' '}
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#d0ff45] inline" />
                </p>
                <p className="text-zinc-400 text-[11px] mt-0.5">
                  Launch the BinDrop icon from your Home Screen and toggle ON &ldquo;Turn on Alerts&rdquo; for iOS 16.4+ lock-screen push notifications.
                </p>
              </div>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="w-full py-3 rounded-full bg-[#d0ff45] text-[#041206] text-xs og-bold"
        >
          Got It
        </button>
      </div>
    </div>
  );
};
