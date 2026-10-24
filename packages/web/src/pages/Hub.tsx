import { STAT_LABELS } from '@gridiron/core';
import { Copy, Crown, LogOut } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Avatar } from '../components/Shell';
import { RefreshLeagueButton } from '../components/RefreshLeague';
import { TeamLogo, TeamStripe } from '../components/team';
import { Badge, Button, Card, ConfirmDialog, Empty, LoadingBlock, PageHeader, SectionTitle, Tabs, cx, useToast } from '../components/ui';
import { pts, relative } from '../lib/format';
import { teamMap, useAction, useCall, useLeague } from '../lib/hooks';

const PLAYOFF_LABEL: Record<string, { label: string; tone: any }> = {
  clinched: { label: 'Clinched', tone: 'good' }, in_position: { label: 'In position', tone: 'info' }, alive: { label: 'Alive', tone: 'neutral' }, eliminated: { label: 'Eliminated', tone: 'bad' },
};

export function Hub() {
  const { leagueId } = useParams();
  const { data: L, isLoading } = useLeague(leagueId);
  const [tab, setTab] = useState<'standings' | 'activity' | 'members' | 'rules'>('standings');
  if (isLoading || !L) return <LoadingBlock />;
  return (
    <div className="space-y-5">
      <PageHeader eyebrow={`${L.league.season} season · ${L.league.status.replace('_', ' ')}`} title={L.league.name} sub={L.league.description || undefined} actions={<RefreshLeagueButton L={L} />} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'standings', label: 'Standings' }, { value: 'activity', label: 'Activity' }, { value: 'members', label: 'Members' }, { value: 'rules', label: 'Rules & scoring' }]} />
      {tab === 'standings' && <Standings L={L} />}
      {tab === 'activity' && <Activity leagueId={leagueId!} />}
      {tab === 'members' && <Members L={L} />}
      {tab === 'rules' && <Rules L={L} />}
    </div>
  );
}

function Standings({ L }: { L: any }) {
  const { data } = useCall<any>(['standings', L.league.id], 'standings.get', { leagueId: L.league.id });
  const tm = teamMap(L);
  if (!data) return <LoadingBlock />;
  const champ = data.champion ? tm.get(data.champion) : null;
  return (
    <div className="space-y-5">
      {champ && <Card className="flex items-center gap-3"><Crown className="h-7 w-7 text-accent" /><TeamLogo team={champ} size={40} /><div><div className="label">Champion</div><div className="font-display text-2xl font-bold uppercase">{champ.name}</div></div></Card>}
      <div className="scroll-x rounded-card bg-surface hairline">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead className="border-b border-line text-left text-muted">
            <tr><th className="w-10 px-3 py-2.5">#</th><th>Team</th><th className="text-right">W</th><th className="text-right">L</th><th className="text-right">T</th><th className="px-2 text-right">PF</th><th className="px-2 text-right">PA</th><th className="px-2">Strk</th><th className="px-3">Playoffs</th></tr>
          </thead>
          <tbody>
            {data.standings.map((r: any, i: number) => {
              const t = tm.get(r.teamId);
              const cut = data.playoffTeams > 0 && i === data.playoffTeams - 1;
              return (
                <tr key={r.teamId} className={cx('border-b border-line', cut && 'border-b-2 border-b-accent', r.teamId === L.myTeamId && 'bg-accent/[.06]')}>
                  <td className="num px-3 py-2.5 font-display text-lg font-bold text-muted">{r.rank}</td>
                  <td className="py-2"><div className="flex items-center gap-2.5"><TeamStripe team={t} vertical /><TeamLogo team={t} size={28} /><div className="min-w-0"><div className="truncate font-semibold">{t.name}</div><div className="truncate text-[12px] text-muted">{t.owner_name ?? (t.is_ai ? 'AI manager' : 'Open seat')}{r.tieBreakNote ? ` · ${r.tieBreakNote}` : ''}</div></div></div></td>
                  <td className="num text-right font-semibold">{r.wins}</td><td className="num text-right">{r.losses}</td><td className="num text-right">{r.ties}</td>
                  <td className="num px-2 text-right">{pts(r.pointsFor)}</td><td className="num px-2 text-right text-muted">{pts(r.pointsAgainst)}</td>
                  <td className="num px-2">{r.streak}</td>
                  <td className="px-3">{PLAYOFF_LABEL[r.playoffStatus] ? <Badge tone={PLAYOFF_LABEL[r.playoffStatus].tone}>{PLAYOFF_LABEL[r.playoffStatus].label}</Badge> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-faint">{data.mode === 'total_points' ? 'Ranked by total points.' : `Ranked by record; tie-breakers: ${L.settings.season.tieBreakers.map((t: string) => t.replace(/_/g, ' ')).join(', ')}.`} {data.playoffTeams ? `Top ${data.playoffTeams} make the playoffs (line under #${data.playoffTeams}).` : ''} Standings recalculate automatically from final results, including stat corrections.</p>
      {data.playoffs.length > 0 && (
        <Card>
          <SectionTitle>Playoff bracket</SectionTitle>
          <div className="scroll-x flex gap-4">
            {[...new Set(data.playoffs.map((p: any) => p.week))].map((w: any) => (
              <div key={w} className="min-w-[220px] space-y-2">
                <div className="label">Week {w}</div>
                {data.playoffs.filter((p: any) => p.week === w).map((p: any) => (
                  <div key={p.id} className="rounded-lg bg-raised p-2.5 text-[13px]">
                    {[{ id: p.home_team_id, seed: p.home_seed, pts: p.home_points }, ...(p.away_team_id ? [{ id: p.away_team_id, seed: p.away_seed, pts: p.away_points }] : [])].map((s) => (
                      <div key={s.id} className={cx('flex items-center gap-2 py-0.5', p.winner_team_id && p.winner_team_id !== s.id && 'text-muted')}><span className="num w-5 text-faint">{s.seed}</span><span className="flex-1 truncate font-semibold">{tm.get(s.id)?.name}</span><span className="num">{p.status === 'scheduled' ? '' : pts(Number(s.pts))}</span></div>
                    ))}
                    {!p.away_team_id && <div className="text-[12px] text-muted">First-round bye</div>}
                    {p.kind === 'championship' && <Badge tone="accent" className="mt-1">Championship</Badge>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function Activity({ leagueId }: { leagueId: string }) {
  const { data } = useCall<any[]>(['activity', leagueId], 'activity.list', { leagueId, limit: 80 });
  if (!data) return <LoadingBlock />;
  if (!data.length) return <Empty title="No activity yet" />;
  return (
    <Card pad={false}>
      {data.map((a) => (
        <div key={a.id} className="flex gap-3 border-t border-line px-4 py-2.5 text-[13px] first:border-t-0">
          <span className="w-28 shrink-0 text-[12px] text-faint">{relative(a.created_at)}</span>
          <Badge className="hidden shrink-0 sm:inline-flex">{a.kind.replace(/_/g, ' ')}</Badge>
          <span className="min-w-0 flex-1">{a.summary}</span>
        </div>
      ))}
    </Card>
  );
}

function Members({ L }: { L: any }) {
  const toast = useToast();
  const nav = useNavigate();
  const [leaving, setLeaving] = useState(false);
  const leave = useAction('leagues.leave', { invalidate: ['league', 'dashboard'], success: 'You left the league.', onSuccess: () => nav('/leagues') });
  const teamOf = (uid: string) => L.teams.find((t: any) => t.owner_user_id === uid);
  const link = `${location.href.split('#')[0]}#/join/${L.league.inviteCode}`;
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <Card pad={false}>
        {L.members.map((m: any) => {
          const t = teamOf(m.user_id);
          return (
            <div key={m.user_id} className="flex items-center gap-3 border-t border-line px-4 py-3 first:border-t-0">
              <Avatar user={m} size={34} />
              <div className="min-w-0 flex-1"><div className="truncate font-semibold">{m.display_name} <span className="font-normal text-muted">@{m.username}</span></div><div className="truncate text-[12px] text-muted">{t ? t.name : 'No team'} · joined {relative(m.joined_at)}</div></div>
              <Badge tone={m.role === 'commissioner' ? 'accent' : m.role === 'co_commissioner' ? 'info' : 'neutral'}>{m.role.replace('_', '-')}</Badge>
            </div>
          );
        })}
        {L.teams.filter((t: any) => t.is_ai).map((t: any) => (
          <div key={t.id} className="flex items-center gap-3 border-t border-line px-4 py-3">
            <TeamLogo team={t} size={34} /><div className="min-w-0 flex-1"><div className="truncate font-semibold">{t.name}</div><div className="text-[12px] text-muted">AI manager · {t.ai_difficulty}</div></div><Badge>AI</Badge>
          </div>
        ))}
      </Card>
      <div className="space-y-4">
        {L.league.inviteCode && (
          <Card>
            <SectionTitle sub="Anyone with this code can join while seats are open.">Invite</SectionTitle>
            <div className="mb-2 rounded-lg bg-sunken px-3 py-2 text-center font-mono text-2xl font-bold tracking-[.3em]">{L.league.inviteCode}</div>
            <div className="break-all rounded-lg bg-raised px-3 py-2 font-mono text-[12px] text-muted">{link}</div>
            <Button size="sm" className="mt-2 w-full" icon={<Copy className="h-4 w-4" />} onClick={async () => { try { await navigator.clipboard.writeText(link); toast('good', 'Invite link copied.'); } catch { toast('info', 'Copy the link above manually.'); } }}>Copy invite link</Button>
          </Card>
        )}
        {L.role !== 'commissioner' && <Button variant="ghost" className="w-full text-bad" icon={<LogOut className="h-4 w-4" />} onClick={() => setLeaving(true)}>Leave league</Button>}
      </div>
      <ConfirmDialog open={leaving} onClose={() => setLeaving(false)} danger title="Leave this league?" confirmLabel="Leave league"
        body={L.league.status === 'setup' ? 'Your team will be removed.' : 'Your team stays in the league and an AI manager takes over so the schedule is not disrupted.'}
        onConfirm={() => leave.mutateAsync({ leagueId: L.league.id })} />
    </div>
  );
}

function Rules({ L }: { L: any }) {
  const s = L.settings, r = s.roster, sc = L.scoring;
  const { data: history } = useCall<any[]>(['league', 'scoringHistory', L.league.id], 'leagues.scoringHistory', { leagueId: L.league.id });
  const rows: [string, string][] = [
    ['Roster', `QB ${r.QB} · RB ${r.RB} · WR ${r.WR} · TE ${r.TE} · FLEX ${r.FLEX} (${r.flexEligible.join('/')})${r.SUPERFLEX ? ` · SUPERFLEX ${r.SUPERFLEX}` : ''} · K ${r.K} · DST ${r.DST} · Bench ${r.BN} · IR ${r.IR}`],
    ['Season', `NFL weeks ${s.season.startWeek}–${s.season.startWeek + s.season.regularSeasonWeeks - 1}, ${s.season.standingsMode === 'head_to_head' ? 'head-to-head' : 'total points'}${s.season.doubleHeaders ? ', double headers' : ''}`],
    ['Playoffs', s.season.playoffTeams ? `${s.season.playoffTeams} teams${s.season.consolationBracket ? ' with consolation bracket' : ''}` : 'None'],
    ['Lineup lock', s.season.lineupLock === 'game_time' ? 'Each player locks at his game\'s kickoff' : 'Everyone locks at the week\'s first kickoff'],
    ['Waivers', `${s.waivers.mode === 'faab' ? `FAAB ($${s.waivers.faabBudget})` : s.waivers.mode.replace('_', ' ')} · ${s.waivers.waiverPeriodHours}h after drops · ${s.waivers.continuous ? 'continuous' : 'free agency after clearing'}`],
    ['Trades', `${s.trades.review.replace('_', ' ')} review · deadline ${s.trades.tradeDeadlineWeek ? `after week ${s.trades.tradeDeadlineWeek}` : 'none'}${s.trades.review === 'league_vote' ? ` · ${Math.round(s.trades.vetoThreshold * 100)}% veto threshold` : ''}`],
    ['Stat corrections', s.season.statCorrections === 'auto' ? 'Applied automatically and announced' : 'Reviewed by the commissioner'],
  ];
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <SectionTitle sub={`Settings version ${L.league.settingsVersion}`}>League rules</SectionTitle>
        <dl className="divide-y divide-line">{rows.map(([k, v]) => <div key={k} className="grid gap-1 py-2 sm:grid-cols-[130px_1fr]"><dt className="label">{k}</dt><dd className="text-[13px]">{v}</dd></div>)}</dl>
      </Card>
      <Card>
        <SectionTitle sub={`${sc.preset.replace('_', '-').toUpperCase()} · version ${L.league.scoringVersion}`}>Scoring</SectionTitle>
        <div className="grid grid-cols-2 gap-x-6 text-[13px]">
          {Object.entries(sc.perStat).filter(([, v]) => v).map(([k, v]: any) => <div key={k} className="flex justify-between border-b border-line py-1"><span>{(STAT_LABELS as any)[k]}</span><span className="num font-semibold">{v > 0 ? '+' : ''}{v}</span></div>)}
        </div>
        <div className="mt-3 text-[13px]"><span className="label">Points allowed</span><div className="mt-1 flex flex-wrap gap-1.5">{sc.pointsAllowedTiers.map((t: any, i: number) => <span key={i} className="rounded bg-raised px-2 py-0.5">{t.max === null ? 'more' : `≤${t.max}`}: {t.points > 0 ? '+' : ''}{t.points}</span>)}</div></div>
        {sc.bonuses.length > 0 && <div className="mt-3 text-[13px]"><span className="label">Bonuses</span>{sc.bonuses.map((b: any) => <div key={b.id}>{b.label}: {b.points > 0 ? '+' : ''}{b.points}</div>)}</div>}
        {history && history.length > 1 && (
          <div className="mt-4"><span className="label">Change history</span>{history.map((h) => <div key={h.version} className="text-[12px] text-muted">v{h.version} · {relative(h.created_at)} · {h.changed_by ?? 'system'}: {h.reason}</div>)}</div>
        )}
      </Card>
    </div>
  );
}
