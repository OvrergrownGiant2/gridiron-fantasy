import {
  activeRosterSize, hasRoomFor, irEligible, nextWaiverRun, optimizeLineup, validateRoster,
  type InjuryStatus, type OptimizerPlayer, type Position, type RosterPlayer, type Slot,
} from '@gridiron/core';
import { z } from 'zod';
import { badRequest, conflict, type Actor, type App } from '../app';
import { isUniqueViolation, type Db } from '../db/db';
import { activity, audit, getLeague, notifyTeamOwner, publishLeague, requirePermission, requireTeamControl, withTx, type LeagueRow } from './common';
import { byeWeeks, lockedPlayerIds, teamGameMap } from './nfl';
import { projectionsFor, teamWeekScore } from './scoring';

export interface RosterEntryRow { id: string; team_id: string; player_id: string; slot: Slot; acquired_via: string; acquired_at: string; position: Position; injury_status: InjuryStatus; full_name: string; nfl_team_id: string | null }

export async function rosterRows(db: Db, teamId: string, forUpdate = false): Promise<RosterEntryRow[]> {
  return db.query<RosterEntryRow>(
    `SELECT r.*, p.position, p.injury_status, p.full_name, p.nfl_team_id FROM roster_entries r JOIN nfl_players p ON p.id = r.player_id
     WHERE r.team_id = $1 ORDER BY r.acquired_at ${forUpdate ? 'FOR UPDATE OF r' : ''}`, [teamId]);
}

async function locksFor(app: App, db: Db, league: LeagueRow, ids: string[]) {
  return lockedPlayerIds(db, { season: league.season, week: league.current_week, now: app.clock.now(), mode: league.settings.season.lineupLock, playerIds: ids });
}

function assertSeasonOpen(league: LeagueRow) {
  if (league.status === 'setup' || league.status === 'drafting') throw badRequest('Rosters open after the draft is complete.');
  if (league.status === 'complete') throw badRequest('The season is over.');
}

/** Full roster view for the My Team page. */
export async function getRoster(app: App, actor: Actor, input: { teamId: string; week?: number }) {
  const team = await app.db.one<{ league_id: string }>('SELECT league_id FROM teams WHERE id = $1', [input.teamId]);
  if (!team) throw badRequest('Team not found.');
  await requirePermission(app.db, actor, team.league_id, 'league.view');
  const league = await getLeague(app.db, team.league_id);
  const week = input.week ?? league.current_week;
  const m = await app.db.one<{ id: string; status: string }>('SELECT id, status FROM matchups WHERE league_id = $1 AND week = $2 AND (home_team_id = $3 OR away_team_id = $3) ORDER BY kind LIMIT 1', [league.id, week, input.teamId]);
  const finalized = m?.status === 'final';
  const score = await teamWeekScore(app.db, league, input.teamId, week, { matchupId: m?.id ?? null, finalized, now: app.clock.now() });
  const byes = await byeWeeks(app.db, league.season);
  const rows = finalized ? [] : await rosterRows(app.db, input.teamId);
  const via = new Map(rows.map((r) => [r.player_id, { acquiredVia: r.acquired_via, acquiredAt: r.acquired_at }]));
  const decorate = (p: (typeof score.starters)[number]) => ({
    ...p, byeWeek: p.nflTeamId ? (byes.get(p.nflTeamId) ?? [])[0] ?? null : null,
    irEligible: irEligible(p.injuryStatus, league.settings.roster), ...via.get(p.playerId),
  });
  return {
    teamId: input.teamId, week, finalized, editable: !finalized && week === league.current_week && league.status !== 'complete',
    points: score.points, projected: score.projected,
    starters: score.starters.map(decorate), bench: score.bench.map(decorate),
    rosterConfig: league.settings.roster, maxActive: activeRosterSize(league.settings.roster),
  };
}

const lineupSchema = z.object({
  teamId: z.string().uuid(),
  assignments: z.array(z.object({ playerId: z.string(), slot: z.enum(['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPERFLEX', 'K', 'DST', 'BN', 'IR']) })).min(1).max(40),
  reason: z.string().max(200).optional(),
});

export async function setLineup(app: App, actor: Actor, input: unknown) {
  const p = lineupSchema.parse(input);
  const { team, override } = await requireTeamControl(app.db, actor, p.teamId, { allowCommissioner: true });
  if (override && !p.reason) throw badRequest('Commissioner lineup corrections require a reason.');
  return withTx(app, async (db) => {
    const league = await getLeague(db, team.league_id);
    assertSeasonOpen(league);
    const rows = await rosterRows(db, team.id, true);
    const locked = await locksFor(app, db, league, rows.map((r) => r.player_id));
    const next = new Map(rows.map((r) => [r.player_id, r.slot]));
    for (const a of p.assignments) {
      if (!next.has(a.playerId)) throw badRequest('A player in this lineup is not on the roster.');
      const cur = next.get(a.playerId)!;
      if (cur !== a.slot && locked.has(a.playerId) && !override) {
        const r = rows.find((x) => x.player_id === a.playerId)!;
        throw badRequest(`${r.full_name} is locked: their game has started.`);
      }
      next.set(a.playerId, a.slot);
    }
    const proposed: RosterPlayer[] = rows.map((r) => ({ playerId: r.player_id, position: r.position, slot: next.get(r.player_id)!, injuryStatus: r.injury_status, locked: locked.has(r.player_id) }));
    const issues = validateRoster(proposed, league.settings.roster);
    if (issues.length) throw badRequest(issues[0].message, issues);
    const changed: string[] = [];
    for (const r of rows) {
      const s = next.get(r.player_id)!;
      if (s !== r.slot) { await db.query('UPDATE roster_entries SET slot = $2 WHERE id = $1', [r.id, s]); changed.push(`${r.full_name} → ${s}`); }
    }
    if (changed.length && override) {
      await audit(db, { leagueId: league.id, actor, action: 'roster.override_lineup', target: team.id, reason: p.reason, payload: { changed } });
      await notifyTeamOwner(app, db, team.id, { leagueId: league.id, kind: 'announcement', title: 'A commissioner adjusted your lineup', body: p.reason });
    }
    if (changed.length) publishLeague(app, db, league.id, 'roster', { teamId: team.id });
    return { changed };
  });
}

/** Suggest an optimized lineup. Never applied automatically; the client must submit it via setLineup. */
export async function suggestLineup(app: App, actor: Actor, input: { teamId: string }) {
  const { team } = await requireTeamControl(app.db, actor, input.teamId, { allowCommissioner: true });
  const league = await getLeague(app.db, team.league_id);
  const rows = await rosterRows(app.db, team.id);
  const ids = rows.map((r) => r.player_id);
  const [locked, proj, games] = await Promise.all([locksFor(app, app.db, league, ids), projectionsFor(app.db, league, league.current_week, ids), teamGameMap(app.db, league.season, league.current_week)]);
  const players: OptimizerPlayer[] = rows.map((r) => {
    const g = r.nfl_team_id ? games.get(r.nfl_team_id) : undefined;
    return {
      playerId: r.player_id, name: r.full_name, position: r.position, slot: r.slot, injuryStatus: r.injury_status,
      locked: locked.has(r.player_id), projected: proj.get(r.player_id)?.points ?? 0, onBye: !g, gameStarted: locked.has(r.player_id),
    };
  });
  const result = optimizeLineup(players, league.settings.roster);
  return { ...result, note: 'Projections are estimates, not guarantees. Review before saving.' };
}

export type Availability = { status: 'rostered'; teamId: string } | { status: 'waivers'; clearsAt: string | null; reason: string } | { status: 'free_agent' };

export async function availability(app: App, db: Db, league: LeagueRow, playerIds: string[]): Promise<Map<string, Availability>> {
  const out = new Map<string, Availability>();
  if (!playerIds.length) return out;
  const rostered = await db.query<{ player_id: string; team_id: string }>('SELECT player_id, team_id FROM roster_entries WHERE league_id = $1 AND player_id = ANY($2)', [league.id, playerIds]);
  const onWaivers = await db.query<{ player_id: string; clears_at: string }>('SELECT player_id, clears_at FROM player_waivers WHERE league_id = $1 AND player_id = ANY($2) AND clears_at > $3', [league.id, playerIds, app.clock.now().toISOString()]);
  const r = new Map(rostered.map((x) => [x.player_id, x.team_id]));
  const w = new Map(onWaivers.map((x) => [x.player_id, x.clears_at]));
  const unrostered = playerIds.filter((id) => !r.has(id));
  const locked = await locksFor(app, db, league, unrostered);
  const nextRun = league.waiver_next_run_at;
  for (const id of playerIds) {
    if (r.has(id)) out.set(id, { status: 'rostered', teamId: r.get(id)! });
    else if (league.settings.waivers.continuous) out.set(id, { status: 'waivers', clearsAt: nextRun, reason: 'This league uses continuous waivers.' });
    else if (w.has(id)) out.set(id, { status: 'waivers', clearsAt: w.get(id)!, reason: 'Recently dropped.' });
    else if (locked.has(id)) out.set(id, { status: 'waivers', clearsAt: nextRun, reason: 'Their game has started this week.' });
    else out.set(id, { status: 'free_agent' });
  }
  return out;
}

export async function waiverClearTime(app: App, league: LeagueRow): Promise<string> {
  const w = league.settings.waivers;
  const after = new Date(app.clock.now().getTime() + w.waiverPeriodHours * 3_600_000);
  return nextWaiverRun(after, w.processDay, w.processHourUtc).toISOString();
}

const addSchema = z.object({
  teamId: z.string().uuid(),
  addPlayerId: z.string().min(1),
  dropPlayerId: z.string().min(1).nullable().optional(),
  requestId: z.string().min(8).max(64),       // idempotency key from the client
});

/**
 * Instant free-agent add (with optional drop). Atomic: the UNIQUE(league_id,
 * player_id) constraint guarantees that two simultaneous adds of the same player
 * cannot both succeed, regardless of application-level checks.
 */
export async function addFreeAgent(app: App, actor: Actor, input: unknown) {
  const p = addSchema.parse(input);
  const { team } = await requireTeamControl(app.db, actor, p.teamId);
  const prior = await app.db.one<{ id: string; status: string; summary: string }>('SELECT id, status, summary FROM transactions WHERE idempotency_key = $1', [`fa:${p.requestId}`]);
  if (prior) return { transactionId: prior.id, summary: prior.summary, duplicate: true };
  try {
    return await withTx(app, async (db) => {
      const league = await getLeague(db, team.league_id);
      assertSeasonOpen(league);
      await db.one('SELECT id FROM teams WHERE id = $1 FOR UPDATE', [team.id]); // serialize this team's moves
      const player = await db.one<{ id: string; full_name: string; position: Position; active: boolean }>('SELECT id, full_name, position, active FROM nfl_players WHERE id = $1', [p.addPlayerId]);
      if (!player) throw badRequest('Player not found.');
      const avail = (await availability(app, db, league, [player.id])).get(player.id)!;
      if (avail.status === 'rostered') throw conflict(`${player.full_name} is already on a roster.`);
      if (avail.status === 'waivers') throw badRequest(`${player.full_name} is on waivers (${avail.reason}) Submit a waiver claim instead.`);
      const rows = await rosterRows(db, team.id, true);
      let dropName: string | null = null;
      if (p.dropPlayerId) {
        const d = rows.find((r) => r.player_id === p.dropPlayerId);
        if (!d) throw badRequest('The player to drop is not on your roster.');
        if ((await locksFor(app, db, league, [d.player_id])).has(d.player_id)) throw badRequest(`${d.full_name} is locked and cannot be dropped until the week ends.`);
        dropName = d.full_name;
      }
      const room = hasRoomFor(rows.map((r) => ({ playerId: r.player_id, position: r.position, slot: r.slot, injuryStatus: r.injury_status, locked: false })), league.settings.roster, [player.position], p.dropPlayerId ? [p.dropPlayerId] : []);
      if (room) throw badRequest(room.message);
      if (p.dropPlayerId) await dropInternal(app, db, league, team.id, p.dropPlayerId, 'add_drop');
      await db.query("INSERT INTO roster_entries (league_id, team_id, player_id, slot, acquired_via) VALUES ($1,$2,$3,'BN','free_agent')", [league.id, team.id, player.id]);
      const summary = `${team.name} added ${player.full_name}${dropName ? ` and dropped ${dropName}` : ''}.`;
      const tx = await db.one<{ id: string }>(`INSERT INTO transactions (league_id, type, status, team_id, actor_user_id, summary, details, idempotency_key)
        VALUES ($1,$2,'completed',$3,$4,$5,$6,$7) RETURNING id`, [league.id, p.dropPlayerId ? 'add_drop' : 'add', team.id, actor.kind === 'user' ? actor.userId : null, summary, JSON.stringify({ add: player.id, drop: p.dropPlayerId ?? null }), `fa:${p.requestId}`]);
      await activity(app, db, league.id, 'player_added', summary, { teamId: team.id, add: player.id, drop: p.dropPlayerId ?? null });
      publishLeague(app, db, league.id, 'roster', { teamId: team.id });
      return { transactionId: tx!.id, summary, duplicate: false };
    });
  } catch (e) {
    if (isUniqueViolation(e, 'roster_entries_league_id_player_id_key')) throw conflict('Another team just added that player.');
    if (isUniqueViolation(e, 'transactions_idempotency_key_key')) {
      const again = await app.db.one<{ id: string; summary: string }>('SELECT id, summary FROM transactions WHERE idempotency_key = $1', [`fa:${p.requestId}`]);
      return { transactionId: again!.id, summary: again!.summary, duplicate: true };
    }
    throw e;
  }
}

/** Removes a player and places them on waivers. Caller holds the transaction. */
export async function dropInternal(app: App, db: Db, league: LeagueRow, teamId: string, playerId: string, via: string) {
  const del = await db.query('DELETE FROM roster_entries WHERE team_id = $1 AND player_id = $2 RETURNING id', [teamId, playerId]);
  if (!del.length) throw badRequest('Player is not on this roster.');
  await db.query(`INSERT INTO player_waivers (league_id, player_id, clears_at) VALUES ($1,$2,$3)
    ON CONFLICT (league_id, player_id) DO UPDATE SET clears_at = EXCLUDED.clears_at`, [league.id, playerId, await waiverClearTime(app, league)]);
  await db.query("UPDATE waiver_claims SET status = 'invalid', result_reason = 'Drop player left the roster.' WHERE team_id = $1 AND drop_player_id = $2 AND status = 'pending'", [teamId, playerId]);
  void via;
}

export async function dropPlayer(app: App, actor: Actor, input: { teamId: string; playerId: string; requestId: string }) {
  const { team } = await requireTeamControl(app.db, actor, input.teamId);
  return withTx(app, async (db) => {
    const league = await getLeague(db, team.league_id);
    assertSeasonOpen(league);
    const rows = await rosterRows(db, team.id, true);
    const d = rows.find((r) => r.player_id === input.playerId);
    if (!d) throw badRequest('Player is not on your roster.');
    if ((await locksFor(app, db, league, [d.player_id])).has(d.player_id)) throw badRequest(`${d.full_name} is locked and cannot be dropped until the week ends.`);
    await dropInternal(app, db, league, team.id, d.player_id, 'drop');
    const summary = `${team.name} dropped ${d.full_name}.`;
    try {
      await db.query(`INSERT INTO transactions (league_id, type, status, team_id, actor_user_id, summary, details, idempotency_key) VALUES ($1,'drop','completed',$2,$3,$4,$5,$6)`,
        [league.id, team.id, actor.kind === 'user' ? actor.userId : null, summary, JSON.stringify({ drop: d.player_id }), `drop:${input.requestId}`]);
    } catch (e) { if (isUniqueViolation(e)) throw conflict('This drop was already processed.'); throw e; }
    await activity(app, db, league.id, 'player_dropped', summary, { teamId: team.id, drop: d.player_id });
    publishLeague(app, db, league.id, 'roster', { teamId: team.id });
    return { summary };
  });
}

/** Emergency roster correction / manual roster construction by a commissioner. */
export async function commissionerRosterEdit(app: App, actor: Actor, input: { teamId: string; addPlayerId?: string | null; removePlayerId?: string | null; reason: string }) {
  const t = await app.db.one<{ league_id: string; name: string }>('SELECT league_id, name FROM teams WHERE id = $1', [input.teamId]);
  if (!t) throw badRequest('Team not found.');
  await requirePermission(app.db, actor, t.league_id, 'team.manage_any');
  if (!input.reason || input.reason.trim().length < 3) throw badRequest('A reason is required for commissioner roster edits.');
  try {
    return await withTx(app, async (db) => {
      const league = await getLeague(db, t.league_id);
      const parts: string[] = [];
      if (input.removePlayerId) {
        const p = await db.one<{ full_name: string }>('SELECT full_name FROM nfl_players WHERE id = $1', [input.removePlayerId]);
        const del = await db.query('DELETE FROM roster_entries WHERE team_id = $1 AND player_id = $2 RETURNING id', [input.teamId, input.removePlayerId]);
        if (!del.length) throw badRequest('That player is not on this team.');
        parts.push(`removed ${p?.full_name}`);
      }
      if (input.addPlayerId) {
        const p = await db.one<{ full_name: string; position: Position }>('SELECT full_name, position FROM nfl_players WHERE id = $1', [input.addPlayerId]);
        if (!p) throw badRequest('Player not found.');
        const rows = await rosterRows(db, input.teamId, true);
        const room = hasRoomFor(rows.map((r) => ({ playerId: r.player_id, position: r.position, slot: r.slot, injuryStatus: r.injury_status, locked: false })), league.settings.roster, [p.position], []);
        if (room) throw badRequest(room.message);
        await db.query("INSERT INTO roster_entries (league_id, team_id, player_id, slot, acquired_via) VALUES ($1,$2,$3,'BN','commissioner')", [league.id, input.teamId, input.addPlayerId]);
        await db.query('DELETE FROM player_waivers WHERE league_id = $1 AND player_id = $2', [league.id, input.addPlayerId]);
        parts.push(`added ${p.full_name}`);
      }
      if (!parts.length) throw badRequest('Nothing to change.');
      const summary = `Commissioner ${parts.join(' and ')} on ${t.name}.`;
      await db.query(`INSERT INTO transactions (league_id, type, status, team_id, actor_user_id, summary, details) VALUES ($1,'commissioner','completed',$2,$3,$4,$5)`,
        [league.id, input.teamId, actor.kind === 'user' ? actor.userId : null, summary, JSON.stringify({ ...input })]);
      await audit(db, { leagueId: league.id, actor, action: 'roster.override_edit', target: input.teamId, reason: input.reason, payload: input });
      await activity(app, db, league.id, 'commissioner', `${summary} Reason: ${input.reason}`);
      await notifyTeamOwner(app, db, input.teamId, { leagueId: league.id, kind: 'announcement', title: 'A commissioner changed your roster', body: `${summary} Reason: ${input.reason}` });
      publishLeague(app, db, league.id, 'roster', { teamId: input.teamId });
      return { summary };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('That player is already rostered in this league.');
    throw e;
  }
}

/** Roster legality report used by the commissioner dashboard. */
export async function rosterViolations(app: App, league: LeagueRow) {
  const teams = await app.db.query<{ id: string; name: string }>('SELECT id, name FROM teams WHERE league_id = $1', [league.id]);
  const out: { teamId: string; teamName: string; issues: string[] }[] = [];
  for (const t of teams) {
    const rows = await rosterRows(app.db, t.id);
    const issues = validateRoster(rows.map((r) => ({ playerId: r.player_id, position: r.position, slot: r.slot, injuryStatus: r.injury_status, locked: false })), league.settings.roster);
    if (issues.length) out.push({ teamId: t.id, teamName: t.name, issues: issues.map((i) => i.message) });
  }
  return out;
}
