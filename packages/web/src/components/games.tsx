import { kickoff } from '../lib/format';
import { StatusPill, cx } from './ui';

export interface GameView { id: string; week: number; homeTeamId: string; awayTeamId: string; kickoffAt: string; status: string; display: any; homeScore: number | null; awayScore: number | null; quarter: string | null; clock: string | null }

export function GameCard({ g, myPlayers }: { g: GameView; myPlayers?: Record<string, { name: string; position: string; points: number; starter: boolean }[]> }) {
  const started = g.display === 'LIVE' || g.display === 'FINAL' || g.display === 'DELAYED';
  const detail = g.display === 'LIVE' ? [g.quarter, g.clock].filter(Boolean).join(' ') : g.display === 'UPCOMING' ? kickoff(g.kickoffAt) : g.display === 'DELAYED' ? g.clock : null;
  const winner = g.display === 'FINAL' ? ((g.homeScore ?? 0) > (g.awayScore ?? 0) ? g.homeTeamId : g.awayTeamId) : null;
  const mine = [...(myPlayers?.[g.awayTeamId] ?? []), ...(myPlayers?.[g.homeTeamId] ?? [])];
  return (
    <div className={cx('rounded-xl bg-surface p-3 hairline', g.display === 'LIVE' && 'ring-1 ring-live/40')}>
      <div className="mb-2 flex items-center justify-between gap-2"><StatusPill status={g.display} detail={detail} /></div>
      {[g.awayTeamId, g.homeTeamId].map((t, i) => (
        <div key={t} className="flex items-center justify-between py-0.5">
          <span className={cx('font-display text-lg font-semibold tracking-wide', winner && winner !== t && 'text-muted')}>{i === 1 && <span className="mr-1 text-[11px] text-faint">@</span>}{t}</span>
          <span className={cx('num font-display text-xl font-bold', winner && winner !== t && 'text-muted')}>{started ? (i === 0 ? g.awayScore : g.homeScore) ?? 0 : ''}</span>
        </div>
      ))}
      {mine.length > 0 && (
        <div className="mt-2 border-t border-line pt-2 text-[12px]">
          {mine.slice(0, 4).map((p) => (
            <div key={p.name} className="flex justify-between gap-2"><span className={cx('truncate', !p.starter && 'text-muted')}>{p.name} <span className="text-faint">{p.position}{p.starter ? '' : ' · BN'}</span></span><span className="num font-semibold">{p.points.toFixed(1)}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}
