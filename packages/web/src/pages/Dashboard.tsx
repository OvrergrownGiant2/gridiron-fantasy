import { ArrowLeftRight, ChevronLeft, ChevronRight, Gavel, ListChecks, PlusCircle, Repeat, Search, UserPlus, Users, Vote } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { GameCard } from '../components/games';
import { TeamChip, TeamLogo, TeamStripe } from '../components/team';
import { Badge, Button, Card, Empty, ErrorNote, LoadingBlock, SectionTitle, StatusPill, cx } from '../components/ui';
import { pts } from '../lib/format';
import { rememberedLeague, useCall, useMe } from '../lib/hooks';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const STATUS_LABEL: Record<string, string> = { setup: 'Pre-draft', drafting: 'Drafting', in_season: 'In season', playoffs: 'Playoffs', complete: 'Complete' };

export function Dashboard() {
  const { data: me } = useMe();
  const { data, isLoading, error, refetch } = useCall<any>(['dashboard'], 'dashboard.get', {}, { refetchInterval: 45_000 });
  const leagues: any[] = data?.leagues ?? [];
  const focus = leagues.find((l) => l.id === rememberedLeague()) ?? leagues[0];
  const [week, setWeek] = useState<number | null>(null);
  const { data: board } = useCall<any>(['matchups', 'board', week, focus?.id], 'nfl.scoreboard', { week: week ?? undefined, leagueId: focus?.id }, { refetchInterval: 30_000 });

  if (isLoading) return <LoadingBlock rows={6} />;
  if (error) return <ErrorNote error={error} retry={refetch} />;
  const user = me?.user;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="label">{board?.week ? `NFL ${data.data?.season ?? ''} · Week ${board.currentWeek}` : 'NFL season'}</div>
          <h1 className="font-display text-4xl font-bold uppercase leading-none tracking-wide">{greeting()}, {user?.displayName?.split(' ')[0]}</h1>
          <p className="mt-1 text-muted">@{user?.username} · {leagues.length} league{leagues.length === 1 ? '' : 's'}</p>
        </div>
        {(data.pendingVotes > 0 || data.reviewQueue > 0) && (
          <div className="flex flex-wrap gap-2">
            {data.pendingVotes > 0 && <Badge tone="accent"><Vote className="h-3 w-3" /> {data.pendingVotes} trade vote{data.pendingVotes === 1 ? '' : 's'} waiting</Badge>}
            {data.reviewQueue > 0 && <Badge tone="warn"><Gavel className="h-3 w-3" /> {data.reviewQueue} trade{data.reviewQueue === 1 ? '' : 's'} to review</Badge>}
          </div>
        )}
      </div>

      {leagues.length === 0 ? <Onboarding /> : (
        <>
          <section>
            <SectionTitle sub="Every league you belong to, with this week's matchup.">Your leagues</SectionTitle>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {leagues.map((l) => <LeagueCard key={l.id} l={l} />)}
              <Link to="/leagues" className="flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line text-muted transition hover:border-accent hover:text-ink">
                <PlusCircle className="h-6 w-6" /><span className="font-semibold">Create or join a league</span>
              </Link>
            </div>
          </section>

          {focus && <QuickActions l={focus} />}
        </>
      )}

      <section>
        <SectionTitle sub={focus ? `Your ${focus.name} players are listed under their games.` : undefined}
          action={board?.week ? (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" aria-label="Previous week" disabled={board.week <= 1} onClick={() => setWeek(board.week - 1)}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="num w-20 text-center font-display text-lg font-semibold uppercase">Week {board.week}</span>
              <Button size="sm" variant="ghost" aria-label="Next week" disabled={board.week >= 18} onClick={() => setWeek(board.week + 1)}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          ) : null}>NFL scoreboard</SectionTitle>
        {!board ? <LoadingBlock rows={2} /> : board.games.length === 0 ? (
          <Empty title="No games available" body={board.status?.message ?? 'Schedule data has not been loaded yet.'} />
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {[...board.games].sort((a: any, b: any) => order(a) - order(b) || Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt)).map((g: any) => <GameCard key={g.id} g={g} myPlayers={board.myPlayers} />)}
          </div>
        )}
      </section>
    </div>
  );
}

const order = (g: any) => ({ LIVE: 0, DELAYED: 1, UPCOMING: 2, FINAL: 3 } as any)[g.display] ?? 4;

function LeagueCard({ l }: { l: any }) {
  const team = { name: l.team_name ?? l.name, abbrev: l.abbrev, primary_color: l.primary_color, secondary_color: l.secondary_color, logo_media_id: l.team_logo_media_id, logo_preset: l.logo_preset };
  const m = l.matchup;
  const leading = m && m.myPoints >= m.oppPoints;
  return (
    <Link to={`/league/${l.id}/${l.status === 'setup' || l.status === 'drafting' ? 'draft' : 'matchups'}`} className="group flex flex-col overflow-hidden rounded-card bg-surface hairline transition hover:-translate-y-0.5 hover:shadow-lg">
      <TeamStripe team={team} />
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <TeamChip team={team} sub={l.name} size={40} />
          <Badge tone={l.status === 'in_season' ? 'good' : l.status === 'playoffs' ? 'accent' : 'neutral'}>{STATUS_LABEL[l.status]}</Badge>
        </div>
        {m ? (
          <div className="rounded-xl bg-raised p-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="label">Week {m.week}{m.kind !== 'regular' ? ` · ${m.kind}` : ''}</span>
              <StatusPill status={m.status === 'live' ? 'LIVE' : m.status === 'final' ? 'FINAL' : 'UPCOMING'} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className={cx('num font-display text-3xl font-bold', m.status !== 'scheduled' && !leading && 'text-muted')}>{pts(m.myPoints, 1)}</span>
              <span className="text-[12px] text-faint">vs</span>
              <span className="flex min-w-0 items-center gap-2">
                <span className={cx('num font-display text-3xl font-bold', m.status !== 'scheduled' && leading && 'text-muted')}>{m.opponent ? pts(m.oppPoints, 1) : '—'}</span>
                {m.opponent ? <TeamLogo team={m.opponent} size={26} /> : <span className="text-[12px] text-muted">Solo</span>}
              </span>
            </div>
          </div>
        ) : (
          <div className="rounded-xl bg-raised p-3 text-[13px] text-muted">{l.status === 'setup' ? 'Waiting for the draft. Open the draft room to start or set it up.' : l.status === 'drafting' ? 'The draft is live — head to the draft room.' : 'No matchup this week.'}</div>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted">
          {l.rank && <span><b className="text-ink">{l.rank}</b> of {l.team_count}</span>}
          {l.record && <span className="num"><b className="text-ink">{l.record.wins}-{l.record.losses}{l.record.ties ? `-${l.record.ties}` : ''}</b></span>}
          {l.nextOpponent && <span>Next: {l.nextOpponent.name}</span>}
          {l.pending_offers > 0 && <Badge tone="accent">{l.pending_offers} offer{l.pending_offers === 1 ? '' : 's'}</Badge>}
          {l.pending_claims > 0 && <Badge tone="info">{l.pending_claims} claim{l.pending_claims === 1 ? '' : 's'}</Badge>}
          {l.unread > 0 && <Badge tone="neutral">{l.unread} unread</Badge>}
        </div>
      </div>
    </Link>
  );
}

function QuickActions({ l }: { l: any }) {
  const base = `/league/${l.id}`;
  const actions = [
    { to: `${base}/team`, icon: ListChecks, label: 'Set lineup' },
    { to: `${base}/players`, icon: Search, label: 'Search players' },
    { to: `${base}/trades?new=1`, icon: ArrowLeftRight, label: 'Propose a trade' },
    { to: `${base}/waivers`, icon: Repeat, label: 'Waiver claim' },
    { to: `${base}/trades`, icon: Vote, label: 'Review offers', badge: l.pending_offers },
    ...(l.role === 'commissioner' || l.role === 'co_commissioner' ? [{ to: `${base}/commissioner`, icon: Gavel, label: 'Commissioner' }] : []),
  ];
  return (
    <section>
      <SectionTitle sub={`For ${l.name}. Switch leagues from the menu.`}>Quick actions</SectionTitle>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {actions.map((a) => (
          <Link key={a.label} to={a.to} className="flex items-center gap-2.5 rounded-xl bg-surface px-3 py-3 text-[13px] font-semibold hairline transition hover:bg-raised">
            <a.icon className="h-4 w-4 text-accent" /><span className="flex-1">{a.label}</span>
            {a.badge ? <span className="rounded-full bg-accent px-1.5 text-[10px] text-accent-ink">{a.badge}</span> : null}
          </Link>
        ))}
      </div>
    </section>
  );
}

function Onboarding() {
  const items = [
    { to: '/leagues/new?template=league', icon: PlusCircle, title: 'Create a league', body: 'Head-to-head or a 3–10 team league with friends or AI managers. Ready in one screen.' },
    { to: '/leagues?join=1', icon: UserPlus, title: 'Join with a code', body: 'Got an invite? Enter the 8-character code or open the link your commissioner sent.' },
    { to: '/leagues/new?template=solo', icon: Users, title: 'High Score Challenge', body: 'Play on your own: build a roster and chase the highest weekly totals.' },
  ];
  return (
    <Card className="overflow-hidden" pad={false}>
      <div className="bg-turf px-6 py-8 text-white">
        <div className="font-display text-3xl font-bold uppercase tracking-wide">Kick off your first season</div>
        <p className="mt-1 max-w-xl text-white/75">Leagues are fully independent: each keeps its own rosters, scoring, waivers, trades and chat.</p>
      </div>
      <div className="grid gap-px bg-line sm:grid-cols-3">
        {items.map((i) => (
          <Link key={i.title} to={i.to} className="flex flex-col gap-2 bg-surface p-5 transition hover:bg-raised">
            <i.icon className="h-6 w-6 text-accent" />
            <div className="font-display text-xl font-semibold uppercase tracking-wide">{i.title}</div>
            <p className="text-[13px] text-muted">{i.body}</p>
          </Link>
        ))}
      </div>
    </Card>
  );
}
