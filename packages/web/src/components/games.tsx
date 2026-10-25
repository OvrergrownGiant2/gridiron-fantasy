import { useEffect, useState } from 'react';
import { kickoff } from '../lib/format';
import { NFL_TEAM_INFO } from '../lib/nflTeams';
import { PlayerPhoto } from './PlayerCard';
import { cx } from './ui';

declare const __LOCAL_HEADSHOTS__: boolean;

export interface GameView { id: string; week: number; homeTeamId: string; awayTeamId: string; kickoffAt: string; status: string; display: any; homeScore: number | null; awayScore: number | null; quarter: string | null; clock: string | null }
type MyPlayer = { playerId?: string; name: string; position: string; points: number; starter: boolean };

/**
 * NFL team logo: the copy served with the site first, then the original image, then the
 * team's abbreviation on its colors.
 */
export function NflLogo({ team, size = 40, className }: { team: string; size?: number; className?: string }) {
  const info = NFL_TEAM_INFO[team];
  const sources = info ? [...(typeof __LOCAL_HEADSHOTS__ !== 'undefined' && __LOCAL_HEADSHOTS__ ? [`team-logos/${team}.png`] : []), info.logo] : [];
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [team]);
  if (i >= sources.length) {
    return (
      <span aria-hidden className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-display font-bold text-white', className)}
        style={{ width: size, height: size, fontSize: size * 0.34, background: `linear-gradient(150deg, ${info?.color ?? '#334155'}, ${info?.color2 ?? '#0F172A'})`, boxShadow: 'inset 0 0 0 2px rgba(255,255,255,.18)' }}>{team}</span>
    );
  }
  return <img key={sources[i]} src={sources[i]} alt="" width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setI(i + 1)}
    className={cx('shrink-0 object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,.55)]', className)} style={{ width: size, height: size }} />;
}

/** Stadium-billboard scoreboard for one NFL game. Always dark, like a real board, in every theme. */
export function GameCard({ g, myPlayers }: { g: GameView; myPlayers?: Record<string, MyPlayer[]> }) {
  // A game can be under way while the data source has no scores yet (e.g. after a snapshot was
  // taken). Then the board says so instead of showing a made-up 0–0.
  const noScores = g.homeScore == null && g.awayScore == null;
  const awaiting = (g.display === 'LIVE' || g.display === 'DELAYED') && noScores;
  const live = g.display === 'LIVE' && !awaiting;
  const final = g.display === 'FINAL';
  const started = (live || final || g.display === 'DELAYED') && !awaiting;
  const winner = final && g.homeScore !== g.awayScore ? ((g.homeScore ?? 0) > (g.awayScore ?? 0) ? g.homeTeamId : g.awayTeamId) : null;
  const mine = [...(myPlayers?.[g.awayTeamId] ?? []), ...(myPlayers?.[g.homeTeamId] ?? [])].sort((a, b) => Number(b.starter) - Number(a.starter) || b.points - a.points);
  const k = new Date(g.kickoffAt);
  const day = k.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
  const time = k.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  return (
    <article aria-label={`${g.awayTeamId} at ${g.homeTeamId}`}
      className={cx('relative flex flex-col overflow-hidden rounded-card bg-[#07090D] text-white shadow-[0_10px_30px_-12px_rgba(0,0,0,.55)] ring-1 ring-white/10', live && 'ring-2 ring-[#FF3B4E]/70')}>
      {/* LED dot matrix + top glare */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[.09]" style={{ backgroundImage: 'radial-gradient(circle, #fff 0.7px, transparent 1.1px)', backgroundSize: '4px 4px' }} />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-white/[.06] to-transparent" />

      {/* status strip */}
      <div className="relative flex items-center justify-between gap-2 border-b border-white/10 bg-black/40 px-4 py-2 text-[11px] font-semibold uppercase tracking-[.2em]">
        {awaiting ? (
          <span className="flex min-w-0 items-center gap-2 text-[#FFD36B]"><span className="h-2 w-2 shrink-0 rounded-full bg-[#FFD36B]/80" /><span className="truncate">In progress · results after the game</span></span>
        ) : live ? (
          <span className="flex items-center gap-2 text-[#FF5A6A]"><span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FF3B4E] opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-[#FF3B4E]" /></span>Live{g.quarter ? ` · ${g.quarter}` : ''}{g.clock ? ` ${g.clock}` : ''}</span>
        ) : final ? (
          <span className="text-white/70">Final</span>
        ) : g.display === 'DELAYED' ? (
          <span className="text-[#F0AB3C]">Delayed{g.clock ? ` · ${g.clock}` : ''}</span>
        ) : (
          <span className="text-[#FFD36B]">{day} · {time}</span>
        )}
        <span className="text-white/35">Wk {g.week}</span>
      </div>

      {/* the two teams */}
      <div className="relative">
        {([g.awayTeamId, g.homeTeamId] as const).map((t, i) => {
          const info = NFL_TEAM_INFO[t];
          const score = i === 0 ? g.awayScore : g.homeScore;
          const lost = Boolean(winner && winner !== t);
          return (
            <div key={t} className={cx('relative flex items-center gap-3 py-3 pl-5 pr-4', i === 1 && 'border-t border-white/[.07]')}>
              <div aria-hidden className="absolute inset-y-0 left-0 w-1.5" style={{ background: info?.color ?? '#475569' }} />
              <div aria-hidden className={cx('absolute inset-0', lost && 'opacity-40')} style={{ background: `linear-gradient(90deg, ${info?.color ?? '#334155'}59 0%, ${info?.color ?? '#334155'}1F 45%, transparent 75%)` }} />
              <NflLogo team={t} size={44} className={cx('relative', lost && 'opacity-55 grayscale-[.4]')} />
              <div className={cx('relative min-w-0 flex-1 leading-none', lost && 'opacity-50')}>
                <div className="flex items-baseline gap-2">
                  <span className="font-display text-[26px] font-bold tracking-wide">{t}</span>
                  {i === 1 && <span className="text-[10px] font-semibold uppercase tracking-[.18em] text-white/35">Home</span>}
                </div>
                <div className="mt-1 truncate text-[11px] font-semibold uppercase tracking-[.16em] text-white/55">{info ? `${info.city} ${info.name}` : ''}</div>
              </div>
              <div className="relative flex items-center gap-1.5">
                {winner === t && <span aria-label="Winner" className="text-[12px] text-[#FFD36B]">◀</span>}
                <span className={cx('num min-w-[2.4ch] text-right font-display text-[46px] font-bold leading-none tabular-nums',
                  !started ? 'text-white/15' : live ? 'text-[#FFC940] [text-shadow:0_0_14px_rgba(255,201,64,.55),0_0_2px_rgba(255,201,64,.9)]' : lost ? 'text-white/40' : 'text-white [text-shadow:0_0_12px_rgba(255,255,255,.25)]')}>
                  {started ? score ?? 0 : awaiting ? '··' : '–'}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* your fantasy players in this game */}
      {mine.length > 0 && (
        <div className="relative mt-auto border-t border-white/10 bg-white/[.04] px-4 py-2.5">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[.2em] text-white/40">Your players</div>
          <div className="space-y-1">
            {mine.slice(0, 4).map((p) => (
              <div key={p.name} className="flex items-center gap-2 text-[12.5px]">
                {p.playerId && <PlayerPhoto id={p.playerId} name={p.name} position={p.position} size={22} />}
                <span className={cx('min-w-0 flex-1 truncate font-semibold', !p.starter && 'text-white/50')}>{p.name} <span className="font-normal text-white/40">{p.position}{p.starter ? '' : ' · bench'}</span></span>
                <span className={cx('num font-display text-[16px] font-bold', started ? (live ? 'text-[#FFC940]' : 'text-white') : 'text-white/30')}>{started ? p.points.toFixed(1) : '—'}</span>
              </div>
            ))}
            {mine.length > 4 && <div className="text-[11px] text-white/40">+{mine.length - 4} more</div>}
          </div>
        </div>
      )}
      {!started && !mine.length && <div className="relative mt-auto border-t border-white/[.07] px-4 py-2 text-[11.5px] text-white/40">Kickoff {kickoff(g.kickoffAt)}</div>}
    </article>
  );
}
