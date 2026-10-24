import {
  computeStandings, playoffFirstRound, projectPlayer, round2, scoreStatLine, winProbability,
  type InjuryStatus, type Position, type Projection, type ScoreLine, type ScoringRules, type Slot, type StatLine,
} from '@gridiron/core';
import type { App } from '../app';
import type { Db } from '../db/db';
import { activity, audit, getLeague, getScoringRules, notifyTeamOwner, publishLeague, withTx, type LeagueRow } from './common';
import { currentNflWeek, teamGameMap, weekStatLines, type GameRow } from './nfl';

// ---------------------------------------------------------------------------
// Season-wide per-league fantasy history (cached by scoring + stats version)
// ---------------------------------------------------------------------------

export interface PlayerMeta { id: string; full_name: string; position: Position; nfl_team_id: string | null; injury_status: InjuryStatus; injury_note: string | null; rank: number; jersey: number | null; active: boolean }

interface SeasonModel {
  history: Map<string, { week: number; points: number }[]>;
  opponentFactor: Map<string, number>;   // `${defTeam}:${pos}` → factor
  positionalRank: Map<string, number>;
}

const modelCache = new Map<string, SeasonModel>();

async function statsStamp(db: Db, season: number): Promise<string> {
  const r = await db.one<{ m: string | null; c: number }>('SELECT max(updated_at) AS m, count(*)::int AS c FROM player_game_stats WHERE season = $1', [season]);
  return `${r?.m ?? '0'}:${r?.c ?? 0}`;
}

export async function seasonModel(db: Db, leagueId: string, season: number, rules: ScoringRules, scoringVersion: number): Promise<SeasonModel> {
  const key = `${leagueId}:${scoringVersion}:${season}:${await statsStamp(db, season)}`;
  const hit = modelCache.get(key);
  if (hit) return hit;
  const rows = await db.query<{ player_id: string; week: number; stats: StatLine; position: Position; nfl_team_id: string | null; home_team_id: string; away_team_id: string }>(
    `SELECT s.player_id, s.week, s.stats, p.position, p.nfl_team_id, g.home_team_id, g.away_team_id
     FROM player_game_stats s JOIN nfl_players p ON p.id = s.player_id JOIN nfl_games g ON g.id = s.game_id
     WHERE s.season = $1`, [season]);
  const history = new Map<string, { week: number; points: number }[]>();
  const allowed = new Map<string, { sum: number; games: Set<string> }>();
  const posTotals = new Map<string, { sum: number; games: number }>();
  for (const r of rows) {
    const pts = scoreStatLine(r.stats, rules, r.position).total;
    history.set(r.player_id, [...(history.get(r.player_id) ?? []), { week: r.week, points: pts }]);
    if (r.position === 'DST' || !r.nfl_team_id) continue;
    const opp = r.nfl_team_id === r.home_team_id ? r.away_team_id : r.home_team_id;
    const k = `${opp}:${r.position}`;
    const a = allowed.get(k) ?? { sum: 0, games: new Set<string>() };
    a.sum += pts; a.games.add(`${r.week}`);
    allowed.set(k, a);
  }
  for (const h of history.values()) h.sort((a, b) => a.week - b.week);
  for (const [k, a] of allowed) {
    const pos = k.split(':')[1];
    const t = posTotals.get(pos) ?? { sum: 0, games: 0 };
    t.sum += a.sum; t.games += a.games.size;
    posTotals.set(pos, t);
  }
  const opponentFactor = new Map<string, number>();
  for (const [k, a] of allowed) {
    const pos = k.split(':')[1];
    const t = posTotals.get(pos)!;
    const avg = t.games ? t.sum / t.games : 0;
    if (avg > 0 && a.games.size >= 2) opponentFactor.set(k, (a.sum / a.games.size) / avg);
  }
  const players = await db.query<{ id: string; position: Position; rank: number }>('SELECT id, position, rank FROM nfl_players ORDER BY rank, id');
  const counters = new Map<Position, number>();
  const positionalRank = new Map<string, number>();
  for (const p of players) { const n = (counters.get(p.position) ?? 0) + 1; counters.set(p.position, n); positionalRank.set(p.id, n); }
  const model = { history, opponentFactor, positionalRank };
  if (modelCache.size > 30) modelCache.delete(modelCache.keys().next().value!);
  modelCache.set(key, model);
  return model;
}

export async function playerMeta(db: Db, ids: string[]): Promise<Map<string, PlayerMeta>> {
  if (!ids.length) return new Map();
  const rows = await db.query<PlayerMeta>('SELECT id, full_name, position, nfl_team_id, injury_status, injury_note, rank, jersey, active FROM nfl_players WHERE id = ANY($1)', [ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

export async function projectionsFor(db: Db, league: LeagueRow, week: number, ids: string[]): Promise<Map<string, Projection>> {
  const { rules, version } = await getScoringRules(db, league.id);
  const model = await seasonModel(db, league.id, league.season, rules, version);
  const meta = await playerMeta(db, ids);
  const games = await teamGameMap(db, league.season, week);
  const out = new Map<string, Projection>();
  for (const id of ids) {
    const m = meta.get(id);
    if (!m) continue;
    const g = m.nfl_team_id ? games.get(m.nfl_team_id) : undefined;
    const opp = g ? (g.home_team_id === m.nfl_team_id ? g.away_team_id : g.home_team_id) : null;
    const hist = (model.history.get(id) ?? []).filter((h) => h.week < week).map((h) => h.points);
    out.set(id, projectPlayer({
      position: m.position, positionalRank: model.positionalRank.get(id) ?? 99, history: hist,
      onBye: !g, injuryStatus: m.injury_status,
      opponentFactor: opp ? model.opponentFactor.get(`${opp}:${m.position}`) ?? null : null,
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Team week scoring
// ---------------------------------------------------------------------------

export interface LineupPlayerScore {
  playerId: string; name: string; position: Position; nflTeamId: string | null; slot: Slot;
  points: number; breakdown: ScoreLine[]; projected: number; projection: Projection | null;
  game: { id: string; status: GameRow['status']; kickoffAt: string; opponent: string; isHome: boolean; quarter: string | null; clock: string | null; homeScore: number | null; awayScore: number | null } | null;
  statsFinal: boolean; injuryStatus: InjuryStatus; locked: boolean;
}

export interface TeamWeekScore {
  teamId: string; week: number; points: number; projected: number; remainingSd: number;
  final: boolean; starters: LineupPlayerScore[]; bench: LineupPlayerScore[];
  activePlayers: number; yetToPlay: number; completed: number;
}

function gameProgress(g: GameRow | undefined): number {
  if (!g) return 1;
  if (g.status === 'final' || g.status === 'canceled' || g.status === 'postponed') return 1;
  if (g.status !== 'in_progress') return 0;
  const q = Number((g.quarter ?? 'Q1').replace(/\D/g, '')) || 1;
  const [mm, ss] = (g.clock ?? '15:00').split(':').map(Number);
  const left = Math.max(0, Math.min(900, (mm || 0) * 60 + (ss || 0)));
  return Math.min(0.99, ((Math.min(q, 4) - 1) * 900 + (900 - left)) / 3600);
}

/**
 * Scores a team's lineup for `week`. Finalized weeks read the immutable snapshot;
 * open weeks use current roster slots (locked starters cannot move, so this is stable).
 */
export async function teamWeekScore(db: Db, league: LeagueRow, teamId: string, week: number, opts: { matchupId?: string | null; finalized?: boolean; scoringVersion?: number | null; now: Date }): Promise<TeamWeekScore> {
  const { rules } = await getScoringRules(db, league.id, opts.scoringVersion ?? undefined);
  let entries: { player_id: string; slot: Slot }[];
  if (opts.finalized && opts.matchupId) {
    entries = await db.query('SELECT player_id, slot FROM matchup_lineups WHERE matchup_id = $1 AND team_id = $2', [opts.matchupId, teamId]);
  } else {
    entries = await db.query('SELECT player_id, slot FROM roster_entries WHERE team_id = $1', [teamId]);
  }
  const ids = entries.map((e) => e.player_id);
  const [meta, stats, games, proj] = await Promise.all([
    playerMeta(db, ids), weekStatLines(db, league.season, week, ids), teamGameMap(db, league.season, week), projectionsFor(db, league, week, ids),
  ]);
  const nowMs = opts.now.getTime();
  const rows: LineupPlayerScore[] = entries.map((e) => {
    const m = meta.get(e.player_id)!;
    const st = stats.get(e.player_id);
    const g = m?.nfl_team_id ? games.get(m.nfl_team_id) : undefined;
    const sc = st ? scoreStatLine(st.stats, rules, m.position) : { total: 0, lines: [] };
    const p = proj.get(e.player_id) ?? null;
    return {
      playerId: e.player_id, name: m?.full_name ?? e.player_id, position: m?.position ?? 'WR', nflTeamId: m?.nfl_team_id ?? null, slot: e.slot,
      points: sc.total, breakdown: sc.lines, projected: p?.points ?? 0, projection: p,
      game: g ? { id: g.id, status: g.status, kickoffAt: g.kickoff_at, opponent: g.home_team_id === m.nfl_team_id ? g.away_team_id : g.home_team_id, isHome: g.home_team_id === m.nfl_team_id, quarter: g.quarter, clock: g.clock, homeScore: g.home_score, awayScore: g.away_score } : null,
      statsFinal: Boolean(st?.isFinal), injuryStatus: m?.injury_status ?? 'healthy',
      locked: Boolean(g && g.status !== 'postponed' && g.status !== 'canceled' && (Date.parse(g.kickoff_at) <= nowMs || g.status !== 'scheduled')),
    };
  });
  const order: Slot[] = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPERFLEX', 'K', 'DST', 'BN', 'IR'];
  rows.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot) || b.projected - a.projected);
  const starters = rows.filter((r) => r.slot !== 'BN' && r.slot !== 'IR');
  const bench = rows.filter((r) => r.slot === 'BN' || r.slot === 'IR');
  let points = 0, projected = 0, varSum = 0, yetToPlay = 0, active = 0, completed = 0;
  for (const s of starters) {
    points += s.points;
    const g = s.nflTeamId ? games.get(s.nflTeamId) : undefined;
    const prog = gameProgress(g);
    const remaining = s.projected * (1 - prog);
    projected += s.points + remaining;
    varSum += (remaining * 0.5) ** 2;
    if (!g || prog >= 1) completed++; else if (prog > 0) active++; else yetToPlay++;
  }
  return {
    teamId, week, points: round2(points), projected: Math.round(projected * 10) / 10, remainingSd: Math.sqrt(varSum),
    final: Boolean(opts.finalized), starters, bench, activePlayers: active, yetToPlay, completed,
  };
}

// ---------------------------------------------------------------------------
// Matchups
// ---------------------------------------------------------------------------

export interface MatchupRow {
  id: string; league_id: string; week: number; kind: 'regular' | 'playoff' | 'consolation' | 'championship';
  bracket_round: number | null; bracket_slot: number | null; home_team_id: string; away_team_id: string | null;
  home_seed: number | null; away_seed: number | null; status: 'scheduled' | 'live' | 'final';
  home_points: number; away_points: number; winner_team_id: string | null; scoring_version: number | null; finalized_at: string | null;
}

export async function matchupDetail(app: App, db: Db, league: LeagueRow, m: MatchupRow) {
  const finalized = m.status === 'final';
  const now = app.clock.now();
  const home = await teamWeekScore(db, league, m.home_team_id, m.week, { matchupId: m.id, finalized, scoringVersion: m.scoring_version, now });
  const away = m.away_team_id ? await teamWeekScore(db, league, m.away_team_id, m.week, { matchupId: m.id, finalized, scoringVersion: m.scoring_version, now }) : null;
  const wp = away && !finalized ? winProbability(home.projected, away.projected, home.remainingSd, away.remainingSd) : null;
  return {
    id: m.id, week: m.week, kind: m.kind, status: m.status, bracketRound: m.bracket_round,
    homeSeed: m.home_seed, awaySeed: m.away_seed, winnerTeamId: m.winner_team_id, finalizedAt: m.finalized_at,
    scoringVersion: m.scoring_version,
    home, away,
    winProbabilityHome: wp === null ? null : Math.round(wp * 1000) / 1000,
  };
}

/** Recompute live totals for a league's open week and push them to clients. */
export async function recomputeLeagueWeek(app: App, leagueId: string, week: number): Promise<void> {
  const league = await getLeague(app.db, leagueId);
  const ms = await app.db.query<MatchupRow>("SELECT * FROM matchups WHERE league_id = $1 AND week = $2 AND status <> 'final'", [leagueId, week]);
  if (!ms.length) return;
  const now = app.clock.now();
  const games = await teamGameMap(app.db, league.season, week);
  const anyStarted = [...games.values()].some((g) => g.status !== 'scheduled');
  for (const m of ms) {
    const h = await teamWeekScore(app.db, league, m.home_team_id, week, { now });
    const a = m.away_team_id ? await teamWeekScore(app.db, league, m.away_team_id, week, { now }) : null;
    await app.db.query('UPDATE matchups SET home_points = $2, away_points = $3, status = $4, updated_at = now() WHERE id = $1 AND status <> \'final\'',
      [m.id, h.points, a?.points ?? 0, anyStarted ? 'live' : 'scheduled']);
  }
  app.bus.publish(`league:${leagueId}`, { type: 'scores', leagueId, payload: { week } });
}

/** All of a week's NFL games are done (final, canceled or postponed) and settled for 30 minutes. */
async function weekComplete(db: Db, season: number, week: number, now: Date, settleMinutes: number): Promise<boolean> {
  const r = await db.one<{ open: number; total: number; last: string | null }>(
    `SELECT count(*) FILTER (WHERE status NOT IN ('final','canceled','postponed'))::int AS open, count(*)::int AS total,
            max(updated_at) AS last FROM nfl_games WHERE season = $1 AND week = $2`, [season, week]);
  if (!r || r.total === 0) return false;
  if (r.open > 0) return false;
  if (settleMinutes <= 0) return true;
  return !r.last || now.getTime() - Date.parse(r.last) >= settleMinutes * 60_000;
}

export async function onNflDataChanged(app: App, season: number, weeks: number[]): Promise<void> {
  const leagues = await app.db.query<{ id: string; current_week: number }>("SELECT id, current_week FROM leagues WHERE season = $1 AND status IN ('in_season','playoffs')", [season]);
  for (const l of leagues) {
    for (const w of weeks) {
      if (w === l.current_week) await recomputeLeagueWeek(app, l.id, w);
      else if (w < l.current_week) await reconcileFinalizedWeek(app, l.id, w, 'provider', null);
    }
  }
  await advanceLeagues(app, season);
}

export function settleMinutes(app: App): number {
  return app.provider.isDemo || app.provider.snapshotAsOf ? 0 : 60;
}

/** Finalize every league week whose NFL games are complete. */
export async function advanceLeagues(app: App, season: number): Promise<void> {
  const leagues = await app.db.query<{ id: string }>("SELECT id FROM leagues WHERE season = $1 AND status IN ('in_season','playoffs')", [season]);
  const now = app.clock.now();
  for (const { id } of leagues) {
    for (let guard = 0; guard < 20; guard++) {
      const league = await getLeague(app.db, id);
      if (league.status !== 'in_season' && league.status !== 'playoffs') break;
      const hasMatchups = await app.db.one("SELECT 1 FROM matchups WHERE league_id = $1 AND week = $2 AND status <> 'final' LIMIT 1", [id, league.current_week]);
      if (!hasMatchups) break;
      if (!(await weekComplete(app.db, season, league.current_week, now, settleMinutes(app)))) break;
      await finalizeWeek(app, id, league.current_week);
    }
  }
}

export async function finalizeWeek(app: App, leagueId: string, week: number): Promise<void> {
  const results: { teamId: string; won: boolean | null; pts: number; opp: number }[] = [];
  await withTx(app, async (db) => {
    const league = await getLeague(db, leagueId, true);
    if (league.current_week !== week) return; // already finalized by a concurrent run
    const { version } = await getScoringRules(db, leagueId);
    const ms = await db.query<MatchupRow>("SELECT * FROM matchups WHERE league_id = $1 AND week = $2 AND status <> 'final' FOR UPDATE", [leagueId, week]);
    const now = app.clock.now();
    for (const m of ms) {
      const h = await teamWeekScore(db, league, m.home_team_id, week, { now });
      const a = m.away_team_id ? await teamWeekScore(db, league, m.away_team_id, week, { now }) : null;
      for (const side of [h, a]) {
        if (!side) continue;
        for (const p of side.starters) {
          await db.query('INSERT INTO matchup_lineups (matchup_id, team_id, player_id, slot, points, breakdown) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
            [m.id, side.teamId, p.playerId, p.slot, p.points, JSON.stringify(p.breakdown)]);
        }
        for (const p of side.bench) {
          await db.query('INSERT INTO matchup_lineups (matchup_id, team_id, player_id, slot, points, breakdown) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
            [m.id, side.teamId, p.playerId, p.slot, p.points, JSON.stringify(p.breakdown)]);
        }
      }
      const hp = h.points, ap = a?.points ?? 0;
      const winner = !a ? (m.kind === 'regular' ? null : m.home_team_id) : hp > ap ? m.home_team_id : ap > hp ? m.away_team_id : (m.kind === 'regular' ? null : (m.home_seed ?? 99) <= (m.away_seed ?? 99) ? m.home_team_id : m.away_team_id);
      await db.query("UPDATE matchups SET status = 'final', home_points = $2, away_points = $3, winner_team_id = $4, scoring_version = $5, finalized_at = now(), updated_at = now() WHERE id = $1",
        [m.id, hp, ap, winner, version]);
      results.push({ teamId: m.home_team_id, won: a ? (winner === m.home_team_id ? true : winner === null ? null : false) : null, pts: hp, opp: ap });
      if (a) results.push({ teamId: a.teamId, won: winner === a.teamId ? true : winner === null ? null : false, pts: ap, opp: hp });
    }
    await db.query('UPDATE leagues SET current_week = $2, updated_at = now() WHERE id = $1', [leagueId, week + 1]);
    await activity(app, db, leagueId, 'week_final', `Week ${week} is final.`, { week });
    await audit(db, { leagueId, actor: { kind: 'system' }, action: 'week.finalize', target: `week:${week}`, payload: { scoringVersion: version, matchups: ms.length } });
    await afterWeekFinalized(app, db, await getLeague(db, leagueId), week);
    for (const r of results) {
      const verdict = r.won === true ? 'Win' : r.won === false ? 'Loss' : 'Final';
      await notifyTeamOwner(app, db, r.teamId, { leagueId, kind: 'matchup_result', title: `Week ${week}: ${verdict} ${r.pts.toFixed(2)}–${r.opp.toFixed(2)}`, link: `/league/${leagueId}/matchups?week=${week}` });
    }
    publishLeague(app, db, leagueId, 'scores', { week, final: true });
  });
}

/** Playoff seeding / bracket advancement / season completion. */
async function afterWeekFinalized(app: App, db: Db, league: LeagueRow, week: number) {
  const se = league.settings.season;
  const regEnd = se.startWeek + se.regularSeasonWeeks - 1;
  const teams = await db.query<{ id: string }>('SELECT id FROM teams WHERE league_id = $1 ORDER BY id', [league.id]);
  if (week === regEnd) {
    if (se.playoffTeams < 2) {
      await db.query("UPDATE leagues SET status = 'complete' WHERE id = $1", [league.id]);
      await activity(app, db, league.id, 'season_complete', 'The regular season is complete.');
      return;
    }
    const standings = await leagueStandings(db, league);
    const seeds = standings.slice(0, se.playoffTeams).map((s) => s.teamId);
    const { pairs } = playoffFirstRound(se.playoffTeams);
    const rounds = Math.ceil(Math.log2(se.playoffTeams));
    let slot = 0;
    for (const [a, b] of pairs) {
      await db.query(`INSERT INTO matchups (league_id, week, kind, bracket_round, bracket_slot, home_team_id, away_team_id, home_seed, away_seed)
        VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8)`, [league.id, week + 1, rounds === 1 ? 'championship' : 'playoff', slot++, seeds[a - 1], b ? seeds[b - 1] : null, a, b]);
    }
    if (se.consolationBracket) await createConsolation(db, league.id, week + 1, standings.slice(se.playoffTeams).map((s) => s.teamId));
    await db.query("UPDATE leagues SET status = 'playoffs' WHERE id = $1", [league.id]);
    await activity(app, db, league.id, 'playoffs', `Playoffs begin in week ${week + 1}: ${seeds.length} teams qualified.`);
    return;
  }
  if (week > regEnd) {
    const prev = await db.query<MatchupRow>("SELECT * FROM matchups WHERE league_id = $1 AND week = $2 AND kind IN ('playoff','championship') ORDER BY bracket_slot", [league.id, week]);
    if (prev.some((m) => m.kind === 'championship')) {
      const champ = prev.find((m) => m.kind === 'championship')!;
      await db.query("UPDATE leagues SET status = 'complete' WHERE id = $1", [league.id]);
      const t = await db.one<{ name: string }>('SELECT name FROM teams WHERE id = $1', [champ.winner_team_id]);
      await activity(app, db, league.id, 'champion', `${t?.name ?? 'A team'} won the championship!`, { teamId: champ.winner_team_id });
      return;
    }
    const winners = prev.map((m) => ({ teamId: m.winner_team_id!, seed: m.winner_team_id === m.home_team_id ? m.home_seed : m.away_seed }));
    const round = (prev[0]?.bracket_round ?? 1) + 1;
    const isFinal = winners.length === 2;
    for (let i = 0; i + 1 < winners.length; i += 2) {
      const [x, y] = (winners[i].seed ?? 99) <= (winners[i + 1].seed ?? 99) ? [winners[i], winners[i + 1]] : [winners[i + 1], winners[i]];
      await db.query(`INSERT INTO matchups (league_id, week, kind, bracket_round, bracket_slot, home_team_id, away_team_id, home_seed, away_seed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [league.id, week + 1, isFinal ? 'championship' : 'playoff', round, i / 2, x.teamId, y.teamId, x.seed, y.seed]);
    }
    if (league.settings.season.consolationBracket) {
      const inPlayoffs = new Set(winners.map((w) => w.teamId));
      const rest = teams.map((t) => t.id).filter((id) => !inPlayoffs.has(id));
      await createConsolation(db, league.id, week + 1, rest);
    }
  }
}

async function createConsolation(db: Db, leagueId: string, week: number, teamIds: string[]) {
  for (let i = 0; i + 1 < teamIds.length; i += 2) {
    await db.query("INSERT INTO matchups (league_id, week, kind, home_team_id, away_team_id) VALUES ($1,$2,'consolation',$3,$4)", [leagueId, week, teamIds[i], teamIds[i + 1]]);
  }
}

export async function leagueStandings(db: Db, league: LeagueRow) {
  const teams = await db.query<{ id: string }>('SELECT id FROM teams WHERE league_id = $1', [league.id]);
  const ms = await db.query<MatchupRow>("SELECT * FROM matchups WHERE league_id = $1 AND status = 'final' AND kind = 'regular'", [league.id]);
  const weeksCompleted = new Set(ms.map((m) => m.week)).size;
  return computeStandings({
    teamIds: teams.map((t) => t.id),
    matchups: ms.map((m) => ({ week: m.week, homeTeamId: m.home_team_id, awayTeamId: m.away_team_id, homePoints: Number(m.home_points), awayPoints: Number(m.away_points), kind: m.kind })),
    settings: league.settings.season, weeksCompleted, leagueSeed: league.id,
  });
}

// ---------------------------------------------------------------------------
// Corrections and commissioner recalculation
// ---------------------------------------------------------------------------

/**
 * Re-scores the snapshot lineups of a finalized week. For provider corrections the
 * league's policy decides whether the change applies automatically or waits for a
 * commissioner. Scoring-rule changes never touch finalized weeks unless a
 * commissioner explicitly requests a recalculation (with a reason).
 */
export async function reconcileFinalizedWeek(app: App, leagueId: string, week: number, source: 'provider' | 'scoring_change', request: { actorUserId: string; reason: string; useCurrentScoring: boolean } | null) {
  return withTx(app, async (db) => {
    const league = await getLeague(db, leagueId);
    const ms = await db.query<MatchupRow>("SELECT * FROM matchups WHERE league_id = $1 AND week = $2 AND status = 'final' FOR UPDATE", [leagueId, week]);
    const current = await getScoringRules(db, leagueId);
    const changes: { matchupId: string; oldHome: number; oldAway: number; newHome: number; newAway: number }[] = [];
    const auto = request !== null || (source === 'provider' && league.settings.season.statCorrections === 'auto');
    for (const m of ms) {
      const version = request?.useCurrentScoring ? current.version : m.scoring_version ?? current.version;
      const { rules } = await getScoringRules(db, leagueId, version);
      const lineups = await db.query<{ team_id: string; player_id: string; slot: string }>('SELECT team_id, player_id, slot FROM matchup_lineups WHERE matchup_id = $1', [m.id]);
      const ids = lineups.map((l) => l.player_id);
      const [stats, meta] = await Promise.all([weekStatLines(db, league.season, week, ids), playerMeta(db, ids)]);
      const totals = new Map<string, number>();
      for (const l of lineups) {
        const pos = meta.get(l.player_id)!.position;
        const s = stats.get(l.player_id);
        const sc = s ? scoreStatLine(s.stats, rules, pos) : { total: 0, lines: [] };
        if (auto) await db.query('UPDATE matchup_lineups SET points = $4, breakdown = $5 WHERE matchup_id = $1 AND team_id = $2 AND player_id = $3', [m.id, l.team_id, l.player_id, sc.total, JSON.stringify(sc.lines)]);
        if (l.slot !== 'BN' && l.slot !== 'IR') totals.set(l.team_id, round2((totals.get(l.team_id) ?? 0) + sc.total));
      }
      const nh = totals.get(m.home_team_id) ?? 0, na = m.away_team_id ? totals.get(m.away_team_id) ?? 0 : 0;
      if (nh !== Number(m.home_points) || na !== Number(m.away_points)) changes.push({ matchupId: m.id, oldHome: Number(m.home_points), oldAway: Number(m.away_points), newHome: nh, newAway: na });
      if (request && (version !== m.scoring_version)) await db.query('UPDATE matchups SET scoring_version = $2 WHERE id = $1', [m.id, version]);
    }
    if (!changes.length) return { changes: [] as typeof changes, applied: false };
    for (const c of changes) {
      const dup = await db.one("SELECT id FROM score_corrections WHERE matchup_id = $1 AND status = 'pending' AND new_home = $2 AND new_away = $3", [c.matchupId, c.newHome, c.newAway]);
      if (dup && !auto) continue;
      await db.query(`INSERT INTO score_corrections (league_id, matchup_id, week, source, old_home, old_away, new_home, new_away, status, decided_by, reason, decided_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $9 = 'applied' THEN now() END)`,
        [leagueId, c.matchupId, week, source, c.oldHome, c.oldAway, c.newHome, c.newAway, auto ? 'applied' : 'pending', request?.actorUserId ?? null, request?.reason ?? (auto ? 'Automatic provider stat correction (league policy)' : null)]);
      if (auto) await applyCorrection(db, c.matchupId, c.newHome, c.newAway);
    }
    if (auto) {
      await activity(app, db, leagueId, 'stat_correction', `Week ${week} scores were updated (${source === 'provider' ? 'official stat correction' : 'commissioner recalculation'}).`, { week, changes });
      if (request) await audit(db, { leagueId, actor: { kind: 'user', userId: request.actorUserId }, action: 'scores.recalculate', target: `week:${week}`, reason: request.reason, payload: { changes, useCurrentScoring: request.useCurrentScoring } });
      publishLeague(app, db, leagueId, 'scores', { week });
    }
    return { changes, applied: auto };
  });
}

export async function applyCorrection(db: Db, matchupId: string, home: number, away: number) {
  const m = await db.one<MatchupRow>('SELECT * FROM matchups WHERE id = $1', [matchupId]);
  if (!m) return;
  const winner = !m.away_team_id ? (m.kind === 'regular' ? null : m.home_team_id) : home > away ? m.home_team_id : away > home ? m.away_team_id : (m.kind === 'regular' ? null : m.winner_team_id);
  await db.query('UPDATE matchups SET home_points = $2, away_points = $3, winner_team_id = $4, updated_at = now() WHERE id = $1', [matchupId, home, away, winner]);
}

export { currentNflWeek };
