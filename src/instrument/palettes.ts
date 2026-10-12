/**
 * Wobble — palette scenes (global color stories for the instrument)
 */

export interface Palette {
  name: string;
  bg: string;
  colors: [string, string, string, string, string];
}

export const PALETTES: Palette[] = [
  {
    name: 'Candy Shop',
    bg: '#FFF7EC',
    colors: ['#FF5CA8', '#4D7CFE', '#FFC53D', '#35E0A1', '#A06BFF'],
  },
  {
    name: 'Citrus Punch',
    bg: '#FFF9EC',
    colors: ['#FF9F1C', '#FFD23F', '#2EC4B6', '#F46036', '#7BDFF2'],
  },
  {
    name: 'Berry Blast',
    bg: '#1E1033',
    colors: ['#FF4D8D', '#B967FF', '#5E60CE', '#FF8FAB', '#FFD6E0'],
  },
  {
    name: 'Sour Apple',
    bg: '#0E2418',
    colors: ['#B8F135', '#35E0A1', '#FFF15C', '#4D7CFE', '#FF5CA8'],
  },
];

const STORAGE_KEY = 'wobble-palette-v1';
let activeIndex = 0;

try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== null) {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n >= 0 && n < PALETTES.length) activeIndex = n;
  }
} catch {
  // storage unavailable — keep default
}

export function getPalette(): Palette {
  return PALETTES[activeIndex];
}

export function getPaletteIndex(): number {
  return activeIndex;
}

export function setPaletteIndex(i: number): void {
  if (i < 0 || i >= PALETTES.length) return;
  activeIndex = i;
  try {
    localStorage.setItem(STORAGE_KEY, String(i));
  } catch {
    // ignore
  }
}

/** Convert #rrggbb + alpha (0..1) to rgba() string. */
export function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}
