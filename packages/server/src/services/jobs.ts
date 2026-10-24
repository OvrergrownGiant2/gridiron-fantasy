import type { App } from '../app';
import { draftTick } from './drafts';
import { runSync } from './nfl';
import { setLineup, suggestLineup } from './rosters';
import { tradeTick } from './trades';
import { waiverTick } from './waivers';
import { notifyTeamOwner } from './common';
import { seasonOf, weekGames } from './nfl';

/**
 * About 90 minutes before a week's first kickoff, remind each manager whose
 * starting lineup includes a player on bye or ruled out. Sent once per league-week.
 */
export async function lineupLockReminders(app: App): Promise<number> {
  const season = await seasonOf(app.db);
  if (!season) return 0;
  const leagues = await app.db.query<{ id: string; current_week: number }>("SELECT id, current_week FROM leagues WHERE season = $1 AND status IN ('in_season','playoffs')", [season]);
  const now = app.clock.now().getTime();
  let sent = 0;
  for (const l of leagues) {
    const games = (await weekGames(app.db, season, l.current_week)).filter((g) => g.status === 'scheduled');
    const first = games.map((g) => Date.parse(g.kickoff_at)).sort((a, b) => a - b)[0];
    if (!first || first - now > 90 * 60_000 || first < now) continue;
    const key = `lineup_reminder:${l.id}:${l.current_week}`;
    if (await app.db.one('SELECT 1 FROM app_kv WHERE key = $1', [key])) continue;
    await app.db.query('INSERT INTO app_kv (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING', [key, JSON.stringify({ at: new Date(now).toISOString() })]);
    const playing = new Set(games.flatMap((g) => [g.home_team_id, g.away_team_id]));
    const allWeek = new Set((await weekGames(app.db, season, l.current_week)).flatMap((g) => [g.home_team_id, g.away_team_id]));
    const rows = await app.db.query<{ team_id: string; full_name: string; nfl_team_id: string | null; injury_status: string }>(
      `SELECT r.team_id, p.full_name, p.nfl_team_id, p.injury_status FROM roster_entries r JOIN teams t ON t.id = r.team_id JOIN nfl_players p ON p.id = r.player_id
       WHERE r.league_id = $1 AND NOT t.is_ai AND r.slot NOT IN ('BN','IR')`, [l.id]);
    const byTeam = new Map<string, string[]>();
    for (const r of rows) {
      const bye = !r.nfl_team_id || !allWeek.has(r.nfl_team_id);
      const out = ['out', 'ir', 'suspended', 'pup'].includes(r.injury_status);
      if (bye || out) byTeam.set(r.team_id, [...(byTeam.get(r.team_id) ?? []), `${r.full_name} (${bye ? 'bye' : r.injury_status})`]);
    }
    for (const [teamId, list] of byTeam) {
      await notifyTeamOwner(app, app.db, teamId, { leagueId: l.id, kind: 'lineup_lock', title: 'Lineups lock soon', body: `Starters who will not play: ${list.join(', ')}.`, link: `/league/${l.id}/team` });
      sent++;
    }
    void playing;
  }
  return sent;
}

/** AI managers keep their lineups optimal through the same setLineup path as humans. */
export async function aiLineups(app: App): Promise<number> {
  const teams = await app.db.query<{ id: string }>("SELECT t.id FROM teams t JOIN leagues l ON l.id = t.league_id WHERE t.is_ai AND l.status IN ('in_season','playoffs')");
  let n = 0;
  for (const t of teams) {
    try {
      const actor = { kind: 'ai' as const, teamId: t.id };
      const s = await suggestLineup(app, actor, { teamId: t.id });
      if (s.changes.length && s.projectedAfter > s.projectedBefore + 0.05) {
        await setLineup(app, actor, { teamId: t.id, assignments: s.assignment });
        n++;
      }
    } catch (e) { app.log(`AI lineup for ${t.id} skipped: ${(e as Error).message}`); }
  }
  return n;
}

export interface JobRunner { stop(): void; runOnce(): Promise<void> }

/** In-process scheduler. In production run exactly one instance with JOBS_ENABLED=true. */
export function startJobs(app: App, opts: { fastTickMs?: number; slowTickMs?: number } = {}): JobRunner {
  let stopped = false;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAi = 0;
  const busy = { fast: false, slow: false, sync: false };
  const slow = async () => {
    if (busy.slow) return; busy.slow = true;
    try {
      await tradeTick(app);
      await waiverTick(app);
      await lineupLockReminders(app);
      if (app.clock.now().getTime() - lastAi > 10 * 60_000) { lastAi = app.clock.now().getTime(); await aiLineups(app); }
    } catch (e) { app.log(`job error: ${(e as Error).message}`); } finally { busy.slow = false; }
  };
  const fast = async () => {
    if (busy.fast) return; busy.fast = true;
    try { await draftTick(app); } catch (e) { app.log(`draft tick error: ${(e as Error).message}`); } finally { busy.fast = false; }
  };
  const sync = async () => {
    if (stopped) return;
    let wait = 30;
    if (!busy.sync) {
      busy.sync = true;
      try { wait = (await runSync(app)).nextRunInSeconds; } catch (e) { app.log(`sync error: ${(e as Error).message}`); } finally { busy.sync = false; }
    }
    syncTimer = setTimeout(sync, Math.max(5, Math.min(wait, 900)) * 1000);
  };
  const f = setInterval(fast, opts.fastTickMs ?? 1000);
  const s = setInterval(slow, opts.slowTickMs ?? 15_000);
  void sync();
  return {
    stop() { stopped = true; clearInterval(f); clearInterval(s); if (syncTimer) clearTimeout(syncTimer); },
    async runOnce() { await runSync(app, { force: true }); await fast(); await slow(); },
  };
}
