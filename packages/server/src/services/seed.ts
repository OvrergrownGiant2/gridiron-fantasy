import { scoringPreset, defaultLeagueSettings } from '@gridiron/core';
import type { App } from '../app';
import type { OffsetClock } from '../clock';
import { register } from './auth';
import { autoDraftAll } from './drafts';
import { createLeague, joinLeague, updateTeam } from './leagues';
import { runSync } from './nfl';
import { setLineup, suggestLineup } from './rosters';
import { postMessage } from './social';
import { proposeTrade } from './trades';
import { waiverTick } from './waivers';
import { aiLineups } from './jobs';
import { DEMO_SEASON, easternToUtc } from '../providers/demo';

export const DEMO_USERS = [
  { username: 'demo', password: 'demo1234', email: 'demo@example.com', displayName: 'Demo Manager' },
  { username: 'alex', password: 'alex1234', email: 'alex@example.com', displayName: 'Alex Rivera' },
];

/**
 * Development / demo seed. Simulates the demo season from preseason up to `until`
 * through the real pipeline (sync → scoring → finalization → waivers → AI lineups),
 * so every number on screen was produced by the same code that runs in production.
 * Requires the demo provider and an OffsetClock.
 */
export async function seedDemo(app: App, clock: OffsetClock, onProgress: (msg: string, pct: number) => void = () => {}) {
  if (!app.provider.replayable) throw new Error('Seeding requires a replayable provider (demo or snapshot).');
  const existing = await app.db.one<{ c: number }>('SELECT count(*)::int AS c FROM users');
  if (existing && existing.c > 0) return { skipped: true };
  const realOffset = clock.offsetMs;
  const target = clock.now().getTime();
  const setTime = (ms: number) => clock.set(ms - Date.now());

  onProgress('Loading NFL demo data', 5);
  setTime(Date.parse(`${DEMO_SEASON}-09-01T12:00:00Z`));
  await runSync(app, { force: true });

  onProgress('Creating demo managers', 12);
  const ids: string[] = [];
  for (const u of DEMO_USERS) ids.push((await register(app, u)).user.id);
  const demo = { kind: 'user' as const, userId: ids[0] };
  const alex = { kind: 'user' as const, userId: ids[1] };

  const big = defaultLeagueSettings();
  big.season.regularSeasonWeeks = 14; big.season.playoffTeams = 4;
  const l1 = await createLeague(app, demo, { name: 'Sunday Funday League', description: 'A 10-team PPR league: you versus nine AI managers.', teamCount: 10, aiTeams: 9, aiDifficulty: 'medium', teamName: 'Gridiron Gang', settings: big, scoring: scoringPreset('ppr') });

  const small = defaultLeagueSettings();
  small.season.regularSeasonWeeks = 14; small.season.playoffTeams = 2;
  small.trades.review = 'commissioner'; small.waivers.mode = 'rolling';
  small.roster = { ...small.roster, SUPERFLEX: 1, BN: 5 };
  const l2 = await createLeague(app, demo, { name: 'Friends & Family', description: 'Half-PPR superflex with rolling waivers and commissioner trade review.', teamCount: 4, aiTeams: 2, aiDifficulty: 'easy', teamName: 'Couch Coaches', settings: small, scoring: scoringPreset('half_ppr') });
  await joinLeague(app, alex, { inviteCode: l2.inviteCode, teamName: 'Rivera Rockets' });

  const teams = await app.db.query<{ id: string; league_id: string; owner_user_id: string | null }>('SELECT id, league_id, owner_user_id FROM teams WHERE owner_user_id IS NOT NULL');
  const myTeam1 = teams.find((t) => t.league_id === l1.id && t.owner_user_id === ids[0])!;
  const myTeam2 = teams.find((t) => t.league_id === l2.id && t.owner_user_id === ids[0])!;
  const alexTeam = teams.find((t) => t.league_id === l2.id && t.owner_user_id === ids[1])!;
  await updateTeam(app, demo, { teamId: myTeam1.id, primaryColor: '#0B4F6C', secondaryColor: '#F2C14E', logoPreset: 'preset-3', description: 'Built on speed and questionable decisions.' });
  await updateTeam(app, demo, { teamId: myTeam2.id, primaryColor: '#0F766E', secondaryColor: '#FB7185', logoPreset: 'preset-7' });
  await updateTeam(app, alex, { teamId: alexTeam.id, primaryColor: '#3730A3', secondaryColor: '#A5F3FC', logoPreset: 'preset-5' });

  onProgress('Running drafts', 20);
  await autoDraftAll(app, demo, { leagueId: l1.id });
  await autoDraftAll(app, demo, { leagueId: l2.id });

  // Step through the season week by week (Tuesday mornings, then Wednesday waivers).
  const humanLineups = async () => {
    for (const [actor, teamId] of [[demo, myTeam1.id], [demo, myTeam2.id], [alex, alexTeam.id]] as const) {
      try {
        const s = await suggestLineup(app, actor, { teamId });
        if (s.changes.length) await setLineup(app, actor, { teamId, assignments: s.assignment });
      } catch { /* locked players etc. */ }
    }
  };
  const weekStart = (w: number) => Date.parse(`${DEMO_SEASON}-09-08T12:00:00Z`) + (w - 1) * 7 * 86_400_000; // Tuesday before TNF
  for (let w = 1; w <= 18; w++) {
    const tue = weekStart(w);
    if (tue > target) break;
    onProgress(`Simulating week ${w}`, 20 + Math.min(70, w * 5));
    setTime(tue);
    await runSync(app, { force: true });
    await aiLineups(app);
    await humanLineups();
    const wed = tue + 22 * 3_600_000; // Wednesday 10:00 UTC (after 08:00 waiver run)
    if (wed <= target) { setTime(wed); await waiverTick(app); }
  }
  setTime(target);
  await runSync(app, { force: true });
  await aiLineups(app);
  await humanLineups();

  onProgress('Adding league chatter', 94);
  await postMessage(app, demo, { leagueId: l2.id, body: 'Welcome to Friends & Family! Trades go through commissioner review this year.' });
  await postMessage(app, alex, { leagueId: l2.id, body: 'Bring it on @demo 🏈' });
  try {
    const mine = await app.db.query<{ player_id: string; slot: string }>("SELECT player_id, slot FROM roster_entries WHERE team_id = $1 AND slot = 'BN' LIMIT 1", [alexTeam.id]);
    const yours = await app.db.query<{ player_id: string }>("SELECT player_id FROM roster_entries WHERE team_id = $1 AND slot = 'BN' LIMIT 1", [myTeam2.id]);
    if (mine[0] && yours[0]) {
      await proposeTrade(app, alex, { fromTeamId: alexTeam.id, toTeamId: myTeam2.id, message: 'Bench swap? Both of us could use the depth.', assets: [
        { fromTeamId: alexTeam.id, toTeamId: myTeam2.id, type: 'player', playerId: mine[0].player_id },
        { fromTeamId: myTeam2.id, toTeamId: alexTeam.id, type: 'player', playerId: yours[0].player_id },
      ] });
    }
  } catch (e) { app.log(`seed trade skipped: ${(e as Error).message}`); }
  clock.set(realOffset);
  onProgress('Ready', 100);
  void easternToUtc;
  return { skipped: false, leagues: [l1.id, l2.id] };
}
