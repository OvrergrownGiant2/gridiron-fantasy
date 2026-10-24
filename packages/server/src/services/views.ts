import { z } from 'zod';
import { badRequest, notFound, type Actor, type App } from '../app';
import { getLeague, requirePermission, requireUser, withTx } from './common';
import { listMyLeagues } from './leagues';
import { dataStatus, gameView, seasonOf, currentNflWeek, weekGames } from './nfl';
import { rosterViolations } from './rosters';
import { leagueStandings, matchupDetail, reconcileFinalizedWeek, applyCorrection, teamWeekScore, type MatchupRow } from './scoring';
import { pendingCommissionerTrades } from './trades';
import { audit, activity } from './common';

export async function weekMatchups(app: App, actor: Actor, input: { leagueId: string; week?: number }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  const league = await getLeague(app.db, input.leagueId);
  const week = input.week ?? league.current_week;
  const ms = await app.db.query<MatchupRow>('SELECT * FROM matchups WHERE league_id = $1 AND week = $2 ORDER BY kind, bracket_slot NULLS LAST, id', [league.id, week]);
  const details = [];
  for (const m of ms) details.push(await matchupDetail(app, app.db, league, m));
  const weeks = await app.db.query<{ week: number; kind: string }>('SELECT DISTINCT week, min(kind) AS kind FROM matchups WHERE league_id = $1 GROUP BY week ORDER BY week', [league.id]);
  return { week, currentWeek: league.current_week, weeks, matchups: details };
}

export async function getMatchup(app: App, actor: Actor, input: { matchupId: string }) {
  const m = await app.db.one<MatchupRow>('SELECT * FROM matchups WHERE id = $1', [input.matchupId]);
  if (!m) throw notFound('Matchup');
  await requirePermission(app.db, actor, m.league_id, 'league.view');
  return matchupDetail(app, app.db, await getLeague(app.db, m.league_id), m);
}

export async function standings(app: App, actor: Actor, input: { leagueId: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  const league = await getLeague(app.db, input.leagueId);
  const rows = await leagueStandings(app.db, league);
  const playoffs = await app.db.query<MatchupRow>("SELECT * FROM matchups WHERE league_id = $1 AND kind IN ('playoff','championship') ORDER BY week, bracket_slot", [league.id]);
  const champion = league.status === 'complete' ? playoffs.find((p) => p.kind === 'championship')?.winner_team_id ?? rows[0]?.teamId ?? null : null;
  return { standings: rows, mode: league.settings.season.standingsMode, playoffTeams: league.settings.season.playoffTeams, playoffs, champion };
}

export async function schedule(app: App, actor: Actor, input: { leagueId: string; teamId?: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  return app.db.query(`SELECT id, week, kind, home_team_id, away_team_id, status, home_points, away_points, winner_team_id FROM matchups
    WHERE league_id = $1 AND ($2::uuid IS NULL OR home_team_id = $2 OR away_team_id = $2) ORDER BY week, kind`, [input.leagueId, input.teamId ?? null]);
}

export async function nflScoreboard(app: App, actor: Actor, input: { week?: number; leagueId?: string }) {
  const userId = requireUser(actor);
  const status = await dataStatus(app);
  const season = await seasonOf(app.db);
  if (!season) return { status, week: null, currentWeek: null, games: [], myPlayers: {} };
  const currentWeek = await currentNflWeek(app.db, season);
  const week = input.week ?? currentWeek;
  const available = status.health !== 'unconfigured' && status.health !== 'never_synced';
  // Relevant performances: the viewer's rostered players in the selected league, grouped by NFL team.
  const myPlayers: Record<string, { name: string; position: string; points: number; starter: boolean }[]> = {};
  if (input.leagueId) {
    try {
      await requirePermission(app.db, actor, input.leagueId, 'league.view');
      const league = await getLeague(app.db, input.leagueId);
      const team = await app.db.one<{ id: string }>('SELECT id FROM teams WHERE league_id = $1 AND owner_user_id = $2', [league.id, userId]);
      if (team && league.status !== 'setup' && league.status !== 'drafting' && week === league.current_week) {
        const sc = await teamWeekScore(app.db, league, team.id, week, { now: app.clock.now() });
        for (const p of [...sc.starters, ...sc.bench]) {
          if (!p.nflTeamId) continue;
          (myPlayers[p.nflTeamId] ??= []).push({ name: p.name, position: p.position, points: p.points, starter: p.slot !== 'BN' && p.slot !== 'IR' });
        }
      }
    } catch { /* not a member: omit */ }
  }
  return { status, week, currentWeek, games: (await weekGames(app.db, season, week)).map((g) => gameView(g, available)), myPlayers };
}

export async function nflStatus(app: App) {
  return dataStatus(app);
}

/** Home dashboard: one card per league plus the most urgent items. */
export async function dashboard(app: App, actor: Actor) {
  const userId = requireUser(actor);
  const leagues = await listMyLeagues(app, actor);
  const cards = [];
  for (const l of leagues as any[]) {
    let matchup = null, rank = null, record = null, nextOpponent = null;
    if (l.team_id && (l.status === 'in_season' || l.status === 'playoffs' || l.status === 'complete')) {
      const league = await getLeague(app.db, l.id);
      const m = await app.db.one<MatchupRow>('SELECT * FROM matchups WHERE league_id = $1 AND week = $2 AND (home_team_id = $3 OR away_team_id = $3) LIMIT 1', [l.id, league.current_week, l.team_id]);
      if (m) {
        const mine = m.home_team_id === l.team_id;
        const opp = mine ? m.away_team_id : m.home_team_id;
        const o = opp ? await app.db.one('SELECT id, name, abbrev, primary_color, secondary_color, logo_media_id, logo_preset FROM teams WHERE id = $1', [opp]) : null;
        matchup = { id: m.id, week: m.week, status: m.status, kind: m.kind, myPoints: Number(mine ? m.home_points : m.away_points), oppPoints: Number(mine ? m.away_points : m.home_points), opponent: o };
      }
      const next = await app.db.one<MatchupRow>("SELECT * FROM matchups WHERE league_id = $1 AND week > $2 AND (home_team_id = $3 OR away_team_id = $3) ORDER BY week LIMIT 1", [l.id, league.current_week, l.team_id]);
      if (next) {
        const opp = next.home_team_id === l.team_id ? next.away_team_id : next.home_team_id;
        nextOpponent = opp ? await app.db.one('SELECT id, name, abbrev FROM teams WHERE id = $1', [opp]) : null;
      }
      const st = await leagueStandings(app.db, league);
      const row = st.find((s) => s.teamId === l.team_id);
      if (row) { rank = row.rank; record = { wins: row.wins, losses: row.losses, ties: row.ties, pointsFor: row.pointsFor }; }
    }
    cards.push({ ...l, matchup, rank, record, nextOpponent });
  }
  const pendingVotes = (await app.db.one<{ c: number }>(`SELECT count(*)::int AS c FROM trades t JOIN league_members m ON m.league_id = t.league_id AND m.user_id = $1
    WHERE t.status = 'in_review' AND t.review_route = 'league_vote' AND NOT EXISTS (SELECT 1 FROM trade_votes v WHERE v.trade_id = t.id AND v.user_id = $1)`, [userId]))!.c;
  const commish = await app.db.query<{ league_id: string }>("SELECT league_id FROM league_members WHERE user_id = $1 AND role IN ('commissioner','co_commissioner')", [userId]);
  let reviewQueue = 0;
  for (const c of commish) reviewQueue += (await pendingCommissionerTrades(app, c.league_id)).length;
  const unread = (await app.db.one<{ c: number }>('SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]))!.c;
  return { leagues: cards, pendingVotes, reviewQueue, unread, data: await dataStatus(app) };
}

export async function commissionerDashboard(app: App, actor: Actor, input: { leagueId: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'trade.review');
  const league = await getLeague(app.db, input.leagueId);
  const trades = await app.db.query(`SELECT t.id, t.status, t.review_route, t.review_reason, t.review_ends_at, t.flags, t.analysis, t.accepted_at,
      pt.name AS proposer_name, rt.name AS recipient_name,
      (SELECT count(*)::int FROM trade_votes v WHERE v.trade_id = t.id) AS votes_cast
    FROM trades t JOIN teams pt ON pt.id = t.proposer_team_id JOIN teams rt ON rt.id = t.recipient_team_id
    WHERE t.league_id = $1 AND t.status IN ('in_review','approved') ORDER BY t.accepted_at`, [league.id]);
  const corrections = await app.db.query("SELECT * FROM score_corrections WHERE league_id = $1 ORDER BY created_at DESC LIMIT 30", [league.id]);
  const pendingClaims = (await app.db.one<{ c: number }>("SELECT count(*)::int AS c FROM waiver_claims WHERE league_id = $1 AND status = 'pending'", [league.id]))!.c;
  const failedTx = await app.db.query("SELECT id, summary, created_at FROM transactions WHERE league_id = $1 AND status = 'failed' ORDER BY created_at DESC LIMIT 20", [league.id]);
  const invalidClaims = await app.db.query(`SELECT c.id, c.result_reason, c.processed_at, t.name AS team_name, p.full_name FROM waiver_claims c JOIN teams t ON t.id = c.team_id JOIN nfl_players p ON p.id = c.add_player_id
    WHERE c.league_id = $1 AND c.status = 'invalid' AND c.processed_at > now() - interval '14 days' ORDER BY c.processed_at DESC LIMIT 20`, [league.id]);
  const recent = await app.db.query(`SELECT a.id, a.action, a.target, a.reason, a.actor_kind, a.created_at, u.display_name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
    WHERE a.league_id = $1 ORDER BY a.id DESC LIMIT 25`, [league.id]);
  const se = league.settings.season;
  const deadlines = [
    league.waiver_next_run_at ? { label: 'Next waiver run', at: league.waiver_next_run_at } : null,
    league.settings.trades.tradeDeadlineWeek ? { label: `Trade deadline (after week ${league.settings.trades.tradeDeadlineWeek})`, week: league.settings.trades.tradeDeadlineWeek } : null,
    se.playoffTeams ? { label: 'Playoffs begin', week: se.startWeek + se.regularSeasonWeeks } : null,
  ].filter(Boolean);
  return {
    trades, corrections, pendingClaims, failedTx, invalidClaims, recent, deadlines,
    rosterViolations: league.status === 'setup' ? [] : await rosterViolations(app, league),
    status: league.status, currentWeek: league.current_week,
  };
}

const recalcSchema = z.object({ leagueId: z.string().uuid(), fromWeek: z.number().int().min(1).max(18), toWeek: z.number().int().min(1).max(18), useCurrentScoring: z.boolean(), reason: z.string().trim().min(3).max(300) });

/** Transparent recalculation of finalized weeks. Requires a reason; logged and announced. */
export async function recalculateWeeks(app: App, actor: Actor, input: unknown) {
  const p = recalcSchema.parse(input);
  await requirePermission(app.db, actor, p.leagueId, 'scores.recalculate');
  const league = await getLeague(app.db, p.leagueId);
  if (p.toWeek < p.fromWeek) throw badRequest('Invalid week range.');
  if (p.toWeek >= league.current_week) throw badRequest('Only finalized weeks can be recalculated; open weeks always use current rules.');
  const userId = requireUser(actor);
  const results = [];
  for (let w = p.fromWeek; w <= p.toWeek; w++) {
    results.push({ week: w, ...(await reconcileFinalizedWeek(app, league.id, w, 'scoring_change', { actorUserId: userId, reason: p.reason, useCurrentScoring: p.useCurrentScoring })) });
  }
  return { results };
}

export async function decideCorrection(app: App, actor: Actor, input: { correctionId: string; apply: boolean; reason: string }) {
  const c = await app.db.one<{ id: string; league_id: string; matchup_id: string; week: number; status: string; new_home: number; new_away: number }>('SELECT * FROM score_corrections WHERE id = $1', [input.correctionId]);
  if (!c) throw notFound('Correction');
  await requirePermission(app.db, actor, c.league_id, 'scores.recalculate');
  if (c.status !== 'pending') throw badRequest('This correction was already decided.');
  if (!input.reason?.trim()) throw badRequest('A reason is required.');
  const userId = requireUser(actor);
  if (input.apply) {
    await reconcileFinalizedWeek(app, c.league_id, c.week, 'provider', { actorUserId: userId, reason: input.reason, useCurrentScoring: false });
  }
  await withTx(app, async (db) => {
    await db.query("UPDATE score_corrections SET status = $2, decided_by = $3, reason = $4, decided_at = now() WHERE id = $1 AND status = 'pending'", [c.id, input.apply ? 'applied' : 'dismissed', userId, input.reason]);
    if (!input.apply) await audit(db, { leagueId: c.league_id, actor, action: 'scores.dismiss_correction', target: c.id, reason: input.reason });
    if (!input.apply) await activity(app, db, c.league_id, 'stat_correction', `A week ${c.week} stat correction was reviewed and not applied. Reason: ${input.reason}`);
  });
  void applyCorrection;
  return { ok: true };
}
