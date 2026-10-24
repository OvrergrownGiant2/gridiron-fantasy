import {
  activeRosterSize, aiWaiverClaim, hasRoomFor, nextWaiverRun, resolveWaivers, reverseStandingsPriority,
  type PendingClaim, type Position, type TeamWaiverState,
} from '@gridiron/core';
import { z } from 'zod';
import { badRequest, conflict, notFound, type Actor, type App } from '../app';
import { isUniqueViolation, type Db } from '../db/db';
import { activity, audit, getLeague, notifyTeamOwner, publishLeague, requirePermission, requireTeamControl, withTx, type LeagueRow } from './common';
import { lockedPlayerIds } from './nfl';
import { availability, dropInternal, rosterRows } from './rosters';
import { leagueStandings, projectionsFor } from './scoring';

const claimSchema = z.object({
  teamId: z.string().uuid(),
  addPlayerId: z.string().min(1),
  dropPlayerId: z.string().min(1).nullable().optional(),
  bid: z.number().int().min(0).max(10000).default(0),
  groupId: z.string().max(40).nullable().optional(),
});

export async function submitClaim(app: App, actor: Actor, input: unknown) {
  const p = claimSchema.parse(input);
  const { team } = await requireTeamControl(app.db, actor, p.teamId);
  return withTx(app, async (db) => {
    const league = await getLeague(db, team.league_id);
    if (league.status === 'setup' || league.status === 'drafting' || league.status === 'complete') throw badRequest('Waivers are closed right now.');
    const a = (await availability(app, db, league, [p.addPlayerId])).get(p.addPlayerId);
    if (!a) throw badRequest('Player not found.');
    if (a.status === 'rostered') throw conflict('That player is already on a roster.');
    if (a.status === 'free_agent') throw badRequest('That player is a free agent; add him directly instead of claiming.');
    const w = league.settings.waivers;
    if (w.mode === 'faab') {
      if (p.bid === 0 && !w.allowZeroBids) throw badRequest('$0 bids are not allowed in this league.');
      const t = await db.one<{ faab_remaining: number }>('SELECT faab_remaining FROM teams WHERE id = $1', [team.id]);
      if (p.bid > (t?.faab_remaining ?? 0)) throw badRequest(`You only have $${t?.faab_remaining ?? 0} of FAAB remaining.`);
    }
    if (p.dropPlayerId) {
      const own = await db.one('SELECT 1 FROM roster_entries WHERE team_id = $1 AND player_id = $2', [team.id, p.dropPlayerId]);
      if (!own) throw badRequest('The player to drop is not on your roster.');
    } else {
      const rows = await rosterRows(db, team.id);
      const player = await db.one<{ position: Position }>('SELECT position FROM nfl_players WHERE id = $1', [p.addPlayerId]);
      const room = hasRoomFor(rows.map((r) => ({ playerId: r.player_id, position: r.position, slot: r.slot, injuryStatus: r.injury_status, locked: false })), league.settings.roster, [player!.position], []);
      if (room) throw badRequest(`${room.message} Your claim needs a drop.`);
    }
    const rank = ((await db.one<{ m: number | null }>("SELECT max(rank) AS m FROM waiver_claims WHERE team_id = $1 AND status = 'pending'", [team.id]))?.m ?? 0) + 1;
    try {
      const c = await db.one<{ id: string }>(`INSERT INTO waiver_claims (league_id, team_id, add_player_id, drop_player_id, bid, rank, group_id, status, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8) RETURNING id`, [league.id, team.id, p.addPlayerId, p.dropPlayerId ?? null, w.mode === 'faab' ? p.bid : 0, rank, p.groupId ?? null, actor.kind === 'user' ? actor.userId : null]);
      publishLeague(app, db, league.id, 'waivers', { teamId: team.id });
      return { claimId: c!.id, processesAt: league.waiver_next_run_at };
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('You already have a pending claim for that player. Edit it instead.');
      throw e;
    }
  });
}

async function claimForTeam(app: App, actor: Actor, claimId: string) {
  const c = await app.db.one<{ id: string; team_id: string; status: string; league_id: string }>('SELECT id, team_id, status, league_id FROM waiver_claims WHERE id = $1', [claimId]);
  if (!c) throw notFound('Claim');
  await requireTeamControl(app.db, actor, c.team_id);
  if (c.status !== 'pending') throw badRequest('Only pending claims can be changed.');
  return c;
}

export async function updateClaim(app: App, actor: Actor, input: { claimId: string; bid?: number; dropPlayerId?: string | null; groupId?: string | null }) {
  const c = await claimForTeam(app, actor, input.claimId);
  const league = await getLeague(app.db, c.league_id);
  if (input.bid !== undefined) {
    const t = await app.db.one<{ faab_remaining: number }>('SELECT faab_remaining FROM teams WHERE id = $1', [c.team_id]);
    if (input.bid < 0 || !Number.isInteger(input.bid) || input.bid > (t?.faab_remaining ?? 0)) throw badRequest('Invalid bid.');
    if (input.bid === 0 && !league.settings.waivers.allowZeroBids) throw badRequest('$0 bids are not allowed in this league.');
  }
  if (input.dropPlayerId) {
    const own = await app.db.one('SELECT 1 FROM roster_entries WHERE team_id = $1 AND player_id = $2', [c.team_id, input.dropPlayerId]);
    if (!own) throw badRequest('The player to drop is not on your roster.');
  }
  await app.db.query(`UPDATE waiver_claims SET bid = COALESCE($2, bid),
      drop_player_id = CASE WHEN $4 THEN $3 ELSE drop_player_id END,
      group_id = CASE WHEN $6 THEN $5 ELSE group_id END WHERE id = $1 AND status = 'pending'`,
    [c.id, input.bid ?? null, input.dropPlayerId ?? null, input.dropPlayerId !== undefined, input.groupId ?? null, input.groupId !== undefined]);
  return { ok: true };
}

export async function cancelClaim(app: App, actor: Actor, input: { claimId: string }) {
  const c = await claimForTeam(app, actor, input.claimId);
  await app.db.query("UPDATE waiver_claims SET status = 'canceled', result_reason = 'Canceled by manager', processed_at = now() WHERE id = $1 AND status = 'pending'", [c.id]);
  return { ok: true };
}

export async function reorderClaims(app: App, actor: Actor, input: { teamId: string; claimIds: string[] }) {
  const { team } = await requireTeamControl(app.db, actor, input.teamId);
  return withTx(app, async (db) => {
    const pending = await db.query<{ id: string }>("SELECT id FROM waiver_claims WHERE team_id = $1 AND status = 'pending' FOR UPDATE", [team.id]);
    const set = new Set(pending.map((p) => p.id));
    if (input.claimIds.length !== set.size || input.claimIds.some((id) => !set.has(id))) throw badRequest('The claim list changed; refresh and try again.');
    for (let i = 0; i < input.claimIds.length; i++) await db.query('UPDATE waiver_claims SET rank = $2 WHERE id = $1', [input.claimIds[i], i + 1]);
    return { ok: true };
  });
}

export async function waiverOverview(app: App, actor: Actor, input: { leagueId: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  const league = await getLeague(app.db, input.leagueId);
  const mine = actor.kind === 'user' ? await app.db.one<{ id: string; faab_remaining: number; waiver_priority: number }>('SELECT id, faab_remaining, waiver_priority FROM teams WHERE league_id = $1 AND owner_user_id = $2', [league.id, actor.userId]) : null;
  const priority = await app.db.query('SELECT id, name, abbrev, waiver_priority, faab_remaining, primary_color, secondary_color, logo_media_id, logo_preset FROM teams WHERE league_id = $1 ORDER BY waiver_priority', [league.id]);
  const claims = mine ? await app.db.query(
    `SELECT c.*, a.full_name AS add_name, a.position AS add_position, a.nfl_team_id AS add_team, d.full_name AS drop_name
     FROM waiver_claims c JOIN nfl_players a ON a.id = c.add_player_id LEFT JOIN nfl_players d ON d.id = c.drop_player_id
     WHERE c.team_id = $1 ORDER BY (c.status = 'pending') DESC, c.rank, c.created_at DESC LIMIT 100`, [mine.id]) : [];
  return {
    mode: league.settings.waivers.mode, continuous: league.settings.waivers.continuous, faabBudget: league.settings.waivers.faabBudget,
    nextRunAt: league.waiver_next_run_at, myTeam: mine, priority, claims,
  };
}

/** Process all due claims for one league. Deterministic and idempotent per claim. */
export async function processWaivers(app: App, leagueId: string, actor: Actor = { kind: 'system' }) {
  if (actor.kind === 'user') await requirePermission(app.db, actor, leagueId, 'waiver.process_now');
  const summary = await withTx(app, async (db) => {
    const league = await getLeague(db, leagueId, true);
    const now = app.clock.now();
    if (league.status !== 'in_season' && league.status !== 'playoffs') return null;
    await aiSubmitClaims(app, db, league);
    const claimsRaw = await db.query<{ id: string; team_id: string; add_player_id: string; drop_player_id: string | null; bid: number; rank: number; group_id: string | null; created_at: string }>(
      "SELECT * FROM waiver_claims WHERE league_id = $1 AND status = 'pending' ORDER BY created_at FOR UPDATE", [league.id]);
    const locked = await lockedPlayerIds(db, { season: league.season, week: league.current_week, now, mode: league.settings.season.lineupLock, playerIds: claimsRaw.map((c) => c.add_player_id) });
    const claims: PendingClaim[] = claimsRaw.filter((c) => !locked.has(c.add_player_id)).map((c) => ({
      id: c.id, teamId: c.team_id, addPlayerId: c.add_player_id, dropPlayerId: c.drop_player_id, bid: c.bid, rank: c.rank, groupId: c.group_id, createdAt: c.created_at,
    }));
    const teams = await db.query<{ id: string; waiver_priority: number; faab_remaining: number }>('SELECT id, waiver_priority, faab_remaining FROM teams WHERE league_id = $1 ORDER BY waiver_priority FOR UPDATE', [league.id]);
    let order = teams.map((t) => t.id);
    if (league.settings.waivers.mode === 'reverse_standings') {
      order = reverseStandingsPriority((await leagueStandings(db, league)).map((s) => s.teamId));
    }
    const maxActive = activeRosterSize(league.settings.roster);
    const states: TeamWaiverState[] = [];
    for (const t of teams) {
      const rows = await rosterRows(db, t.id, true);
      states.push({ teamId: t.id, priority: order.indexOf(t.id) + 1, faabRemaining: t.faab_remaining, rosterPlayerIds: rows.map((r) => r.player_id), activeRosterCount: rows.filter((r) => r.slot !== 'IR').length, maxActive });
    }
    const rostered = new Set((await db.query<{ player_id: string }>('SELECT player_id FROM roster_entries WHERE league_id = $1', [league.id])).map((r) => r.player_id));
    const result = resolveWaivers(claims, states, league.settings.waivers, (id) => !rostered.has(id));
    const names = new Map((await db.query<{ id: string; full_name: string }>('SELECT id, full_name FROM nfl_players WHERE id = ANY($1)', [[...claims.map((c) => c.addPlayerId), ...claims.map((c) => c.dropPlayerId).filter(Boolean)]])).map((r) => [r.id, r.full_name]));
    const teamNames = new Map((await db.query<{ id: string; name: string }>('SELECT id, name FROM teams WHERE league_id = $1', [league.id])).map((r) => [r.id, r.name]));
    const won: string[] = [];
    for (const o of result.outcomes) {
      const c = claims.find((x) => x.id === o.claimId)!;
      if (o.status === 'won') {
        // The pure resolver already validated roster room/budget; the DB constraint is the final guard.
        if (c.dropPlayerId) await dropInternal(app, db, league, c.teamId, c.dropPlayerId, 'waiver');
        await db.query("INSERT INTO roster_entries (league_id, team_id, player_id, slot, acquired_via) VALUES ($1,$2,$3,'BN','waiver')", [league.id, c.teamId, c.addPlayerId]);
        await db.query('DELETE FROM player_waivers WHERE league_id = $1 AND player_id = $2', [league.id, c.addPlayerId]);
        const s = `${teamNames.get(c.teamId)} claimed ${names.get(c.addPlayerId)}${league.settings.waivers.mode === 'faab' ? ` for $${c.bid}` : ''}${c.dropPlayerId ? `, dropping ${names.get(c.dropPlayerId)}` : ''}.`;
        await db.query(`INSERT INTO transactions (league_id, type, status, team_id, summary, details, idempotency_key) VALUES ($1,'waiver','completed',$2,$3,$4,$5)`,
          [league.id, c.teamId, s, JSON.stringify({ claimId: c.id, bid: c.bid, add: c.addPlayerId, drop: c.dropPlayerId }), `waiver:${c.id}`]);
        won.push(s);
      }
      await db.query('UPDATE waiver_claims SET status = $2, result_reason = $3, processed_at = $4 WHERE id = $1', [o.claimId, o.status, o.reason, now.toISOString()]);
      await notifyTeamOwner(app, db, c.teamId, {
        leagueId: league.id, kind: 'waiver_result',
        title: o.status === 'won' ? `Waiver claim won: ${names.get(c.addPlayerId)}` : `Waiver claim ${o.status === 'lost' ? 'lost' : 'not processed'}: ${names.get(c.addPlayerId)}`,
        body: o.reason, link: `/league/${league.id}/waivers`,
      });
    }
    if (league.settings.waivers.mode === 'faab') {
      for (const [teamId, faab] of Object.entries(result.faab)) await db.query('UPDATE teams SET faab_remaining = $2 WHERE id = $1', [teamId, faab]);
    } else {
      for (let i = 0; i < result.priorityOrder.length; i++) await db.query('UPDATE teams SET waiver_priority = $2 WHERE id = $1', [result.priorityOrder[i], i + 1]);
    }
    await db.query('DELETE FROM player_waivers WHERE league_id = $1 AND clears_at <= $2', [league.id, now.toISOString()]);
    const w = league.settings.waivers;
    await db.query('UPDATE leagues SET waiver_next_run_at = $2 WHERE id = $1', [league.id, nextWaiverRun(now, w.processDay, w.processHourUtc).toISOString()]);
    const summaryText = won.length ? `Waivers processed: ${won.length} claim${won.length === 1 ? '' : 's'} awarded.` : 'Waivers processed: no claims awarded.';
    if (claims.length) await activity(app, db, league.id, 'waivers', summaryText, { awarded: won });
    if (actor.kind === 'user') await audit(db, { leagueId: league.id, actor, action: 'waivers.process_now', payload: { claims: claims.length, awarded: won.length } });
    publishLeague(app, db, league.id, 'waivers', {});
    publishLeague(app, db, league.id, 'roster', {});
    return { processed: claims.length, awarded: won.length, results: won };
  });
  return summary ?? { processed: 0, awarded: 0, results: [] };
}

/** AI managers file at most one improving claim per run, through the same pipeline as humans. */
async function aiSubmitClaims(app: App, db: Db, league: LeagueRow) {
  const ais = await db.query<{ id: string; ai_difficulty: 'easy' | 'medium' | 'hard'; faab_remaining: number }>('SELECT id, ai_difficulty, faab_remaining FROM teams WHERE league_id = $1 AND is_ai', [league.id]);
  if (!ais.length) return;
  const pool = await db.query<{ id: string; position: Position }>(
    `SELECT p.id, p.position FROM nfl_players p WHERE p.active AND p.injury_status = 'healthy'
       AND NOT EXISTS (SELECT 1 FROM roster_entries r WHERE r.league_id = $1 AND r.player_id = p.id) ORDER BY p.rank LIMIT 60`, [league.id]);
  const proj = await projectionsFor(db, league, league.current_week, pool.map((p) => p.id));
  for (const ai of ais) {
    const has = await db.one("SELECT 1 FROM waiver_claims WHERE team_id = $1 AND status = 'pending'", [ai.id]);
    if (has) continue;
    const rows = await rosterRows(db, ai.id);
    const rp = await projectionsFor(db, league, league.current_week, rows.map((r) => r.player_id));
    const pick = aiWaiverClaim({
      difficulty: ai.ai_difficulty, cfg: league.settings.roster, faabRemaining: ai.faab_remaining, faabBudget: league.settings.waivers.faabBudget,
      available: pool.map((p) => ({ playerId: p.id, position: p.position, projection: proj.get(p.id)?.points ?? 0 })),
      roster: rows.map((r) => ({ playerId: r.player_id, position: r.position, projection: rp.get(r.player_id)?.points ?? 0, locked: false, starter: r.slot !== 'BN' && r.slot !== 'IR' })),
    });
    if (!pick) continue;
    await db.query(`INSERT INTO waiver_claims (league_id, team_id, add_player_id, drop_player_id, bid, rank, status) VALUES ($1,$2,$3,$4,$5,1,'pending') ON CONFLICT DO NOTHING`,
      [league.id, ai.id, pick.addPlayerId, pick.dropPlayerId, league.settings.waivers.mode === 'faab' ? pick.bid : 0]);
  }
}

export async function waiverTick(app: App): Promise<number> {
  const now = app.clock.now();
  const leagues = await app.db.query<{ id: string; waiver_next_run_at: string | null; settings: any }>("SELECT id, waiver_next_run_at, settings FROM leagues WHERE status IN ('in_season','playoffs')");
  let n = 0;
  for (const l of leagues) {
    if (!l.waiver_next_run_at) {
      const w = l.settings.waivers;
      await app.db.query('UPDATE leagues SET waiver_next_run_at = $2 WHERE id = $1', [l.id, nextWaiverRun(now, w.processDay, w.processHourUtc).toISOString()]);
      continue;
    }
    if (Date.parse(l.waiver_next_run_at) <= now.getTime()) {
      try { await processWaivers(app, l.id); n++; } catch (e) { app.log(`waiver processing failed for ${l.id}: ${(e as Error).message}`); }
    }
  }
  return n;
}

export async function transactionHistory(app: App, actor: Actor, input: { leagueId: string; limit?: number; before?: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  return app.db.query(`SELECT t.id, t.type, t.status, t.team_id, t.summary, t.created_at, tm.name AS team_name FROM transactions t LEFT JOIN teams tm ON tm.id = t.team_id
    WHERE t.league_id = $1 AND ($2::timestamptz IS NULL OR t.created_at < $2) ORDER BY t.created_at DESC LIMIT $3`, [input.leagueId, input.before ?? null, Math.min(100, input.limit ?? 50)]);
}
