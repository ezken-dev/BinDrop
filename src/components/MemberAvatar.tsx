import React from 'react';
import type { HouseholdMember } from '../utils/trashDutyLogic';

function makeAvatarSvg(bg1: string, bg2: string, accent: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${bg1}"/>
        <stop offset="100%" stop-color="${bg2}"/>
      </linearGradient>
    </defs>
    <rect width="120" height="120" rx="60" fill="url(#g)"/>
    <circle cx="60" cy="44" r="21" fill="${accent}" opacity="0.9"/>
    <path d="M24 106 C28 78 92 78 96 106" fill="${accent}" opacity="0.85"/>
    <text x="60" y="51" font-family="sans-serif" font-size="16" font-weight="bold" fill="#060804" text-anchor="middle">${label}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const PRESET_AVATARS: { id: string; label: string; url: string }[] = [
  { id: 'lime_volt', label: 'Volt Lime', url: makeAvatarSvg('#1a2e05', '#0a1202', '#c6ff00', 'VL') },
  { id: 'neon_mint', label: 'Cyber Mint', url: makeAvatarSvg('#064e3b', '#022c22', '#34d399', 'CM') },
  { id: 'electric_sky', label: 'Ice Cyan', url: makeAvatarSvg('#0c4a6e', '#082f49', '#38bdf8', 'IC') },
  { id: 'solar_gold', label: 'Solar Gold', url: makeAvatarSvg('#451a03', '#1c0a00', '#facc15', 'SG') },
  { id: 'hyper_coral', label: 'Hyper Coral', url: makeAvatarSvg('#4c0519', '#1f020a', '#fb7185', 'HC') },
  { id: 'uv_pulse', label: 'UV Violet', url: makeAvatarSvg('#2e1065', '#13052b', '#c084fc', 'UV') },
];

interface MemberAvatarProps {
  member: Pick<HouseholdMember, 'displayName' | 'photoURL' | 'avatarColor'>;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  highlightRing?: boolean;
}

const SIZE_MAP = {
  sm: 'w-9 h-9 text-xs',
  md: 'w-11 h-11 text-sm',
  lg: 'w-14 h-14 text-base',
  xl: 'w-20 h-20 text-xl',
};

export const MemberAvatar: React.FC<MemberAvatarProps> = ({
  member,
  size = 'md',
  highlightRing = false,
}) => {
  const sizeClasses = SIZE_MAP[size];
  const ringClasses = highlightRing
    ? 'ring-2 ring-[#c6ff00] ring-offset-2 ring-offset-[#060804]'
    : 'border border-white/15';

  if (member.photoURL) {
    return (
      <div
        className={`${sizeClasses} ${ringClasses} rounded-full overflow-hidden bg-[#141812] shrink-0 relative`}
      >
        <img
          src={member.photoURL}
          alt={member.displayName}
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover"
        />
      </div>
    );
  }

  return (
    <div
      className={`${sizeClasses} ${ringClasses} rounded-full flex items-center justify-center font-bold text-[#060804] shrink-0 select-none`}
      style={{ backgroundColor: member.avatarColor || '#c6ff00' }}
    >
      {member.displayName.slice(0, 2).toUpperCase()}
    </div>
  );
};
