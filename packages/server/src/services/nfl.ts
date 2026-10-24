import { displayStatus, statHash, type NflGame, type PlayerGameStat, type StatLine } from '@gridiron/core';
import type { App } from '../app';
import type { Db } from '../db/db';
import { ProviderError } from '../providers/provider';
import { advanceLeagues, onNflDataChanged } from './scoring';
import { notifyTeamOwner } from './common';

export interface GameRow {
  id: string; season: number; week: number; home_team_id: string; away_team_id: string; kickoff_at: string;
  status: NflGame['status']; home_score: number | null; away_score: number | null; quarter: string | null; clock: string | null; updated_at: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function seasonOf(db: Db): Promise<number | null> {
  const r = await db.one<{ value: { season: number } }>("SELECT value FROM app_kv WHERE key = 'nfl_season'");
  return r?.value.season ?? null;
}

/** Current NFL week: the first week that still has unfinished games. */
export async function currentNflWeek(db: Db, season: number): Promise<number> {
  const r = await db.one<{ w: number | null }>(
    `SELECT min(week) AS w FROM nfl_games WHERE season = $1 AND status NOT IN ('final','canceled','postponed')`, [season]);
  if (r?.w) return r.w;
  const last = await db.one<{ w: number | null }>('SELECT max(week) AS w FROM nfl_games WHERE season = $1', [season]);
  return last?.w ?? 1;
}

export async function weekGames(db: Db, season: number, week: number): Promise<GameRow[]> {
  return db.query<GameRow>('SELECT * FROM nfl_games WHERE season = $1 AND week = $2 ORDER BY kickoff_at, id', [season, week]);
}

/** Map NFL team → game this week (absent = bye). */
export async function teamGameMap(db: Db, season: number, week: number): Promise<Map<string, GameRow>> {
  const m = new Map<string, GameRow>();
  for (const g of await weekGames(db, season, week)) { m.set(g.home_team_id, g); m.set(g.away_team_id, g); }
  return m;
}

export async function byeWeeks(db: Db, season: number): Promise<Map<string, number[]>> {
  const rows = await db.query<{ team: string; week: number }>(
    `WITH weeks AS (SELECT DISTINCT week FROM nfl_games WHERE season = $1),
          played AS (SELECT week, home_team_id AS team FROM nfl_games WHERE season = $1 UNION SELECT week, away_team_id FROM nfl_games WHERE season = $1)
     SELECT t.id AS team, w.week FROM nfl_teams t CROSS JOIN weeks w
     WHERE NOT EXISTS (SELECT 1 FROM played p WHERE p.team = t.id AND p.week = w.week) ORDER BY w.week`, [season]);
  const m = new Map<string, number[]>();
  for (const r of rows) m.set(r.team, [...(m.get(r.team) ?? []), r.week]);
  return m;
}

/**
 * A player is locked for `week` once their NFL game has kicked off (or, in
 * first-game mode, once the week's first game has kicked off). Locks clear when
 * the fantasy week is finalized and the league moves to the next week.
 */
export async function lockedPlayerIds(db: Db, opts: { season: number; week: number; now: Date; mode: 'game_time' | 'first_game_of_week'; playerIds: string[] }): Promise<Set<string>> {
  if (opts.playerIds.length === 0) return new Set();
  const games = await weekGames(db, opts.season, opts.week);
  const nowMs = opts.now.getTime();
  if (opts.mode === 'first_game_of_week') {
    const first = games.filter((g) => g.status !== 'postponed' && g.status !== 'canceled').map((g) => Date.parse(g.kickoff_at)).sort((a, b) => a - b)[0];
    return first !== undefined && first <= nowMs ? new Set(opts.playerIds) : new Set();
  }
  const started = new Set<string>();
  for (const g of games) {
    if (g.status === 'postponed' || g.status === 'canceled') continue;
    if (Date.parse(g.kickoff_at) <= nowMs || g.status === 'in_progress' || g.status === 'final') { started.add(g.home_team_id); started.add(g.away_team_id); }
  }
  const rows = await db.query<{ id: string; nfl_team_id: string | null }>('SELECT id, nfl_team_id FROM nfl_players WHERE id = ANY($1)', [opts.playerIds]);
  return new Set(rows.filter((r) => r.nfl_team_id && started.has(r.nfl_team_id)).map((r) => r.id));
}

/** Weekly stat lines summed per player (a player normally has one game per week). */
export async function weekStatLines(db: Db, season: number, week: number, playerIds?: string[]): Promise<Map<string, { stats: StatLine; isFinal: boolean; gameId: string }>> {
  const rows = playerIds
    ? await db.query<{ player_id: string; stats: StatLine; is_final: boolean; game_id: string }>('SELECT player_id, stats, is_final, game_id FROM player_game_stats WHERE season = $1 AND week = $2 AND player_id = ANY($3)', [season, week, playerIds])
    : await db.query<{ player_id: string; stats: StatLine; is_final: boolean; game_id: string }>('SELECT player_id, stats, is_final, game_id FROM player_game_stats WHERE season = $1 AND week = $2', [season, week]);
  const m = new Map<string, { stats: StatLine; isFinal: boolean; gameId: string }>();
  for (const r of rows) {
    const prev = m.get(r.player_id);
    if (!prev) { m.set(r.player_id, { stats: r.stats, isFinal: r.is_final, gameId: r.game_id }); continue; }
    const merged: StatLine = { ...prev.stats };
    for (const [k, v] of Object.entries(r.stats)) (merged as any)[k] = ((merged as any)[k] ?? 0) + (v as number);
    m.set(r.player_id, { stats: merged, isFinal: prev.isFinal && r.is_final, gameId: prev.gameId });
  }
  return m;
}

// ---------------------------------------------------------------------------
// Sync pipeline
// ---------------------------------------------------------------------------

export interface SyncResult { ok: boolean; changedStats: number; changedGames: number; week: number | null; error?: string; nextRunInSeconds: number }

async function upsertGames(db: Db, games: NflGame[]): Promise<number> {
  let changed = 0;
  for (const g of games) {
    const r = await db.query(
      `INSERT INTO nfl_games (id, season, season_type, week, home_team_id, away_team_id, kickoff_at, status, home_score, away_score, quarter, clock, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (id) DO UPDATE SET week = EXCLUDED.week, kickoff_at = EXCLUDED.kickoff_at, status = EXCLUDED.status,
         home_score = EXCLUDED.home_score, away_score = EXCLUDED.away_score, quarter = EXCLUDED.quarter, clock = EXCLUDED.clock, updated_at = now()
       WHERE (nfl_games.status, nfl_games.home_score, nfl_games.away_score, nfl_games.quarter, nfl_games.clock, nfl_games.kickoff_at, nfl_games.week)
         IS DISTINCT FROM (EXCLUDED.status, EXCLUDED.home_score, EXCLUDED.away_score, EXCLUDED.quarter, EXCLUDED.clock, EXCLUDED.kickoff_at, EXCLUDED.week)
       RETURNING id`,
      [g.id, g.season, g.seasonType, g.week, g.homeTeamId, g.awayTeamId, g.kickoffAt, g.status, g.homeScore, g.awayScore, g.quarter, g.clock]);
    changed += r.length;
  }
  return changed;
}

/** Idempotent: identical deliveries (same hash) are skipped; corrections update the row. */
export async function upsertStats(db: Db, stats: PlayerGameStat[]): Promise<{ changed: number; weeks: Set<number> }> {
  let changed = 0;
  const weeks = new Set<number>();
  const known = new Set((await db.query<{ id: string }>('SELECT id FROM nfl_players WHERE id = ANY($1)', [[...new Set(stats.map((s) => s.playerId))]])).map((r) => r.id));
  for (const s of stats) {
    if (!known.has(s.playerId)) continue; // unknown players are synced on the next reference sync
    const hash = statHash(s.stats, s.isFinal);
    const r = await db.query(
      `INSERT INTO player_game_stats (player_id, game_id, season, week, stats, is_final, hash, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (player_id, game_id) DO UPDATE SET stats = EXCLUDED.stats, is_final = EXCLUDED.is_final, hash = EXCLUDED.hash, updated_at = now()
       WHERE player_game_stats.hash <> EXCLUDED.hash
       RETURNING player_id`,
      [s.playerId, s.gameId, s.season, s.week, JSON.stringify(s.stats), s.isFinal, hash]);
    if (r.length) { changed++; weeks.add(s.week); }
  }
  return { changed, weeks };
}

export async function syncReference(app: App): Promise<void> {
  const [teams, players] = [await app.provider.teams(), await app.provider.players()];
  const before = new Map((await app.db.query<{ id: string; injury_status: string }>('SELECT id, injury_status FROM nfl_players')).map((r) => [r.id, r.injury_status]));
  await app.db.tx(async (db) => {
    for (const t of teams) {
      await db.query(`INSERT INTO nfl_teams (id, city, name, conference, division) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (id) DO UPDATE SET city = EXCLUDED.city, name = EXCLUDED.name, conference = EXCLUDED.conference, division = EXCLUDED.division`,
        [t.id, t.city, t.name, t.conference, t.division]);
    }
    for (const p of players) {
      await db.query(`INSERT INTO nfl_players (id, provider, provider_player_id, full_name, position, nfl_team_id, jersey, injury_status, injury_note, active, rank, profile, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, position = EXCLUDED.position, nfl_team_id = EXCLUDED.nfl_team_id,
          jersey = EXCLUDED.jersey, injury_status = EXCLUDED.injury_status, injury_note = EXCLUDED.injury_note, active = EXCLUDED.active,
          rank = EXCLUDED.rank, profile = COALESCE(EXCLUDED.profile, nfl_players.profile), updated_at = now()`,
        [p.id, p.provider, p.providerPlayerId, p.fullName, p.position, p.nflTeamId, p.jersey, p.injuryStatus, p.injuryNote, p.active, p.rank, p.profile ? JSON.stringify(p.profile) : null]);
    }
  });
  // Injury notifications for rostered players whose designation got worse or changed.
  const changed = players.filter((p) => before.has(p.id) && before.get(p.id) !== p.injuryStatus);
  if (changed.length && changed.length < 200) {
    for (const p of changed) {
      const owners = await app.db.query<{ team_id: string; league_id: string }>("SELECT r.team_id, r.league_id FROM roster_entries r JOIN leagues l ON l.id = r.league_id WHERE r.player_id = $1 AND l.status IN ('in_season','playoffs')", [p.id]);
      for (const o of owners) {
        await notifyTeamOwner(app, app.db, o.team_id, {
          leagueId: o.league_id, kind: 'player_injury',
          title: p.injuryStatus === 'healthy' ? `${p.fullName} no longer has an injury designation` : `${p.fullName} is now listed ${p.injuryStatus}`,
          body: p.injuryNote ?? '', link: `/league/${o.league_id}/team`,
        });
      }
    }
  }
}

async function setSyncState(db: Db, key: string, provider: string, patch: { ok: boolean; error?: string; nextRunAt: Date; now: Date; meta?: unknown }) {
  await db.query(
    `INSERT INTO provider_sync_state (key, provider, last_attempt_at, last_success_at, last_error, consecutive_failures, next_run_at, meta)
     VALUES ($1,$2,$3, CASE WHEN $4 THEN $3::timestamptz END, $5, CASE WHEN $4 THEN 0 ELSE 1 END, $6, COALESCE($7::jsonb, '{}'::jsonb))
     ON CONFLICT (key) DO UPDATE SET provider = EXCLUDED.provider, last_attempt_at = EXCLUDED.last_attempt_at,
       last_success_at = CASE WHEN $4 THEN EXCLUDED.last_attempt_at ELSE provider_sync_state.last_success_at END,
       last_error = CASE WHEN $4 THEN NULL ELSE EXCLUDED.last_error END,
       consecutive_failures = CASE WHEN $4 THEN 0 ELSE provider_sync_state.consecutive_failures + 1 END,
       next_run_at = EXCLUDED.next_run_at, meta = CASE WHEN $7::jsonb IS NULL THEN provider_sync_state.meta ELSE EXCLUDED.meta END`,
    [key, provider, patch.now.toISOString(), patch.ok, patch.error ?? null, patch.nextRunAt.toISOString(), patch.meta === undefined ? null : JSON.stringify(patch.meta)]);
}

/** Exponential backoff: base × 2^failures, capped at 30 minutes; honors Retry-After. */
export function backoffSeconds(base: number, failures: number, retryAfter?: number): number {
  const b = Math.min(1800, base * 2 ** Math.min(failures, 8));
  return Math.max(b, retryAfter ?? 0);
}

/**
 * One sync cycle: refresh reference data when stale, then the current week's games
 * and stats. Returns when the next cycle should run (provider-aware cadence).
 */
export async function runSync(app: App, opts: { force?: boolean } = {}): Promise<SyncResult> {
  const now = app.clock.now();
  const p = app.provider;
  const state = await app.db.one<{ consecutive_failures: number; next_run_at: string | null; last_success_at: string | null }>("SELECT * FROM provider_sync_state WHERE key = 'live'");
  if (!opts.force && state?.next_run_at && Date.parse(state.next_run_at) > now.getTime()) {
    return { ok: true, changedGames: 0, changedStats: 0, week: null, nextRunInSeconds: Math.ceil((Date.parse(state.next_run_at) - now.getTime()) / 1000) };
  }
  try {
    const cs = await p.currentSeason(now);
    const prevSeason = await seasonOf(app.db);
    const ref = await app.db.one<{ last_success_at: string | null }>("SELECT last_success_at FROM provider_sync_state WHERE key = 'reference'");
    const refAge = ref?.last_success_at ? now.getTime() - Date.parse(ref.last_success_at) : Infinity;
    if (refAge > 15 * 60_000 || prevSeason !== cs.season) {
      await syncReference(app);
      await upsertGames(app.db, await p.schedule(cs.season));
      await app.db.query(`INSERT INTO app_kv (key, value) VALUES ('nfl_season', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ season: cs.season })]);
      await setSyncState(app.db, 'reference', p.id, { ok: true, now, nextRunAt: new Date(now.getTime() + 15 * 60_000) });
    }
    const dbWeek = await currentNflWeek(app.db, cs.season);
    // Also refresh the previous week so late corrections are picked up. On the first sync
    // of a season (e.g. a deployment that starts mid-season) backfill every earlier week.
    const hasHistory = await app.db.one('SELECT 1 FROM player_game_stats WHERE season = $1 AND week < $2 - 1 LIMIT 1', [cs.season, dbWeek]);
    const weeks = hasHistory || dbWeek <= 2
      ? [...new Set([dbWeek, Math.max(1, dbWeek - 1)])]
      : Array.from({ length: dbWeek }, (_, i) => i + 1);
    let changedGames = 0, changedStats = 0;
    const statWeeks = new Set<number>();
    for (const w of weeks) {
      changedGames += await upsertGames(app.db, await p.weekGames(cs.season, w));
      const r = await upsertStats(app.db, await p.weekStats(cs.season, w));
      changedStats += r.changed;
      r.weeks.forEach((x) => statWeeks.add(x));
    }
    const games = await weekGames(app.db, cs.season, dbWeek);
    const liveWindow = games.some((g) => g.status === 'in_progress' || g.status === 'delayed'
      || Math.abs(Date.parse(g.kickoff_at) - now.getTime()) < 30 * 60_000);
    const next = liveWindow ? p.livePollSeconds : p.idlePollSeconds;
    await setSyncState(app.db, 'live', p.id, { ok: true, now, nextRunAt: new Date(now.getTime() + next * 1000), meta: { week: dbWeek, live: liveWindow } });
    if (changedGames || changedStats) {
      await onNflDataChanged(app, cs.season, [...new Set([...statWeeks, dbWeek])]);
    } else {
      await advanceLeagues(app, cs.season);
    }
    return { ok: true, changedGames, changedStats, week: dbWeek, nextRunInSeconds: next };
  } catch (e) {
    const err = e as ProviderError;
    const failures = (state?.consecutive_failures ?? 0) + 1;
    const wait = err.kind === 'unconfigured' ? 3600 : backoffSeconds(p.livePollSeconds, failures, err.retryAfterSeconds);
    await setSyncState(app.db, 'live', p.id, { ok: false, now, error: err.message ?? String(e), nextRunAt: new Date(now.getTime() + wait * 1000) });
    app.log(`NFL sync failed (${failures} in a row): ${err.message}`);
    return { ok: false, changedGames: 0, changedStats: 0, week: null, error: err.message, nextRunInSeconds: wait };
  }
}

export type DataHealth = 'ok' | 'stale' | 'error' | 'unconfigured' | 'never_synced';

export async function dataStatus(app: App) {
  const now = app.clock.now();
  const p = app.provider;
  const live = await app.db.one<{ last_success_at: string | null; last_error: string | null; consecutive_failures: number; next_run_at: string | null; meta: any }>("SELECT * FROM provider_sync_state WHERE key = 'live'");
  const season = await seasonOf(app.db);
  let health: DataHealth = 'ok';
  if (!p.configured) health = 'unconfigured';
  else if (!live?.last_success_at) health = live?.last_error ? 'error' : 'never_synced';
  else {
    const interval = (live.meta?.live ? p.livePollSeconds : p.idlePollSeconds) * 1000;
    const age = now.getTime() - Date.parse(live.last_success_at);
    if (live.consecutive_failures > 0) health = age > 3 * interval ? 'error' : 'stale';
    else if (age > 3 * interval + 60_000) health = 'stale';
  }
  const week = season ? await currentNflWeek(app.db, season) : null;
  return {
    provider: { id: p.id, label: p.label, isDemo: p.isDemo, configured: p.configured, snapshotAsOf: p.snapshotAsOf ?? null },
    health,
    message: p.snapshotAsOf && health === 'ok' ? `Real NFL data from nflverse, captured ${p.snapshotAsOf.slice(0, 10)}. This is a snapshot: games played after that will not get results here.` : healthMessage(health, p.label, live?.last_error ?? null),
    lastUpdatedAt: live?.last_success_at ?? null,
    lastError: live?.last_error ?? null,
    nextRunAt: live?.next_run_at ?? null,
    live: Boolean(live?.meta?.live),
    season, week,
    now: now.toISOString(),
  };
}

function healthMessage(h: DataHealth, label: string, err: string | null): string {
  switch (h) {
    case 'ok': return `Connected to ${label}.`;
    case 'stale': return `Data from ${label} may be out of date; retrying.${err ? ` Last error: ${err}` : ''}`;
    case 'error': return `Unable to reach ${label}. Scores shown are the last known values.${err ? ` (${err})` : ''}`;
    case 'unconfigured': return 'No NFL data provider is configured, so live scores and stats are unavailable. An administrator must add provider credentials.';
    case 'never_synced': return `Waiting for the first sync from ${label}.`;
  }
}

export function gameView(g: GameRow, dataAvailable = true) {
  return {
    id: g.id, week: g.week, homeTeamId: g.home_team_id, awayTeamId: g.away_team_id, kickoffAt: g.kickoff_at,
    status: g.status, display: displayStatus(g.status, dataAvailable), homeScore: g.home_score, awayScore: g.away_score,
    quarter: g.quarter, clock: g.clock, updatedAt: g.updated_at,
  };
}
