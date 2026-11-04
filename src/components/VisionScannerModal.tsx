import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image as ImageIcon,
  Zap,
  ZapOff,
  ChevronRight,
  Check,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  calculateDropPoints,
  type HouseholdMember,
} from '../utils/trashDutyLogic';
import {
  compressUploadedImage,
  generateSimulatedTrashSceneDataUrl,
} from '../utils/sceneImageGenerator';

interface VisionScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeAssignee: HouseholdMember;
  isOverdue: boolean;
  isHostOrAdmin: boolean;
  rotationIntervalHours?: number;
  onSubmitTrashPhoto: (payload: {
    imageUrl: string;
    locationNote: string;
    verifyImmediatelyAsHost: boolean;
    pointsAwarded: number;
    nextStreak: number;
    completedOnTime: boolean;
  }) => Promise<void>;
}

export const VisionScannerModal: React.FC<VisionScannerModalProps> = ({
  isOpen,
  onClose,
  activeAssignee,
  isOverdue,
  isHostOrAdmin,
  rotationIntervalHours = 96,
  onSubmitTrashPhoto,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [locationNote, setLocationNote] = useState('Main outdoor trash bin');
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [flashEnabled, setFlashEnabled] = useState(false);
  const [shutterFlashActive, setShutterFlashActive] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const stopCameraStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  }, []);

  const startCameraStream = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setCameraActive(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setCameraActive(true);
    } catch {
      setCameraActive(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen && !previewDataUrl) {
      startCameraStream();
    } else {
      stopCameraStream();
    }
    return () => {
      stopCameraStream();
    };
  }, [isOpen, previewDataUrl, startCameraStream, stopCameraStream]);

  const toggleFlash = async () => {
    const nextState = !flashEnabled;
    setFlashEnabled(nextState);
    try {
      const track = streamRef.current?.getVideoTracks()?.[0];
      if (track && 'applyConstraints' in track) {
        await track.applyConstraints({
          advanced: [{ torch: nextState } as MediaTrackConstraintSet],
        });
      }
    } catch {
      // Hardware torch not supported on this device; visual shutter flash still works
    }
  };

  const triggerAnalysisTransition = (dataUrl: string) => {
    setPreviewDataUrl(dataUrl);
    setIsAnalyzing(true);
    setTimeout(() => {
      setIsAnalyzing(false);
    }, 650);
  };

  const handleCaptureFromLiveCamera = () => {
    setErrorMessage(null);
    if (flashEnabled) {
      setShutterFlashActive(true);
      setTimeout(() => setShutterFlashActive(false), 180);
    }

    const video = videoRef.current;
    if (cameraActive && video && video.videoWidth > 0 && video.videoHeight > 0) {
      try {
        const canvas = document.createElement('canvas');
        const maxDim = 560;
        const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#041206';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
          if (dataUrl && dataUrl.length > 500) {
            stopCameraStream();
            triggerAnalysisTransition(dataUrl);
            return;
          }
        }
      } catch {
        // Fallback to gallery picker below
      }
    }

    // If no live hardware camera stream is running, open the file/gallery picker
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMessage(null);
    setIsProcessingFile(true);
    try {
      const compressed = await compressUploadedImage(file);
      stopCameraStream();
      triggerAnalysisTransition(compressed.dataUrl);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to process photo from device.'
      );
    } finally {
      setIsProcessingFile(false);
      e.target.value = '';
    }
  };

  const rewardPreview = calculateDropPoints({
    completedBeforeDeadline: !isOverdue,
    currentStreak: activeAssignee.currentStreak,
  });

  const handleSubmit = async (verifyImmediatelyAsHost: boolean) => {
    if (!previewDataUrl) {
      handleCaptureFromLiveCamera();
      return;
    }
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await onSubmitTrashPhoto({
        imageUrl: previewDataUrl,
        locationNote: locationNote.trim() || 'Outdoor trash bin',
        verifyImmediatelyAsHost,
        pointsAwarded: rewardPreview.pointsAwarded,
        nextStreak: rewardPreview.nextStreak,
        completedOnTime: !isOverdue,
      });
      setPreviewDataUrl(null);
      onClose();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to upload trash disposal photo.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const rotationDays = Math.max(1, Math.round(rotationIntervalHours / 24));
  const nextCycleLabel = `Next: ${rotationDays} ${rotationDays === 1 ? 'Day' : 'Days'} (${rotationIntervalHours}h)`;

  const fallbackBackdropUrl = generateSimulatedTrashSceneDataUrl({
    memberName: activeAssignee.displayName,
    variant: 'valid_bag_in_bin',
  });

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Duty Photo Upload"
          initial={{ opacity: 0, scale: 0.96, y: 18 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 18 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className="fixed inset-0 z-50 bg-[#050e06] flex items-center justify-center sm:p-4"
        >
          {/* Centered Mobile-Proportioned Camera Shell on Desktop, Full-Bleed on Phone */}
          <div className="relative w-full h-full sm:max-w-[430px] sm:h-[88vh] sm:max-h-[860px] sm:rounded-[44px] sm:border-2 sm:border-[#c8ff2e]/40 overflow-hidden bg-[#101912] flex flex-col justify-between shadow-[0_32px_90px_rgba(0,0,0,0.92)]">
            {/* Hidden File Input for Gallery / Native Camera */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
              data-testid="trash-photo-file-input"
            />

            {/* Visual Shutter Flash Overlay */}
            <AnimatePresence>
              {shutterFlashActive && (
                <motion.div
                  initial={{ opacity: 0.9 }}
                  animate={{ opacity: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.22 }}
                  className="absolute inset-0 z-40 bg-white pointer-events-none"
                />
              )}
            </AnimatePresence>

            {/* Full-Bleed Camera / Photo Preview Layer */}
            <div className="absolute inset-0 z-0 bg-[#141d15]">
              {previewDataUrl ? (
                <motion.img
                  key="captured-preview"
                  initial={{ scale: 1.04, opacity: 0.8 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                  src={previewDataUrl}
                  alt="Captured trash disposal proof"
                  className="w-full h-full object-cover"
                />
              ) : (
                <>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className={`w-full h-full object-cover transition-opacity duration-300 ${
                      cameraActive ? 'opacity-100' : 'opacity-0'
                    }`}
                  />
                  {!cameraActive && (
                    <div className="absolute inset-0">
                      <img
                        src={fallbackBackdropUrl}
                        alt="Trash viewfinder backdrop"
                        className="w-full h-full object-cover opacity-55 brightness-75 contrast-110"
                      />
                      <div className="absolute inset-0 bg-gradient-to-b from-[#071309]/70 via-transparent to-[#071309]/90" />
                    </div>
                  )}
                </>
              )}
            </div>

            {/* TOP FLOATING GLASS HEADER PILL (Matches Reference Right Screen) */}
            <div className="relative z-20 pt-5 px-4 sm:px-5">
              <div className="w-full rounded-[24px] bg-[#2a332b]/80 backdrop-blur-xl border border-white/15 px-4 py-3.5 flex items-center justify-between gap-3 shadow-lg">
                <div className="flex items-center gap-3.5 min-w-0">
                  {/* Scanner Bracket Emblem */}
                  <div className="w-11 h-11 rounded-2xl bg-[#182619]/90 border border-[#c8ff2e]/30 flex items-center justify-center shrink-0">
                    <svg
                      className="w-5 h-5 text-[#c8ff2e]"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 8V6a2 2 0 0 1 2-2h2" />
                      <path d="M4 16v2a2 2 0 0 0 2 2h2" />
                      <path d="M16 4h2a2 2 0 0 1 2 2v2" />
                      <path d="M16 20h2a2 2 0 0 0 2-2v-2" />
                      <path d="M10 9.5a2.5 2.5 0 1 0 0 5" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-base sm:text-[17px] og-bold text-white truncate">
                      Duty Photo Upload
                    </h2>
                    <p className="text-xs text-zinc-300/90 og-regular truncate">
                      {nextCycleLabel}
                    </p>
                  </div>
                </div>

                <motion.button
                  type="button"
                  whileTap={{ scale: 0.9 }}
                  onClick={onClose}
                  aria-label="Close Duty Photo Upload"
                  className="w-9 h-9 rounded-full bg-white/[0.06] hover:bg-white/[0.14] flex items-center justify-center text-zinc-200 transition-colors shrink-0"
                >
                  <ChevronRight className="w-5 h-5" />
                </motion.button>
              </div>
            </div>

            {/* CENTER LIME VIEWFINDER BRACKETS & DETECTION OVERLAY (Matches Reference Right Screen) */}
            <div className="relative z-20 flex-1 flex flex-col items-center justify-center px-7 py-4">
              <motion.div
                animate={{
                  scale: previewDataUrl ? 0.98 : 1,
                }}
                transition={{ type: 'spring', stiffness: 320, damping: 24 }}
                className="relative w-full max-w-[290px] aspect-square flex items-center justify-center"
              >
                {/* Outer 4 Thick Lime Corner Brackets */}
                <div className="absolute -top-3 -left-3 w-12 h-12 border-t-[4px] border-l-[4px] border-[#c8ff2e] rounded-tl-[22px] pointer-events-none" />
                <div className="absolute -top-3 -right-3 w-12 h-12 border-t-[4px] border-r-[4px] border-[#c8ff2e] rounded-tr-[22px] pointer-events-none" />
                <div className="absolute -bottom-3 -left-3 w-12 h-12 border-b-[4px] border-l-[4px] border-[#c8ff2e] rounded-bl-[22px] pointer-events-none" />
                <div className="absolute -bottom-3 -right-3 w-12 h-12 border-b-[4px] border-r-[4px] border-[#c8ff2e] rounded-br-[22px] pointer-events-none" />

                {/* Inner Translucent Olive-Tinted Framing Box with Inner Brackets */}
                <div className="relative w-full h-full rounded-[24px] bg-[#364d18]/35 backdrop-blur-[2px] border border-[#c8ff2e]/35 flex flex-col items-center justify-center gap-2.5 p-5">
                  {/* Inner subtle corner ticks */}
                  <div className="absolute top-2.5 left-2.5 w-6 h-6 border-t-[2.5px] border-l-[2.5px] border-[#c8ff2e]/85 rounded-tl-xl pointer-events-none" />
                  <div className="absolute top-2.5 right-2.5 w-6 h-6 border-t-[2.5px] border-r-[2.5px] border-[#c8ff2e]/85 rounded-tr-xl pointer-events-none" />
                  <div className="absolute bottom-2.5 left-2.5 w-6 h-6 border-b-[2.5px] border-l-[2.5px] border-[#c8ff2e]/85 rounded-bl-xl pointer-events-none" />
                  <div className="absolute bottom-2.5 right-2.5 w-6 h-6 border-b-[2.5px] border-r-[2.5px] border-[#c8ff2e]/85 rounded-br-xl pointer-events-none" />

                  {/* Center Status Pills inside the Viewfinder */}
                  <motion.div
                    key={previewDataUrl ? 'detected' : 'scanning'}
                    initial={{ opacity: 0, scale: 0.92, y: 6 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    className="flex flex-col items-center gap-2.5"
                  >
                    <div className="px-4 py-1.5 rounded-full bg-[#253812]/90 border border-[#c8ff2e]/70 text-[#d8ff66] text-sm og-medium shadow-md">
                      {previewDataUrl ? 'Waste Detected' : 'Waste Detected'}
                    </div>
                    <div className="px-4 py-1.5 rounded-full bg-[#253812]/90 border border-[#c8ff2e]/60 text-[#d8ff66] text-sm og-medium shadow-md">
                      {isProcessingFile
                        ? 'Processing...'
                        : isAnalyzing
                        ? 'Analyzing...'
                        : previewDataUrl
                        ? `Ready (+${rewardPreview.pointsAwarded} pts)`
                        : 'Analyzing...'}
                    </div>
                  </motion.div>
                </div>
              </motion.div>

              {/* Helper Pill & Optional Retake / Location Note below Frame */}
              <div className="mt-6 w-full flex flex-col items-center gap-2.5">
                {!previewDataUrl ? (
                  <div className="px-5 py-2 rounded-full bg-[#262f28]/85 backdrop-blur-md border border-white/10 text-xs sm:text-sm text-zinc-200 og-regular shadow">
                    Center trash in frame
                  </div>
                ) : (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="w-full max-w-[320px] space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        id="trash-location-note"
                        type="text"
                        value={locationNote}
                        onChange={(e) => setLocationNote(e.target.value)}
                        placeholder="Bin location note..."
                        className="flex-1 px-4 py-2 rounded-full bg-[#122214]/90 border border-[#c8ff2e]/35 text-xs text-white placeholder:text-zinc-400 focus:outline-none focus:border-[#c8ff2e]"
                      />
                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.94 }}
                        onClick={() => setPreviewDataUrl(null)}
                        className="px-3.5 py-2 rounded-full bg-[#262f28]/90 border border-white/15 text-xs og-medium text-zinc-200 flex items-center gap-1 shrink-0"
                      >
                        <RotateCcw className="w-3.5 h-3.5 text-[#c8ff2e]" />
                        <span>Retake</span>
                      </motion.button>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.96 }}
                        disabled={isSubmitting}
                        onClick={() => handleSubmit(false)}
                        data-testid="submit-photo-for-host-btn"
                        className="lime-cta w-full py-2.5 px-5 rounded-full text-xs og-bold flex items-center justify-center gap-1.5"
                      >
                        <Check className="w-4 h-4" />
                        <span>
                          {isSubmitting
                            ? 'Uploading Photo...'
                            : 'Submit Photo for Host Verification'}
                        </span>
                      </motion.button>

                      {isHostOrAdmin && (
                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.96 }}
                          disabled={isSubmitting}
                          onClick={() => handleSubmit(true)}
                          data-testid="host-instant-verify-submit-btn"
                          className="w-full py-2 px-4 rounded-full bg-[#132916]/95 border border-[#c8ff2e]/50 text-[#c8ff2e] text-[11px] og-bold flex items-center justify-center gap-1.5"
                        >
                          <ShieldCheck className="w-3.5 h-3.5" />
                          <span>
                            Host: Instant Verify (+{rewardPreview.pointsAwarded} pts &amp; Rotate)
                          </span>
                        </motion.button>
                      )}
                    </div>
                  </motion.div>
                )}

                {errorMessage && (
                  <p className="text-xs text-rose-400 og-medium text-center bg-black/60 px-3 py-1 rounded-full">
                    {errorMessage}
                  </p>
                )}
              </div>
            </div>

            {/* BOTTOM CAMERA CONTROL DECK (Matches Reference Right Screen) */}
            <div className="relative z-20 rounded-t-[34px] bg-[#162018]/95 backdrop-blur-2xl border-t border-white/10 px-7 pt-5 pb-7 flex items-center justify-between">
              {/* Left: Upload from Gallery */}
              <div className="flex flex-col items-center gap-1.5 w-24">
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.9 }}
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="open-camera-upload-btn"
                  aria-label="Upload from Gallery"
                  className="w-13 h-13 rounded-full bg-[#253027] hover:bg-[#2f3d31] border border-white/15 flex items-center justify-center text-zinc-200 transition-colors shadow-md"
                >
                  <ImageIcon className="w-5 h-5" />
                </motion.button>
                <span className="text-[11px] text-zinc-300 og-regular text-center leading-tight">
                  Upload from
                  <br />
                  Gallery
                </span>
              </div>

              {/* Center: Large Circular Lime Shutter / Submit Button */}
              <div className="flex flex-col items-center">
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.9 }}
                  disabled={isSubmitting || isProcessingFile}
                  onClick={() => {
                    if (previewDataUrl) {
                      handleSubmit(isHostOrAdmin);
                    } else {
                      handleCaptureFromLiveCamera();
                    }
                  }}
                  aria-label={previewDataUrl ? 'Confirm and Upload Trash Photo' : 'Capture Trash Photo'}
                  className="w-20 h-20 rounded-full p-1.5 border-[3px] border-[#c8ff2e] shadow-[0_0_36px_rgba(200,255,46,0.45)] flex items-center justify-center bg-[#0c1a0e] disabled:opacity-50"
                >
                  <div className="w-full h-full rounded-full bg-[#c8ff2e] flex items-center justify-center text-[#071809]">
                    {previewDataUrl ? (
                      <Check className="w-8 h-8 stroke-[2.8]" />
                    ) : (
                      /* Camera Aperture Shutter Icon matching Reference */
                      <svg
                        className="w-9 h-9"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="14.31" y1="8" x2="20.05" y2="17.94" />
                        <line x1="9.69" y1="8" x2="21.17" y2="8" />
                        <line x1="7.38" y1="12" x2="13.12" y2="2.06" />
                        <line x1="9.69" y1="16" x2="3.95" y2="6.06" />
                        <line x1="14.31" y1="16" x2="2.83" y2="16" />
                        <line x1="16.62" y1="12" x2="10.88" y2="21.94" />
                      </svg>
                    )}
                  </div>
                </motion.button>
              </div>

              {/* Right: Flash Toggle */}
              <div className="flex flex-col items-center gap-1.5 w-24">
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.9 }}
                  onClick={toggleFlash}
                  aria-label="Toggle Flash"
                  className={`w-13 h-13 rounded-full border flex items-center justify-center transition-colors shadow-md ${
                    flashEnabled
                      ? 'bg-[#c8ff2e]/20 border-[#c8ff2e] text-[#c8ff2e]'
                      : 'bg-[#253027] hover:bg-[#2f3d31] border-white/15 text-zinc-200'
                  }`}
                >
                  {flashEnabled ? (
                    <Zap className="w-5 h-5" />
                  ) : (
                    <ZapOff className="w-5 h-5" />
                  )}
                </motion.button>
                <span className="text-[11px] text-zinc-300 og-regular text-center">
                  Flash
                </span>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
