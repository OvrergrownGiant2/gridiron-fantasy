import { readableTextOn } from '@gridiron/core';
import { ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PlayerName } from '../components/PlayerModal';
import { TeamLogo } from '../components/team';
import { RefreshLeagueButton } from '../components/RefreshLeague';
import { Badge, Button, Card, Empty, ErrorNote, LoadingBlock, PageHeader, StatusPill, cx, slotLabel } from '../components/ui';
import { kickoff, pct, pts } from '../lib/format';
import { teamMap, useCall, useLeague } from '../lib/hooks';

export function Matchups() {
  const { leagueId } = useParams();
  const [params, setParams] = useSearchParams();
  const weekParam = params.get('week') ? Number(params.get('week')) : undefined;
  const { data: L } = useLeague(leagueId);
  const { data, isLoading, error, refetch } = useCall<any>(['matchups', leagueId, weekParam ?? 'current'], 'matchups.week', { leagueId, week: weekParam }, { refetchInterval: (q) => (q.state.data as any)?.matchups?.some((m: any) => m.status === 'live') ? 20_000 : 60_000 });
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { setSel(null); }, [weekParam]);
  if (isLoading || !L) return <LoadingBlock rows={6} />;
  if (error) return <ErrorNote error={error} retry={refetch} />;
  if (L.league.status === 'setup' || L.league.status === 'drafting') return <Empty title="No matchups yet" body="The schedule is generated when the draft completes." />;
  const tm = teamMap(L);
  const mine = data.matchups.find((m: any) => m.home.teamId === L.myTeamId || m.away?.teamId === L.myTeamId);
  const active = data.matchups.find((m: any) => m.id === sel) ?? mine ?? data.matchups[0];
  const weeks: number[] = data.weeks.map((w: any) => w.week);
  const go = (w: number) => setParams({ week: String(w) });
  const idx = weeks.indexOf(data.week);
  return (
    <div className="space-y-5">
      <PageHeader title="Matchups" sub={data.week === data.currentWeek ? 'Live scoring updates automatically from the scoring engine.' : data.week < data.currentWeek ? 'Final results.' : 'Upcoming week. Points show once games start.'}
        actions={<div className="flex flex-wrap items-center gap-1">
          <RefreshLeagueButton L={L} size="sm" />
          <Button size="sm" variant="ghost" aria-label="Previous week" disabled={idx <= 0} onClick={() => go(weeks[idx - 1])}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="num min-w-[90px] text-center font-display text-xl font-semibold uppercase">Week {data.week}</span>
          <Button size="sm" variant="ghost" aria-label="Next week" disabled={idx < 0 || idx >= weeks.length - 1} onClick={() => go(weeks[idx + 1])}><ChevronRight className="h-4 w-4" /></Button>
        </div>} />
      {data.matchups.length === 0 ? <Empty title="No matchups this week" /> : (
        <>
          {active && <MatchupDetail m={active} tm={tm} leagueId={leagueId!} />}
          <div>
            <div className="label mb-2">All matchups · week {data.week}</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {data.matchups.map((m: any) => <MatchupTile key={m.id} m={m} tm={tm} active={m.id === active?.id} onClick={() => setSel(m.id)} />)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function statusOf(m: any) { return m.status === 'live' ? 'LIVE' : m.status === 'final' ? 'FINAL' : 'UPCOMING'; }

function MatchupTile({ m, tm, active, onClick }: { m: any; tm: Map<string, any>; active: boolean; onClick: () => void }) {
  const h = tm.get(m.home.teamId), a = m.away ? tm.get(m.away.teamId) : null;
  return (
    <button onClick={onClick} className={cx('rounded-xl bg-surface p-3 text-left hairline transition hover:bg-raised', active && 'ring-2 ring-accent')}>
      <div className="mb-1.5 flex items-center justify-between"><StatusPill status={statusOf(m) as any} />{m.kind !== 'regular' && <Badge tone="accent">{m.kind}</Badge>}</div>
      {[{ t: h, s: m.home }, ...(a ? [{ t: a, s: m.away }] : [])].map(({ t, s }) => (
        <div key={t.id} className="flex items-center gap-2 py-0.5">
          <TeamLogo team={t} size={22} /><span className={cx('flex-1 truncate text-[13px] font-semibold', m.winnerTeamId && m.winnerTeamId !== t.id && 'text-muted')}>{t.name}</span>
          <span className="num font-display text-lg font-bold">{pts(s.points)}</span>
        </div>
      ))}
      {!a && <div className="text-[12px] text-muted">Personal points challenge</div>}
    </button>
  );
}

/** Animates a number when it changes (score bumps). */
function Score({ value, className }: { value: number; className?: string }) {
  const prev = useRef(value);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (value !== prev.current) { setBump(true); const t = setTimeout(() => setBump(false), 600); prev.current = value; return () => clearTimeout(t); }
  }, [value]);
  return <span className={cx('num inline-block', bump && 'animate-bump', className)}>{pts(value)}</span>;
}

function SideHeader({ team, s, align, winner, seed }: { team: any; s: any; align: 'left' | 'right'; winner: boolean | null; seed?: number | null }) {
  const fg = readableTextOn(team.primary_color);
  return (
    <div className={cx('flex flex-1 items-center gap-3 p-4', align === 'right' && 'flex-row-reverse text-right')} style={{ background: team.primary_color, color: fg }}>
      <TeamLogo team={team} size={52} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-xl font-bold uppercase leading-tight sm:text-2xl">{seed ? <span className="mr-1 opacity-70">#{seed}</span> : null}{team.name}</div>
        <div className="text-[12px] opacity-80">{team.owner_name ?? (team.is_ai ? 'AI manager' : '')}</div>
        <div className="mt-1 text-[12px] opacity-80">{s.yetToPlay} to play · {s.activePlayers} playing · {s.completed} done</div>
      </div>
      <div>
        <Score value={s.points} className={cx('font-display text-4xl font-bold leading-none sm:text-5xl', winner === false && 'opacity-60')} />
        <div className="num text-[12px] opacity-80" title="Projected final (estimate)">proj {pts(s.projected, 1)}</div>
      </div>
    </div>
  );
}

function MatchupDetail({ m, tm, leagueId }: { m: any; tm: Map<string, any>; leagueId: string }) {
  const h = tm.get(m.home.teamId), a = m.away ? tm.get(m.away.teamId) : null;
  const winH = m.winnerTeamId ? m.winnerTeamId === h.id : null;
  const slots = Math.max(m.home.starters.length, m.away?.starters.length ?? 0);
  return (
    <Card pad={false} className="overflow-hidden">
      <div className="flex flex-col sm:flex-row">
        <SideHeader team={h} s={m.home} align="left" winner={winH} seed={m.homeSeed} />
        {a && <div className="h-px bg-white/25 sm:h-auto sm:w-px" aria-hidden />}
        {a && <SideHeader team={a} s={m.away} align="right" winner={winH === null ? null : !winH} seed={m.awaySeed} />}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2 text-[12.5px]">
        <span className="flex items-center gap-2"><StatusPill status={statusOf(m) as any} />{m.kind !== 'regular' && <Badge tone="accent">{m.kind}{m.bracketRound ? ` · round ${m.bracketRound}` : ''}</Badge>}
          {m.status === 'final' && m.scoringVersion && <span className="text-muted">Scored with rules v{m.scoringVersion}</span>}</span>
        {m.winProbabilityHome !== null && a && (
          <span className="flex items-center gap-2 text-muted" title="Normal-approximation estimate from projections; not a prediction you should rely on.">
            <Info className="h-3.5 w-3.5" /> Win chance (estimate)
            <span className="relative h-2 w-28 overflow-hidden rounded-full" style={{ background: a.primary_color }}><span className="absolute inset-y-0 left-0" style={{ width: pct(m.winProbabilityHome), background: h.primary_color }} /></span>
            <span className="num font-semibold text-ink">{pct(m.winProbabilityHome)}</span>
          </span>
        )}
      </div>
      <div className="scroll-x">
        <table className="w-full min-w-[560px] text-[13px]">
          <tbody>
            {Array.from({ length: slots }, (_, i) => {
              const hp = m.home.starters[i], ap = m.away?.starters[i];
              return (
                <tr key={i} className="border-b border-line last:border-0">
                  <PlayerCell p={hp} leagueId={leagueId} />
                  <td className="w-14 bg-raised text-center font-display text-[15px] font-semibold text-muted">{slotLabel(hp?.slot ?? ap?.slot ?? '')}</td>
                  {a ? <PlayerCell p={ap} leagueId={leagueId} right /> : <td />}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details className="border-t border-line">
        <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-semibold text-muted">Bench</summary>
        <div className="grid gap-px bg-line sm:grid-cols-2">
          {[m.home, m.away].filter(Boolean).map((s: any) => (
            <div key={s.teamId} className="bg-surface p-3 text-[13px]">
              {s.bench.length === 0 ? <span className="text-muted">No bench players.</span> : s.bench.map((p: any) => (
                <div key={p.playerId} className="flex justify-between py-1"><PlayerName leagueId={leagueId} id={p.playerId} name={p.name} injury={p.injuryStatus} className="font-medium" /><span className="num text-muted">{pts(p.points)}</span></div>
              ))}
            </div>
          ))}
        </div>
      </details>
      <p className="border-t border-line px-4 py-2 text-[12px] text-faint">Actual points are bold; projections (estimates) are muted. Live numbers are provisional until the provider marks a game final.</p>
    </Card>
  );
}

function PlayerCell({ p, leagueId, right }: { p: any; leagueId: string; right?: boolean }) {
  if (!p) return <td className="px-3 py-2.5 text-faint">Empty</td>;
  const g = p.game;
  const state = !g ? <Badge tone="warn">Bye</Badge> : g.status === 'in_progress' ? <StatusPill status="LIVE" detail={`${g.quarter ?? ''} ${g.clock ?? ''}`} /> : g.status === 'final' ? <span className="text-muted">Final{p.statsFinal ? '' : ' · stats pending'}</span> : g.status === 'scheduled' ? <span className="text-muted">{kickoff(g.kickoffAt)}</span> : <StatusPill status={g.status === 'delayed' ? 'DELAYED' : 'POSTPONED'} />;
  return (
    <td className={cx('px-3 py-2', right && 'text-right')}>
      <div className={cx('flex items-center gap-3', right && 'flex-row-reverse')}>
        <div className={cx('min-w-0 flex-1', right && 'flex flex-col items-end')}>
          <PlayerName leagueId={leagueId} id={p.playerId} name={p.name} injury={p.injuryStatus} />
          <div className="flex items-center gap-1.5 text-[12px] text-muted">{p.position} · {p.nflTeamId}{g ? ` ${g.isHome ? 'vs' : '@'} ${g.opponent}` : ''} · {state}</div>
          {p.breakdown.length > 0 && <div className="truncate text-[11.5px] text-faint">{p.breakdown.slice(0, 4).map((l: any) => `${l.value} ${l.key.replace(/_/g, ' ')}`).join(', ')}</div>}
        </div>
        <div className={cx('w-16', right ? 'text-left' : 'text-right')}>
          <div className="num font-display text-xl font-bold leading-none">{pts(p.points)}</div>
          <div className="num text-[11px] text-faint">{pts(p.projected, 1)}</div>
        </div>
      </div>
    </td>
  );
}
