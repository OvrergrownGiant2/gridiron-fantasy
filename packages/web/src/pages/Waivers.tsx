import { ArrowDown, ArrowUp, Play, X } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { TeamLogo } from '../components/team';
import { Badge, Button, Card, ConfirmDialog, Empty, Input, LoadingBlock, SectionTitle, Tabs } from '../components/ui';
import { dateTime, relative } from '../lib/format';
import { useAction, useCall, useLeague } from '../lib/hooks';
import { Players } from './Players';

export function Waivers() {
  const { leagueId } = useParams();
  const { data: L } = useLeague(leagueId);
  const { data, isLoading } = useCall<any>(['waivers', leagueId], 'waivers.overview', { leagueId });
  const [tab, setTab] = useState<'players' | 'claims' | 'history'>('players');
  const [confirm, setConfirm] = useState(false);
  const reorder = useAction('waivers.reorder', { invalidate: ['waivers'] });
  const cancel = useAction('waivers.cancelClaim', { invalidate: ['waivers'], success: 'Claim canceled.' });
  const update = useAction('waivers.updateClaim', { invalidate: ['waivers'], success: 'Bid updated.' });
  const processNow = useAction('waivers.processNow', { invalidate: ['waivers', 'roster', 'players', 'transactions'], success: (r: any) => `Processed ${r.processed} claim(s); ${r.awarded} awarded.` });
  const { data: tx } = useCall<any[]>(['transactions', leagueId], 'transactions.list', { leagueId, limit: 50 });
  if (isLoading || !L) return <LoadingBlock />;
  const pending = data.claims.filter((c: any) => c.status === 'pending');
  const history = data.claims.filter((c: any) => c.status !== 'pending');
  const move = (i: number, d: number) => {
    const ids = pending.map((c: any) => c.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    reorder.mutate({ teamId: data.myTeam.id, claimIds: ids });
  };
  const modeLabel = data.mode === 'faab' ? 'FAAB bidding' : data.mode === 'rolling' ? 'Rolling priority' : 'Reverse standings';
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card><div className="label">System</div><div className="font-display text-2xl font-semibold uppercase">{modeLabel}</div><div className="text-[13px] text-muted">{data.continuous ? 'Continuous waivers: every add is a claim.' : 'Free agents can be added instantly once waivers clear.'}</div></Card>
        <Card><div className="label">Next waiver run</div><div className="font-display text-2xl font-semibold">{data.nextRunAt ? dateTime(data.nextRunAt) : 'After the season starts'}</div><div className="text-[13px] text-muted">{data.nextRunAt ? relative(data.nextRunAt) : ''}</div></Card>
        <Card>
          {data.mode === 'faab'
            ? <><div className="label">Your FAAB</div><div className="num font-display text-3xl font-bold">${data.myTeam?.faab_remaining ?? 0}<span className="text-lg text-muted"> / ${data.faabBudget}</span></div></>
            : <><div className="label">Your priority</div><div className="num font-display text-3xl font-bold">#{data.myTeam?.waiver_priority ?? '—'}</div></>}
          {L.permissions.includes('waiver.process_now') && <Button size="sm" className="mt-2" icon={<Play className="h-3.5 w-3.5" />} onClick={() => setConfirm(true)}>Process now</Button>}
        </Card>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'players', label: 'Available players' }, { value: 'claims', label: 'My claims', count: pending.length }, { value: 'history', label: 'History & priority' }]} />
      {tab === 'players' && <Players defaultStatus="available" title="Waivers & Free Agents" />}
      {tab === 'claims' && (pending.length === 0 ? <Empty title="No pending claims" body="Claim players who are on waivers from the Available players tab. Claims process together at the next waiver run." /> : (
        <Card pad={false}>
          {pending.map((c: any, i: number) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3 first:border-t-0">
              <span className="num w-6 font-display text-xl font-bold text-muted">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">Add {c.add_name} <span className="text-[12px] text-muted">{c.add_position} · {c.add_team}</span></div>
                <div className="text-[12px] text-muted">{c.drop_name ? `Drop ${c.drop_name}` : 'No drop'}{c.group_id ? ` · group "${c.group_id}"` : ''}</div>
              </div>
              {data.mode === 'faab' && <BidInput value={c.bid} max={data.myTeam.faab_remaining} onSave={(bid) => update.mutate({ claimId: c.id, bid })} />}
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                <Button size="sm" variant="ghost" aria-label="Move down" disabled={i === pending.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                <Button size="sm" variant="ghost" aria-label="Cancel claim" onClick={() => cancel.mutate({ claimId: c.id })}><X className="h-4 w-4" /></Button>
              </div>
            </div>
          ))}
          <p className="border-t border-line px-4 py-2 text-[12px] text-faint">Order matters: when your top claim fails, your next claim is tried. Claims in the same group are alternatives.</p>
        </Card>
      ))}
      {tab === 'history' && (
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <div className="min-w-0 space-y-5">
            <Card pad={false}>
              <div className="label border-b border-line px-4 py-2.5">Your claim results</div>
              {history.length === 0 ? <div className="px-4 py-4 text-[13px] text-muted">No processed claims yet.</div> : history.map((c: any) => (
                <div key={c.id} className="flex items-start gap-3 border-t border-line px-4 py-3 first:border-t-0">
                  <Badge tone={c.status === 'won' ? 'good' : c.status === 'lost' ? 'warn' : 'neutral'}>{c.status}</Badge>
                  <div className="min-w-0 flex-1"><div className="font-semibold">{c.add_name}{data.mode === 'faab' ? ` · $${c.bid}` : ''}</div><div className="text-[12.5px] text-muted">{c.result_reason}</div></div>
                  <span className="text-[12px] text-faint">{c.processed_at ? dateTime(c.processed_at) : ''}</span>
                </div>
              ))}
            </Card>
            <Card pad={false}>
              <div className="label border-b border-line px-4 py-2.5">League transactions</div>
              {(tx ?? []).map((t: any) => (
                <div key={t.id} className="flex gap-3 border-t border-line px-4 py-2.5 text-[13px] first:border-t-0">
                  <Badge>{t.type.replace('_', ' ')}</Badge><span className="min-w-0 flex-1">{t.summary}</span><span className="shrink-0 text-[12px] text-faint">{relative(t.created_at)}</span>
                </div>
              ))}
            </Card>
          </div>
          <Card>
            <SectionTitle sub={data.mode === 'faab' ? 'Breaks ties between equal bids.' : 'Winning a claim moves a team to the back.'}>Waiver priority</SectionTitle>
            <ol className="space-y-1.5">
              {data.priority.map((t: any) => (
                <li key={t.id} className="flex items-center gap-2 text-[13px]">
                  <span className="num w-5 text-right font-display text-lg font-bold text-muted">{t.waiver_priority}</span>
                  <TeamLogo team={t} size={22} /><span className="flex-1 truncate font-semibold">{t.name}</span>
                  {data.mode === 'faab' && <span className="num text-muted">${t.faab_remaining}</span>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title="Process waivers now?" confirmLabel="Process claims"
        body="All pending claims for players whose games have not started will be resolved immediately using the league's priority rules. This is recorded in the audit log."
        onConfirm={() => processNow.mutateAsync({ leagueId })} />
    </div>
  );
}

function BidInput({ value, max, onSave }: { value: number; max: number; onSave: (n: number) => void }) {
  const [v, setV] = useState(value);
  return (
    <div className="flex items-center gap-1">
      <span className="text-muted">$</span>
      <Input aria-label="Bid" className="h-8 w-20" type="number" min={0} max={max} value={v} onChange={(e) => setV(Math.max(0, Math.min(max, Math.round(Number(e.target.value) || 0))))} />
      {v !== value && <Button size="sm" variant="primary" onClick={() => onSave(v)}>Save</Button>}
    </div>
  );
}
