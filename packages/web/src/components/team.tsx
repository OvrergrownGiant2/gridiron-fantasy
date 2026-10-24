import { readableTextOn } from '@gridiron/core';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { cx } from './ui';

export interface TeamLike {
  id?: string; name: string; abbrev?: string; primary_color?: string; secondary_color?: string;
  logo_media_id?: string | null; logo_preset?: string | null; is_ai?: boolean;
}

/** Twelve original emblem designs: an outer shape and an inner glyph, drawn in the team's two colors. */
const SHAPES = [
  'M32 4 56 12v18c0 14-10 24-24 30C18 54 8 44 8 30V12Z',                // shield
  'M32 4a28 28 0 1 0 .01 0Z',                                             // roundel
  'M32 4 56 18v28L32 60 8 46V18Z',                                        // hexagon
  'M32 3 61 32 32 61 3 32Z',                                              // diamond
];
const GLYPHS: { fill?: string; line?: string; lineOnPrimary?: boolean }[] = [
  { fill: 'M35 14 22 35h9l-3 15 14-22h-9l2-14Z' },                                                   // bolt
  { fill: 'm32 15 4.6 9.4 10.4 1.5-7.5 7.3 1.8 10.3L32 38.6l-9.3 4.9 1.8-10.3L17 25.9l10.4-1.5Z' }, // star
  { fill: 'M15 32c5-11 29-11 34 0-5 11-29 11-34 0Z', line: 'M25 32h14m-10-3v6m3-6v6m3-6v6', lineOnPrimary: true }, // football
  { fill: 'm18 42 4-20 7 8 3-13 3 13 7-8 4 20Z' },                                                 // crown
  { fill: 'M13 36c9-2 15-8 19-19 4 11 10 17 19 19-9 0-14 4-19 11-5-7-10-11-19-11Z' },              // wings
  { line: 'M32 17v30m-11-9c3 7 19 7 22 0M25 23h14' },                                              // anchor
];
const PRESETS = Array.from({ length: 12 }, (_, i) => ({ shape: SHAPES[i % 4], glyph: GLYPHS[(i + Math.floor(i / 6)) % 6] }));
export const PRESET_IDS = PRESETS.map((_, i) => `preset-${i + 1}`);

export function PresetLogo({ preset, primary, secondary, size = 40 }: { preset: string; primary: string; secondary: string; size?: number }) {
  const idx = Math.max(0, (Number(preset.replace('preset-', '')) || 1) - 1) % PRESETS.length;
  const p = PRESETS[idx];
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden>
      <path d={p.shape} fill={primary} stroke={secondary} strokeWidth="3" />
      {p.glyph.fill && <path d={p.glyph.fill} fill={secondary} />}
      {p.glyph.line && <path d={p.glyph.line} fill="none" stroke={p.glyph.lineOnPrimary ? primary : secondary} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

export function useMediaUrl(id: string | null | undefined) {
  const [url, setUrl] = useState<string>('');
  useEffect(() => {
    let alive = true;
    if (!id) { setUrl(''); return; }
    api().mediaUrl(id).then((u) => { if (alive) setUrl(u); }).catch(() => setUrl(''));
    return () => { alive = false; };
  }, [id]);
  return url;
}

export function TeamLogo({ team, size = 40, className }: { team: TeamLike; size?: number; className?: string }) {
  const primary = team.primary_color ?? '#14213D';
  const secondary = team.secondary_color ?? '#FCA311';
  const url = useMediaUrl(team.logo_media_id);
  if (url) return <img src={url} alt="" width={size} height={size} className={cx('shrink-0 rounded-full object-cover hairline', className)} style={{ width: size, height: size }} />;
  if (team.logo_preset) return <span className={cx('shrink-0', className)}><PresetLogo preset={team.logo_preset} primary={primary} secondary={secondary} size={size} /></span>;
  const letters = (team.abbrev ?? team.name.slice(0, 2)).slice(0, 3).toUpperCase();
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-display font-bold', className)}
      style={{ width: size, height: size, background: primary, color: readableTextOn(primary), boxShadow: `inset 0 0 0 ${Math.max(2, size / 16)}px ${secondary}`, fontSize: size * 0.36 }}>
      {letters}
    </span>
  );
}

export function TeamChip({ team, sub, size = 32, className }: { team: TeamLike; sub?: React.ReactNode; size?: number; className?: string }) {
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-2.5', className)}>
      <TeamLogo team={team} size={size} />
      <span className="min-w-0">
        <span className="block truncate font-semibold leading-tight">{team.name}</span>
        {sub !== undefined && <span className="block truncate text-[12px] text-muted">{sub}</span>}
      </span>
    </span>
  );
}

/** A thin two-color stripe: how team colors identify a team without hurting readability. */
export function TeamStripe({ team, vertical }: { team: TeamLike; vertical?: boolean }) {
  const a = team.primary_color ?? '#14213D', b = team.secondary_color ?? '#FCA311';
  return <span aria-hidden className={cx('shrink-0 rounded-full', vertical ? 'w-1 self-stretch' : 'h-1 w-full')} style={{ background: vertical ? `linear-gradient(${a} 0 70%, ${b} 70%)` : `linear-gradient(90deg, ${a} 0 70%, ${b} 70%)` }} />;
}
