/** Team color utilities with WCAG contrast handling. */

export function isHex(s: string): boolean { return /^#[0-9a-fA-F]{6}$/.test(s); }

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** White or near-black text, whichever reads better on `bg`. */
export function readableTextOn(bg: string): '#FFFFFF' | '#0B0F17' {
  return contrastRatio(bg, '#FFFFFF') >= contrastRatio(bg, '#0B0F17') ? '#FFFFFF' : '#0B0F17';
}

function mix(hex: string, target: string, t: number): string {
  const a = hexToRgb(hex), b = hexToRgb(target);
  return rgbToHex(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
}

/**
 * Nudge a team color toward black or white until it reaches `min` contrast against
 * `bg`. Used for text/icons drawn in team colors on app surfaces.
 */
export function ensureContrast(fg: string, bg: string, min = 4.5): string {
  if (contrastRatio(fg, bg) >= min) return fg.toUpperCase();
  const target = luminance(bg) > 0.4 ? '#000000' : '#FFFFFF';
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(fg, target, t);
    if (contrastRatio(c, bg) >= min) return c;
  }
  return target;
}

export interface ColorCheck { ratio: number; level: 'AAA' | 'AA' | 'AA large' | 'fail' }
export function checkPair(primary: string, secondary: string): ColorCheck {
  const ratio = Math.round(contrastRatio(primary, secondary) * 100) / 100;
  const level = ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA large' : 'fail';
  return { ratio, level };
}

export const PRESET_PALETTES: { name: string; primary: string; secondary: string }[] = [
  { name: 'Midnight Gold', primary: '#14213D', secondary: '#FCA311' },
  { name: 'Crimson Steel', primary: '#9B1B30', secondary: '#D9DDE3' },
  { name: 'Forest Bolt', primary: '#1B4332', secondary: '#B7E4C7' },
  { name: 'Harbor', primary: '#0B4F6C', secondary: '#F2F4F3' },
  { name: 'Ember', primary: '#C2410C', secondary: '#1C1917' },
  { name: 'Royal Ice', primary: '#3730A3', secondary: '#A5F3FC' },
  { name: 'Graphite Lime', primary: '#27272A', secondary: '#A3E635' },
  { name: 'Desert Sun', primary: '#B45309', secondary: '#FEF3C7' },
  { name: 'Teal Coral', primary: '#0F766E', secondary: '#FB7185' },
  { name: 'Plum Silver', primary: '#581C87', secondary: '#E5E7EB' },
];

export const DEFAULT_COLORS = { primary: '#14213D', secondary: '#FCA311' };
