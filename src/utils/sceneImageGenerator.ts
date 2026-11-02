export type PresetSceneId = 'outdoor_green_bin' | 'commercial_dumpster' | 'indoor_kitchen_bin';

export interface PresetSceneOption {
  id: PresetSceneId;
  title: string;
  subtitle: string;
  expectedOutcome: 'PASS' | 'REJECT';
  dataUrl: string;
}

function createSvgDataUrl(svgString: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svgString.trim())}`;
}

export const PRESET_SCENES: PresetSceneOption[] = [
  {
    id: 'outdoor_green_bin',
    title: 'Curbside Green Rollout Bin',
    subtitle: 'Tied black trash bag inside large 240L municipal wheeled bin outdoors',
    expectedOutcome: 'PASS',
    dataUrl: createSvgDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480" width="640" height="480">
        <defs>
          <linearGradient id="nightSky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#0b132b"/>
            <stop offset="65%" stop-color="#1c2541"/>
            <stop offset="100%" stop-color="#1e293b"/>
          </linearGradient>
          <linearGradient id="binBody" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#15803d"/>
            <stop offset="100%" stop-color="#064e3b"/>
          </linearGradient>
          <radialGradient id="streetGlow" cx="0.8" cy="0.15" r="0.55">
            <stop offset="0%" stop-color="#fde047" stop-opacity="0.32"/>
            <stop offset="100%" stop-color="#0b132b" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect width="640" height="480" fill="url(#nightSky)"/>
        <rect width="640" height="480" fill="url(#streetGlow)"/>
        <!-- Asphalt Curb & Driveway -->
        <rect x="0" y="340" width="640" height="140" fill="#0f172a"/>
        <rect x="0" y="332" width="640" height="12" fill="#334155"/>
        <!-- Fence & trees silhouette -->
        <rect x="30" y="190" width="580" height="142" fill="#111827" opacity="0.65"/>
        <!-- Open Lid of Green Municipal Bin -->
        <path d="M180 140 L375 95 L390 122 L195 162 Z" fill="#166534" stroke="#22c55e" stroke-width="2"/>
        <!-- Tied Black Garbage Bag Inside Top of Bin -->
        <ellipse cx="305" cy="182" rx="74" ry="48" fill="#1e293b" stroke="#475569" stroke-width="3"/>
        <path d="M292 132 L305 150 L320 130 L305 142 Z" fill="#0f172a" stroke="#94a3b8" stroke-width="2"/>
        <path d="M265 172 Q305 155 345 178" fill="none" stroke="#64748b" stroke-width="2.5" opacity="0.7"/>
        <!-- Large Green Wheeled Bin Body -->
        <polygon points="205,175 405,175 382,395 228,395" fill="url(#binBody)" stroke="#22c55e" stroke-width="2.5"/>
        <rect x="196" y="168" width="218" height="18" rx="6" fill="#16a34a"/>
        <!-- Recycling / Municipal Crest on Bin -->
        <rect x="268" y="242" width="74" height="58" rx="8" fill="#052e16" opacity="0.65" stroke="#4ade80" stroke-width="1.5"/>
        <text x="305" y="275" font-family="monospace" font-size="15" font-weight="bold" fill="#86efac" text-anchor="middle">CITY 240L</text>
        <!-- Heavy-Duty Wheels -->
        <circle cx="235" cy="402" r="26" fill="#090d16" stroke="#475569" stroke-width="6"/>
        <circle cx="235" cy="402" r="9" fill="#94a3b8"/>
        <circle cx="375" cy="402" r="26" fill="#090d16" stroke="#475569" stroke-width="6"/>
        <circle cx="375" cy="402" r="9" fill="#94a3b8"/>
        <!-- Second Tied Bag Next to Bin -->
        <ellipse cx="465" cy="368" rx="58" ry="46" fill="#1e293b" stroke="#475569" stroke-width="2.5"/>
        <path d="M455 316 L465 330 L476 315" fill="none" stroke="#94a3b8" stroke-width="3"/>
      </svg>
    `),
  },
  {
    id: 'commercial_dumpster',
    title: 'Apartment Utility Dumpster',
    subtitle: 'Two tied refuse bags placed in large outdoor metal dumpster enclosure',
    expectedOutcome: 'PASS',
    dataUrl: createSvgDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480" width="640" height="480">
        <defs>
          <linearGradient id="duskBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#0f172a"/>
            <stop offset="100%" stop-color="#1e293b"/>
          </linearGradient>
          <linearGradient id="dumpsterSteel" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#0369a1"/>
            <stop offset="100%" stop-color="#0c4a6e"/>
          </linearGradient>
        </defs>
        <rect width="640" height="480" fill="url(#duskBg)"/>
        <rect x="0" y="345" width="640" height="135" fill="#090d16"/>
        <!-- Brick enclosure wall -->
        <rect x="50" y="90" width="540" height="255" fill="#1e293b" stroke="#334155" stroke-width="2"/>
        <!-- Flip-top Dumpster Lids (Open) -->
        <rect x="125" y="118" width="185" height="45" rx="6" fill="#0f172a" stroke="#475569" stroke-width="2"/>
        <rect x="320" y="118" width="185" height="45" rx="6" fill="#0f172a" stroke="#475569" stroke-width="2"/>
        <!-- White & Black Trash Bags Inside Dumpster -->
        <ellipse cx="235" cy="182" rx="66" ry="42" fill="#e2e8f0" stroke="#94a3b8" stroke-width="2.5"/>
        <path d="M225 135 L235 148 L246 135" fill="none" stroke="#f97316" stroke-width="3.5"/>
        <ellipse cx="385" cy="186" rx="68" ry="44" fill="#1e293b" stroke="#64748b" stroke-width="2.5"/>
        <!-- Commercial Dumpster Body -->
        <rect x="115" y="185" width="410" height="190" rx="8" fill="url(#dumpsterSteel)" stroke="#38bdf8" stroke-width="2.5"/>
        <!-- Forklift Side Pockets & Ribs -->
        <rect x="92" y="245" width="28" height="36" fill="#082f49" stroke="#38bdf8" stroke-width="2"/>
        <rect x="520" y="245" width="28" height="36" fill="#082f49" stroke="#38bdf8" stroke-width="2"/>
        <line x1="215" y1="190" x2="215" y2="370" stroke="#0284c7" stroke-width="5"/>
        <line x1="320" y1="190" x2="320" y2="370" stroke="#0284c7" stroke-width="5"/>
        <line x1="425" y1="190" x2="425" y2="370" stroke="#0284c7" stroke-width="5"/>
        <text x="320" y="290" font-family="monospace" font-size="18" font-weight="bold" fill="#bae6fd" text-anchor="middle">MUNICIPAL WASTE · 4 YD</text>
      </svg>
    `),
  },
  {
    id: 'indoor_kitchen_bin',
    title: 'Indoor Kitchen Pedal Bin',
    subtitle: 'Small stainless wastebasket next to kitchen cabinets (Tests AI Rejection)',
    expectedOutcome: 'REJECT',
    dataUrl: createSvgDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480" width="640" height="480">
        <rect width="640" height="480" fill="#1e1b18"/>
        <!-- Indoor Kitchen Wall & Backsplash -->
        <rect x="0" y="0" width="640" height="320" fill="#292524"/>
        <!-- Kitchen Countertop & Cabinet -->
        <rect x="40" y="120" width="240" height="210" fill="#44403c" stroke="#57534e" stroke-width="2"/>
        <rect x="35" y="108" width="250" height="16" rx="3" fill="#d6d3d1"/>
        <!-- Indoor Hardwood Floor -->
        <rect x="0" y="320" width="640" height="160" fill="#451a03"/>
        <line x1="0" y1="360" x2="640" y2="360" stroke="#78350f" stroke-width="2"/>
        <line x1="0" y1="410" x2="640" y2="410" stroke="#78350f" stroke-width="2"/>
        <!-- Small Indoor Stainless Step Wastebasket -->
        <rect x="355" y="230" width="110" height="145" rx="12" fill="#94a3b8" stroke="#cbd5e1" stroke-width="2.5"/>
        <ellipse cx="410" cy="230" rx="55" ry="12" fill="#cbd5e1" stroke="#64748b" stroke-width="2"/>
        <rect x="392" y="366" width="36" height="10" rx="3" fill="#1e293b"/>
        <text x="410" y="305" font-family="monospace" font-size="12" font-weight="bold" fill="#1e293b" text-anchor="middle">INDOOR 10L</text>
      </svg>
    `),
  },
];

export async function renderSceneToJpegBase64(svgDataUrl: string): Promise<{
  dataUrl: string;
  mimeType: string;
}> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve({ dataUrl: svgDataUrl, mimeType: 'image/png' });
        return;
      }
      ctx.drawImage(img, 0, 0, 640, 480);
      const jpegUrl = canvas.toDataURL('image/jpeg', 0.86);
      resolve({ dataUrl: jpegUrl, mimeType: 'image/jpeg' });
    };
    img.onerror = () => {
      resolve({ dataUrl: svgDataUrl, mimeType: 'image/png' });
    };
    img.src = svgDataUrl;
  });
}

export async function compressUploadedImage(file: File): Promise<{
  dataUrl: string;
  mimeType: string;
}> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1024;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve({ dataUrl: String(reader.result), mimeType: file.type || 'image/jpeg' });
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.82);
        resolve({ dataUrl: compressedDataUrl, mimeType: 'image/jpeg' });
      };
      img.onerror = () =>
        resolve({ dataUrl: String(reader.result), mimeType: file.type || 'image/jpeg' });
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
