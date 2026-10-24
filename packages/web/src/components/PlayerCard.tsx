import { ratingTier, type PlayerProfile } from '@gridiron/core';
import { useState } from 'react';
import { useCall } from '../lib/hooks';
import { cx } from './ui';

/** Position colors shared by photos, rating badges and cards. */
export const POS_COLOR: Record<string, { from: string; to: string; chip: string }> = {
  QB: { from: '#3B1A5A', to: '#7C3AED', chip: 'bg-[#E8D5F7] text-[#3B1A5A]' },
  RB: { from: '#0F4A2A', to: '#16A34A', chip: 'bg-[#D3F0DE] text-[#0F4A2A]' },
  WR: { from: '#163C66', to: '#2563EB', chip: 'bg-[#D5E6FA] text-[#163C66]' },
  TE: { from: '#6A3A06', to: '#EA580C', chip: 'bg-[#FBE3C9] text-[#6A3A06]' },
  K: { from: '#1F2937', to: '#6B7280', chip: 'bg-[#E5E7EB] text-[#374151]' },
  DST: { from: '#6B1717', to: '#DC2626', chip: 'bg-[#F3D3D3] text-[#6B1717]' },
};

/** Photo URL + overall rating for every player, loaded once and cached. */
export function usePlayerMeta() {
  const { data } = useCall<Record<string, [string | null, number | null]>>(['playerMeta'], 'players.meta', {}, { staleTime: 30 * 60_000, gcTime: 60 * 60_000 });
  return data;
}

const initials = (name: string) => name.replace(/ (Jr\.|Sr\.|II|III|IV|D\/ST)$/i, '').split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

/**
 * Player headshot (official NFL photo from nflverse). Falls back to initials on the position
 * color when there is no photo or it can't load (e.g. hosts that block outside images).
 */
export function PlayerPhoto({ id, name, position, team, size = 32, src, className }: { id: string; name: string; position?: string; team?: string | null; size?: number; src?: string | null; className?: string }) {
  const meta = usePlayerMeta();
  const url = src !== undefined ? src : meta?.[id]?.[0] ?? null;
  const [broken, setBroken] = useState(false);
  const c = POS_COLOR[position ?? ''] ?? POS_COLOR.K;
  const style = { width: size, height: size, background: `linear-gradient(160deg, ${c.from}, ${c.to})` };
  if (!url || broken || position === 'DST') {
    return (
      <span aria-hidden className={cx('inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-display font-bold text-white', className)} style={{ ...style, fontSize: Math.max(9, size * 0.36) }}>
        {position === 'DST' ? (team ?? 'D') : initials(name)}
      </span>
    );
  }
  return (
    <span className={cx('inline-block shrink-0 overflow-hidden rounded-full', className)} style={style}>
      <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" decoding="async" onError={() => setBroken(true)}
        className="h-full w-full object-cover object-top" style={{ transform: 'scale(1.18) translateY(6%)' }} />
    </span>
  );
}

const TIER_STYLE: Record<string, string> = {
  elite: 'bg-gradient-to-b from-[#F7D774] to-[#C9961A] text-[#2B1D00]',
  great: 'bg-gradient-to-b from-[#34D399] to-[#059669] text-white',
  good: 'bg-gradient-to-b from-[#60A5FA] to-[#2563EB] text-white',
  average: 'bg-gradient-to-b from-[#9CA3AF] to-[#6B7280] text-white',
  low: 'bg-gradient-to-b from-[#A8A29E] to-[#78716C] text-white',
  none: 'bg-sunken text-muted',
};

/** Overall rating badge, Madden-style. */
export function OvrBadge({ ovr, size = 'md', className }: { ovr: number | null | undefined; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const tier = ratingTier(ovr ?? null);
  const dims = size === 'lg' ? 'h-16 w-14 text-[34px]' : size === 'sm' ? 'h-7 w-7 text-[13px]' : 'h-9 w-9 text-[17px]';
  return (
    <span title={ovr == null ? 'Not rated yet: no NFL games' : `Overall rating ${ovr}`} className={cx('num inline-flex shrink-0 flex-col items-center justify-center rounded-md font-display font-bold leading-none shadow-sm', dims, TIER_STYLE[tier], className)}>
      {ovr ?? 'NR'}
      {size === 'lg' && <span className="mt-0.5 text-[10px] font-semibold tracking-[.18em] opacity-80">OVR</span>}
    </span>
  );
}

const barColor = (v: number) => (v >= 90 ? '#F2C230' : v >= 80 ? '#34D399' : v >= 70 ? '#60A5FA' : v >= 60 ? '#A3A3A3' : '#78716C');

/** Compact attribute chips for list rows: the player's best three ratings. */
export function TopAttrs({ profile, max = 3 }: { profile: PlayerProfile | null | undefined; max?: number }) {
  const attrs = [...(profile?.card?.attrs ?? [])].sort((a, b) => b.v - a.v).slice(0, max);
  if (!attrs.length) return null;
  return (
    <span className="flex gap-1">
      {attrs.map((a) => (
        <span key={a.k} title={`${a.label}: ${a.detail}`} className="inline-flex items-baseline gap-1 rounded bg-raised px-1.5 py-0.5 text-[11px]">
          <span className="font-semibold text-muted">{a.k}</span><span className="num font-bold" style={{ color: a.v >= 90 ? '#B88A0F' : undefined }}>{a.v}</span>
        </span>
      ))}
    </span>
  );
}

const ft = (inches: number) => `${Math.floor(inches / 12)}'${inches % 12}"`;

/**
 * The Madden-style player card: photo, overall, attribute bars, season line and bio.
 * Ratings are Gridiron's own, computed from real stats — not EA's Madden ratings.
 */
export function PlayerCardPanel({ player, profile, className, actions }: {
  player: { id: string; name: string; position: string; nflTeamId: string | null; jersey?: number | null; injuryStatus?: string };
  profile: PlayerProfile | null | undefined; className?: string; actions?: React.ReactNode;
}) {
  const c = POS_COLOR[player.position] ?? POS_COLOR.K;
  const card = profile?.card;
  const bio = profile?.bio;
  const bioBits = [bio?.age ? `Age ${bio.age}` : null, bio?.height ? ft(bio.height) : null, bio?.weight ? `${bio.weight} lb` : null, bio?.experience != null ? (bio.experience <= 1 ? 'Rookie' : `${bio.experience} yrs`) : null].filter(Boolean);
  return (
    <div className={cx('overflow-hidden rounded-card text-white shadow-lg', className)} style={{ background: `linear-gradient(150deg, ${c.from} 0%, #0B1220 70%)` }}>
      <div className="relative flex items-end gap-3 px-4 pt-4">
        <div className="absolute right-3 top-3"><OvrBadge ovr={card?.ovr} size="lg" /></div>
        <PlayerPhoto id={player.id} name={player.name} position={player.position} team={player.nflTeamId} size={88} src={profile?.headshot ?? null} className="ring-2 ring-white/20" />
        <div className="min-w-0 pb-1 pr-16">
          <div className="text-[11px] font-semibold uppercase tracking-[.16em] text-white/60">{player.position} · {player.nflTeamId ?? 'FA'}{player.jersey ? ` · #${player.jersey}` : ''}</div>
          <div className="font-display text-[26px] font-bold uppercase leading-[1.05] tracking-wide">{player.name}</div>
          {bioBits.length > 0 && <div className="mt-0.5 text-[12px] text-white/70">{bioBits.join(' · ')}</div>}
        </div>
      </div>
      {card && card.attrs.length > 0 ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 pt-4">
          {card.attrs.map((a) => (
            <div key={a.k} title={a.detail}>
              <div className="flex items-baseline justify-between text-[11px]"><span className="font-semibold uppercase tracking-wider text-white/70">{a.label}</span><span className="num font-display text-[15px] font-bold">{a.v}</span></div>
              <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full" style={{ width: `${a.v}%`, background: barColor(a.v) }} /></div>
              <div className="mt-0.5 truncate text-[10.5px] text-white/50">{a.detail}</div>
            </div>
          ))}
        </div>
      ) : <p className="px-4 pt-4 text-[13px] text-white/70">{card?.basis ?? 'No ratings for this player yet.'}</p>}
      {card && card.line.length > 0 && (
        <div className="mx-4 mt-4 rounded-lg bg-white/5 px-2 py-2">
          <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-[.16em] text-white/50">{card.lineSeason} season</div>
          <div className="grid grid-cols-3 gap-y-2">
            {card.line.map((s) => <div key={s.k} className="px-1 text-center"><div className="num font-display text-[17px] font-bold leading-tight">{s.value}</div><div className="truncate text-[10px] uppercase tracking-wide text-white/55">{s.label}</div></div>)}
          </div>
        </div>
      )}
      <div className="px-4 pb-3 pt-3 text-[11px] text-white/50">
        {bio?.college && <span>{bio.college}{bio.draft ? ' · ' : ''}</span>}{bio?.draft && <span>{bio.draft}</span>}
        <div className="mt-1">Gridiron ratings from real stats{card?.basis ? ` (${card.basis})` : ''}. Not EA Madden ratings.</div>
      </div>
      {actions && <div className="flex flex-wrap gap-2 border-t border-white/10 px-4 py-3">{actions}</div>}
    </div>
  );
}
