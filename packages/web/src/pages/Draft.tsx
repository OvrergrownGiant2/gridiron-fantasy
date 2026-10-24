import { ArrowDown, ArrowUp, Bot, Check, FastForward, Gavel, Grid3x3, ListOrdered, Pause, Play, Plus, Shuffle, Timer, Undo2, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { OvrBadge, PlayerCardPanel, PlayerHover, PlayerPhoto, TopAttrs, usePlayerMeta } from '../components/PlayerCard';
import { InjuryTag, Modal } from '../components/ui';
import { TeamChip, TeamLogo } from '../components/team';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorNote, Field, Input, LoadingBlock, PageHeader, SectionTitle, Segmented, Select, Tabs, cx, useToast } from '../components/ui';
import { teamMap, useAction, useCall, useLeague } from '../lib/hooks';
import { NFL_TEAM_IDS } from '../lib/nfl';

function useCountdown(deadline: string | null, serverNow: string | undefined) {
  const [offset] = useState(() => (serverNow ? Date.parse(serverNow) - Date.now() : 0));
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []);
  if (!deadline) return null;
  return Math.max(0, Math.round((Date.parse(deadline) - (now + offset)) / 1000));
}

const fmtClock = (s: number | null) => s === null ? '—' : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function Draft() {
  const { leagueId } = useParams();
  const [params, setParams] = useSearchParams();
  const mockId = params.get('mock') ?? undefined;
  const { data: L } = useLeague(leagueId);
  const { data, isLoading, error, refetch } = useCall<any>(['draft', leagueId, mockId ?? 'real'], 'drafts.get', { leagueId, draftId: mockId }, { refetchInterval: (q) => ((q.state.data as any)?.draft?.status === 'in_progress' ? 2000 : 15_000) });
  if (isLoading || !L) return <LoadingBlock rows={6} />;
  if (error) return <ErrorNote error={error} retry={refetch} />;
  const d = data.draft;
  if (!d || d.status === 'scheduled') return <PreDraft L={L} draft={d} onMock={(id) => setParams({ mock: id })} />;
  return <DraftRoom L={L} data={data} mock={Boolean(mockId)} onExitMock={() => setParams({})} />;
}

function PreDraft({ L, draft, onMock }: { L: any; draft: any; onMock: (id: string) => void }) {
  const canControl = L.permissions.includes('draft.control');
  const qc = useQueryClient();
  const toast = useToast();
  const tm = teamMap(L);
  const [type, setType] = useState(L.settings.draft.type);
  const [secs, setSecs] = useState(L.settings.draft.pickSeconds);
  const [order, setOrder] = useState<string[]>(draft?.order ?? L.teams.map((t: any) => t.id));
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [aiCount, setAiCount] = useState(Math.max(0, L.league.maxTeams - L.teams.length));
  useEffect(() => { if (draft?.order) setOrder(draft.order); else setOrder(L.teams.map((t: any) => t.id)); }, [draft?.order?.join(), L.teams.length]);
  const configure = useAction('drafts.configure', { invalidate: ['draft', 'league'], success: 'Draft order saved.' });
  const start = useAction('drafts.start', { invalidate: ['draft', 'league', 'dashboard'], success: 'The draft has started!' });
  const addAi = useAction('leagues.addAi', { invalidate: ['league'], success: (r: any) => `${r.added} AI manager(s) added.` });
  const mock = useAction('drafts.mock', { onSuccess: (r: any) => onMock(r.draftId) });
  const open = L.league.maxTeams - L.teams.length;
  const midSeason = L.settings.season.startWeek > 1;
  const move = (i: number, dlt: number) => { const o = [...order]; [o[i], o[i + dlt]] = [o[i + dlt], o[i]]; setOrder(o); };
  return (
    <div className="space-y-5">
      <PageHeader title="Draft room" sub={L.league.status === 'setup' ? 'The draft has not started.' : 'Draft complete.'}
        actions={<Button icon={<Zap className="h-4 w-4" />} loading={mock.isPending} disabled={!L.myTeamId} onClick={() => mock.mutate({ leagueId: L.league.id, type: type === 'linear' ? 'linear' : 'snake' })}>Mock draft</Button>} />
      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <Card>
          <SectionTitle sub={draft ? 'Saved order. Adjust and save again before starting.' : canControl ? 'Randomize or set the order, then save.' : 'The commissioner sets the order.'}
            action={canControl && <Button size="sm" icon={<Shuffle className="h-4 w-4" />} onClick={() => setOrder([...order].sort(() => Math.random() - 0.5))}>Shuffle</Button>}>Draft order</SectionTitle>
          <ol className="space-y-1.5">
            {order.map((id, i) => {
              const t = tm.get(id);
              if (!t) return null;
              return (
                <li key={id} className="flex items-center gap-3 rounded-lg bg-raised px-3 py-2">
                  <span className="num w-6 font-display text-xl font-bold text-muted">{i + 1}</span>
                  <TeamChip className="flex-1" team={t} sub={t.is_ai ? `AI · ${t.ai_difficulty}` : t.owner_name ?? 'Open'} size={30} />
                  {canControl && <div className="flex"><Button size="sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></Button><Button size="sm" variant="ghost" aria-label="Move down" disabled={i === order.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></Button></div>}
                </li>
              );
            })}
          </ol>
          {open > 0 && (
            <div className="mt-3 rounded-lg bg-raised p-3 text-[13px]">
              <p className="text-muted">{open} open seat{open === 1 ? '' : 's'}. Share this invite code with friends, or fill seats with AI managers.</p>
              {L.league.inviteCode && <div className="mt-2 flex items-center gap-2"><span className="rounded-md bg-sunken px-3 py-1.5 font-mono text-lg font-bold tracking-[.25em]">{L.league.inviteCode}</span>
                <Button size="sm" onClick={async () => { try { await navigator.clipboard.writeText(L.league.inviteCode); toast('good', 'Invite code copied.'); } catch { toast('info', 'Select the code to copy it.'); } }}>Copy</Button></div>}
            </div>
          )}
        </Card>
        <div className="space-y-4">
          {canControl ? (
            <>
              <Card>
                <SectionTitle>Settings</SectionTitle>
                <div className="space-y-3">
                  <Segmented size="sm" value={type} onChange={setType} options={[{ value: 'snake', label: 'Snake' }, { value: 'linear', label: 'Linear' }, { value: 'auction', label: 'Auction' }, { value: 'manual', label: 'Manual' }]} />
                  <Field label="Pick timer" htmlFor="pd-timer"><Select id="pd-timer" value={secs} onChange={(e) => setSecs(Number(e.target.value))}>{[30, 60, 90, 120, 300, 3600].map((n) => <option key={n} value={n}>{n < 60 ? `${n}s` : n < 3600 ? `${n / 60} min` : '1 hour'}</option>)}</Select></Field>
                  <Button className="w-full" loading={configure.isPending} onClick={() => configure.mutate({ leagueId: L.league.id, type, pickSeconds: secs, order })}>Save order & settings</Button>
                  <Button variant="primary" size="lg" className="w-full" icon={<Play className="h-4 w-4" />} loading={start.isPending} disabled={L.teams.length < 1}
                    onClick={async () => { if (!draft || draft.order.join() !== order.join() || draft.type !== type) await configure.mutateAsync({ leagueId: L.league.id, type, pickSeconds: secs, order }); start.mutate({ leagueId: L.league.id }); }}>Start draft</Button>
                </div>
              </Card>
              {open > 0 && (
                <Card>
                  <SectionTitle sub="AI managers follow the same rules as people.">Fill seats with AI</SectionTitle>
                  <div className="flex gap-2"><Select aria-label="How many" value={aiCount} onChange={(e) => setAiCount(Number(e.target.value))}>{Array.from({ length: open }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</Select>
                    <Button icon={<Bot className="h-4 w-4" />} loading={addAi.isPending} onClick={() => addAi.mutate({ leagueId: L.league.id, count: aiCount || 1, difficulty: 'medium' })}>Add</Button></div>
                </Card>
              )}
              <Card>
                <SectionTitle sub={midSeason ? 'Recommended for leagues that start after the NFL season began.' : 'Skip the live draft and let every team auto-draft by rankings and needs.'}>Build rosters automatically</SectionTitle>
                <Button className="w-full" onClick={() => setConfirmAuto(true)}>Auto-draft all teams</Button>
                <p className="mt-2 text-[12px] text-muted">You can still adjust rosters afterwards from the Digital Commissioner.</p>
              </Card>
            </>
          ) : <Card><p className="text-[14px] text-muted">Waiting for the commissioner to start the draft. Try a mock draft to practice.</p></Card>}
        </div>
      </div>
      <ConfirmDialog open={confirmAuto} onClose={() => setConfirmAuto(false)} title="Auto-draft every team?" confirmLabel="Auto-draft"
        body="Each team will draft automatically using rankings, positional needs and queues. Managers will not pick live. This is recorded in the audit log."
        onConfirm={async () => { await api().call('drafts.autoAll', { leagueId: L.league.id }); await qc.invalidateQueries(); toast('good', 'Rosters built. The season schedule is ready.'); }} />
    </div>
  );
}

function DraftRoom({ L, data, mock, onExitMock }: { L: any; data: any; mock: boolean; onExitMock: () => void }) {
  const d = data.draft;
  const tm = teamMap(L);
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [pos, setPos] = useState('');
  const [nflTeam, setNflTeam] = useState('');
  const [view, setView] = useState<'players' | 'board' | 'team'>('players');
  const [undo, setUndo] = useState(false);
  const [sort, setSort] = useState<'rank' | 'ovr'>('rank');
  const [selId, setSelId] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const meta = usePlayerMeta();
  const left = useCountdown(d.status === 'in_progress' ? (d.type === 'auction' ? (d.auction?.phase === 'bidding' ? d.auction.endsAt : d.pickDeadline) : d.pickDeadline) : null, data.serverNow);
  const { data: avail } = useCall<any[]>(['draftAvailable', d.id, q, pos, nflTeam, sort, data.picks.length], 'drafts.available', { leagueId: L.league.id, draftId: d.id, q: q || undefined, position: pos || undefined, nflTeam: nflTeam || undefined, limit: 120, sort }, { enabled: d.status !== 'complete' });
  const canControl = !mock && L.permissions.includes('draft.control');
  const myTurn = d.onClockTeamId && d.onClockTeamId === data.myTeamId;
  const onClock = d.onClockTeamId ? tm.get(d.onClockTeamId) : null;
  const pause = useAction('drafts.pause', { invalidate: ['draft'] });
  const queueIds: string[] = data.queue.map((x: any) => x.player_id);
  const setQueue = useAction('drafts.queue', { invalidate: ['draft'], quiet: true });
  const pick = async (playerId: string) => {
    try { await api().call('drafts.pick', { leagueId: L.league.id, draftId: d.id, playerId, expectedPick: d.currentPick }); qc.invalidateQueries({ queryKey: ['draft'] }); qc.invalidateQueries({ queryKey: ['draftAvailable'] }); }
    catch (e: any) { toast('bad', e.message); qc.invalidateQueries({ queryKey: ['draft'] }); }
  };
  const myPicks = data.picks.filter((p: any) => p.team_id === data.myTeamId);
  // Only offered when nobody else is a person, so no one drafts on another person's behalf.
  const othersAllAi = L.teams.every((t: any) => t.id === data.myTeamId || t.is_ai);
  const canFinish = Boolean(data.myTeamId) && d.type !== 'auction' && d.status === 'in_progress' && (mock || othersAllAi);
  const finish = async () => {
    setFinishing(true);
    try { const r = await api().call<any>('drafts.finishForMe', { leagueId: L.league.id, draftId: d.id }); toast('good', `${r.picks} picks made for you.`); await qc.invalidateQueries(); }
    catch (e: any) { toast('bad', e.message); } finally { setFinishing(false); }
  };
  const list: any[] = avail ?? [];
  const sel = list.find((p) => p.id === selId) ?? list[0] ?? null;
  const canPick = (myTurn || (canControl && !mock)) && d.status === 'in_progress' && d.type !== 'auction';
  const choose = (p: any) => { setSelId(p.id); if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) setSheet(true); };
  const pickAndClose = async (id: string) => { await pick(id); setSheet(false); setSelId(null); };
  const selActions = sel && (
    <>
      {canPick && <Button variant="primary" icon={<Check className="h-4 w-4" />} onClick={() => pickAndClose(sel.id)}>{myTurn ? `Draft ${sel.full_name.split(' ').slice(-1)[0]}` : 'Pick for team'}</Button>}
      {!queueIds.includes(sel.id) && data.myTeamId && <Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setQueue.mutate({ leagueId: L.league.id, draftId: d.id, playerIds: [...queueIds, sel.id] })}>Queue</Button>}
      {d.type === 'auction' && d.auction?.phase === 'nominating' && (d.auction.nominatorTeamId === data.myTeamId || canControl) && <Button variant="primary" onClick={() => api().call('drafts.nominate', { leagueId: L.league.id, draftId: d.id, playerId: sel.id, openingBid: 1 }).then(() => { qc.invalidateQueries({ queryKey: ['draft'] }); setSheet(false); }).catch((e) => toast('bad', e.message))}>Nominate $1</Button>}
    </>
  );
  const recent = [...data.picks].reverse().slice(0, 12);
  const upcoming = useMemo(() => {
    if (d.type === 'auction') return [];
    const out: string[] = [];
    const n = d.order.length;
    for (let o = d.currentPick; o < Math.min(d.totalPicks + 1, d.currentPick + n + 2); o++) {
      const round = Math.ceil(o / n), idx = (o - 1) % n;
      out.push(d.order[(d.type === 'snake' || d.type === 'manual') && round % 2 === 0 ? n - 1 - idx : idx]);
    }
    return out;
  }, [d.currentPick, d.order, d.type, d.totalPicks]);

  if (d.status === 'complete') {
    return (
      <div className="space-y-5">
        <PageHeader title={mock ? 'Mock draft complete' : 'Draft complete'} sub={`${data.picks.length} picks made.`} actions={mock ? <Button onClick={onExitMock}>Back to draft room</Button> : <Link to={`/league/${L.league.id}/team`}><Button variant="primary">Go to my team</Button></Link>} />
        <Board d={d} picks={data.picks} tm={tm} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-card bg-turf text-white">
        <div className="flex flex-wrap items-center gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            {onClock && <TeamLogo team={onClock} size={46} />}
            <div>
              <div className="text-[11px] uppercase tracking-[.14em] text-white/60">{mock ? 'Mock draft · ' : ''}{d.type === 'auction' ? (d.auction?.phase === 'bidding' ? 'Bidding' : `Nominating: ${tm.get(d.auction?.nominatorTeamId)?.name ?? ''}`) : `Round ${d.label?.round} · Pick ${d.label?.pickInRound} · #${d.currentPick} of ${d.totalPicks}`}</div>
              <div className="font-display text-2xl font-bold uppercase leading-tight">{d.status === 'paused' ? 'Draft paused' : d.type === 'auction' ? (d.auction?.player?.full_name ?? 'Up for nomination') : myTurn ? "You're on the clock" : `${onClock?.name ?? ''} on the clock`}</div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className={cx('flex items-center gap-2 rounded-xl px-3 py-1.5 font-display text-3xl font-bold tabular-nums', left !== null && left <= 10 ? 'bg-live text-white' : 'bg-white/10')}><Timer className="h-5 w-5" />{d.status === 'paused' ? 'Paused' : fmtClock(left)}</div>
            {canControl && <>
              <Button variant="secondary" size="sm" icon={d.status === 'paused' ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />} onClick={() => pause.mutate({ leagueId: L.league.id, paused: d.status !== 'paused' })}>{d.status === 'paused' ? 'Resume' : 'Pause'}</Button>
              <Button variant="secondary" size="sm" icon={<Undo2 className="h-4 w-4" />} disabled={!data.picks.length} onClick={() => setUndo(true)}>Undo</Button>
            </>}
            {canFinish && <Button variant="secondary" size="sm" icon={<FastForward className="h-4 w-4" />} loading={finishing} onClick={finish}>Finish for me</Button>}
            {mock && <Button variant="secondary" size="sm" icon={<X className="h-4 w-4" />} onClick={onExitMock}>Leave mock</Button>}
          </div>
        </div>
        {upcoming.length > 0 && (
          <div className="scroll-x flex gap-1.5 border-t border-white/10 px-4 py-2">
            {upcoming.map((id, i) => { const t = tm.get(id); return <span key={i} className={cx('flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[12px]', i === 0 ? 'bg-accent font-semibold text-[#12201B]' : 'bg-white/10', id === data.myTeamId && i > 0 && 'ring-1 ring-accent')}><TeamLogo team={t} size={18} />{t?.abbrev}</span>; })}
          </div>
        )}
      </div>
      {d.type === 'auction' && <AuctionPanel L={L} data={data} tm={tm} left={left} />}
      <Tabs value={view} onChange={setView} tabs={[{ value: 'players', label: 'Players' }, { value: 'board', label: 'Draft board' }, { value: 'team', label: `My picks (${myPicks.length})` }]} />
      {view === 'players' && (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <Card pad={false} className="min-w-0">
            <div className="flex flex-wrap gap-2 border-b border-line p-3">
              <Input aria-label="Search available players" className="min-w-[160px] flex-1" placeholder="Search available players" value={q} onChange={(e) => setQ(e.target.value)} />
              <Select aria-label="NFL team" className="h-10 w-auto" value={nflTeam} onChange={(e) => setNflTeam(e.target.value)}><option value="">All teams</option>{NFL_TEAM_IDS.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
              <Segmented size="sm" value={sort} onChange={setSort} options={[{ value: 'rank', label: 'Rank' }, { value: 'ovr', label: 'OVR' }]} />
              <Segmented size="sm" value={pos || 'ALL'} onChange={(v) => setPos(v === 'ALL' ? '' : v)} options={['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'].map((p) => ({ value: p, label: p }))} />
            </div>
            <div className="max-h-[640px] overflow-y-auto" role="listbox" aria-label="Available players">
              {list.map((p: any) => {
                const on = sel?.id === p.id;
                const line = p.profile?.card?.line ?? [];
                return (
                  <div key={p.id} role="option" aria-selected={on} tabIndex={0} onClick={() => choose(p)} onKeyDown={(e) => { if (e.key === 'Enter') choose(p); }}
                    className={cx('flex cursor-pointer items-center gap-2.5 border-b border-line px-3 py-2 transition last:border-0 hover:bg-raised sm:gap-3', on && 'bg-raised shadow-[inset_3px_0_0_rgb(var(--accent))]')}>
                    <span className="num hidden w-7 text-right text-[12px] text-faint sm:block">{p.rank}</span>
                    <PlayerHover playerId={p.id} disabled={on}><PlayerPhoto id={p.id} name={p.full_name} position={p.position} team={p.nfl_team_id} size={40} src={p.profile?.headshot ?? null} /></PlayerHover>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5"><PlayerHover playerId={p.id} disabled={on}><span className="truncate font-semibold">{p.full_name}</span></PlayerHover>{p.injury_status && p.injury_status !== 'healthy' && <InjuryTag status={p.injury_status} />}</div>
                      <div className="flex items-center gap-2 text-[12px] text-muted"><span className="shrink-0">{p.position} · {p.nfl_team_id ?? 'FA'}</span>
                        <span className="hidden truncate text-faint md:inline">{line.slice(1, 4).map((x: any) => `${x.value} ${x.label.toLowerCase()}`).join(' · ')}</span></div>
                    </div>
                    <span className="hidden sm:block"><TopAttrs profile={p.profile} /></span>
                    <OvrBadge ovr={p.profile?.card?.ovr} />
                    {canPick && <Button size="sm" variant={myTurn ? 'primary' : 'secondary'} className="hidden sm:inline-flex" onClick={(e) => { e.stopPropagation(); pick(p.id); }}>{myTurn ? 'Draft' : 'Pick'}</Button>}
                  </div>
                );
              })}
              {list.length === 0 && <p className="p-4 text-[13px] text-muted">No available players match.</p>}
            </div>
          </Card>
          <div className="space-y-4">
            {sel && <div className="hidden lg:block"><PlayerCardPanel player={{ id: sel.id, name: sel.full_name, position: sel.position, nflTeamId: sel.nfl_team_id, jersey: sel.jersey }} profile={sel.profile} actions={selActions} /></div>}
            <Card pad={false}>
              <div className="label border-b border-line px-3 py-2">Your queue</div>
              {data.queue.length === 0 ? <p className="px-3 py-3 text-[13px] text-muted">Queue players to auto-pick them if your timer runs out.</p> : data.queue.map((x: any, i: number) => (
                <div key={x.player_id} className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[13px] last:border-0">
                  <span className="num w-4 text-faint">{i + 1}</span><PlayerHover playerId={x.player_id} className="flex-1 items-center gap-2"><PlayerPhoto id={x.player_id} name={x.full_name} position={x.position} team={x.nfl_team_id} size={24} /><span className="min-w-0 flex-1 truncate"><b>{x.full_name}</b> <span className="text-muted">{x.position}</span></span></PlayerHover>
                  <button aria-label="Remove from queue" className="text-faint hover:text-bad" onClick={() => setQueue.mutate({ leagueId: L.league.id, draftId: d.id, playerIds: queueIds.filter((id) => id !== x.player_id) })}><X className="h-3.5 w-3.5" /></button>
                </div>
              ))}
            </Card>
            <Card pad={false}>
              <div className="label border-b border-line px-3 py-2">Recent picks</div>
              {recent.length === 0 ? <p className="px-3 py-3 text-[13px] text-muted">No picks yet.</p> : recent.map((p: any) => (
                <div key={p.overall} className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[13px] last:border-0 animate-slideUp">
                  <span className="num w-7 text-faint">{p.overall}</span><TeamLogo team={tm.get(p.team_id)} size={20} />
                  <PlayerHover playerId={p.player_id} className="flex-1 items-center gap-2"><PlayerPhoto id={p.player_id} name={p.full_name} position={p.position} team={p.nfl_team_id} size={24} />
                  <span className="min-w-0 flex-1 truncate"><b>{p.full_name}</b> <span className="text-muted">{p.position}{p.price ? ` · $${p.price}` : ''}</span></span></PlayerHover>
                  <OvrBadge ovr={meta?.[p.player_id]?.[1]} size="sm" />{p.is_auto && <Badge>auto</Badge>}
                </div>
              ))}
            </Card>
          </div>
          <Modal open={sheet && Boolean(sel)} onClose={() => setSheet(false)} title={sel?.full_name ?? 'Player'}>
            {sel && <PlayerCardPanel player={{ id: sel.id, name: sel.full_name, position: sel.position, nflTeamId: sel.nfl_team_id, jersey: sel.jersey }} profile={sel.profile} actions={selActions} />}
          </Modal>
        </div>
      )}
      {view === 'board' && <Board d={d} picks={data.picks} tm={tm} />}
      {view === 'team' && (
        <Card pad={false}>
          {myPicks.length === 0 ? <p className="p-4 text-[13px] text-muted">You haven't drafted anyone yet.</p> : myPicks.map((p: any) => (
            <div key={p.overall} className="flex items-center gap-3 border-b border-line px-4 py-2 text-[13px] last:border-0"><span className="num w-14 text-muted">R{p.round}·{p.pick_in_round}</span><PlayerHover playerId={p.player_id} className="flex-1 items-center gap-3"><PlayerPhoto id={p.player_id} name={p.full_name} position={p.position} team={p.nfl_team_id} size={32} /><b className="min-w-0 flex-1 truncate">{p.full_name}</b></PlayerHover><span className="text-muted">{p.position} · {p.nfl_team_id}</span>{p.price ? <span className="num">${p.price}</span> : null}<OvrBadge ovr={meta?.[p.player_id]?.[1]} size="sm" /></div>
          ))}
        </Card>
      )}
      <ConfirmDialog open={undo} onClose={() => setUndo(false)} title="Undo the last pick?" confirmLabel="Undo pick" requireReason danger
        body="The player returns to the pool and the team goes back on the clock." onConfirm={(reason) => api().call('drafts.undo', { leagueId: L.league.id, reason }).then(() => qc.invalidateQueries({ queryKey: ['draft'] }))} />
    </div>
  );
}

function Board({ d, picks, tm }: { d: any; picks: any[]; tm: Map<string, any> }) {
  const n = d.order.length;
  const byPick = new Map(picks.map((p: any) => [`${p.round}:${p.team_id}`, p]));
  if (d.type === 'auction') {
    return <Card pad={false}>{d.order.map((tid: string) => <div key={tid} className="border-b border-line p-3 last:border-0"><TeamChip team={tm.get(tid)} size={24} /><div className="mt-1 flex flex-wrap gap-1.5">{picks.filter((p) => p.team_id === tid).map((p) => <span key={p.overall} className="rounded bg-raised px-2 py-0.5 text-[12px]">{p.full_name} · ${p.price}</span>)}</div></div>)}</Card>;
  }
  const posTone: Record<string, string> = { QB: 'bg-[#E8D5F7] text-[#3B1A5A]', RB: 'bg-[#D3F0DE] text-[#0F4A2A]', WR: 'bg-[#D5E6FA] text-[#163C66]', TE: 'bg-[#FBE3C9] text-[#6A3A06]', K: 'bg-[#E5E7EB] text-[#374151]', DST: 'bg-[#F3D3D3] text-[#6B1717]' };
  return (
    <div className="scroll-x rounded-card bg-surface hairline">
      <table className="text-[12px]" style={{ minWidth: n * 136 + 40 }}>
        <thead><tr><th className="sticky left-0 bg-surface p-2" />{d.order.map((tid: string) => <th key={tid} className="w-[136px] p-2 text-left"><div className="flex items-center gap-1.5"><TeamLogo team={tm.get(tid)} size={20} /><span className="truncate">{tm.get(tid)?.abbrev}</span></div></th>)}</tr></thead>
        <tbody>
          {Array.from({ length: d.rounds }, (_, r) => (
            <tr key={r}>
              <td className="num sticky left-0 bg-surface p-2 font-display text-[14px] font-semibold text-muted">R{r + 1}</td>
              {d.order.map((tid: string) => {
                const p: any = byPick.get(`${r + 1}:${tid}`);
                return <td key={tid} className="p-1">{p ? <PlayerHover playerId={p.player_id} className="w-full"><div className={cx('flex w-full items-center gap-1.5 rounded-md px-1.5 py-1', posTone[p.position])}><PlayerPhoto id={p.player_id} name={p.full_name} position={p.position} team={p.nfl_team_id} size={24} /><div className="min-w-0"><div className="truncate font-semibold">{p.full_name}</div><div className="opacity-70">{p.position} · {p.nfl_team_id}</div></div></div></PlayerHover> : <div className="h-[38px] rounded-md bg-sunken" />}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuctionPanel({ L, data, tm, left }: { L: any; data: any; tm: Map<string, any>; left: number | null }) {
  const d = data.draft, a = d.auction;
  const qc = useQueryClient();
  const toast = useToast();
  const [custom, setCustom] = useState('');
  const myBudget = data.budgets.find((b: any) => b.team_id === data.myTeamId)?.remaining ?? 0;
  const bid = (amount: number) => api().call('drafts.bid', { leagueId: L.league.id, draftId: d.id, teamId: data.myTeamId, amount }).then(() => qc.invalidateQueries({ queryKey: ['draft'] })).catch((e) => toast('bad', e.message));
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <Card>
        {a?.phase === 'bidding' && a.player ? (
          <div className="flex flex-wrap items-center gap-4">
            <div className="min-w-0 flex-1"><div className="label">Up for bid</div><div className="font-display text-3xl font-bold uppercase">{a.player.full_name}</div><div className="text-muted">{a.player.position} · {a.player.nfl_team_id}</div></div>
            <div className="text-right"><div className="label">High bid</div><div className="num font-display text-4xl font-bold">${a.highBid}</div><div className="text-[13px] text-muted">{tm.get(a.highTeamId)?.name}</div></div>
            {data.myTeamId && a.highTeamId !== data.myTeamId && (
              <div className="flex w-full flex-wrap gap-2">
                <Button variant="primary" onClick={() => bid(a.highBid + 1)}>Bid ${a.highBid + 1}</Button>
                <Button onClick={() => bid(a.highBid + 5)}>${a.highBid + 5}</Button>
                <Input aria-label="Custom bid" className="w-24" inputMode="numeric" value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, ''))} placeholder="$" />
                <Button disabled={!custom} onClick={() => { bid(Number(custom)); setCustom(''); }}>Bid</Button>
                <span className="self-center text-[13px] text-muted">Closes in {left ?? '—'}s · late bids extend the clock</span>
              </div>
            )}
          </div>
        ) : <p className="text-[14px] text-muted">{tm.get(a?.nominatorTeamId)?.name ?? 'A team'} is nominating the next player{a?.nominatorTeamId === data.myTeamId ? ' — that is you. Pick a player below and nominate.' : '.'}</p>}
      </Card>
      <Card pad={false}>
        <div className="label border-b border-line px-3 py-2">Budgets · you have ${myBudget}</div>
        {data.budgets.map((b: any) => <div key={b.team_id} className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[13px] last:border-0"><TeamLogo team={tm.get(b.team_id)} size={20} /><span className="flex-1 truncate">{tm.get(b.team_id)?.name}</span><span className="num font-semibold">${b.remaining}</span></div>)}
      </Card>
    </div>
  );
}

export { Gavel, Grid3x3, ListOrdered };
