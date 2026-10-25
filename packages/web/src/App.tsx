import { useEffect, type ReactNode } from 'react';
import { HashRouter, MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api/client';
import { PlayerModalProvider } from './components/PlayerModal';
import { Shell } from './components/Shell';
import { LoadingBlock } from './components/ui';
import { setUserTimeZone } from './lib/format';
import { useLiveEvents, useMe } from './lib/hooks';
import { Forgot, Login, Register, ResetPassword } from './pages/Auth';
import { Commissioner } from './pages/Commissioner';
import { Dashboard } from './pages/Dashboard';
import { Draft } from './pages/Draft';
import { Hub } from './pages/Hub';
import { CreateLeague, JoinByLink, Leagues } from './pages/Leagues';
import { QuickCreate } from './pages/QuickCreate';
import { Matchups } from './pages/Matchups';
import { MyTeam } from './pages/MyTeam';
import { Players } from './pages/Players';
import { Settings } from './pages/Settings';
import { Chat, Notifications } from './pages/Social';
import { Trades } from './pages/Trades';
import { Waivers } from './pages/Waivers';
import { applyAppearance, applyTheme } from './theme';

function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isLoading } = useMe();
  const loc = useLocation();
  useLiveEvents(Boolean(data?.user));
  useEffect(() => {
    if (data?.user) { applyTheme(data.user.theme); applyAppearance(data.user.appearance ?? null); setUserTimeZone(data.user.timezone); }
  }, [data?.user?.theme, data?.user?.timezone, JSON.stringify(data?.user?.appearance ?? null)]);
  if (isLoading) return <div className="gutter mx-auto max-w-3xl py-10"><LoadingBlock rows={5} /></div>;
  if (!data?.user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  return <PlayerModalProvider><Shell>{children}</Shell></PlayerModalProvider>;
}

export function App({ resetDemo }: { resetDemo?: () => Promise<void> }) {
  // The self-contained demo runs inside a sandboxed frame, so it keeps routing in memory.
  const Router = api().mode === 'demo' ? MemoryRouter : HashRouter;
  const A = (el: ReactNode) => <RequireAuth>{el}</RequireAuth>;
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot" element={<Forgot />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/" element={A(<Dashboard />)} />
        <Route path="/leagues" element={A(<Leagues />)} />
        <Route path="/leagues/new" element={A(<QuickCreate />)} />
        <Route path="/leagues/new/advanced" element={A(<CreateLeague />)} />
        <Route path="/join/:code" element={A(<JoinByLink />)} />
        <Route path="/league/:leagueId/team" element={A(<MyTeam />)} />
        <Route path="/league/:leagueId/matchups" element={A(<Matchups />)} />
        <Route path="/league/:leagueId/players" element={A(<Players />)} />
        <Route path="/league/:leagueId/waivers" element={A(<Waivers />)} />
        <Route path="/league/:leagueId/trades" element={A(<Trades />)} />
        <Route path="/league/:leagueId/hub" element={A(<Hub />)} />
        <Route path="/league/:leagueId/chat" element={A(<Chat />)} />
        <Route path="/league/:leagueId/draft" element={A(<Draft />)} />
        <Route path="/league/:leagueId/commissioner" element={A(<Commissioner />)} />
        <Route path="/notifications" element={A(<Notifications />)} />
        <Route path="/settings" element={A(<Settings resetDemo={resetDemo} />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}
