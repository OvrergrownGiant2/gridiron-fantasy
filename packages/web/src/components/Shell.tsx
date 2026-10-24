import {
  ArrowLeftRight, Bell, ChevronDown, ClipboardList, Gavel, Home, LayoutGrid, LogOut, Menu, MessageSquare, Repeat, Search,
  Settings, Shield, Trophy, Users, X, Swords, ListOrdered, Clock3,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { rememberLeague, rememberedLeague, useCall, useDataStatus, useLeague, useMe, useMyLeagues } from '../lib/hooks';
import { dateTime, relative } from '../lib/format';
import { TeamLogo } from './team';
import { Badge, cx } from './ui';
import { DemoClock } from './DemoClock';

const LEAGUE_SECTIONS = ['team', 'matchups', 'players', 'waivers', 'trades', 'hub', 'chat', 'draft', 'commissioner'];

function currentSection(path: string): string {
  const m = path.match(/^\/league\/[^/]+\/([^/?]+)/);
  return m && LEAGUE_SECTIONS.includes(m[1]) ? m[1] : 'team';
}

export function useActiveLeagueId(): string | null {
  const loc = useLocation();
  const m = loc.pathname.match(/^\/league\/([^/]+)/);
  const fromPath = m?.[1] ?? null;
  useEffect(() => { if (fromPath) rememberLeague(fromPath); }, [fromPath]);
  return fromPath ?? rememberedLeague();
}

function LeagueSwitcher({ leagueId }: { leagueId: string | null }) {
  const { data: leagues } = useMyLeagues();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const current = leagues?.find((l) => l.id === leagueId) ?? leagues?.[0];
  useEffect(() => { if (current && current.id !== leagueId) rememberLeague(current.id); }, [current, leagueId]);
  if (!leagues) return <div className="h-12 rounded-xl bg-sunken" />;
  if (!leagues.length) return <Link to="/leagues" className="flex h-12 items-center rounded-xl bg-sunken px-3 text-[13px] font-semibold text-muted">Create or join a league</Link>;
  const teamOf = (l: any) => ({ name: l.team_name ?? l.name, abbrev: l.abbrev, primary_color: l.primary_color, secondary_color: l.secondary_color, logo_media_id: l.team_logo_media_id, logo_preset: l.logo_preset });
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl bg-white/5 px-2.5 py-2 text-left ring-1 ring-white/10 transition hover:bg-white/10">
        <TeamLogo team={teamOf(current)} size={34} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] uppercase tracking-wider text-white/60">Current league</span>
          <span className="block truncate font-semibold text-white">{current.name}</span>
        </span>
        <ChevronDown className="h-4 w-4 text-white/60" />
      </button>
      {open && (
        <div role="listbox" className="absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl bg-surface text-ink shadow-2xl hairline animate-slideUp">
          {leagues.map((l) => (
            <button key={l.id} role="option" aria-selected={l.id === current.id}
              onClick={() => { setOpen(false); rememberLeague(l.id); nav(`/league/${l.id}/${currentSection(loc.pathname)}`); }}
              className={cx('flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-raised', l.id === current.id && 'bg-raised')}>
              <TeamLogo team={teamOf(l)} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{l.name}</span>
                <span className="block truncate text-[12px] text-muted">{l.team_name ?? 'Observer'} · {l.status.replace('_', ' ')}</span>
              </span>
              {l.unread > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] font-bold text-accent-ink">{l.unread}</span>}
            </button>
          ))}
          <Link to="/leagues" onClick={() => setOpen(false)} className="block border-t border-line px-3 py-2.5 text-[13px] font-semibold text-accent hover:bg-raised">All leagues · create or join</Link>
        </div>
      )}
    </div>
  );
}

function NavItem({ to, icon, label, badge, onClick }: { to: string; icon: ReactNode; label: string; badge?: number; onClick?: () => void }) {
  return (
    <NavLink to={to} end={to === '/'} onClick={onClick}
      className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium transition', isActive ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5 hover:text-white')}>
      {({ isActive }) => (<>
        <span className={cx('h-4 w-[3px] -ml-1 rounded-full', isActive ? 'bg-accent' : 'bg-transparent')} aria-hidden />
        {icon}<span className="flex-1">{label}</span>
        {badge ? <span className="rounded-full bg-accent px-1.5 text-[10px] font-bold text-accent-ink">{badge}</span> : null}
      </>)}
    </NavLink>
  );
}

function useNav(leagueId: string | null) {
  const { data: league } = useLeague(leagueId);
  const { data: notes } = useCall<any>(['notifications', 'count'], 'notifications.list', { unreadOnly: true, limit: 1 }, { refetchInterval: 60_000 });
  const L = (s: string) => (leagueId ? `/league/${leagueId}/${s}` : '/leagues');
  const perms: string[] = league?.permissions ?? [];
  const drafting = league && (league.league.status === 'setup' || league.league.status === 'drafting');
  return {
    league, unread: notes?.unread ?? 0,
    groups: [
      { title: null, items: [
        { to: '/', icon: <Home className="h-4 w-4" />, label: 'Home' },
        { to: '/leagues', icon: <LayoutGrid className="h-4 w-4" />, label: 'My Leagues' },
      ] },
      { title: 'League', items: [
        ...(drafting ? [{ to: L('draft'), icon: <ListOrdered className="h-4 w-4" />, label: 'Draft Room' }] : []),
        { to: L('team'), icon: <Shield className="h-4 w-4" />, label: 'My Team' },
        { to: L('matchups'), icon: <Swords className="h-4 w-4" />, label: 'Matchups' },
        { to: L('players'), icon: <Search className="h-4 w-4" />, label: 'Players' },
        { to: L('waivers'), icon: <Repeat className="h-4 w-4" />, label: 'Waivers & Free Agents' },
        { to: L('trades'), icon: <ArrowLeftRight className="h-4 w-4" />, label: 'Trades' },
        { to: L('hub'), icon: <Trophy className="h-4 w-4" />, label: 'League Hub' },
        { to: L('chat'), icon: <MessageSquare className="h-4 w-4" />, label: 'League Chat' },
        ...(perms.includes('trade.review') ? [{ to: L('commissioner'), icon: <Gavel className="h-4 w-4" />, label: 'Digital Commissioner' }] : []),
      ] },
      { title: 'You', items: [
        { to: '/notifications', icon: <Bell className="h-4 w-4" />, label: 'Notifications', badge: notes?.unread ?? 0 },
        { to: '/settings', icon: <Settings className="h-4 w-4" />, label: 'Profile & Settings' },
      ] },
    ],
  };
}

export function DataBanner() {
  const { data } = useDataStatus();
  if (!data) return null;
  const snap = data.provider.snapshotAsOf as string | null;
  const tone = data.provider.isDemo ? 'demo' : snap ? 'snapshot' : data.health === 'ok' ? null : data.health === 'stale' ? 'warn' : 'bad';
  if (!tone) return null;
  return (
    <div role="status" className={cx('gutter flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[12.5px]',
      tone === 'demo' || tone === 'snapshot' ? 'bg-accent/15 text-ink' : tone === 'warn' ? 'bg-warn/15 text-ink' : 'bg-bad/15 text-ink')}>
      <Badge tone={tone === 'demo' || tone === 'snapshot' ? 'accent' : tone === 'warn' ? 'warn' : 'bad'}>{tone === 'demo' ? 'Demo data' : tone === 'snapshot' ? 'Real data · snapshot' : tone === 'warn' ? 'Stale data' : 'Data unavailable'}</Badge>
      <span className="min-w-[12rem] flex-1">
        {tone === 'demo'
          ? 'Players, games and stats are simulated. No real NFL data is shown.'
          : tone === 'snapshot'
            ? <>Real players, schedule and stats from <a className="font-semibold underline" href="https://github.com/nflverse/nflverse-data" target="_blank" rel="noreferrer">nflverse</a>, captured {dateTime(snap!)}. Not live: games after that show no results.</>
            : data.message}
        {data.lastUpdatedAt && tone !== 'snapshot' && <span className="text-muted"> · Updated {relative(data.lastUpdatedAt, Date.parse(data.now))}</span>}
      </span>
      {data.provider.isDemo && <DemoClock />}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const leagueId = useActiveLeagueId();
  const { groups, league, unread } = useNav(leagueId);
  const { data: me } = useMe();
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  const qc = useQueryClient();
  const nav = useNavigate();
  useEffect(() => setDrawer(false), [loc.pathname]);
  const logout = async () => { await api().call('auth.logout'); api().sessionChanged(); qc.clear(); nav('/login'); };

  const sidebar = (onItem?: () => void) => (
    <div className="flex h-full flex-col gap-4 bg-turf px-3 py-4 text-white">
      <Link to="/" className="flex items-center gap-2 px-2">
        <Logo />
        <span className="font-display text-[22px] font-bold uppercase tracking-wide">Gridiron</span>
      </Link>
      <LeagueSwitcher leagueId={leagueId} />
      <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto" aria-label="Main">
        {groups.map((g, i) => (
          <div key={i} className="flex flex-col gap-0.5">
            {g.title && <div className="px-3 pb-1 text-[10.5px] font-semibold uppercase tracking-[.14em] text-white/45">{g.title}</div>}
            {g.items.map((it: any) => <NavItem key={it.label} {...it} onClick={onItem} />)}
          </div>
        ))}
      </nav>
      {me?.user && (
        <div className="flex items-center gap-2 border-t border-white/10 px-2 pt-3">
          <Avatar user={me.user} size={30} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold">{me.user.displayName}</div>
            <div className="truncate text-[12px] text-white/55">@{me.user.username}</div>
          </div>
          <button onClick={logout} aria-label="Sign out" title="Sign out" className="rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white"><LogOut className="h-4 w-4" /></button>
        </div>
      )}
    </div>
  );

  const L = (s: string) => (leagueId ? `/league/${leagueId}/${s}` : '/leagues');
  const tabs = [
    { to: '/', icon: Home, label: 'Home' },
    { to: L('team'), icon: Shield, label: 'Team' },
    { to: L('matchups'), icon: Swords, label: 'Matchup' },
    { to: L('players'), icon: Search, label: 'Players' },
  ];

  return (
    <div className="flex h-full">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 lg:block">{sidebar()}</aside>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 w-[84%] max-w-xs shadow-2xl animate-slideUp" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
            {sidebar(() => setDrawer(false))}
            <button onClick={() => setDrawer(false)} aria-label="Close menu" className="absolute right-2 top-3 rounded-lg p-2 text-white/70"><X className="h-5 w-5" /></button>
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-2 bg-turf py-2 text-white lg:hidden gutter" style={{ top: 'env(safe-area-inset-top, 0px)' }}>
          <button onClick={() => setDrawer(true)} aria-label="Open menu" className="rounded-lg p-2 hover:bg-white/10"><Menu className="h-5 w-5" /></button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] uppercase tracking-wider text-white/55">{league?.league?.name ?? 'Gridiron'}</div>
            <div className="truncate font-display text-lg font-semibold uppercase leading-tight tracking-wide">{pageName(loc.pathname)}</div>
          </div>
          <Link to="/notifications" aria-label="Notifications" className="relative rounded-lg p-2 hover:bg-white/10">
            <Bell className="h-5 w-5" />{unread > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent" />}
          </Link>
        </header>
        <DataBanner />
        <main className="gutter mx-auto w-full max-w-6xl flex-1 pb-28 pt-5 lg:pb-10 lg:pt-8">{children}</main>
        <nav aria-label="Quick" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 backdrop-blur lg:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)', paddingLeft: 'env(safe-area-inset-left, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)' }}>
          {tabs.map((t) => (
            <NavLink key={t.label} to={t.to} end={t.to === '/'} className={({ isActive }) => cx('flex flex-col items-center gap-0.5 py-2 text-[11px] font-semibold', isActive ? 'text-accent' : 'text-muted')}>
              <t.icon className="h-5 w-5" />{t.label}
            </NavLink>
          ))}
          <button onClick={() => setDrawer(true)} className="flex flex-col items-center gap-0.5 py-2 text-[11px] font-semibold text-muted"><Menu className="h-5 w-5" />More</button>
        </nav>
      </div>
    </div>
  );
}

function pageName(path: string) {
  if (path === '/') return 'Home';
  if (path.startsWith('/leagues')) return 'My Leagues';
  if (path.startsWith('/notifications')) return 'Notifications';
  if (path.startsWith('/settings')) return 'Settings';
  const s = currentSection(path);
  return ({ team: 'My Team', matchups: 'Matchups', players: 'Players', waivers: 'Waivers', trades: 'Trades', hub: 'League Hub', chat: 'Chat', draft: 'Draft Room', commissioner: 'Commissioner' } as any)[s] ?? 'Gridiron';
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="rgb(var(--accent))" />
      <path d="M7 16c3.2-6.5 14.8-6.5 18 0-3.2 6.5-14.8 6.5-18 0Z" fill="#12201B" />
      <path d="M12.5 16h7M14 14.3v3.4M16 14.3v3.4M18 14.3v3.4" stroke="rgb(var(--accent))" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function Avatar({ user, size = 32 }: { user: { displayName?: string; display_name?: string; avatarMediaId?: string | null; avatar_media_id?: string | null }; size?: number }) {
  const name = user.displayName ?? user.display_name ?? '?';
  const id = user.avatarMediaId ?? user.avatar_media_id;
  return <TeamLogo team={{ name, abbrev: name.split(' ').map((w) => w[0]).join('').slice(0, 2), primary_color: '#2A3D36', secondary_color: '#2A3D36', logo_media_id: id }} size={size} />;
}

export { ClipboardList, Users, Clock3 };
