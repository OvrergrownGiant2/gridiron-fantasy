import {
  activeRosterSize, aiDraftPick, chooseAutoPick, maxAuctionBid, pickLabel, seededRandom, shuffle, slotAccepts, teamIndexForPick, validateBid,
  type AiDifficulty, type DraftablePlayer, type Position, type RosterConfig, type Slot, type StarterSlot,
} from '@gridiron/core';
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound, type Actor, type App } from '../app';
import { isUniqueViolation, type Db } from '../db/db';
import { activity, audit, getLeague, notifyTeamOwner, publishLeague, requirePermission, roleIn, withTx, type LeagueRow } from './common';
import { startSeason } from './leagues';
import { can } from '@gridiron/core';

interface DraftRow {
  id: string; league_id: string; type: 'snake' | 'linear' | 'auction' | 'manual'; is_mock: boolean; mock_user_id: string | null;
  status: 'scheduled' | 'in_progress' | 'paused' | 'complete'; team_order: string[]; rounds: number; pick_seconds: number;
  current_pick: number; pick_deadline: string | null; paused_remaining_ms: number | null; auction_budget: number | null;
  auction_state: AuctionState | null; scheduled_at: string | null; started_at: string | null; completed_at: string | null;
}
interface AuctionState { phase: 'nominating' | 'bidding'; nominatorIndex: number; playerId: string | null; highBid: number; highTeamId: string | null; endsAt: string | null; bids: { teamId: string; amount: number; at: string }[] }

const AI_THINK_MS = 1500;

async function lockDraft(db: Db, draftId: string): Promise<DraftRow> {
  const d = await db.one<DraftRow>('SELECT * FROM drafts WHERE id = $1 FOR UPDATE', [draftId]);
  if (!d) throw notFound('Draft');
  return d;
}

function totalPicks(d: DraftRow) { return d.team_order.length * d.rounds; }
function teamOnClock(d: DraftRow): string | null {
  if (d.type === 'auction') return null;
  if (d.current_pick > totalPicks(d)) return null;
  return d.team_order[teamIndexForPick(d.type === 'manual' ? 'snake' : d.type, d.team_order.length, d.current_pick)];
}

const STARTER_ORDER: StarterSlot[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'FLEX', 'SUPERFLEX'];
/** First open starting slot that accepts the position, otherwise the bench. */
export function firstOpenSlot(cfg: RosterConfig, pos: Position, current: Slot[]): Slot {
  for (const s of STARTER_ORDER) {
    if (cfg[s] > 0 && slotAccepts(s, pos, cfg) && current.filter((x) => x === s).length < cfg[s]) return s;
  }
  return 'BN';
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const configureSchema = z.object({
  leagueId: z.string().uuid(),
  type: z.enum(['snake', 'linear', 'auction', 'manual']).optional(),
  pickSeconds: z.number().int().min(10).max(86400).optional(),
  order: z.array(z.string().uuid()).optional(),       // manual order; omitted → random
  scheduledAt: z.string().datetime().nullable().optional(),
});

export async function configureDraft(app: App, actor: Actor, input: unknown) {
  const p = configureSchema.parse(input);
  await requirePermission(app.db, actor, p.leagueId, 'draft.control');
  return withTx(app, async (db) => {
    const league = await getLeague(db, p.leagueId, true);
    if (league.status !== 'setup') throw badRequest('The draft can only be configured before it starts.');
    const teams = (await db.query<{ id: string }>('SELECT id FROM teams WHERE league_id = $1 ORDER BY waiver_priority, id', [league.id])).map((t) => t.id);
    if (teams.length < 1) throw badRequest('The league has no teams yet.');
    let order = teams;
    if (p.order) {
      if (p.order.length !== teams.length || new Set(p.order).size !== teams.length || p.order.some((id) => !teams.includes(id))) throw badRequest('Draft order must list every team exactly once.');
      order = p.order;
    } else {
      order = shuffle(teams, seededRandom(`${league.id}:${app.platform.randomToken(8)}`));
    }
    const type = p.type ?? league.settings.draft.type;
    const pickSeconds = p.pickSeconds ?? league.settings.draft.pickSeconds;
    const rounds = activeRosterSize(league.settings.roster);
    await db.query('DELETE FROM drafts WHERE league_id = $1 AND NOT is_mock', [league.id]);
    const d = await db.one<{ id: string }>(`INSERT INTO drafts (league_id, type, status, team_order, rounds, pick_seconds, auction_budget, scheduled_at)
      VALUES ($1,$2,'scheduled',$3,$4,$5,$6,$7) RETURNING id`, [league.id, type, JSON.stringify(order), rounds, pickSeconds, type === 'auction' ? league.settings.draft.auctionBudget : null, p.scheduledAt ?? null]);
    for (let i = 0; i < order.length; i++) await db.query('UPDATE teams SET draft_slot = $2 WHERE id = $1', [order[i], i + 1]);
    await audit(db, { leagueId: league.id, actor, action: 'draft.configure', payload: { type, pickSeconds, order, rounds } });
    publishLeague(app, db, league.id, 'draft', {});
    return { draftId: d!.id, order };
  });
}

export async function startDraft(app: App, actor: Actor, input: { leagueId: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'draft.control');
  return withTx(app, async (db) => {
    const league = await getLeague(db, input.leagueId, true);
    let d = await db.one<DraftRow>('SELECT * FROM drafts WHERE league_id = $1 AND NOT is_mock FOR UPDATE', [league.id]);
    if (!d) {
      await configureDraft(app, actor, { leagueId: league.id });
      d = await db.one<DraftRow>('SELECT * FROM drafts WHERE league_id = $1 AND NOT is_mock FOR UPDATE', [league.id]);
    }
    if (!d || d.status !== 'scheduled') throw badRequest('The draft has already started.');
    const teams = (await db.one<{ c: number }>('SELECT count(*)::int AS c FROM teams WHERE league_id = $1', [league.id]))!.c;
    if (teams !== d.team_order.length) throw badRequest('Teams changed since the draft was configured. Re-configure the draft order.');
    const now = app.clock.now();
    const firstTeam = teamOnClock({ ...d, status: 'in_progress' as const });
    const firstIsAi = d.type !== 'auction' && firstTeam ? (await db.one<{ is_ai: boolean }>('SELECT is_ai FROM teams WHERE id = $1', [firstTeam]))?.is_ai : false;
    await db.query("UPDATE drafts SET status = 'in_progress', started_at = $2, pick_deadline = $3, auction_state = $4 WHERE id = $1",
      [d.id, now.toISOString(), new Date(now.getTime() + (firstIsAi ? AI_THINK_MS : d.pick_seconds * 1000)).toISOString(),
        d.type === 'auction' ? JSON.stringify({ phase: 'nominating', nominatorIndex: 0, playerId: null, highBid: 0, highTeamId: null, endsAt: null, bids: [] }) : null]);
    if (d.type === 'auction') for (const t of d.team_order) await db.query('INSERT INTO auction_budgets (draft_id, team_id, remaining) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [d.id, t, d.auction_budget]);
    await db.query("UPDATE leagues SET status = 'drafting' WHERE id = $1", [league.id]);
    await activity(app, db, league.id, 'draft_started', 'The draft has started!');
    const first = { ...d, status: 'in_progress' as const };
    const onClock = teamOnClock(first);
    if (onClock) await notifyTeamOwner(app, db, onClock, { leagueId: league.id, kind: 'draft_turn', title: "You're on the clock!", link: `/league/${league.id}/draft` });
    publishLeague(app, db, league.id, 'draft', {});
    return { ok: true };
  });
}

export async function createMockDraft(app: App, actor: Actor, input: { leagueId: string; type?: 'snake' | 'linear'; pickSeconds?: number }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  if (actor.kind !== 'user') throw forbidden();
  return withTx(app, async (db) => {
    const league = await getLeague(db, input.leagueId);
    const teams = (await db.query<{ id: string; owner_user_id: string | null }>('SELECT id, owner_user_id FROM teams WHERE league_id = $1 ORDER BY id', [league.id]));
    const mine = teams.find((t) => t.owner_user_id === actor.userId);
    if (!mine) throw badRequest('You need a team in this league to run a mock draft.');
    await db.query('DELETE FROM drafts WHERE league_id = $1 AND is_mock AND mock_user_id = $2', [league.id, actor.userId]);
    const order = shuffle(teams.map((t) => t.id), seededRandom(app.platform.randomToken(8)));
    const now = app.clock.now();
    const d = await db.one<{ id: string }>(`INSERT INTO drafts (league_id, type, is_mock, mock_user_id, status, team_order, rounds, pick_seconds, started_at, pick_deadline)
      VALUES ($1,$2,true,$3,'in_progress',$4,$5,$6,$7,$8) RETURNING id`,
      [league.id, input.type ?? 'snake', actor.userId, JSON.stringify(order), activeRosterSize(league.settings.roster), input.pickSeconds ?? 60, now.toISOString(), new Date(now.getTime() + AI_THINK_MS).toISOString()]);
    return { draftId: d!.id };
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export async function getDraft(app: App, actor: Actor, input: { leagueId: string; draftId?: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  const d = input.draftId
    ? await app.db.one<DraftRow>('SELECT * FROM drafts WHERE id = $1 AND league_id = $2', [input.draftId, input.leagueId])
    : await app.db.one<DraftRow>('SELECT * FROM drafts WHERE league_id = $1 AND NOT is_mock', [input.leagueId]);
  if (!d) return { draft: null };
  if (d.is_mock && actor.kind === 'user' && d.mock_user_id !== actor.userId) throw notFound('Draft');
  const league = await getLeague(app.db, input.leagueId);
  const picks = await app.db.query(`SELECT dp.overall, dp.round, dp.pick_in_round, dp.team_id, dp.player_id, dp.price, dp.is_auto, dp.created_at,
      p.full_name, p.position, p.nfl_team_id FROM draft_picks dp JOIN nfl_players p ON p.id = dp.player_id WHERE dp.draft_id = $1 ORDER BY dp.overall`, [d.id]);
  const userTeam = actor.kind === 'user' ? await app.db.one<{ id: string }>('SELECT id FROM teams WHERE league_id = $1 AND owner_user_id = $2', [input.leagueId, actor.userId]) : null;
  const queue = userTeam ? await app.db.query(`SELECT q.player_id, q.position AS rank, p.full_name, p.position, p.nfl_team_id FROM draft_queue q JOIN nfl_players p ON p.id = q.player_id
      WHERE q.draft_id = $1 AND q.team_id = $2 AND NOT EXISTS (SELECT 1 FROM draft_picks dp WHERE dp.draft_id = q.draft_id AND dp.player_id = q.player_id) ORDER BY q.position`, [d.id, userTeam.id]) : [];
  const budgets = d.type === 'auction' ? await app.db.query('SELECT team_id, remaining FROM auction_budgets WHERE draft_id = $1', [d.id]) : [];
  let auctionPlayer = null;
  if (d.auction_state?.playerId) auctionPlayer = await app.db.one('SELECT id, full_name, position, nfl_team_id FROM nfl_players WHERE id = $1', [d.auction_state.playerId]);
  return {
    draft: {
      id: d.id, type: d.type, isMock: d.is_mock, status: d.status, order: d.team_order, rounds: d.rounds, pickSeconds: d.pick_seconds,
      currentPick: d.current_pick, totalPicks: totalPicks(d), onClockTeamId: d.status === 'in_progress' ? teamOnClock(d) : null,
      pickDeadline: d.pick_deadline, pausedRemainingMs: d.paused_remaining_ms, scheduledAt: d.scheduled_at, startedAt: d.started_at, completedAt: d.completed_at,
      auction: d.auction_state ? { ...d.auction_state, player: auctionPlayer, nominatorTeamId: d.team_order[d.auction_state.nominatorIndex] } : null,
      budget: d.auction_budget,
      label: d.current_pick <= totalPicks(d) ? pickLabel(d.team_order.length, d.current_pick) : null,
    },
    picks, queue, budgets, myTeamId: userTeam?.id ?? null, rosterConfig: league.settings.roster,
    serverNow: app.clock.now().toISOString(),
  };
}

export async function draftAvailable(app: App, actor: Actor, input: { leagueId: string; draftId: string; q?: string; position?: string; nflTeam?: string; limit?: number; sort?: 'rank' | 'ovr' }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  const d = await app.db.one<DraftRow>('SELECT * FROM drafts WHERE id = $1 AND league_id = $2', [input.draftId, input.leagueId]);
  if (!d) throw notFound('Draft');
  const params: unknown[] = [d.id, input.leagueId];
  const where = ['p.active', 'NOT EXISTS (SELECT 1 FROM draft_picks dp WHERE dp.draft_id = $1 AND dp.player_id = p.id)'];
  if (!d.is_mock) where.push('NOT EXISTS (SELECT 1 FROM roster_entries r WHERE r.league_id = $2 AND r.player_id = p.id)');
  else where.push('$2::uuid IS NOT NULL');
  if (input.q) { params.push(`%${input.q.toLowerCase()}%`); where.push(`lower(p.full_name) LIKE $${params.length}`); }
  if (input.position) { params.push(input.position); where.push(`p.position = $${params.length}`); }
  if (input.nflTeam) { params.push(input.nflTeam); where.push(`p.nfl_team_id = $${params.length}`); }
  params.push(Math.min(300, input.limit ?? 150));
  return app.db.query(`SELECT p.id, p.full_name, p.position, p.nfl_team_id, p.rank, p.injury_status, p.jersey, p.profile FROM nfl_players p WHERE ${where.join(' AND ')} ORDER BY ${input.sort === 'ovr' ? "(p.profile->'card'->>'ovr')::int DESC NULLS LAST, " : ''}p.rank, p.id LIMIT $${params.length}`, params);
}

export async function setQueue(app: App, actor: Actor, input: { leagueId: string; draftId: string; playerIds: string[] }) {
  if (actor.kind !== 'user') throw forbidden();
  await requirePermission(app.db, actor, input.leagueId, 'draft.pick_own');
  const team = await app.db.one<{ id: string }>('SELECT id FROM teams WHERE league_id = $1 AND owner_user_id = $2', [input.leagueId, actor.userId]);
  if (!team) throw badRequest('You have no team in this league.');
  const ids = [...new Set(input.playerIds)].slice(0, 100);
  return withTx(app, async (db) => {
    await db.query('DELETE FROM draft_queue WHERE draft_id = $1 AND team_id = $2', [input.draftId, team.id]);
    for (let i = 0; i < ids.length; i++) await db.query('INSERT INTO draft_queue (draft_id, team_id, player_id, position) VALUES ($1,$2,$3,$4)', [input.draftId, team.id, ids[i], i + 1]);
    return { count: ids.length };
  });
}

// ---------------------------------------------------------------------------
// Picks
// ---------------------------------------------------------------------------

async function teamDraftedPositions(db: Db, draftId: string, teamId: string): Promise<Position[]> {
  return (await db.query<{ position: Position }>('SELECT p.position FROM draft_picks dp JOIN nfl_players p ON p.id = dp.player_id WHERE dp.draft_id = $1 AND dp.team_id = $2', [draftId, teamId])).map((r) => r.position);
}

/** Records one pick. Caller must hold the draft row lock. */
async function recordPick(app: App, db: Db, league: LeagueRow, d: DraftRow, teamId: string, playerId: string, opts: { auto: boolean; madeBy: string | null; price?: number }) {
  const player = await db.one<{ id: string; full_name: string; position: Position; active: boolean }>('SELECT id, full_name, position, active FROM nfl_players WHERE id = $1', [playerId]);
  if (!player || !player.active) throw badRequest('Player is not available.');
  const have = await teamDraftedPositions(db, d.id, teamId);
  if (have.length >= d.rounds) throw badRequest('This team has a full roster.');
  const limit = league.settings.roster.positionLimits[player.position];
  if (limit && have.filter((p) => p === player.position).length >= limit) throw badRequest(`League limit of ${limit} ${player.position} reached.`);
  const overall = d.type === 'auction' ? (await db.one<{ c: number }>('SELECT count(*)::int AS c FROM draft_picks WHERE draft_id = $1', [d.id]))!.c + 1 : d.current_pick;
  const { round, pickInRound } = pickLabel(d.team_order.length, overall);
  try {
    await db.query(`INSERT INTO draft_picks (draft_id, league_id, overall, round, pick_in_round, team_id, player_id, price, is_auto, made_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [d.id, league.id, overall, round, pickInRound, teamId, playerId, opts.price ?? null, opts.auto, opts.madeBy]);
    if (!d.is_mock) {
      const slots = (await db.query<{ slot: Slot }>('SELECT slot FROM roster_entries WHERE team_id = $1', [teamId])).map((r) => r.slot);
      await db.query('INSERT INTO roster_entries (league_id, team_id, player_id, slot, acquired_via) VALUES ($1,$2,$3,$4,\'draft\')', [league.id, teamId, playerId, firstOpenSlot(league.settings.roster, player.position, slots)]);
    }
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict(`${player.full_name} has already been drafted.`);
    throw e;
  }
  if (!d.is_mock) {
    const team = await db.one<{ name: string }>('SELECT name FROM teams WHERE id = $1', [teamId]);
    await activity(app, db, league.id, 'draft_pick', `${team?.name} drafted ${player.full_name} (${player.position}) — round ${round}, pick ${pickInRound}${opts.price ? ` for $${opts.price}` : ''}${opts.auto ? ' (auto)' : ''}.`, { overall });
  }
  return { overall, player };
}

async function advance(app: App, db: Db, league: LeagueRow, d: DraftRow) {
  const next = d.current_pick + 1;
  const now = app.clock.now();
  if (next > totalPicks(d)) {
    await db.query("UPDATE drafts SET current_pick = $2, status = 'complete', completed_at = $3, pick_deadline = NULL WHERE id = $1", [d.id, next, now.toISOString()]);
    if (!d.is_mock) await completeLeagueDraft(app, db, league);
    return;
  }
  const nd = { ...d, current_pick: next };
  const onClock = teamOnClock(nd)!;
  const isAi = (await db.one<{ is_ai: boolean }>('SELECT is_ai FROM teams WHERE id = $1', [onClock]))?.is_ai;
  const mockAi = d.is_mock && !(await db.one('SELECT 1 FROM teams WHERE id = $1 AND owner_user_id = $2', [onClock, d.mock_user_id]));
  const ms = isAi || mockAi ? AI_THINK_MS : d.type === 'manual' ? 365 * 86_400_000 : d.pick_seconds * 1000;
  await db.query('UPDATE drafts SET current_pick = $2, pick_deadline = $3 WHERE id = $1', [d.id, next, new Date(now.getTime() + ms).toISOString()]);
  if (!d.is_mock && !isAi && d.type !== 'manual') await notifyTeamOwner(app, db, onClock, { leagueId: league.id, kind: 'draft_turn', title: "You're on the clock!", link: `/league/${league.id}/draft` });
}

async function completeLeagueDraft(app: App, db: Db, league: LeagueRow) {
  await activity(app, db, league.id, 'draft_complete', 'The draft is complete. Good luck this season!');
  await startSeason(app, db, league.id);
}

export async function makePick(app: App, actor: Actor, input: { leagueId: string; draftId: string; playerId: string; expectedPick: number }) {
  return withTx(app, async (db) => {
    const d = await lockDraft(db, input.draftId);
    if (d.league_id !== input.leagueId) throw notFound('Draft');
    if (d.type === 'auction') throw badRequest('Use nominations and bids in an auction draft.');
    if (d.status !== 'in_progress') throw badRequest(d.status === 'paused' ? 'The draft is paused.' : 'The draft is not in progress.');
    if (d.current_pick !== input.expectedPick) throw conflict('That pick was already made. The board has been refreshed.');
    const league = await getLeague(db, d.league_id);
    const teamId = teamOnClock(d)!;
    let madeBy: string | null = null;
    if (actor.kind === 'user') {
      const role = await roleIn(db, d.league_id, actor.userId);
      if (!role) throw notFound('League');
      const team = await db.one<{ owner_user_id: string | null }>('SELECT owner_user_id FROM teams WHERE id = $1', [teamId]);
      const mine = d.is_mock ? (team?.owner_user_id === actor.userId && d.mock_user_id === actor.userId) : team?.owner_user_id === actor.userId;
      const commish = !d.is_mock && can(role, 'draft.control');
      if (d.type === 'manual' && !commish) throw forbidden('In a manual draft the commissioner enters every pick.');
      if (!mine && !commish) throw forbidden("It isn't your turn.");
      if (!mine && commish) await audit(db, { leagueId: d.league_id, actor, action: 'draft.pick_for_team', target: teamId, payload: { playerId: input.playerId, overall: d.current_pick } });
      madeBy = actor.userId;
    } else if (actor.kind === 'ai' && actor.teamId !== teamId) throw forbidden();
    const r = await recordPick(app, db, league, d, teamId, input.playerId, { auto: actor.kind !== 'user', madeBy });
    await advance(app, db, league, d);
    publishLeague(app, db, d.league_id, 'draft', { overall: r.overall });
    return { overall: r.overall };
  });
}

async function autoPickFor(app: App, db: Db, league: LeagueRow, d: DraftRow, teamId: string) {
  const team = await db.one<{ is_ai: boolean; ai_difficulty: AiDifficulty | null; owner_user_id: string | null }>('SELECT is_ai, ai_difficulty, owner_user_id FROM teams WHERE id = $1', [teamId]);
  const have = await teamDraftedPositions(db, d.id, teamId);
  const avail = await db.query<{ id: string; position: Position; rank: number }>(
    `SELECT p.id, p.position, p.rank FROM nfl_players p WHERE p.active
       AND NOT EXISTS (SELECT 1 FROM draft_picks dp WHERE dp.draft_id = $1 AND dp.player_id = p.id)
       AND ($3 OR NOT EXISTS (SELECT 1 FROM roster_entries r WHERE r.league_id = $2 AND r.player_id = p.id))
     ORDER BY p.rank, p.id LIMIT 250`, [d.id, league.id, d.is_mock]);
  const available: DraftablePlayer[] = avail.map((a) => ({ id: a.id, position: a.position, rank: a.rank, projectedSeason: 0 }));
  const remaining = d.rounds - have.length;
  const queue = (await db.query<{ player_id: string }>('SELECT player_id FROM draft_queue WHERE draft_id = $1 AND team_id = $2 ORDER BY position', [d.id, teamId])).map((q) => q.player_id);
  const humanInMock = d.is_mock && team?.owner_user_id === d.mock_user_id;
  const pick = team?.is_ai || (d.is_mock && !humanInMock)
    ? aiDraftPick({ difficulty: team?.ai_difficulty ?? 'medium', cfg: league.settings.roster, available, have, picksRemainingForTeam: remaining, seed: `${d.id}:${d.current_pick}` })
    : chooseAutoPick({ cfg: league.settings.roster, available, queue, have, picksRemainingForTeam: remaining });
  if (!pick) throw new Error('No players available to draft.');
  return pick.id;
}

/** Timer job: auto-picks for expired clocks and AI turns; closes auction lots. Safe to run concurrently. */
export async function draftTick(app: App): Promise<number> {
  const now = app.clock.now().toISOString();
  const due = await app.db.query<{ id: string }>("SELECT id FROM drafts WHERE status = 'in_progress' AND (pick_deadline <= $1::timestamptz OR (auction_state->>'endsAt') <= $1::text)", [now]);
  let n = 0;
  for (const { id } of due) {
    try {
      await withTx(app, async (db) => {
        const d = await lockDraft(db, id);
        if (d.status !== 'in_progress') return;
        const league = await getLeague(db, d.league_id);
        if (d.type === 'auction') { await auctionTick(app, db, league, d); n++; return; }
        if (!d.pick_deadline || d.pick_deadline > app.clock.now().toISOString()) return;
        const teamId = teamOnClock(d);
        if (!teamId) return;
        const playerId = await autoPickFor(app, db, league, d, teamId);
        await recordPick(app, db, league, d, teamId, playerId, { auto: true, madeBy: null });
        await advance(app, db, league, d);
        publishLeague(app, db, d.league_id, 'draft', {});
        n++;
      });
    } catch (e) {
      app.log(`draft tick failed for ${id}: ${(e as Error).message}`);
    }
  }
  return n;
}

export async function pauseDraft(app: App, actor: Actor, input: { leagueId: string; paused: boolean }) {
  await requirePermission(app.db, actor, input.leagueId, 'draft.control');
  return withTx(app, async (db) => {
    const d = await db.one<DraftRow>('SELECT * FROM drafts WHERE league_id = $1 AND NOT is_mock FOR UPDATE', [input.leagueId]);
    if (!d) throw notFound('Draft');
    const now = app.clock.now().getTime();
    if (input.paused) {
      if (d.status !== 'in_progress') throw badRequest('The draft is not running.');
      const remaining = d.pick_deadline ? Math.max(0, Date.parse(d.pick_deadline) - now) : d.pick_seconds * 1000;
      await db.query("UPDATE drafts SET status = 'paused', paused_remaining_ms = $2, pick_deadline = NULL WHERE id = $1", [d.id, remaining]);
    } else {
      if (d.status !== 'paused') throw badRequest('The draft is not paused.');
      await db.query("UPDATE drafts SET status = 'in_progress', pick_deadline = $2, paused_remaining_ms = NULL WHERE id = $1", [d.id, new Date(now + Math.max(10_000, d.paused_remaining_ms ?? 0)).toISOString()]);
    }
    await audit(db, { leagueId: input.leagueId, actor, action: input.paused ? 'draft.pause' : 'draft.resume' });
    await activity(app, db, input.leagueId, 'draft', input.paused ? 'The commissioner paused the draft.' : 'The draft resumed.');
    publishLeague(app, db, input.leagueId, 'draft', {});
    return { ok: true };
  });
}

export async function undoPick(app: App, actor: Actor, input: { leagueId: string; reason: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'draft.control');
  if (!input.reason || input.reason.trim().length < 3) throw badRequest('A reason is required to undo a pick.');
  return withTx(app, async (db) => {
    const d = await db.one<DraftRow>('SELECT * FROM drafts WHERE league_id = $1 AND NOT is_mock FOR UPDATE', [input.leagueId]);
    if (!d) throw notFound('Draft');
    if (d.status === 'complete') throw badRequest('The draft is complete; use commissioner roster edits instead.');
    const last = await db.one<{ id: string; overall: number; team_id: string; player_id: string; price: number | null }>('SELECT id, overall, team_id, player_id, price FROM draft_picks WHERE draft_id = $1 ORDER BY overall DESC LIMIT 1', [d.id]);
    if (!last) throw badRequest('No picks to undo.');
    await db.query('DELETE FROM draft_picks WHERE id = $1', [last.id]);
    await db.query('DELETE FROM roster_entries WHERE league_id = $1 AND player_id = $2', [input.leagueId, last.player_id]);
    if (d.type === 'auction' && last.price) await db.query('UPDATE auction_budgets SET remaining = remaining + $3 WHERE draft_id = $1 AND team_id = $2', [d.id, last.team_id, last.price]);
    else await db.query('UPDATE drafts SET current_pick = $2, pick_deadline = $3 WHERE id = $1', [d.id, last.overall, new Date(app.clock.now().getTime() + d.pick_seconds * 1000).toISOString()]);
    const p = await db.one<{ full_name: string }>('SELECT full_name FROM nfl_players WHERE id = $1', [last.player_id]);
    await audit(db, { leagueId: input.leagueId, actor, action: 'draft.undo', target: last.player_id, reason: input.reason, payload: { overall: last.overall } });
    await activity(app, db, input.leagueId, 'draft', `The commissioner undid pick #${last.overall} (${p?.full_name}). Reason: ${input.reason}`);
    publishLeague(app, db, input.leagueId, 'draft', {});
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Auction
// ---------------------------------------------------------------------------

const BID_SECONDS = 15;

async function openSpots(db: Db, d: DraftRow, teamId: string) {
  return d.rounds - (await teamDraftedPositions(db, d.id, teamId)).length;
}

export async function nominate(app: App, actor: Actor, input: { leagueId: string; draftId: string; playerId: string; openingBid: number }) {
  return withTx(app, async (db) => {
    const d = await lockDraft(db, input.draftId);
    if (d.type !== 'auction' || d.status !== 'in_progress' || d.auction_state?.phase !== 'nominating') throw badRequest('Nominations are not open.');
    const nominator = d.team_order[d.auction_state.nominatorIndex];
    await assertControls(db, actor, d.league_id, nominator);
    return placeNomination(app, db, d, nominator, input.playerId, input.openingBid);
  });
}

async function assertControls(db: Db, actor: Actor, leagueId: string, teamId: string) {
  if (actor.kind === 'system') return;
  if (actor.kind === 'ai') { if (actor.teamId !== teamId) throw forbidden(); return; }
  const role = await roleIn(db, leagueId, actor.userId);
  if (!role) throw notFound('League');
  const t = await db.one<{ owner_user_id: string | null }>('SELECT owner_user_id FROM teams WHERE id = $1', [teamId]);
  if (t?.owner_user_id !== actor.userId && !can(role, 'draft.control')) throw forbidden("It isn't your turn.");
}

async function placeNomination(app: App, db: Db, d: DraftRow, teamId: string, playerId: string, bid: number) {
  const taken = await db.one('SELECT 1 FROM draft_picks WHERE draft_id = $1 AND player_id = $2', [d.id, playerId]);
  if (taken) throw conflict('That player has already been drafted.');
  const budget = (await db.one<{ remaining: number }>('SELECT remaining FROM auction_budgets WHERE draft_id = $1 AND team_id = $2', [d.id, teamId]))!.remaining;
  const err = validateBid(bid, 0, budget, await openSpots(db, d, teamId));
  if (err) throw badRequest(err);
  const now = app.clock.now();
  const st: AuctionState = { ...d.auction_state!, phase: 'bidding', playerId, highBid: bid, highTeamId: teamId, endsAt: new Date(now.getTime() + BID_SECONDS * 1000).toISOString(), bids: [{ teamId, amount: bid, at: now.toISOString() }] };
  await db.query('UPDATE drafts SET auction_state = $2, pick_deadline = NULL WHERE id = $1', [d.id, JSON.stringify(st)]);
  publishLeague(app, db, d.league_id, 'draft', {});
  return { ok: true };
}

export async function placeBid(app: App, actor: Actor, input: { leagueId: string; draftId: string; teamId: string; amount: number }) {
  return withTx(app, async (db) => {
    const d = await lockDraft(db, input.draftId);
    if (d.type !== 'auction' || d.status !== 'in_progress' || d.auction_state?.phase !== 'bidding') throw badRequest('There is no player up for bid.');
    await assertControls(db, actor, d.league_id, input.teamId);
    if (!d.team_order.includes(input.teamId)) throw badRequest('Team is not in this draft.');
    const st = d.auction_state;
    if (st.endsAt && Date.parse(st.endsAt) <= app.clock.now().getTime()) throw conflict('Bidding has closed for this player.');
    if (st.highTeamId === input.teamId) throw badRequest('You already hold the high bid.');
    const budget = (await db.one<{ remaining: number }>('SELECT remaining FROM auction_budgets WHERE draft_id = $1 AND team_id = $2', [d.id, input.teamId]))!.remaining;
    const err = validateBid(input.amount, st.highBid, budget, await openSpots(db, d, input.teamId));
    if (err) throw badRequest(err);
    const now = app.clock.now();
    const endsAt = new Date(Math.max(Date.parse(st.endsAt!), now.getTime() + 8000)).toISOString(); // anti-snipe extension
    const next: AuctionState = { ...st, highBid: input.amount, highTeamId: input.teamId, endsAt, bids: [...st.bids.slice(-19), { teamId: input.teamId, amount: input.amount, at: now.toISOString() }] };
    await db.query('UPDATE drafts SET auction_state = $2 WHERE id = $1', [d.id, JSON.stringify(next)]);
    publishLeague(app, db, d.league_id, 'draft', {});
    return { ok: true };
  });
}

function aiAuctionValue(rank: number, budget: number, difficulty: AiDifficulty, seed: string): number {
  const noise = 0.85 + seededRandom(seed)() * (difficulty === 'hard' ? 0.2 : 0.4);
  return Math.max(1, Math.round(budget * 0.3 * Math.exp(-rank / 22) * noise));
}

async function auctionTick(app: App, db: Db, league: LeagueRow, d: DraftRow) {
  const st = d.auction_state!;
  const now = app.clock.now();
  if (st.phase === 'nominating') {
    const nominator = d.team_order[st.nominatorIndex];
    const t = await db.one<{ is_ai: boolean }>('SELECT is_ai FROM teams WHERE id = $1', [nominator]);
    if (!t?.is_ai && d.pick_deadline && Date.parse(d.pick_deadline) > now.getTime()) return;
    const playerId = await autoPickFor(app, db, league, d, nominator);
    await placeNomination(app, db, d, nominator, playerId, 1);
    return;
  }
  if (st.endsAt && Date.parse(st.endsAt) <= now.getTime()) {
    // Award the lot.
    await recordPick(app, db, league, d, st.highTeamId!, st.playerId!, { auto: false, madeBy: null, price: st.highBid });
    await db.query('UPDATE auction_budgets SET remaining = remaining - $3 WHERE draft_id = $1 AND team_id = $2', [d.id, st.highTeamId, st.highBid]);
    const done = (await db.one<{ c: number }>('SELECT count(*)::int AS c FROM draft_picks WHERE draft_id = $1', [d.id]))!.c >= totalPicks(d);
    if (done) {
      await db.query("UPDATE drafts SET status = 'complete', completed_at = $2, auction_state = NULL WHERE id = $1", [d.id, now.toISOString()]);
      if (!d.is_mock) await completeLeagueDraft(app, db, league);
    } else {
      let idx = st.nominatorIndex;
      for (let i = 0; i < d.team_order.length; i++) {
        idx = (idx + 1) % d.team_order.length;
        if (await openSpots(db, d, d.team_order[idx]) > 0) break;
      }
      const next: AuctionState = { phase: 'nominating', nominatorIndex: idx, playerId: null, highBid: 0, highTeamId: null, endsAt: null, bids: [] };
      await db.query('UPDATE drafts SET auction_state = $2, pick_deadline = $3 WHERE id = $1', [d.id, JSON.stringify(next), new Date(now.getTime() + d.pick_seconds * 1000).toISOString()]);
      await notifyTeamOwner(app, db, d.team_order[idx], { leagueId: league.id, kind: 'draft_turn', title: 'Your turn to nominate a player', link: `/league/${league.id}/draft` });
    }
    publishLeague(app, db, d.league_id, 'draft', {});
    return;
  }
  // AI bidding: at most one AI raise per tick.
  const player = await db.one<{ rank: number }>('SELECT rank FROM nfl_players WHERE id = $1', [st.playerId]);
  const ais = await db.query<{ id: string; ai_difficulty: AiDifficulty }>('SELECT id, ai_difficulty FROM teams WHERE league_id = $1 AND is_ai', [league.id]);
  for (const ai of ais) {
    if (ai.id === st.highTeamId) continue;
    const spots = await openSpots(db, d, ai.id);
    if (spots <= 0) continue;
    const budget = (await db.one<{ remaining: number }>('SELECT remaining FROM auction_budgets WHERE draft_id = $1 AND team_id = $2', [d.id, ai.id]))!.remaining;
    const value = Math.min(maxAuctionBid(budget, spots), aiAuctionValue(player?.rank ?? 300, d.auction_budget ?? 200, ai.ai_difficulty, `${ai.id}:${st.playerId}`));
    if (st.highBid + 1 <= value) {
      const next: AuctionState = { ...st, highBid: st.highBid + 1, highTeamId: ai.id, endsAt: new Date(Math.max(Date.parse(st.endsAt!), now.getTime() + 6000)).toISOString(), bids: [...st.bids.slice(-19), { teamId: ai.id, amount: st.highBid + 1, at: now.toISOString() }] };
      await db.query('UPDATE drafts SET auction_state = $2 WHERE id = $1', [d.id, JSON.stringify(next)]);
      publishLeague(app, db, d.league_id, 'draft', {});
      return;
    }
  }
}

/** For leagues that start mid-season: build rosters automatically (each team auto-drafts) without a live draft room. */
export async function autoDraftAll(app: App, actor: Actor, input: { leagueId: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'draft.control');
  const league = await getLeague(app.db, input.leagueId);
  if (league.status !== 'setup' && league.status !== 'drafting') throw badRequest('Rosters are already set.');
  let d = await app.db.one<DraftRow>('SELECT * FROM drafts WHERE league_id = $1 AND NOT is_mock', [league.id]);
  if (!d || d.status === 'scheduled') {
    if (!d) await configureDraft(app, actor, { leagueId: league.id, type: 'snake' });
    else if (d.type === 'auction') await configureDraft(app, actor, { leagueId: league.id, type: 'snake' });
    await startDraft(app, actor, { leagueId: league.id });
  }
  for (let i = 0; i < 400; i++) {
    const done = await withTx(app, async (db) => {
      const row = await db.one<DraftRow>('SELECT * FROM drafts WHERE league_id = $1 AND NOT is_mock FOR UPDATE', [league.id]);
      if (!row || row.status === 'complete') return true;
      if (row.type === 'auction') throw badRequest('Auto-draft is only available for snake or linear drafts.');
      const l = await getLeague(db, league.id);
      const teamId = teamOnClock(row)!;
      const playerId = await autoPickFor(app, db, l, row, teamId);
      await recordPick(app, db, l, row, teamId, playerId, { auto: true, madeBy: null });
      await advance(app, db, l, row);
      return false;
    });
    if (done) break;
  }
  await audit(app.db, { leagueId: league.id, actor, action: 'draft.auto_all' });
  app.bus.publish(`league:${league.id}`, { type: 'draft', leagueId: league.id });
  return { ok: true };
}

/**
 * "Finish my draft": auto-picks the rest of the draft using the caller's queue, rankings and
 * roster needs. Allowed only when every other team is an AI (solo and vs-AI leagues), so a
 * person can never draft on behalf of other people.
 */
export async function finishForMe(app: App, actor: Actor, input: { leagueId: string; draftId?: string }) {
  if (actor.kind !== 'user') throw forbidden();
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  const d0 = input.draftId
    ? await app.db.one<DraftRow>('SELECT * FROM drafts WHERE id = $1 AND league_id = $2', [input.draftId, input.leagueId])
    : await app.db.one<DraftRow>('SELECT * FROM drafts WHERE league_id = $1 AND NOT is_mock', [input.leagueId]);
  if (!d0) throw notFound('Draft');
  if (d0.type === 'auction') throw badRequest('Auction drafts cannot be finished automatically.');
  if (d0.is_mock ? d0.mock_user_id !== actor.userId : false) throw notFound('Draft');
  const humans = await app.db.query<{ owner_user_id: string | null }>('SELECT owner_user_id FROM teams WHERE league_id = $1 AND NOT is_ai', [input.leagueId]);
  if (!d0.is_mock && humans.some((h) => h.owner_user_id !== actor.userId)) throw forbidden('Other people are drafting in this league, so only the commissioner can auto-draft (before the draft starts).');
  let picks = 0;
  for (let guard = 0; guard < 400; guard++) {
    const done = await withTx(app, async (db) => {
      const d = await lockDraft(db, d0.id);
      if (d.status !== 'in_progress' || d.current_pick > totalPicks(d)) return true;
      const league = await getLeague(db, d.league_id);
      const teamId = teamOnClock(d)!;
      const playerId = await autoPickFor(app, db, league, d, teamId);
      await recordPick(app, db, league, d, teamId, playerId, { auto: true, madeBy: null });
      await advance(app, db, league, d);
      picks++;
      return false;
    });
    if (done) break;
  }
  if (!d0.is_mock) await audit(app.db, { leagueId: input.leagueId, actor, action: 'draft.finish_for_me', target: d0.id, payload: { picks } });
  publishLeague(app, app.db, input.leagueId, 'draft', {});
  return { picks };
}
