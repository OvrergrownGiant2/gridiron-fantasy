import { AppError, forbidden, type Actor, type App } from '../app';
import { audit, getLeague, requirePermission, requireUser } from './common';
import { dataStatus, runSync } from './nfl';
import { advanceLeagues, recomputeLeagueWeek } from './scoring';

const COOLDOWN_MS = 60_000;

/**
 * Creator-only "Refresh league": pulls the latest NFL data from the configured
 * provider, then recalculates this league's live scores, finalizes any weeks whose
 * games are complete and updates standings. Limited to once a minute per league.
 */
export async function refreshLeague(app: App, actor: Actor, input: { leagueId: string }) {
  const userId = requireUser(actor);
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  const before = await getLeague(app.db, input.leagueId);
  if (before.created_by !== userId) throw forbidden('Only the league creator can refresh the league.');

  const key = `league_refresh:${before.id}`;
  const last = await app.db.one<{ value: { at: string } }>('SELECT value FROM app_kv WHERE key = $1', [key]);
  const since = last ? app.clock.now().getTime() - Date.parse(last.value.at) : Infinity;
  if (since < COOLDOWN_MS) throw new AppError(429, 'cooldown', `The league was refreshed moments ago. Try again in ${Math.ceil((COOLDOWN_MS - since) / 1000)} seconds.`);
  await app.db.query('INSERT INTO app_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify({ at: app.clock.now().toISOString() })]);

  const sync = await runSync(app, { force: true });
  let weeksFinalized = 0;
  if (before.status === 'in_season' || before.status === 'playoffs') {
    await recomputeLeagueWeek(app, before.id, before.current_week);
    await advanceLeagues(app, before.season);
    const after = await getLeague(app.db, before.id);
    weeksFinalized = Math.max(0, after.current_week - before.current_week);
    if (after.status === 'in_season' || after.status === 'playoffs') await recomputeLeagueWeek(app, after.id, after.current_week);
  }
  const status = await dataStatus(app);
  const after = await getLeague(app.db, before.id);
  await audit(app.db, { leagueId: before.id, actor, action: 'league.refresh', payload: { changedGames: sync.changedGames, changedStats: sync.changedStats, weeksFinalized, ok: sync.ok } });
  app.bus.publish(`league:${before.id}`, { type: 'scores', leagueId: before.id, payload: { week: after.current_week } });
  return {
    ok: sync.ok, error: sync.error ?? null,
    changedGames: sync.changedGames, changedStats: sync.changedStats, weeksFinalized,
    currentWeek: after.current_week, status: after.status,
    snapshotAsOf: status.provider.snapshotAsOf ?? null, providerLabel: status.provider.label, lastUpdatedAt: status.lastUpdatedAt,
  };
}
