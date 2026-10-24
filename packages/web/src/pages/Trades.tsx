import { AlertTriangle, ArrowLeftRight, Check, Flag, Gavel, Plus, Vote, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { PlayerName } from '../components/PlayerModal';
import { TeamChip, TeamLogo } from '../components/team';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorNote, Field, Input, LoadingBlock, Modal, PageHeader, Select, Tabs, Textarea, cx, useToast } from '../components/ui';
import { dateTime, pts, relative } from '../lib/format';
import { teamMap, useAction, useCall, useLeague } from '../lib/hooks';
import { useQueryClient } from '@tanstack/react-query';

const STATUS_TONE: Record<string, any> = { proposed: 'info', in_review: 'warn', approved: 'good', executed: 'good', rejected: 'neutral', canceled: 'neutral', expired: 'neutral', countered: 'neutral', vetoed: 'bad', failed: 'bad' };

export function Trades() {
  const { leagueId } = useParams();
  const [params, setParams] = useSearchParams();
  const { data: L } = useLeague(leagueId);
  const [scope, setScope] = useState<'open' | 'all'>('open');
  const { data, isLoading, error, refetch } = useCall<any[]>(['trades', leagueId, scope], 'trades.list', { leagueId, scope });
  const [builder, setBuilder] = useState<{ counterOf?: any } | null>(params.get('new') ? {} : null);
  if (isLoading || !L) return <LoadingBlock />;
  const tm = teamMap(L);
  const canTrade = L.myTeamId && L.role !== 'observer' && L.league.status === 'in_season';
  const mine = (t: any) => t.proposerTeamId === L.myTeamId || t.recipientTeamId === L.myTeamId;
  const list = data ?? [];
  const incoming = list.filter((t) => t.status === 'proposed' && t.recipientTeamId === L.myTeamId);
  return (
    <div className="space-y-5">
      <PageHeader title="Trades" sub={`Review: ${L.settings.trades.review.replace('_', ' ')} · deadline ${L.settings.trades.tradeDeadlineWeek ? `after week ${L.settings.trades.tradeDeadlineWeek}` : 'none'} · offers expire after ${L.settings.trades.offerExpiryHours}h`}
        actions={canTrade ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setBuilder({})}>Propose trade</Button> : null} />
      {L.league.status !== 'in_season' && <p className="rounded-lg bg-sunken px-3 py-2 text-[13px] text-muted">Trades are open during the regular season{L.settings.trades.tradeDeadlineWeek ? ', up to the deadline' : ''}.</p>}
      <Tabs value={scope} onChange={setScope} tabs={[{ value: 'open', label: 'Active & recent', count: incoming.length }, { value: 'all', label: 'All trades' }]} />
      {error ? <ErrorNote error={error} retry={refetch} /> : list.length === 0 ? <Empty icon={<ArrowLeftRight className="h-8 w-8" />} title="No trades yet" body="Propose a trade to another manager. The digital commissioner checks every rule before anything moves." /> : (
        <div className="space-y-3">{[...list].sort((a, b) => Number(mine(b)) - Number(mine(a))).map((t) => <TradeCard key={t.id} t={t} L={L} tm={tm} onCounter={() => setBuilder({ counterOf: t })} />)}</div>
      )}
      {builder && <TradeBuilder L={L} counterOf={builder.counterOf} onClose={() => { setBuilder(null); if (params.get('new')) setParams({}); }} />}
    </div>
  );
}

function assetLabel(a: any) {
  if (a.asset_type === 'faab') return `$${a.faab_amount} FAAB`;
  if (a.asset_type === 'draft_pick') return `${a.draft_season} round ${a.draft_round} pick`;
  return null;
}

function TradeCard({ t, L, tm, onCounter }: { t: any; L: any; tm: Map<string, any>; onCounter: () => void }) {
  const p = tm.get(t.proposerTeamId), r = tm.get(t.recipientTeamId);
  const me = L.myTeamId;
  const [accepting, setAccepting] = useState(false);
  const [decide, setDecide] = useState<'approve' | 'veto' | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const reject = useAction('trades.reject', { invalidate: ['trades'], success: 'Trade declined.' });
  const cancel = useAction('trades.cancel', { invalidate: ['trades'], success: 'Offer withdrawn.' });
  const vote = useAction('trades.vote', { invalidate: ['trades', 'roster'], success: (o: any) => o.outcome === 'pending' ? 'Vote recorded.' : `Vote recorded. The trade was ${o.outcome}.` });
  const decideA = useAction('trades.decide', { invalidate: ['trades', 'roster', 'commish'] });
  const side = (teamId: string) => t.assets.filter((a: any) => a.to_team_id === teamId);
  const analysisSide = (teamId: string) => t.analysis?.sides?.find((s: any) => s.teamId === teamId);
  const canReview = L.permissions.includes('trade.review') && t.status === 'in_review' && t.reviewRoute === 'commissioner';
  return (
    <Card pad={false} className={cx(t.status === 'proposed' && t.recipientTeamId === me && 'ring-2 ring-accent')}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <Badge tone={STATUS_TONE[t.status]}>{t.status.replace('_', ' ')}</Badge>
          {t.parentTradeId && <Badge>Counteroffer</Badge>}
          <span className="text-muted">Proposed {relative(t.createdAt)}{t.status === 'proposed' ? ` · expires ${dateTime(t.expiresAt)}` : ''}{t.reviewEndsAt && t.status === 'in_review' ? ` · review ends ${dateTime(t.reviewEndsAt)}` : ''}</span>
        </div>
      </div>
      <div className="grid gap-px bg-line md:grid-cols-2">
        {[p, r].map((team) => {
          const a = analysisSide(team.id);
          return (
            <div key={team.id} className="bg-surface p-4">
              <div className="mb-2 flex items-center justify-between gap-2"><TeamChip team={team} sub={team.id === me ? 'You receive' : 'Receives'} size={30} />
                {a && <span className="num text-right text-[12px] text-muted" title="Model estimate">{a.weeklyPointsChange >= 0 ? '+' : ''}{pts(a.weeklyPointsChange, 1)} pts/wk</span>}</div>
              <ul className="space-y-1.5">
                {side(team.id).map((x: any) => (
                  <li key={x.id} className="flex items-center gap-2 rounded-lg bg-raised px-2.5 py-1.5 text-[13px]">
                    {x.asset_type === 'player' ? <><PlayerName leagueId={L.league.id} id={x.player_id} name={x.full_name} injury={x.injury_status} /><span className="text-[12px] text-muted">{x.position} · {x.nfl_team_id}</span></> : <b>{assetLabel(x)}</b>}
                  </li>
                ))}
              </ul>
              {a && (a.injuryRisks.length > 0 || a.byeConflicts.length > 0 || a.needsAddressed.length > 0 || a.needsCreated.length > 0) && (
                <div className="mt-2 space-y-0.5 text-[12px] text-muted">
                  {a.needsAddressed.length > 0 && <div className="text-good">Addresses need at {a.needsAddressed.join(', ')}</div>}
                  {a.needsCreated.length > 0 && <div className="text-warn">Opens a hole at {a.needsCreated.join(', ')}</div>}
                  {a.injuryRisks.map((x: string) => <div key={x}>⚕ {x}</div>)}
                  {a.byeConflicts.map((x: string) => <div key={x}>{x}</div>)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {(t.message || t.analysis || t.flags.length > 0 || t.reviewReason || t.decisionReason || t.dropNames.length > 0) && (
        <div className="space-y-2 border-t border-line px-4 py-3 text-[13px]">
          {t.message && <p className="italic text-muted">“{t.message}”</p>}
          {t.dropNames.length > 0 && <p className="text-muted">Roster drops on completion: {t.dropNames.map((d: any) => d.full_name).join(', ')}</p>}
          {t.analysis && <p><b>Analysis (advisory):</b> {t.analysis.summary} <span className="text-faint">{t.analysis.disclaimer}</span></p>}
          {t.flags.length > 0 && (
            <div className="rounded-lg bg-warn/10 p-2.5">
              {t.flags.map((f: any) => <div key={f.code} className="flex items-start gap-1.5"><Flag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />{f.message}</div>)}
              <div className="mt-1 text-[12px] text-muted">{t.flagDisclaimer}</div>
            </div>
          )}
          {t.reviewReason && <p className="text-muted"><Gavel className="mr-1 inline h-3.5 w-3.5" />{t.reviewReason}</p>}
          {t.decisionReason && <p><b>Decision:</b> {t.decisionReason}</p>}
          {t.reviewRoute === 'league_vote' && (
            <p className="text-muted"><Vote className="mr-1 inline h-3.5 w-3.5" />{t.votesCast} of {t.eligibleVoters} eligible managers voted{t.votes ? ` · ${t.votes.approve} approve, ${t.votes.veto} veto` : ' · counts hidden until voting closes'}{t.myVote ? ` · you voted ${t.myVote}` : ''}</p>
          )}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3 empty:hidden">
        {t.status === 'proposed' && t.recipientTeamId === me && <>
          <Button size="sm" variant="ghost" icon={<X className="h-4 w-4" />} onClick={() => setRejecting(true)}>Decline</Button>
          <Button size="sm" icon={<ArrowLeftRight className="h-4 w-4" />} onClick={onCounter}>Counter</Button>
          <Button size="sm" variant="primary" icon={<Check className="h-4 w-4" />} onClick={() => setAccepting(true)}>Accept</Button>
        </>}
        {t.status === 'proposed' && t.proposerTeamId === me && <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate({ tradeId: t.id })}>Withdraw offer</Button>}
        {t.canVote && !t.myVote && t.status === 'in_review' && <>
          <Button size="sm" variant="danger" loading={vote.isPending} onClick={() => vote.mutate({ tradeId: t.id, vote: 'veto' })}>Vote veto</Button>
          <Button size="sm" variant="primary" loading={vote.isPending} onClick={() => vote.mutate({ tradeId: t.id, vote: 'approve' })}>Vote approve</Button>
        </>}
        {canReview && <>
          <Button size="sm" variant="danger" onClick={() => setDecide('veto')}>Veto</Button>
          <Button size="sm" variant="primary" onClick={() => setDecide('approve')}>Approve</Button>
        </>}
      </div>
      {accepting && <AcceptModal t={t} L={L} onClose={() => setAccepting(false)} />}
      <ConfirmDialog open={rejecting} onClose={() => setRejecting(false)} title="Decline this trade?" confirmLabel="Decline" requireReason={false}
        body="The other manager will be notified. You can still send a counteroffer instead." onConfirm={() => reject.mutateAsync({ tradeId: t.id })} />
      <ConfirmDialog open={Boolean(decide)} onClose={() => setDecide(null)} title={decide === 'approve' ? 'Approve trade' : 'Veto trade'} confirmLabel={decide === 'approve' ? 'Approve and execute' : 'Veto'} danger={decide === 'veto'} requireReason
        reasonLabel="Explain your decision (shown to the league and stored in the audit log)"
        body={decide === 'veto' ? 'Vetoing should be reserved for rule violations or clear collusion. An unbalanced trade alone is not a rule violation.' : 'Players move immediately if none are locked; otherwise the trade executes when the week ends.'}
        onConfirm={async (reason) => { await decideA.mutateAsync({ tradeId: t.id, decision: decide, reason }); }} />
    </Card>
  );
}

function AcceptModal({ t, L, onClose }: { t: any; L: any; onClose: () => void }) {
  const { data: roster } = useCall<any>(['roster', L.myTeamId], 'rosters.get', { teamId: L.myTeamId });
  const [drops, setDrops] = useState<string[]>([]);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const inCount = t.assets.filter((a: any) => a.asset_type === 'player' && a.to_team_id === L.myTeamId).length;
  const outIds = t.assets.filter((a: any) => a.asset_type === 'player' && a.from_team_id === L.myTeamId).map((a: any) => a.player_id);
  const players = roster ? [...roster.starters, ...roster.bench].filter((p: any) => p.slot !== 'IR') : [];
  const need = roster ? Math.max(0, players.length + inCount - outIds.length - roster.maxActive) : 0;
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api().call<any>('trades.accept', { tradeId: t.id, recipientDrops: drops });
      toast('good', r.route === 'auto' ? 'Trade accepted and processed.' : `Trade accepted. ${r.reason}`);
      for (const k of ['trades', 'roster', 'players', 'dashboard']) qc.invalidateQueries({ queryKey: [k] });
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Accept trade" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={drops.length < need} onClick={go}>Accept trade</Button></>}>
      <div className="space-y-3 text-[14px]">
        <p className="text-muted">Accepting is binding once the league's review process approves it ({L.settings.trades.review.replace('_', ' ')}).</p>
        {need > 0 && (
          <Field label={`Choose ${need} player${need === 1 ? '' : 's'} to drop to make room`}>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {players.filter((p: any) => !outIds.includes(p.playerId)).map((p: any) => (
                <label key={p.playerId} className={cx('flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 hairline', drops.includes(p.playerId) && 'bg-bad/10')}>
                  <input type="checkbox" disabled={p.locked} checked={drops.includes(p.playerId)} onChange={(e) => setDrops(e.target.checked ? [...drops, p.playerId].slice(-need) : drops.filter((d) => d !== p.playerId))} />
                  <span className="flex-1">{p.name} <span className="text-[12px] text-muted">{p.position} · {p.slot}{p.locked ? ' · locked' : ''}</span></span>
                </label>
              ))}
            </div>
          </Field>
        )}
        <ErrorNote error={err} />
      </div>
    </Modal>
  );
}

interface Pick { fromTeamId: string; toTeamId: string; type: 'player' | 'faab' | 'draft_pick'; playerId?: string; faabAmount?: number; draftRound?: number; draftSeason?: number }

function TradeBuilder({ L, counterOf, onClose }: { L: any; counterOf?: any; onClose: () => void }) {
  const me = L.myTeamId;
  const others = L.teams.filter((t: any) => t.id !== me);
  const [partner, setPartner] = useState<string>(counterOf ? counterOf.proposerTeamId : others[0]?.id);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(counterOf ? counterOf.assets.filter((a: any) => a.asset_type === 'player').map((a: any) => a.player_id) : []));
  const [faab, setFaab] = useState<{ mine: number; theirs: number }>({ mine: 0, theirs: 0 });
  const [picks, setPicks] = useState<Pick[]>([]);
  const [message, setMessage] = useState('');
  const [drops, setDrops] = useState<string[]>([]);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const { data: mine } = useCall<any>(['roster', me], 'rosters.get', { teamId: me });
  const { data: theirs } = useCall<any>(['roster', partner], 'rosters.get', { teamId: partner }, { enabled: Boolean(partner) });
  const list = (r: any) => (r ? [...r.starters, ...r.bench] : []);
  const assets: Pick[] = useMemo(() => {
    const out: Pick[] = [];
    for (const p of list(mine)) if (selected.has(p.playerId)) out.push({ fromTeamId: me, toTeamId: partner, type: 'player', playerId: p.playerId });
    for (const p of list(theirs)) if (selected.has(p.playerId)) out.push({ fromTeamId: partner, toTeamId: me, type: 'player', playerId: p.playerId });
    if (faab.mine > 0) out.push({ fromTeamId: me, toTeamId: partner, type: 'faab', faabAmount: faab.mine });
    if (faab.theirs > 0) out.push({ fromTeamId: partner, toTeamId: me, type: 'faab', faabAmount: faab.theirs });
    return [...out, ...picks];
  }, [mine, theirs, selected, faab, picks, me, partner]);
  const [preview, setPreview] = useState<any>(null);
  useEffect(() => {
    if (assets.length < 2) { setPreview(null); return; }
    const t = setTimeout(() => {
      api().call('trades.preview', { fromTeamId: me, toTeamId: partner, assets, proposerDrops: drops }).then(setPreview).catch(() => setPreview(null));
    }, 400);
    return () => clearTimeout(t);
  }, [assets, drops, me, partner]);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (counterOf) await api().call('trades.counter', { tradeId: counterOf.id, assets, proposerDrops: drops, message });
      else await api().call('trades.propose', { fromTeamId: me, toTeamId: partner, assets, proposerDrops: drops, message });
      toast('good', counterOf ? 'Counteroffer sent.' : 'Trade offer sent.');
      qc.invalidateQueries({ queryKey: ['trades'] });
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const partnerTeam = L.teams.find((t: any) => t.id === partner);
  const myTeam = L.teams.find((t: any) => t.id === me);
  const needsDrop = preview?.problems?.details?.some?.((d: any) => d.code === 'needs_drop' && d.teamId === me);
  const Column = ({ team, roster, mineSide }: { team: any; roster: any; mineSide: boolean }) => (
    <div className="min-w-0">
      <div className="mb-2"><TeamChip team={team} sub={mineSide ? 'You send' : 'You receive'} size={28} /></div>
      {!roster ? <LoadingBlock rows={4} /> : (
        <div className="max-h-[300px] space-y-1 overflow-y-auto pr-1">
          {list(roster).map((p: any) => (
            <label key={p.playerId} className={cx('flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hairline', selected.has(p.playerId) && 'bg-accent/12 ring-1 ring-accent', p.locked && 'opacity-60')}>
              <input type="checkbox" checked={selected.has(p.playerId)} onChange={() => toggle(p.playerId)} />
              <span className="min-w-0 flex-1 truncate"><b>{p.name}</b> <span className="text-muted">{p.position} · {p.nflTeamId}{p.locked ? ' · locked' : ''}</span></span>
              <span className="num text-[12px] text-muted">{pts(p.projected, 1)}</span>
            </label>
          ))}
        </div>
      )}
      {L.settings.trades.allowFaab && L.settings.waivers.mode === 'faab' && (
        <div className="mt-2 flex items-center gap-2 text-[13px]"><span className="text-muted">FAAB $</span>
          <Input aria-label={mineSide ? 'FAAB you send' : 'FAAB you receive'} className="h-8 w-24" type="number" min={0} max={team.faab_remaining} value={mineSide ? faab.mine : faab.theirs} onChange={(e) => { const v = Math.max(0, Math.min(team.faab_remaining, Math.round(Number(e.target.value) || 0))); setFaab((f) => (mineSide ? { ...f, mine: v } : { ...f, theirs: v })); }} />
          <span className="text-faint">of ${team.faab_remaining}</span>
        </div>
      )}
    </div>
  );
  return (
    <Modal open wide onClose={onClose} title={counterOf ? 'Counteroffer' : 'Propose a trade'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={assets.length < 2 || !assets.some((a) => a.fromTeamId === me) || !assets.some((a) => a.fromTeamId === partner)} onClick={submit}>{counterOf ? 'Send counteroffer' : 'Send offer'}</Button></>}>
      <div className="space-y-4">
        {!counterOf && <Field label="Trade with" htmlFor="tb-partner"><Select id="tb-partner" value={partner} onChange={(e) => { setPartner(e.target.value); setSelected(new Set([...selected].filter((id) => list(mine).some((p: any) => p.playerId === id)))); }}>{others.map((t: any) => <option key={t.id} value={t.id}>{t.name}{t.is_ai ? ' (AI)' : ''}</option>)}</Select></Field>}
        <div className="grid gap-4 md:grid-cols-2">
          {myTeam && <Column team={myTeam} roster={mine} mineSide />}
          {partnerTeam && <Column team={partnerTeam} roster={theirs} mineSide={false} />}
        </div>
        {L.settings.trades.allowDraftPicks && (
          <details className="rounded-lg bg-raised p-3 text-[13px]">
            <summary className="cursor-pointer font-semibold">Include future draft picks</summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {[{ from: me, to: partner, label: 'You send' }, { from: partner, to: me, label: 'You receive' }].map((s) => (
                <Button key={s.label} size="sm" onClick={() => setPicks([...picks, { fromTeamId: s.from, toTeamId: s.to, type: 'draft_pick', draftSeason: L.league.season + 1, draftRound: 1 }])}>{s.label}: add pick</Button>
              ))}
            </div>
            {picks.map((p, i) => (
              <div key={i} className="mt-2 flex flex-wrap items-center gap-2">
                <span>{p.fromTeamId === me ? 'You send' : 'You receive'}</span>
                <Select aria-label="Pick season" className="h-8 w-24" value={p.draftSeason} onChange={(e) => setPicks(picks.map((x, j) => (j === i ? { ...x, draftSeason: Number(e.target.value) } : x)))}>{[1, 2].map((d) => <option key={d} value={L.league.season + d}>{L.league.season + d}</option>)}</Select>
                <Select aria-label="Pick round" className="h-8 w-28" value={p.draftRound} onChange={(e) => setPicks(picks.map((x, j) => (j === i ? { ...x, draftRound: Number(e.target.value) } : x)))}>{Array.from({ length: 15 }, (_, r) => <option key={r} value={r + 1}>Round {r + 1}</option>)}</Select>
                <Button size="sm" variant="ghost" onClick={() => setPicks(picks.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
          </details>
        )}
        {needsDrop && mine && (
          <Field label="Your roster would be over the limit. Choose players to drop">
            <div className="flex flex-wrap gap-1.5">{list(mine).filter((p: any) => !selected.has(p.playerId) && !p.locked).map((p: any) => (
              <button key={p.playerId} onClick={() => setDrops(drops.includes(p.playerId) ? drops.filter((d) => d !== p.playerId) : [...drops, p.playerId])} className={cx('rounded-lg px-2 py-1 text-[12px] hairline', drops.includes(p.playerId) && 'bg-bad/15 text-bad')}>{p.name}</button>
            ))}</div>
          </Field>
        )}
        <Field label="Message (optional)" htmlFor="tb-msg"><Textarea id="tb-msg" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} /></Field>
        {preview?.analysis && (
          <div className="rounded-lg bg-raised p-3 text-[13px]">
            <div className="label mb-1">Advisory analysis · next {preview.analysis.horizonWeeks} week(s)</div>
            <p>{preview.analysis.summary}</p>
            <div className="mt-1 grid gap-2 sm:grid-cols-2">{preview.analysis.sides.map((s: any) => <div key={s.teamId}><b>{L.teams.find((t: any) => t.id === s.teamId)?.name}</b>: value in {s.valueIn} / out {s.valueOut}, {s.weeklyPointsChange >= 0 ? '+' : ''}{s.weeklyPointsChange} pts/wk</div>)}</div>
            <p className="mt-1 text-[12px] text-faint">{preview.analysis.disclaimer}</p>
          </div>
        )}
        {preview?.problems && !needsDrop && <div className="flex items-start gap-2 rounded-lg bg-warn/10 p-2.5 text-[13px]"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />{preview.problems.message}</div>}
        <ErrorNote error={err} />
      </div>
    </Modal>
  );
}

export { TeamLogo };
