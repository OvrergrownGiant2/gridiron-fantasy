import { ArrowDown, ArrowUp, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AcquireModal } from '../components/AcquireModal';
import { PlayerName } from '../components/PlayerModal';
import { NFL_TEAM_IDS } from '../lib/nfl';
import { Badge, Button, Empty, ErrorNote, Input, LoadingBlock, PageHeader, Segmented, Select, Skeleton, cx } from '../components/ui';
import { pts } from '../lib/format';
import { teamMap, useCall, useLeague } from '../lib/hooks';

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

const COLS = [
  { key: 'rank', label: 'Rank' }, { key: 'season_points', label: 'Season' }, { key: 'avg_points', label: 'Avg' },
  { key: 'last_points', label: 'Last' }, { key: 'projected', label: 'Proj' },
] as const;

export function Players({ defaultStatus = 'all', title = 'Players' }: { defaultStatus?: string; title?: string }) {
  const { leagueId } = useParams();
  const { data: L } = useLeague(leagueId);
  const [q, setQ] = useState('');
  const [position, setPosition] = useState('');
  const [nflTeam, setNflTeam] = useState('');
  const [status, setStatus] = useState(defaultStatus);
  const [bye, setBye] = useState('');
  const [sort, setSort] = useState<string>('rank');
  const [dir, setDir] = useState<'asc' | 'desc' | undefined>(undefined);
  const [page, setPage] = useState(0);
  const [acquire, setAcquire] = useState<any>(null);
  const dq = useDebounced(q);
  useEffect(() => setPage(0), [dq, position, nflTeam, status, bye, sort, dir]);
  const input = { leagueId, q: dq || undefined, position: position || undefined, nflTeam: nflTeam || undefined, status, byeWeek: bye ? Number(bye) : undefined, sort, dir, offset: page * 50, limit: 50 };
  const { data, isLoading, isFetching, error, refetch } = useCall<any>(['players', input], 'players.search', input, { placeholderData: (p: any) => p });
  const tm = teamMap(L);
  const myTeam = L?.myTeamId ? tm.get(L.myTeamId) : null;
  const canAcquire = L && L.myTeamId && L.role !== 'observer' && (L.league.status === 'in_season' || L.league.status === 'playoffs');
  const toggleSort = (k: string) => { if (sort === k) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(k); setDir(undefined); } };

  return (
    <div className="space-y-4">
      <PageHeader title={title} sub={data ? `${data.total} players · fantasy points use ${L?.league?.name ?? 'this league'}'s scoring rules` : undefined} />
      <div className="flex flex-col gap-3 rounded-card bg-surface p-3 hairline">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <Input aria-label="Search players by name" className="pl-9" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select aria-label="NFL team" className="w-auto" value={nflTeam} onChange={(e) => setNflTeam(e.target.value)}><option value="">All NFL teams</option>{NFL_TEAM_IDS.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
          <Select aria-label="Bye week" className="w-auto" value={bye} onChange={(e) => setBye(e.target.value)}><option value="">Any bye</option>{Array.from({ length: 14 }, (_, i) => <option key={i} value={i + 4}>Bye wk {i + 4}</option>)}</Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented size="sm" value={position || 'ALL'} onChange={(v) => setPosition(v === 'ALL' ? '' : v)} options={['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST'].map((p) => ({ value: p, label: p }))} />
          <Segmented size="sm" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'available', label: 'Available' }, { value: 'free_agents', label: 'Free agents' }, { value: 'waivers', label: 'On waivers' }, { value: 'rostered', label: 'Rostered' }, { value: 'mine', label: 'My team' }, { value: 'injured', label: 'Injured' }]} />
        </div>
      </div>
      {error ? <ErrorNote error={error} retry={refetch} /> : isLoading ? <LoadingBlock rows={10} /> : data.players.length === 0 ? <Empty title="No players match" body="Try clearing a filter." /> : (
        <div className={cx('scroll-x rounded-card bg-surface hairline transition-opacity', isFetching && 'opacity-70')}>
          <table className="w-full min-w-[720px] text-[13px]">
            <thead className="border-b border-line text-left text-muted">
              <tr>
                <th className="px-3 py-2.5 font-semibold">Player</th>
                <th className="font-semibold">Status</th>
                {COLS.map((c) => (
                  <th key={c.key} className="px-2 text-right font-semibold">
                    <button className={cx('inline-flex items-center gap-0.5', sort === c.key && 'text-ink')} onClick={() => toggleSort(c.key)} aria-label={`Sort by ${c.label}`}>
                      {c.label}{sort === c.key && ((dir ?? (c.key === 'rank' ? 'asc' : 'desc')) === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                    </button>
                  </th>
                ))}
                <th className="px-2 text-right font-semibold">Rost%</th>
                <th className="px-3" />
              </tr>
            </thead>
            <tbody>
              {data.players.map((p: any) => {
                const owner = p.availability.status === 'rostered' ? tm.get(p.availability.teamId) : null;
                return (
                  <tr key={p.id} className="border-b border-line last:border-0 hover:bg-raised">
                    <td className="px-3 py-2">
                      <PlayerName leagueId={leagueId!} id={p.id} name={p.name} injury={p.injuryStatus} />
                      <div className="text-[12px] text-muted">{p.position} · {p.nflTeamId ?? 'FA'}{p.byeWeek ? ` · bye ${p.byeWeek}` : ''}</div>
                    </td>
                    <td>{owner ? <span className={cx('text-[12px]', owner.id === myTeam?.id ? 'font-semibold text-accent' : 'text-muted')}>{owner.id === myTeam?.id ? 'Your team' : owner.abbrev}</span> : p.availability.status === 'waivers' ? <Badge tone="warn">Waivers</Badge> : <Badge tone="good">FA</Badge>}</td>
                    <td className="num px-2 text-right text-muted">{p.rank}</td>
                    <td className="num px-2 text-right font-semibold">{pts(p.seasonPoints, 1)}</td>
                    <td className="num px-2 text-right">{pts(p.avgPoints, 1)}</td>
                    <td className="num px-2 text-right">{p.lastPoints === null ? '—' : pts(p.lastPoints, 1)}</td>
                    <td className="num px-2 text-right text-muted" title="Estimate">{pts(p.projected, 1)}</td>
                    <td className="num px-2 text-right text-muted">{p.rosteredPct}%</td>
                    <td className="px-3 text-right">{canAcquire && p.availability.status !== 'rostered' && <Button size="sm" variant={p.availability.status === 'free_agent' ? 'primary' : 'secondary'} icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAcquire(p)}>{p.availability.status === 'free_agent' ? 'Add' : 'Claim'}</Button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 50 && (
        <div className="flex items-center justify-between text-[13px] text-muted">
          <span>Showing {page * 50 + 1}–{Math.min(data.total, page * 50 + 50)} of {data.total}</span>
          <div className="flex gap-2"><Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" disabled={(page + 1) * 50 >= data.total} onClick={() => setPage(page + 1)}>Next</Button></div>
        </div>
      )}
      {!data && isFetching && <Skeleton className="h-8 w-40" />}
      {acquire && myTeam && <AcquireModal leagueId={leagueId!} teamId={myTeam.id} player={acquire} onClose={() => setAcquire(null)} faab={{ mode: L.settings.waivers.mode, remaining: myTeam.faab_remaining, allowZero: L.settings.waivers.allowZeroBids }} />}
    </div>
  );
}
