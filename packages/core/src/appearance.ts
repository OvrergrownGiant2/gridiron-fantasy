import { z } from 'zod';
import { contrastRatio, hexToRgb, isHex, readableTextOn, rgbToHex } from './colors';

/**
 * Personal appearance: two main colors (picked on color wheels) generate the whole palette
 * for light and dark mode; every individual color, the fonts, corner roundness and the
 * interface size can then be fine-tuned. Unset fields keep the stock Gridiron look.
 */

export const THEME_TOKENS = ['bg', 'surface', 'raised', 'sunken', 'ink', 'muted', 'faint', 'line', 'turf', 'accent', 'accent-ink', 'live', 'good', 'warn', 'bad', 'info'] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];
export type Palette = Record<ThemeToken, string>;

export const TOKEN_INFO: Record<ThemeToken, { label: string; hint: string }> = {
  bg: { label: 'Page background', hint: 'Behind everything' },
  surface: { label: 'Cards', hint: 'Panels and lists' },
  raised: { label: 'Raised areas', hint: 'Hover rows, chips, inner boxes' },
  sunken: { label: 'Sunken areas', hint: 'Inputs, empty slots, tracks' },
  ink: { label: 'Text', hint: 'Main text and headings' },
  muted: { label: 'Secondary text', hint: 'Labels and details' },
  faint: { label: 'Faint text', hint: 'Hints and numbers in passing' },
  line: { label: 'Borders', hint: 'Dividers and outlines' },
  turf: { label: 'Brand surfaces', hint: 'Sidebar, banners, headers' },
  accent: { label: 'Accent', hint: 'Buttons, links, highlights' },
  'accent-ink': { label: 'Text on accent', hint: 'Labels on accent buttons' },
  live: { label: 'Live', hint: 'Games in progress' },
  good: { label: 'Positive', hint: 'Wins, healthy, success' },
  warn: { label: 'Warning', hint: 'Questionable, pending' },
  bad: { label: 'Negative', hint: 'Losses, injuries, errors' },
  info: { label: 'Info', hint: 'Notes and neutral badges' },
};

export const DEFAULT_PALETTES: { light: Palette; dark: Palette } = {
  light: {
    bg: '#F1F4F2', surface: '#FFFFFF', raised: '#F8FAF9', sunken: '#E8EDEA', ink: '#0D1714', muted: '#54655F', faint: '#889791', line: '#DAE2DE',
    turf: '#16362B', accent: '#B07A00', 'accent-ink': '#FFFFFF', live: '#D62839', good: '#168052', warn: '#B26A00', bad: '#C42B2B', info: '#2563A8',
  },
  dark: {
    bg: '#090F0D', surface: '#101916', raised: '#16211D', sunken: '#070B0A', ink: '#E7EFEB', muted: '#96A7A0', faint: '#667770', line: '#24332E',
    turf: '#122C23', accent: '#F2C230', 'accent-ink': '#0E1412', live: '#FF5462', good: '#40C484', warn: '#F0AB3C', bad: '#FF6666', info: '#6EA8EE',
  },
};

export const BODY_FONTS = {
  archivo: { label: 'Archivo', css: "Archivo, system-ui, sans-serif", google: 'Archivo:wght@400;500;600;700' },
  inter: { label: 'Inter', css: "Inter, system-ui, sans-serif", google: 'Inter:wght@400;500;600;700' },
  nunito: { label: 'Nunito (rounded)', css: "Nunito, system-ui, sans-serif", google: 'Nunito:wght@400;600;700;800' },
  grotesk: { label: 'Space Grotesk', css: "'Space Grotesk', system-ui, sans-serif", google: 'Space+Grotesk:wght@400;500;600;700' },
  serif: { label: 'Source Serif', css: "'Source Serif 4', Georgia, serif", google: 'Source+Serif+4:wght@400;600;700' },
  system: { label: 'Device default', css: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", google: null },
} as const;
export const DISPLAY_FONTS = {
  barlow: { label: 'Barlow Condensed', css: "'Barlow Condensed', 'Arial Narrow', sans-serif", google: 'Barlow+Condensed:wght@500;600;700' },
  oswald: { label: 'Oswald', css: "Oswald, 'Arial Narrow', sans-serif", google: 'Oswald:wght@500;600;700' },
  bebas: { label: 'Bebas Neue', css: "'Bebas Neue', 'Arial Narrow', sans-serif", google: 'Bebas+Neue' },
  anton: { label: 'Anton', css: "Anton, 'Arial Narrow', sans-serif", google: 'Anton' },
  archivo: { label: 'Archivo (wide)', css: "Archivo, system-ui, sans-serif", google: 'Archivo:wght@500;600;700;800' },
  serif: { label: 'Playfair', css: "'Playfair Display', Georgia, serif", google: 'Playfair+Display:wght@600;700' },
} as const;
export type BodyFont = keyof typeof BODY_FONTS;
export type DisplayFont = keyof typeof DISPLAY_FONTS;

const hex = z.string().refine(isHex, 'Use a #RRGGBB color.');
const overrides = z.record(z.enum(THEME_TOKENS), hex);
export const appearanceSchema = z.object({
  primary: hex.nullable().optional(),
  accent: hex.nullable().optional(),
  /** 0 = neutral grey backgrounds, 1 = strongly tinted with the main color. */
  tint: z.number().min(0).max(1).optional(),
  font: z.enum(Object.keys(BODY_FONTS) as [BodyFont, ...BodyFont[]]).optional(),
  displayFont: z.enum(Object.keys(DISPLAY_FONTS) as [DisplayFont, ...DisplayFont[]]).optional(),
  /** Card corner radius in px; other corners scale with it. */
  radius: z.number().int().min(0).max(28).optional(),
  /** Interface size, 0.85–1.25. */
  scale: z.number().min(0.85).max(1.25).optional(),
  overrides: z.object({ light: overrides.optional(), dark: overrides.optional() }).optional(),
}).strict();
export type Appearance = z.infer<typeof appearanceSchema>;

export const DEFAULT_APPEARANCE = { tint: 0.35, font: 'archivo' as BodyFont, displayFont: 'barlow' as DisplayFont, radius: 14, scale: 1 };

// ---------------------------------------------------------------- color math
export interface Hsl { h: number; s: number; l: number }
export function hexToHsl(c: string): Hsl {
  const { r, g, b } = hexToRgb(c);
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return { h, s: s * 100, l: l * 100 };
}
export function hslToHex({ h, s, l }: Hsl): string {
  const S = Math.max(0, Math.min(100, s)) / 100, L = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S, hh = (((h % 360) + 360) % 360) / 60, x = c * (1 - Math.abs((hh % 2) - 1));
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  const m = L - c / 2;
  return rgbToHex(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255));
}
/** Moves lightness (darker if `dir` < 0) until `c` reaches `min` contrast against `against`. */
function pushContrast(c: string, against: string, min: number, dir: -1 | 1): string {
  const hsl = hexToHsl(c);
  let out = c;
  for (let i = 0; i < 100 && contrastRatio(out, against) < min; i++) {
    hsl.l = Math.max(0, Math.min(100, hsl.l + dir));
    out = hslToHex(hsl);
  }
  return out;
}

/** The full light and dark palettes for an appearance. */
export function buildPalettes(a: Appearance | null | undefined): { light: Palette; dark: Palette } {
  const light: Palette = { ...DEFAULT_PALETTES.light };
  const dark: Palette = { ...DEFAULT_PALETTES.dark };
  const t = a?.tint ?? DEFAULT_APPEARANCE.tint;
  if (a?.primary) {
    const { h, s, l } = hexToHsl(a.primary);
    // Background saturation grows with the tint setting, capped so text stays readable.
    const bs = Math.min(s, 100) * (0.05 + 0.45 * t);
    Object.assign(light, {
      bg: hslToHex({ h, s: bs, l: 95.5 - 3 * t }), surface: hslToHex({ h, s: bs * 0.6, l: 99.6 }), raised: hslToHex({ h, s: bs, l: 97.6 - t }),
      sunken: hslToHex({ h, s: bs * 1.1, l: 92 - 3 * t }), line: hslToHex({ h, s: bs * 1.1, l: 86.5 - 2 * t }),
      ink: hslToHex({ h, s: Math.min(s, 40) * 0.5, l: 8 }), muted: hslToHex({ h, s: Math.min(s, 30) * 0.55, l: 36 }), faint: hslToHex({ h, s: Math.min(s, 25) * 0.5, l: 55 }),
      turf: pushContrast(a.primary, '#FFFFFF', 7, -1),
    });
    const ds = Math.min(s, 100) * (0.08 + 0.4 * t);
    Object.assign(dark, {
      bg: hslToHex({ h, s: ds, l: 4.5 + 2 * t }), surface: hslToHex({ h, s: ds, l: 7.5 + 2.5 * t }), raised: hslToHex({ h, s: ds, l: 11 + 2.5 * t }),
      sunken: hslToHex({ h, s: ds, l: 3 + t }), line: hslToHex({ h, s: ds, l: 17 + 3 * t }),
      ink: hslToHex({ h, s: Math.min(s, 30) * 0.4, l: 92 }), muted: hslToHex({ h, s: Math.min(s, 25) * 0.5, l: 63 }), faint: hslToHex({ h, s: Math.min(s, 20) * 0.5, l: 45 }),
      turf: hslToHex({ h, s: Math.min(s, 70), l: Math.min(l, 15) }),
    });
  }
  if (a?.accent) {
    // On light pages the accent is darkened just enough to read as text on white.
    light.accent = pushContrast(a.accent, '#FFFFFF', 3, -1);
    dark.accent = pushContrast(a.accent, dark.bg, 4.5, 1);
    light['accent-ink'] = readableTextOn(light.accent);
    dark['accent-ink'] = readableTextOn(dark.accent);
  }
  Object.assign(light, a?.overrides?.light ?? {});
  Object.assign(dark, a?.overrides?.dark ?? {});
  return { light, dark };
}

/** Readability problems worth warning about (text against its background). */
export function paletteWarnings(p: Palette): string[] {
  const out: string[] = [];
  if (contrastRatio(p.ink, p.bg) < 4.5 || contrastRatio(p.ink, p.surface) < 4.5) out.push('Main text is hard to read on the background.');
  if (contrastRatio(p.muted, p.surface) < 3) out.push('Secondary text is hard to read on cards.');
  if (contrastRatio(p['accent-ink'], p.accent) < 3) out.push('Text on accent buttons is hard to read.');
  if (contrastRatio('#FFFFFF', p.turf) < 4.5) out.push('Sidebar text is hard to read on the brand color.');
  return out;
}

const rgbVar = (c: string) => { const { r, g, b } = hexToRgb(c); return `${r} ${g} ${b}`; };
const vars = (p: Palette) => THEME_TOKENS.map((k) => `--${k}: ${rgbVar(p[k])};`).join(' ');

/** CSS that applies an appearance (to be placed after the base stylesheet). Empty for the stock look. */
export function appearanceCss(a: Appearance | null | undefined): string {
  if (!a || Object.keys(a).length === 0) return '';
  const { light, dark } = buildPalettes(a);
  const font = BODY_FONTS[a.font ?? DEFAULT_APPEARANCE.font].css;
  const display = DISPLAY_FONTS[a.displayFont ?? DEFAULT_APPEARANCE.displayFont].css;
  const r = a.radius ?? DEFAULT_APPEARANCE.radius;
  const scale = a.scale ?? DEFAULT_APPEARANCE.scale;
  return [
    `:root { ${vars(light)} --font-sans: ${font}; --font-display: ${display}; --radius: ${r}px; --ui-scale: ${scale}; }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${vars(dark)} } }`,
    `:root[data-theme="dark"] { ${vars(dark)} }`,
  ].join('\n');
}

/** Google Fonts families an appearance needs (beyond the stock fonts). */
export function appearanceFonts(a: Appearance | null | undefined): string[] {
  const out: string[] = [];
  const f = BODY_FONTS[a?.font ?? 'archivo'], d = DISPLAY_FONTS[a?.displayFont ?? 'barlow'];
  if (f.google && a?.font && a.font !== 'archivo') out.push(f.google);
  if (d.google && a?.displayFont && a.displayFont !== 'barlow') out.push(d.google);
  return out;
}

/** Ready-made looks shown as one-tap presets. Original color combinations. */
export const APPEARANCE_PRESETS: { name: string; primary: string; accent: string; tint?: number }[] = [
  { name: 'Gridiron', primary: '#16362B', accent: '#F2C230' },
  { name: 'Midnight', primary: '#0F1E3D', accent: '#38BDF8' },
  { name: 'Crimson', primary: '#5B0E1A', accent: '#F59E0B' },
  { name: 'Royal', primary: '#2E1065', accent: '#FACC15' },
  { name: 'Ocean', primary: '#0B4F6C', accent: '#2DD4BF' },
  { name: 'Ember', primary: '#3B1F0E', accent: '#FB923C' },
  { name: 'Slate', primary: '#1F2937', accent: '#A3E635', tint: 0.1 },
  { name: 'Rose', primary: '#4A1D3F', accent: '#FB7185', tint: 0.5 },
];
