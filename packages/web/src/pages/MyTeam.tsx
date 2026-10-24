import { readableTextOn, slotAccepts, type Slot } from '@gridiron/core';
import { ArrowDownUp, Lock, Sparkles, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PlayerName } from '../components/PlayerModal';
import { TeamLogo, useMediaUrl } from '../components/team';
import { Badge, Button, Card, Empty, ErrorNote, LoadingBlock, Modal, Select, StatusPill, Tabs, cx, slotLabel, useToast } from '../components/ui';
import { kickoff, pts } from '../lib/format';
import { useAction, useCall, useLeague } from '../lib/hooks';
import { TeamCustomizer } from './TeamCustomizer';
import { Assistant } from '../components/Assistant';

const STARTER_ORDER: Slot[] = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPERFLEX', 'K', 'DST'];

export function MyTeam() {
  const { leagueId } = useParams();
  const [params, setParams] = useSearchParams();
  const { data: L, isLoading } = useLeague(leagueId);
  const teamId = params.get('team') ?? L?.myTeamId;
  const [tab, setTab] = useState<'lineup' | 'customize' | 'schedule' | 'insights'>((params.get('tab') as any) ?? 'lineup');
  if (isLoading || !L) return <LoadingBlock />;
  const team = L.teams.find((t: any) => t.id === teamId);
  if (!team) return <Empty title="No team" body="You don't manage a team in this league. Pick a team to view." action={<TeamPicker L={L} value="" onChange={(id) => setParams({ team: id })} />} />;
  const mine = team.id === L.myTeamId;
  return <TeamPage L={L} team={team} mine={mine} tab={tab} setTab={setTab} setParams={setParams} leagueId={leagueId!} />;
}

function TeamPage({ L, team, mine, tab, setTab, setParams, leagueId }: any) {
  const banner = useMediaUrl(team.banner_media_id);
  const pc = team.primary_color, fg = readableTextOn(pc);
  return (
    <div>
      <div className="mb-5 overflow-hidden rounded-card hairline">
        <div className="relative flex flex-wrap items-center gap-4 px-5 py-5" style={{ background: banner ? `linear-gradient(90deg, ${pc} 30%, ${pc}cc 60%, ${pc}66), center/cover url(${banner})` : pc, color: fg }}>
          <div className="absolute inset-y-0 right-0 w-1/3 opacity-25" style={{ background: `repeating-linear-gradient(115deg, ${team.secondary_color} 0 10px, transparent 10px 26px)` }} aria-hidden />
          <TeamLogo team={team} size={64} className="relative" />
          <div className="relative min-w-0 flex-1">
            <div className="text-[12px] font-semibold uppercase tracking-[.14em] opacity-75">{L.league.name}{team.is_ai ? ` · AI manager (${team.ai_difficulty})` : team.owner_name ? ` · ${team.owner_name}` : ''}</div>
            <h1 className="truncate font-display text-3xl sm:text-4xl font-bold uppercase leading-none tracking-wide">{team.name}</h1>
            {team.description && <p className="mt-1 max-w-xl text-[13px] opacity-80">{team.description}</p>}
          </div>
          <div className="relative flex w-full items-center gap-2 sm:w-auto">
            <TeamPicker L={L} value={team.id} onChange={(id: string) => setParams(id === L.myTeamId ? {} : { team: id })} />
          </div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 bg-surface px-5 py-2.5 text-[13px] text-muted">
          <span>Abbrev <b className="text-ink">{team.abbrev}</b></span>
          {L.settings.waivers.mode === 'faab' ? <span>FAAB <b className="num text-ink">${team.faab_remaining}</b> / ${L.settings.waivers.faabBudget}</span> : null}
          <span>Waiver priority <b className="num text-ink">#{team.waiver_priority}</b></span>
          <span>Week <b className="num text-ink">{L.league.currentWeek}</b></span>
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'lineup', label: mine ? 'Lineup' : 'Roster' }, ...(mine ? [{ value: 'customize' as const, label: 'Customize team' }] : []), { value: 'schedule', label: 'Schedule' }, ...(mine ? [{ value: 'insights' as const, label: 'Insights' }] : [])]} />
      {tab === 'lineup' && <Lineup leagueId={leagueId} teamId={team.id} canEdit={mine && L.role !== 'observer'} status={L.league.status} />}
      {tab === 'customize' && mine && <TeamCustomizer team={team} leagueId={leagueId} />}
      {tab === 'insights' && mine && <Assistant leagueId={leagueId} />}
      {tab === 'schedule' && <TeamSchedule leagueId={leagueId} teamId={team.id} L={L} />}
    </div>
  );
}

function TeamPicker({ L, value, onChange }: { L: any; value: string; onChange: (id: string) => void }) {
  return (
    <Select aria-label="View team" className="h-9 w-full text-ink sm:w-auto sm:max-w-[220px]" value={value} onChange={(e) => onChange(e.target.value)}>
      {!value && <option value="">Choose a team…</option>}
      {L.teams.map((t: any) => <option key={t.id} value={t.id}>{t.name}{t.id === L.myTeamId ? ' (you)' : ''}</option>)}
    </Select>
  );
}

function Lineup({ leagueId, teamId, canEdit, status }: { leagueId: string; teamId: string; canEdit: boolean; status: string }) {
  const { data, isLoading, error, refetch } = useCall<any>(['roster', teamId], 'rosters.get', { teamId }, { refetchInterval: 30_000 });
  const [moving, setMoving] = useState<any>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [suggest, setSuggest] = useState(false);
  const toast = useToast();
  const save = useAction('rosters.setLineup', { invalidate: ['roster', 'matchups'], quiet: true });

  const all = useMemo(() => (data ? [...data.starters, ...data.bench] : []), [data]);
  if (status === 'setup' || status === 'drafting') return <Empty title="Rosters fill at the draft" body="Your roster will appear here once the draft is complete." />;
  if (isLoading) return <LoadingBlock rows={8} />;
  if (error) return <ErrorNote error={error} retry={refetch} />;
  const cfg = data.rosterConfig;

  // Slot instances: one row per starting slot (filled or empty), then bench and IR.
  const rows: { slot: Slot; player: any | null; key: string }[] = [];
  for (const s of STARTER_ORDER) {
    const occupants = data.starters.filter((p: any) => p.slot === s);
    for (let i = 0; i < (cfg[s] ?? 0); i++) rows.push({ slot: s, player: occupants[i] ?? null, key: `${s}${i}` });
  }
  const bench = data.bench.filter((p: any) => p.slot === 'BN');
  const ir = data.bench.filter((p: any) => p.slot === 'IR');

  const apply = async (assign: Map<string, Slot>) => {
    try {
      await save.mutateAsync({ teamId, assignments: [...assign].map(([playerId, slot]) => ({ playerId, slot })) });
      toast('good', 'Lineup saved.');
    } catch (e: any) { toast('bad', e.message); }
  };
  const moveTo = (p: any, target: { slot: Slot; player: any | null }) => {
    const assign = new Map<string, Slot>(all.map((x: any) => [x.playerId, x.slot]));
    const from = p.slot as Slot;
    assign.set(p.playerId, target.slot);
    if (target.player && target.player.playerId !== p.playerId) {
      const q = target.player;
      assign.set(q.playerId, slotAccepts(from, q.position, cfg) && !(from === 'IR' && !q.irEligible) ? from : 'BN');
    }
    setMoving(null);
    void apply(assign);
  };
  const targetsFor = (p: any) => {
    const t: { slot: Slot; player: any | null; key: string; label: string }[] = [];
    for (const r of rows) if (slotAccepts(r.slot, p.position, cfg) && r.player?.playerId !== p.playerId && !r.player?.locked) t.push({ ...r, label: r.player ? `${r.slot} · swap with ${r.player.name}` : `${r.slot} · empty` });
    if (p.slot !== 'BN') t.push({ slot: 'BN', player: null, key: 'BN', label: 'Bench' });
    if (cfg.IR > 0 && p.slot !== 'IR' && p.irEligible && ir.length < cfg.IR) t.push({ slot: 'IR', player: null, key: 'IR', label: 'Injured reserve' });
    return t;
  };
  const onDrop = (target: { slot: Slot; player: any | null }) => {
    const p = all.find((x: any) => x.playerId === drag);
    setDrag(null);
    if (!p || p.locked || target.player?.locked) return;
    if (!slotAccepts(target.slot, p.position, cfg)) { toast('bad', `${p.position} can't play ${target.slot}.`); return; }
    moveTo(p, target);
  };

  const Row = ({ slot, player, rowKey }: { slot: Slot; player: any | null; rowKey: string }) => {
    const canDrag = canEdit && data.editable && player && !player.locked;
    const g = player?.game;
    const gameDisplay = !player ? null : !g ? 'BYE' : g.status === 'in_progress' ? 'LIVE' : g.status === 'final' ? 'FINAL' : g.status === 'delayed' ? 'DELAYED' : g.status === 'postponed' ? 'POSTPONED' : 'UPCOMING';
    return (
      <div
        draggable={Boolean(canDrag)}
        onDragStart={() => player && setDrag(player.playerId)}
        onDragOver={(e) => { if (drag && canEdit) e.preventDefault(); }}
        onDrop={() => onDrop({ slot, player })}
        className={cx('grid grid-cols-[52px_1fr_auto] items-center gap-3 border-t border-line px-3 py-2.5 first:border-t-0 sm:grid-cols-[56px_1fr_170px_64px_70px_auto]', drag && player?.playerId === drag && 'opacity-40', canDrag && 'cursor-grab')}
      >
        <span className={cx('rounded-md py-1 text-center font-display text-[15px] font-semibold tracking-wide', slot === 'BN' || slot === 'IR' ? 'bg-sunken text-muted' : 'bg-turf text-white')}>{slotLabel(slot)}</span>
        {player ? (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5"><PlayerName leagueId={leagueId} id={player.playerId} name={player.name} injury={player.injuryStatus} />{player.locked && <Lock className="h-3.5 w-3.5 text-faint" aria-label="Locked: game started" />}</div>
            <div className="truncate text-[12px] text-muted">{player.position} · {player.nflTeamId ?? 'FA'}{g ? ` · ${g.isHome ? 'vs' : '@'} ${g.opponent}` : ''}{player.byeWeek ? ` · bye ${player.byeWeek}` : ''}</div>
          </div>
        ) : <div className="text-[13px] text-faint">Empty — {canEdit ? 'move a player here' : 'no starter'}</div>}
        <div className="hidden text-[12px] sm:block">{player && (gameDisplay === 'BYE' ? <Badge tone="warn">Bye week</Badge> : <StatusPill status={gameDisplay as any} detail={gameDisplay === 'UPCOMING' ? kickoff(g.kickoffAt) : gameDisplay === 'LIVE' ? `${g.quarter ?? ''} ${g.clock ?? ''}` : null} />)}</div>
        <div className="num hidden text-right text-[13px] text-muted sm:block" title="Projection (estimate)">{player ? pts(player.projected, 1) : ''}</div>
        <div className="num text-right font-display text-xl font-bold">{player ? <span className={cx(player.statsFinal ? '' : g?.status === 'in_progress' ? 'text-live' : player.points ? '' : 'text-faint')}>{pts(player.points)}</span> : ''}</div>
        <div className="hidden sm:block">{canEdit && data.editable && player && !player.locked && <Button size="sm" variant="ghost" aria-label={`Move ${player.name}`} onClick={() => setMoving(player)}><ArrowDownUp className="h-4 w-4" /></Button>}</div>
        {canEdit && data.editable && player && !player.locked && <button className="col-span-3 -mt-1 justify-self-start text-[12px] font-semibold text-accent sm:hidden" onClick={() => setMoving(player)}>Move</button>}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-4">
          <div><div className="label">Week {data.week} points</div><div className="num font-display text-4xl font-bold leading-none">{pts(data.points)}</div></div>
          <div><div className="label">Projected</div><div className="num font-display text-2xl font-semibold leading-none text-muted">{pts(data.projected, 1)}</div></div>
        </div>
        {canEdit && data.editable && <Button variant="turf" icon={<Wand2 className="h-4 w-4" />} onClick={() => setSuggest(true)}>Optimize lineup</Button>}
      </div>
      {!data.editable && <p className="rounded-lg bg-sunken px-3 py-2 text-[13px] text-muted">This week is final. Lineups shown are the locked results.</p>}
      <Card pad={false}><div className="label border-b border-line px-3 py-2">Starters</div>{rows.map((r) => <Row key={r.key} slot={r.slot} player={r.player} rowKey={r.key} />)}</Card>
      <Card pad={false}>
        <div className="label border-b border-line px-3 py-2" onDragOver={(e) => drag && e.preventDefault()} onDrop={() => { const p = all.find((x: any) => x.playerId === drag); setDrag(null); if (p && !p.locked && p.slot !== 'BN') moveTo(p, { slot: 'BN', player: null }); }}>Bench ({bench.length}/{cfg.BN})</div>
        {bench.length === 0 ? <div className="px-3 py-3 text-[13px] text-faint">No bench players.</div> : bench.map((p: any) => <Row key={p.playerId} slot="BN" player={p} rowKey={p.playerId} />)}
        {cfg.IR > 0 && <><div className="label border-y border-line px-3 py-2">Injured reserve ({ir.length}/{cfg.IR})</div>{ir.length === 0 ? <div className="px-3 py-3 text-[13px] text-faint">Players listed {cfg.irEligible.join(', ').toUpperCase()} can move here without using a roster spot.</div> : ir.map((p: any) => <Row key={p.playerId} slot="IR" player={p} rowKey={p.playerId} />)}</>}
      </Card>
      <p className="text-[12px] text-faint">Drag players between rows, or use Move. Players lock when their game kicks off. Live points are provisional until the stat provider marks the game final. Projections are estimates.</p>
      <Modal open={Boolean(moving)} onClose={() => setMoving(null)} title={moving ? `Move ${moving.name}` : ''}>
        {moving && <div className="space-y-1.5">{targetsFor(moving).map((t) => <button key={t.key + (t.player?.playerId ?? '')} onClick={() => moveTo(moving, t)} className="flex w-full items-center justify-between rounded-lg bg-raised px-3 py-2.5 text-left text-[14px] hover:bg-sunken"><span>{t.label}</span><span className="font-display font-semibold">{t.slot}</span></button>)}
          {targetsFor(moving).length === 0 && <p className="text-[13px] text-muted">No eligible open slots.</p>}</div>}
      </Modal>
      {suggest && <SuggestModal teamId={teamId} onClose={() => setSuggest(false)} onApply={(a) => { setSuggest(false); void apply(new Map(a.map((x: any) => [x.playerId, x.slot]))); }} />}
    </div>
  );
}

function SuggestModal({ teamId, onClose, onApply }: { teamId: string; onClose: () => void; onApply: (a: any[]) => void }) {
  const { data, isLoading, error } = useCall<any>(['roster', 'suggest', teamId], 'rosters.suggest', { teamId });
  return (
    <Modal open onClose={onClose} title="Lineup optimizer" footer={<><Button variant="ghost" onClick={onClose}>Keep my lineup</Button><Button variant="primary" disabled={!data?.changes?.length} onClick={() => onApply(data.assignment)}>Apply {data?.changes?.length ?? 0} change{data?.changes?.length === 1 ? '' : 's'}</Button></>}>
      {isLoading ? <LoadingBlock /> : error ? <ErrorNote error={error} /> : (
        <div className="space-y-4">
          <div className="flex items-center gap-4 rounded-xl bg-raised p-3">
            <Sparkles className="h-6 w-6 text-accent" />
            <div><div className="label">Projected starters</div><div className="num font-display text-2xl font-bold">{pts(data.projectedBefore, 1)} → {pts(data.projectedAfter, 1)}</div></div>
          </div>
          {data.changes.length === 0 ? <p className="text-[14px] text-muted">Your lineup already starts the highest-projected eligible players.</p> : (
            <ul className="space-y-2">
              {data.changes.map((c: any) => (
                <li key={c.playerId} className="rounded-lg hairline p-3">
                  <div className="flex items-center justify-between gap-2"><b>{c.name}</b><span className="font-display text-lg font-semibold">{c.from} → {c.to}</span></div>
                  <div className="text-[13px] text-muted">{c.reasons.join(' · ')}</div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[12px] text-faint">{data.note} Locked players are never moved.</p>
        </div>
      )}
    </Modal>
  );
}

function TeamSchedule({ leagueId, teamId, L }: { leagueId: string; teamId: string; L: any }) {
  const { data } = useCall<any[]>(['matchups', 'schedule', teamId], 'schedule.get', { leagueId, teamId });
  const tm = new Map(L.teams.map((t: any) => [t.id, t]));
  if (!data) return <LoadingBlock />;
  if (!data.length) return <Empty title="No schedule yet" body="The schedule is created when the draft completes." />;
  return (
    <Card pad={false}>
      {data.map((m: any) => {
        const home = m.home_team_id === teamId;
        const opp: any = tm.get(home ? m.away_team_id : m.home_team_id);
        const my = Number(home ? m.home_points : m.away_points), their = Number(home ? m.away_points : m.home_points);
        const res = m.status === 'final' ? (m.winner_team_id === teamId ? 'W' : m.winner_team_id ? 'L' : opp ? 'T' : '—') : null;
        return (
          <div key={m.id} className="flex items-center gap-3 border-t border-line px-4 py-2.5 first:border-t-0">
            <span className="num w-12 font-display text-lg font-semibold text-muted">WK {m.week}</span>
            <span className="min-w-0 flex-1 truncate">{opp ? <>{home ? 'vs' : '@'} <b>{opp.name}</b></> : <span className="text-muted">Personal points challenge</span>}{m.kind !== 'regular' && <Badge tone="accent" className="ml-2">{m.kind}</Badge>}</span>
            {res && <Badge tone={res === 'W' ? 'good' : res === 'L' ? 'bad' : 'neutral'}>{res}</Badge>}
            <span className="num w-28 text-right font-semibold">{m.status === 'scheduled' ? '' : `${pts(my)}${opp ? ` – ${pts(their)}` : ''}`}</span>
          </div>
        );
      })}
    </Card>
  );
}
