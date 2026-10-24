import { scoreStatLine, type Position, type StatLine } from '@gridiron/core';
import { z } from 'zod';
import { notFound, type Actor, type App } from '../app';
import { getLeague, getScoringRules, requirePermission } from './common';
import { byeWeeks, teamGameMap } from './nfl';
import { availability } from './rosters';
import { projectionsFor, seasonModel } from './scoring';

const searchSchema = z.object({
  leagueId: z.string().uuid(),
  q: z.string().max(60).optional(),
  position: z.enum(['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'FLEX']).optional(),
  nflTeam: z.string().max(4).optional(),
  status: z.enum(['all', 'available', 'free_agents', 'waivers', 'rostered', 'injured', 'mine']).default('all'),
  byeWeek: z.number().int().min(1).max(18).optional(),
  sort: z.enum(['rank', 'season_points', 'avg_points', 'last_points', 'projected', 'name']).default('rank'),
  dir: z.enum(['asc', 'desc']).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});

/** Player explorer: league-specific points, projections and ownership. */
export async function searchPlayers(app: App, actor: Actor, input: unknown) {
  const p = searchSchema.parse(input);
  await requirePermission(app.db, actor, p.leagueId, 'league.view');
  const league = await getLeague(app.db, p.leagueId);
  const { rules, version } = await getScoringRules(app.db, league.id);
  const model = await seasonModel(app.db, league.id, league.season, rules, version);
  const params: unknown[] = [];
  const where: string[] = ['p.active'];
  if (p.q) { params.push(`%${p.q.toLowerCase()}%`); where.push(`lower(p.full_name) LIKE $${params.length}`); }
  if (p.position === 'FLEX') where.push(`p.position IN ('RB','WR','TE')`);
  else if (p.position) { params.push(p.position); where.push(`p.position = $${params.length}`); }
  if (p.nflTeam) { params.push(p.nflTeam.toUpperCase()); where.push(`p.nfl_team_id = $${params.length}`); }
  if (p.status === 'injured') where.push(`p.injury_status <> 'healthy'`);
  const players = await app.db.query<{ id: string; full_name: string; position: Position; nfl_team_id: string | null; injury_status: string; injury_note: string | null; rank: number; jersey: number | null }>(
    `SELECT id, full_name, position, nfl_team_id, injury_status, injury_note, rank, jersey FROM nfl_players p WHERE ${where.join(' AND ')} ORDER BY rank, id LIMIT 2000`, params);
  const ids = players.map((x) => x.id);
  const avail = await availability(app, app.db, league, ids);
  const byes = await byeWeeks(app.db, league.season);
  const userTeam = actor.kind === 'user' ? await app.db.one<{ id: string }>('SELECT id FROM teams WHERE league_id = $1 AND owner_user_id = $2', [league.id, actor.userId]) : null;
  const rosterPct = await rosteredPercent(app, ids);
  let rows = players.map((pl) => {
    const hist = model.history.get(pl.id) ?? [];
    const season = hist.reduce((a, h) => a + h.points, 0);
    const a = avail.get(pl.id)!;
    return {
      id: pl.id, name: pl.full_name, position: pl.position, nflTeamId: pl.nfl_team_id, jersey: pl.jersey,
      injuryStatus: pl.injury_status, injuryNote: pl.injury_note, rank: pl.rank,
      byeWeek: pl.nfl_team_id ? (byes.get(pl.nfl_team_id) ?? [])[0] ?? null : null,
      seasonPoints: Math.round(season * 100) / 100, gamesPlayed: hist.length,
      avgPoints: hist.length ? Math.round((season / hist.length) * 100) / 100 : 0,
      lastPoints: hist.length ? hist[hist.length - 1].points : null,
      availability: a, rosteredPct: rosterPct.get(pl.id) ?? 0,
      projected: 0,
    };
  });
  if (p.byeWeek) rows = rows.filter((r) => r.byeWeek === p.byeWeek);
  if (p.status === 'available') rows = rows.filter((r) => r.availability.status !== 'rostered');
  if (p.status === 'free_agents') rows = rows.filter((r) => r.availability.status === 'free_agent');
  if (p.status === 'waivers') rows = rows.filter((r) => r.availability.status === 'waivers');
  if (p.status === 'rostered') rows = rows.filter((r) => r.availability.status === 'rostered');
  if (p.status === 'mine') rows = rows.filter((r) => r.availability.status === 'rostered' && userTeam && (r.availability as any).teamId === userTeam.id);

  // Projections are computed for the candidate set only when sorting by them, otherwise for the visible page.
  const dir = p.dir ?? (p.sort === 'rank' || p.sort === 'name' ? 'asc' : 'desc');
  const sign = dir === 'asc' ? 1 : -1;
  if (p.sort === 'projected') {
    const proj = await projectionsFor(app.db, league, league.current_week, rows.slice(0, 600).map((r) => r.id));
    rows.forEach((r) => { r.projected = proj.get(r.id)?.points ?? 0; });
  }
  const key: Record<string, (r: (typeof rows)[number]) => number | string> = {
    rank: (r) => r.rank, season_points: (r) => r.seasonPoints, avg_points: (r) => r.avgPoints, last_points: (r) => r.lastPoints ?? -999,
    projected: (r) => r.projected, name: (r) => r.name,
  };
  const k = key[p.sort];
  rows.sort((a, b) => { const x = k(a), y = k(b); return (x < y ? -1 : x > y ? 1 : a.rank - b.rank) * sign; });
  const total = rows.length;
  const page = rows.slice(p.offset, p.offset + p.limit);
  if (p.sort !== 'projected') {
    const proj = await projectionsFor(app.db, league, league.current_week, page.map((r) => r.id));
    page.forEach((r) => { r.projected = proj.get(r.id)?.points ?? 0; });
  }
  return { total, offset: p.offset, limit: p.limit, week: league.current_week, players: page };
}

async function rosteredPercent(app: App, ids: string[]): Promise<Map<string, number>> {
  const leagues = await app.db.one<{ c: number }>("SELECT count(*)::int AS c FROM leagues WHERE status IN ('in_season','playoffs','complete')");
  const n = Math.max(1, leagues?.c ?? 1);
  const rows = await app.db.query<{ player_id: string; c: number }>('SELECT player_id, count(*)::int AS c FROM roster_entries WHERE player_id = ANY($1) GROUP BY player_id', [ids]);
  return new Map(rows.map((r) => [r.player_id, Math.round((r.c / n) * 1000) / 10]));
}

export async function playerProfile(app: App, actor: Actor, input: { leagueId: string; playerId: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  const league = await getLeague(app.db, input.leagueId);
  const pl = await app.db.one('SELECT * FROM nfl_players WHERE id = $1', [input.playerId]);
  if (!pl) throw notFound('Player');
  const { rules } = await getScoringRules(app.db, league.id);
  const logs = await app.db.query<{ week: number; stats: StatLine; is_final: boolean; game_id: string; home_team_id: string; away_team_id: string; home_score: number | null; away_score: number | null; status: string; kickoff_at: string }>(
    `SELECT s.week, s.stats, s.is_final, s.game_id, g.home_team_id, g.away_team_id, g.home_score, g.away_score, g.status, g.kickoff_at
     FROM player_game_stats s JOIN nfl_games g ON g.id = s.game_id WHERE s.player_id = $1 AND s.season = $2 ORDER BY s.week`, [pl.id, league.season]);
  const gameLog = logs.map((l) => {
    const sc = scoreStatLine(l.stats, rules, pl.position);
    const home = l.home_team_id === pl.nfl_team_id;
    return {
      week: l.week, opponent: home ? l.away_team_id : l.home_team_id, isHome: home, stats: l.stats, isFinal: l.is_final,
      points: sc.total, breakdown: sc.lines, gameStatus: l.status,
      result: l.home_score !== null ? `${home ? l.home_score : l.away_score}-${home ? l.away_score : l.home_score}` : null,
    };
  });
  const totals: StatLine = {};
  for (const g of gameLog) for (const [k, v] of Object.entries(g.stats)) (totals as any)[k] = ((totals as any)[k] ?? 0) + (v as number);
  const upcoming = pl.nfl_team_id ? await app.db.query<{ week: number; home_team_id: string; away_team_id: string; kickoff_at: string; status: string }>(
    `SELECT week, home_team_id, away_team_id, kickoff_at, status FROM nfl_games WHERE season = $1 AND (home_team_id = $2 OR away_team_id = $2) AND week >= $3 ORDER BY week LIMIT 5`,
    [league.season, pl.nfl_team_id, league.current_week]) : [];
  const byes = pl.nfl_team_id ? (await byeWeeks(app.db, league.season)).get(pl.nfl_team_id) ?? [] : [];
  const proj = (await projectionsFor(app.db, league, league.current_week, [pl.id])).get(pl.id) ?? null;
  const avail = (await availability(app, app.db, league, [pl.id])).get(pl.id)!;
  let ownerTeam: { id: string; name: string } | null = null;
  if (avail.status === 'rostered') ownerTeam = await app.db.one('SELECT id, name FROM teams WHERE id = $1', [avail.teamId]);
  const games = await teamGameMap(app.db, league.season, league.current_week);
  const g = pl.nfl_team_id ? games.get(pl.nfl_team_id) : null;
  return {
    player: { id: pl.id, name: pl.full_name, position: pl.position, nflTeamId: pl.nfl_team_id, jersey: pl.jersey, injuryStatus: pl.injury_status, injuryNote: pl.injury_note, rank: pl.rank, provider: pl.provider, updatedAt: pl.updated_at },
    seasonPoints: Math.round(gameLog.reduce((a, x) => a + x.points, 0) * 100) / 100,
    totals, totalsBreakdown: scoreStatLine(totals, rules, pl.position).lines,
    gameLog, upcoming: upcoming.map((u) => ({ week: u.week, opponent: u.home_team_id === pl.nfl_team_id ? u.away_team_id : u.home_team_id, isHome: u.home_team_id === pl.nfl_team_id, kickoffAt: u.kickoff_at, status: u.status })),
    byeWeek: byes[0] ?? null, projection: proj, availability: avail, ownerTeam,
    rosteredPct: (await rosteredPercent(app, [pl.id])).get(pl.id) ?? 0,
    thisWeekGame: g ? { status: g.status, kickoffAt: g.kickoff_at } : null,
  };
}
