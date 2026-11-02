import React, { useRef, useState } from 'react';
import {
  Camera,
  Upload,
  CheckCircle2,
  X,
  ArrowRight,
  Clock,
  ShieldCheck,
} from 'lucide-react';
import {
  calculateDropPoints,
  type HouseholdMember,
} from '../utils/trashDutyLogic';
import { compressUploadedImage } from '../utils/sceneImageGenerator';
import { MemberAvatar } from './MemberAvatar';

interface VisionScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeAssignee: HouseholdMember;
  isOverdue: boolean;
  isHostOrAdmin: boolean;
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
  onSubmitTrashPhoto,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [locationNote, setLocationNote] = useState('Main outdoor trash bin');
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const rewardPreview = calculateDropPoints({
    completedBeforeDeadline: !isOverdue,
    currentStreak: activeAssignee.currentStreak,
  });

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMessage(null);
    setIsProcessingFile(true);
    try {
      const compressed = await compressUploadedImage(file);
      setPreviewDataUrl(compressed.dataUrl);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to process photo from device.'
      );
    } finally {
      setIsProcessingFile(false);
    }
  };

  const handleSubmit = async (verifyImmediatelyAsHost: boolean) => {
    if (!previewDataUrl) {
      setErrorMessage('Please snap or select a photo of the trash drop first.');
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Submit Trash Disposal Photo"
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto"
    >
      <div className="w-full max-w-lg glass-panel-elevated rounded-[36px] p-6 sm:p-8 space-y-6 animate-modal-enter my-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <MemberAvatar member={activeAssignee} size="sm" highlightRing />
            <div>
              <span className="text-[11px] og-medium text-[#d0ff45] block">
                Trash Disposal Photo Proof
              </span>
              <h2 className="text-lg og-bold text-white tracking-tight">
                {activeAssignee.displayName}&apos;s Turn
              </h2>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close photo upload modal"
            className="w-10 h-10 rounded-full bg-white/[0.08] hover:bg-white/[0.15] border border-white/10 flex items-center justify-center text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Turn Status & Points Info */}
        <div className="p-4 rounded-2xl bg-[#07190a] border border-white/10 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#d0ff45]" />
            <span className="text-zinc-300 og-regular">
              {isOverdue ? 'Late Submission (After Deadline)' : 'On-Time Submission Window'}
            </span>
          </div>
          <span className="font-mono og-bold text-[#d0ff45]">
            +{rewardPreview.pointsAwarded} pts upon Host Verification
          </span>
        </div>

        {/* Photo Upload / Camera Area */}
        <div className="space-y-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
            className="hidden"
            data-testid="trash-photo-file-input"
          />

          {previewDataUrl ? (
            <div className="relative rounded-3xl overflow-hidden border border-[#d0ff45]/50 bg-black aspect-video">
              <img
                src={previewDataUrl}
                alt="Trash drop preview"
                className="w-full h-full object-cover"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="absolute bottom-3 right-3 px-4 py-2 rounded-full bg-black/80 hover:bg-black text-xs og-medium text-white border border-white/20 flex items-center gap-1.5"
              >
                <Camera className="w-3.5 h-3.5 text-[#d0ff45]" />
                <span>Retake / Change Photo</span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              data-testid="open-camera-upload-btn"
              className="w-full py-12 px-6 rounded-3xl bg-[#08190a] hover:bg-[#0d2410] border-2 border-dashed border-[#d0ff45]/40 hover:border-[#d0ff45] transition-all flex flex-col items-center justify-center gap-3 text-center"
            >
              <div className="w-14 h-14 rounded-2xl bg-[#d0ff45] text-[#041206] flex items-center justify-center shadow-lg">
                <Camera className="w-7 h-7" />
              </div>
              <div className="space-y-1">
                <p className="text-base og-bold text-white">
                  {isProcessingFile ? 'Processing Photo...' : 'Snap or Upload Trash Photo'}
                </p>
                <p className="text-xs og-light text-zinc-400 max-w-xs mx-auto">
                  Take a clear photo of the trash bag at the outdoor bin. Your Host will review and verify the photo to complete your turn.
                </p>
              </div>
            </button>
          )}
        </div>

        {/* Location / Drop Note */}
        <div className="space-y-1.5">
          <label
            htmlFor="trash-location-note"
            className="block text-xs og-medium text-white pl-1"
          >
            Bin Location / Note (Optional)
          </label>
          <input
            id="trash-location-note"
            type="text"
            value={locationNote}
            onChange={(e) => setLocationNote(e.target.value)}
            placeholder="e.g., Green curbside bin by the driveway"
            className="pill-input w-full px-5 py-3.5 rounded-full text-xs og-regular text-white placeholder:text-zinc-500"
          />
        </div>

        {errorMessage && (
          <p className="text-xs text-rose-400 og-medium text-center">{errorMessage}</p>
        )}

        {/* Submit Actions */}
        <div className="space-y-2.5">
          <button
            type="button"
            disabled={isSubmitting || !previewDataUrl}
            onClick={() => handleSubmit(false)}
            data-testid="submit-photo-for-host-btn"
            className="lime-cta w-full py-4 px-6 rounded-full og-bold text-sm flex items-center justify-center gap-2 min-h-[52px] disabled:opacity-45"
          >
            <Upload className="w-4 h-4" />
            <span>
              {isSubmitting
                ? 'Uploading Photo...'
                : 'Submit Photo for Host Verification'}
            </span>
            <ArrowRight className="w-4 h-4" />
          </button>

          {isHostOrAdmin && previewDataUrl && (
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => handleSubmit(true)}
              data-testid="host-instant-verify-submit-btn"
              className="w-full py-3.5 px-6 rounded-full bg-[#132916] hover:bg-[#1a381e] border border-[#d0ff45]/50 text-[#d0ff45] og-bold text-xs flex items-center justify-center gap-2 transition-colors"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>
                Host Shortcut: Upload &amp; Verify Immediately (+{rewardPreview.pointsAwarded} pts &amp; Rotate Turn)
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
