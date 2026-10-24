import { STAT_LABELS } from '@gridiron/core';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { kickoff, pts } from '../lib/format';
import { useCall } from '../lib/hooks';
import { PlayerCardPanel, PlayerPhoto } from './PlayerCard';
import { Badge, InjuryTag, LoadingBlock, Modal, cx } from './ui';

const Ctx = createContext<(leagueId: string, playerId: string) => void>(() => {});
export const useOpenPlayer = () => useContext(Ctx);

export function PlayerModalProvider({ children }: { children: ReactNode }) {
  const [sel, setSel] = useState<{ leagueId: string; playerId: string } | null>(null);
  return (
    <Ctx.Provider value={(leagueId, playerId) => setSel({ leagueId, playerId })}>
      {children}
      {sel && <PlayerModal {...sel} onClose={() => setSel(null)} />}
    </Ctx.Provider>
  );
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 220, h = 48, max = Math.max(...values, 1), min = Math.min(0, ...values);
  const x = (i: number) => 4 + (i * (w - 8)) / (values.length - 1);
  const y = (v: number) => h - 4 - ((v - min) / (max - min || 1)) * (h - 10);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-12 w-full max-w-[260px]" aria-label="Fantasy points by game">
      <path d={`${d} L${x(values.length - 1)},${h - 4} L${x(0)},${h - 4} Z`} fill="rgb(var(--accent) / .14)" />
      <path d={d} fill="none" stroke="rgb(var(--accent))" strokeWidth="2" strokeLinejoin="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="3.5" fill="rgb(var(--accent))" />
    </svg>
  );
}

function PlayerModal({ leagueId, playerId, onClose }: { leagueId: string; playerId: string; onClose: () => void }) {
  const { data, isLoading } = useCall<any>(['player', leagueId, playerId], 'players.profile', { leagueId, playerId });
  const p = data?.player;
  return (
    <Modal open onClose={onClose} wide title={p ? p.name : 'Player'}>
      {isLoading || !data ? <LoadingBlock /> : (
        <div className="space-y-5">
          <PlayerCardPanel player={p} profile={p.profile} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {p.injuryStatus !== 'healthy' ? <Badge tone="bad">{p.injuryStatus}{p.injuryNote ? ` · ${p.injuryNote}` : ''}</Badge> : <Badge tone="good">Healthy</Badge>}
            {data.availability.status === 'rostered' ? <Badge tone="info">On {data.ownerTeam?.name}</Badge> : data.availability.status === 'waivers' ? <Badge tone="warn">On waivers</Badge> : <Badge tone="good">Free agent</Badge>}
            <span className="text-[13px] text-muted">Bye: week {data.byeWeek ?? '—'} · Rostered in {data.rosteredPct}% of leagues · Rank #{p.rank}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Season points (this league)" value={pts(data.seasonPoints)} />
            <Stat label="Avg per game" value={pts(data.gameLog.length ? data.seasonPoints / data.gameLog.length : 0)} />
            <Stat label="This week · projection" value={data.projection ? pts(data.projection.points, 1) : '—'} sub={data.projection ? `Estimate. Range ${pts(data.projection.low, 1)}–${pts(data.projection.high, 1)}. ${data.projection.basis.join('; ')}.` : undefined} />
          </div>
          <Spark values={data.gameLog.map((g: any) => g.points)} />
          <div>
            <div className="label mb-2">Game log</div>
            {data.gameLog.length === 0 ? <p className="text-[13px] text-muted">No games recorded this season.</p> : (
              <div className="scroll-x rounded-lg hairline">
                <table className="w-full min-w-[520px] text-[13px]">
                  <thead className="bg-raised text-left text-muted"><tr><th className="px-3 py-2">Wk</th><th>Opp</th><th>Result</th><th>Line</th><th className="px-3 text-right">Pts</th></tr></thead>
                  <tbody>
                    {data.gameLog.map((g: any) => (
                      <tr key={g.week} className="border-t border-line align-top">
                        <td className="num px-3 py-2">{g.week}</td>
                        <td className="py-2">{g.isHome ? 'vs' : '@'} {g.opponent}</td>
                        <td className="num py-2 text-muted">{g.result ?? '—'}{!g.isFinal && <Badge tone="live" className="ml-1">live</Badge>}</td>
                        <td className="py-2 text-muted">{g.breakdown.map((l: any) => `${l.value} ${STAT_LABELS[l.key as keyof typeof STAT_LABELS] ?? l.label}`).join(' · ') || '—'}</td>
                        <td className="num px-3 py-2 text-right font-semibold" title={g.breakdown.map((l: any) => `${l.label}: ${l.points}`).join('\n')}>{pts(g.points)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {data.totalsBreakdown.length > 0 && (
            <div>
              <div className="label mb-2">Season scoring breakdown</div>
              <div className="grid gap-x-6 sm:grid-cols-2">
                {data.totalsBreakdown.map((l: any) => <div key={l.key} className="flex justify-between border-b border-line py-1.5 text-[13px]"><span>{l.label} <span className="text-faint">({l.value})</span></span><span className={cx('num font-semibold', l.points < 0 && 'text-bad')}>{pts(l.points)}</span></div>)}
              </div>
            </div>
          )}
          <div>
            <div className="label mb-2">Upcoming</div>
            <div className="flex flex-wrap gap-2">
              {data.upcoming.map((u: any) => <span key={u.week} className="rounded-lg bg-raised px-2.5 py-1.5 text-[13px]">Wk {u.week}: {u.isHome ? 'vs' : '@'} {u.opponent} · <span className="text-muted">{kickoff(u.kickoffAt)}</span></span>)}
              {data.byeWeek && <span className="rounded-lg bg-sunken px-2.5 py-1.5 text-[13px] text-muted">Bye in week {data.byeWeek}</span>}
            </div>
          </div>
          <p className="text-[12px] text-faint">Source: {p.provider === 'demo' ? 'simulated demo data' : p.provider} · updated {new Date(p.updatedAt).toLocaleString()}</p>
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return <div className="rounded-xl bg-raised p-3"><div className="label">{label}</div><div className="num font-display text-3xl font-bold">{value}</div>{sub && <div className="mt-1 text-[12px] text-muted">{sub}</div>}</div>;
}

export function PlayerName({ leagueId, id, name, injury, className, position, team, photo = true, photoSize = 26 }: { leagueId: string; id: string; name: string; injury?: string; className?: string; position?: string; team?: string | null; photo?: boolean; photoSize?: number }) {
  const open = useOpenPlayer();
  return (
    <button type="button" onClick={() => open(leagueId, id)} className={cx('inline-flex max-w-full items-center gap-1.5 text-left font-semibold hover:text-accent hover:underline', className)}>
      {photo && <PlayerPhoto id={id} name={name} position={position ?? (id.includes('DST-') ? 'DST' : undefined)} team={team ?? (id.includes('DST-') ? id.split('DST-')[1] : null)} size={photoSize} className="mr-0.5" />}
      <span className="truncate">{name}</span>{injury && <InjuryTag status={injury} />}
    </button>
  );
}
