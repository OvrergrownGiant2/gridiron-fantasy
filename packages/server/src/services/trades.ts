import {
  FLAG_DISCLAIMER, activeRosterSize, aiAcceptsTrade, analyzeTrade, decideVote, hasRoomFor, integrityFlags, playerValue,
  replacementLevels, reviewRoute, validateTradeAssets,
  type Position, type TradeAnalysis, type TradeAsset, type TradeFlag, type TradePlayerInfo,
} from '@gridiron/core';
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound, type Actor, type App } from '../app';
import { isUniqueViolation, type Db } from '../db/db';
import {
  activity, audit, getLeague, notify, notifyCommissioners, notifyTeamOwner, publishLeague, requirePermission, requireTeamControl, roleIn, withTx, type LeagueRow,
} from './common';
import { byeWeeks, lockedPlayerIds } from './nfl';
import { dropInternal, rosterRows } from './rosters';
import { leagueStandings, projectionsFor } from './scoring';

const assetSchema = z.object({
  fromTeamId: z.string().uuid(),
  toTeamId: z.string().uuid(),
  type: z.enum(['player', 'faab', 'draft_pick']),
  playerId: z.string().nullable().optional(),
  faabAmount: z.number().int().nullable().optional(),
  draftRound: z.number().int().min(1).max(30).nullable().optional(),
  draftSeason: z.number().int().min(2000).max(2100).nullable().optional(),
  draftOriginalTeamId: z.string().uuid().nullable().optional(),
});
const proposeSchema = z.object({
  fromTeamId: z.string().uuid(),
  toTeamId: z.string().uuid(),
  assets: z.array(assetSchema).min(2).max(20),
  proposerDrops: z.array(z.string()).max(10).default([]),
  message: z.string().max(500).default(''),
});

type Asset = z.infer<typeof assetSchema>;

interface TradeRow {
  id: string; league_id: string; proposer_team_id: string; recipient_team_id: string; parent_trade_id: string | null; status: string;
  message: string; proposer_drops: string[]; recipient_drops: string[]; review_route: string | null; review_reason: string | null;
  review_ends_at: string | null; flags: TradeFlag[]; analysis: TradeAnalysis | null; decision_reason: string | null; expires_at: string;
  created_at: string; accepted_at: string | null; signature: string; created_by: string | null;
}

function signature(assets: Asset[]): string {
  return assets.map((a) => `${a.fromTeamId}>${a.toTeamId}:${a.type}:${a.playerId ?? ''}:${a.faabAmount ?? ''}:${a.draftSeason ?? ''}:${a.draftRound ?? ''}:${a.draftOriginalTeamId ?? ''}`).sort().join('|');
}

async function tradeAssets(db: Db, tradeId: string): Promise<Asset[]> {
  const rows = await db.query<any>('SELECT * FROM trade_assets WHERE trade_id = $1', [tradeId]);
  return rows.map((r) => ({ fromTeamId: r.from_team_id, toTeamId: r.to_team_id, type: r.asset_type, playerId: r.player_id, faabAmount: r.faab_amount, draftRound: r.draft_round, draftSeason: r.draft_season, draftOriginalTeamId: r.draft_original_team_id }));
}

async function pickOwner(db: Db, leagueId: string, season: number, round: number, originalTeamId: string): Promise<string> {
  const r = await db.one<{ owner_team_id: string }>('SELECT owner_team_id FROM draft_pick_ownership WHERE league_id = $1 AND season = $2 AND round = $3 AND original_team_id = $4', [leagueId, season, round, originalTeamId]);
  return r?.owner_team_id ?? originalTeamId;
}

/** Structural + roster validation shared by propose, accept and execute. */
async function validateAll(app: App, db: Db, league: LeagueRow, teamA: string, teamB: string, assets: Asset[], dropsA: string[], dropsB: string[], phase: 'propose' | 'accept' | 'execute') {
  const ownerRows = await db.query<{ player_id: string; team_id: string }>('SELECT player_id, team_id FROM roster_entries WHERE league_id = $1 AND player_id = ANY($2)', [league.id, [...assets.map((a) => a.playerId).filter(Boolean), ...dropsA, ...dropsB]]);
  const owner = new Map(ownerRows.map((r) => [r.player_id, r.team_id]));
  const faab = Object.fromEntries((await db.query<{ id: string; faab_remaining: number }>('SELECT id, faab_remaining FROM teams WHERE id = ANY($1)', [[teamA, teamB]])).map((t) => [t.id, t.faab_remaining]));
  const checks = validateTradeAssets({
    assets: assets as TradeAsset[], teamA, teamB, settings: league.settings.trades, ownerOf: (id) => owner.get(id) ?? null, faabRemaining: faab,
    week: league.current_week, tradeWindowOpen: league.status === 'in_season' || (league.status === 'playoffs' && league.settings.trades.tradeDeadlineWeek === 0),
  }).filter((c) => !(phase === 'execute' && c.code === 'deadline'));
  if (checks.length) throw badRequest(checks[0].message, checks);
  for (const a of assets.filter((x) => x.type === 'draft_pick')) {
    const orig = a.draftOriginalTeamId ?? a.fromTeamId;
    if ((await pickOwner(db, league.id, a.draftSeason!, a.draftRound!, orig)) !== a.fromTeamId) throw badRequest('A draft pick in this trade is not owned by the sending team.');
  }
  // Locked players cannot move until their week is finalized.
  const playerIds = assets.filter((a) => a.type === 'player').map((a) => a.playerId!);
  const locked = await lockedPlayerIds(db, { season: league.season, week: league.current_week, now: app.clock.now(), mode: league.settings.season.lineupLock, playerIds: [...playerIds, ...dropsA, ...dropsB] });
  if (phase !== 'propose' && locked.size) return { locked: true as const };
  // Roster room after the trade, including chosen drops.
  for (const [team, drops] of [[teamA, dropsA], [teamB, dropsB]] as const) {
    // At proposal time only the proposer's roster room is checked; the recipient chooses drops when accepting.
    if (phase === 'propose' && team === teamB) continue;
    for (const d of drops) if (owner.get(d) !== team) throw badRequest('A player selected to drop is not on that roster.');
    if (drops.some((d) => playerIds.includes(d))) throw badRequest('You cannot drop a player who is part of the trade.');
    const rows = await rosterRows(db, team);
    const outgoing = assets.filter((a) => a.type === 'player' && a.fromTeamId === team).map((a) => a.playerId!);
    const incoming = assets.filter((a) => a.type === 'player' && a.toTeamId === team).map((a) => a.playerId!);
    const pos = (await db.query<{ position: Position }>('SELECT position FROM nfl_players WHERE id = ANY($1)', [incoming])).map((r) => r.position);
    const room = hasRoomFor(rows.map((r) => ({ playerId: r.player_id, position: r.position, slot: r.slot, injuryStatus: r.injury_status, locked: false })), league.settings.roster, pos, [...outgoing, ...drops]);
    if (room) {
      const t = await db.one<{ name: string }>('SELECT name FROM teams WHERE id = $1', [team]);
      throw badRequest(`${t?.name}: ${room.message}`, [{ code: 'needs_drop', teamId: team }]);
    }
  }
  return { locked: locked.size > 0 };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export async function buildAnalysis(app: App, db: Db, league: LeagueRow, teamA: string, teamB: string, assets: Asset[]): Promise<TradeAnalysis> {
  const se = league.settings.season;
  const lastWeek = se.startWeek + se.regularSeasonWeeks - 1;
  const horizon = Math.max(1, Math.min(6, lastWeek - league.current_week + 1));
  const pool = await db.query<{ id: string; position: Position }>('SELECT id, position FROM nfl_players WHERE active ORDER BY rank LIMIT 350');
  const ids = [...new Set([...pool.map((p) => p.id), ...assets.filter((a) => a.playerId).map((a) => a.playerId!)])];
  const [p1, p2] = await Promise.all([projectionsFor(db, league, league.current_week, ids), projectionsFor(db, league, league.current_week + 1, ids)]);
  const weekly = (id: string) => Math.max(p1.get(id)?.points ?? 0, p2.get(id)?.points ?? 0);
  const meta = new Map((await db.query<{ id: string; full_name: string; position: Position; injury_status: any; nfl_team_id: string | null }>('SELECT id, full_name, position, injury_status, nfl_team_id FROM nfl_players WHERE id = ANY($1)', [ids])).map((r) => [r.id, r]));
  const teams = (await db.one<{ c: number }>('SELECT count(*)::int AS c FROM teams WHERE league_id = $1', [league.id]))!.c;
  const r = league.settings.roster;
  const flexShare = r.FLEX / 3;
  const demand: Record<Position, number> = { QB: teams * (r.QB + r.SUPERFLEX), RB: Math.round(teams * (r.RB + flexShare)), WR: Math.round(teams * (r.WR + flexShare)), TE: Math.round(teams * (r.TE + flexShare)), K: teams * r.K, DST: teams * r.DST };
  const repl = replacementLevels(pool.map((p) => ({ id: p.id, position: p.position, weeklyProjection: weekly(p.id) })), demand);
  const byes = await byeWeeks(db, league.season);
  const rosterOf = async (team: string) => rosterRows(db, team);
  const [ra, rb] = await Promise.all([rosterOf(teamA), rosterOf(teamB)]);
  const players: TradePlayerInfo[] = [];
  for (const a of assets.filter((x) => x.type === 'player')) {
    const m = meta.get(a.playerId!);
    if (!m) continue;
    const roster = a.fromTeamId === teamA ? ra : rb;
    const entry = roster.find((x) => x.player_id === a.playerId);
    players.push({
      id: m.id, name: m.full_name, position: m.position, teamId: a.fromTeamId, weeklyProjection: Math.round(weekly(m.id) * 10) / 10,
      value: playerValue({ id: m.id, position: m.position, weeklyProjection: weekly(m.id) }, repl, horizon),
      injuryStatus: m.injury_status, byeWeek: m.nfl_team_id ? (byes.get(m.nfl_team_id) ?? [])[0] ?? null : null, locked: false,
      isStarter: Boolean(entry && entry.slot !== 'BN' && entry.slot !== 'IR'),
    });
  }
  const needs = async (roster: typeof ra): Promise<Position[]> => {
    const out: Position[] = [];
    for (const pos of ['QB', 'RB', 'WR', 'TE'] as Position[]) {
      const best = roster.filter((x) => x.position === pos).map((x) => weekly(x.player_id)).sort((a, b) => b - a);
      const req = (r as unknown as Record<string, number>)[pos] ?? 0;
      if (best.length < req || (best[req - 1] ?? 0) < repl[pos] * 1.05) out.push(pos);
    }
    return out;
  };
  const starterByes = (roster: typeof ra) => [...new Set(roster.filter((x) => x.slot !== 'BN' && x.slot !== 'IR' && x.nfl_team_id).map((x) => (byes.get(x.nfl_team_id!) ?? [])[0]).filter((x): x is number => typeof x === 'number' && x >= league.current_week))];
  return analyzeTrade({
    teamA, teamB, players, assets: assets as TradeAsset[], horizonWeeks: horizon,
    teamNeeds: { [teamA]: await needs(ra), [teamB]: await needs(rb) },
    starterByes: { [teamA]: starterByes(ra), [teamB]: starterByes(rb) },
  });
}

async function computeFlags(app: App, db: Db, league: LeagueRow, teamA: string, teamB: string, assets: Asset[], analysis: TradeAnalysis | null, sig: string, excludeId: string | null) {
  const since = new Date(app.clock.now().getTime() - 30 * 86_400_000).toISOString();
  const prior = (await db.one<{ c: number }>(`SELECT count(*)::int AS c FROM trades WHERE league_id = $1 AND status = 'executed' AND executed_at > $2
    AND ((proposer_team_id = $3 AND recipient_team_id = $4) OR (proposer_team_id = $4 AND recipient_team_id = $3))`, [league.id, since, teamA, teamB]))!.c;
  const owners = await db.query<{ joined_at: string }>(`SELECT m.joined_at FROM league_members m JOIN teams t ON t.owner_user_id = m.user_id AND t.league_id = m.league_id WHERE t.id = ANY($1)`, [[teamA, teamB]]);
  const newest = owners.length ? Math.min(...owners.map((o) => (app.clock.now().getTime() - Date.parse(o.joined_at)) / 86_400_000)) : 999;
  const share = async (team: string) => {
    const rows = await rosterRows(db, team);
    const starters = rows.filter((r) => r.slot !== 'BN' && r.slot !== 'IR');
    const out = assets.filter((a) => a.type === 'player' && a.fromTeamId === team && starters.some((s) => s.player_id === a.playerId)).length;
    return starters.length ? out / starters.length : 0;
  };
  let eliminatedDump = false;
  if (league.settings.season.playoffTeams > 0) {
    const st = await leagueStandings(db, league);
    for (const team of [teamA, teamB]) {
      if (st.find((s) => s.teamId === team)?.playoffStatus !== 'eliminated') continue;
      const top = await db.one(`SELECT 1 FROM nfl_players WHERE id = ANY($1) AND rank <= 40`, [assets.filter((a) => a.fromTeamId === team && a.playerId).map((a) => a.playerId!)]);
      if (top) eliminatedDump = true;
    }
  }
  const dup = await db.one(`SELECT 1 FROM trades WHERE league_id = $1 AND signature = $2 AND status IN ('proposed','in_review','approved') AND ($3::uuid IS NULL OR id <> $3)`, [league.id, sig, excludeId]);
  return integrityFlags({ analysis, priorTradesBetweenPair30d: prior, newestMemberDays: newest, starterShareSentA: await share(teamA), starterShareSentB: await share(teamB), eliminatedTeamSendsTopPlayer: eliminatedDump, duplicateOfOpenTrade: Boolean(dup) });
}

/** Preview analysis without creating a trade (used by the trade builder). */
export async function previewTrade(app: App, actor: Actor, input: unknown) {
  const p = proposeSchema.parse(input);
  await requireTeamControl(app.db, actor, p.fromTeamId);
  const league = await getLeague(app.db, (await app.db.one<{ league_id: string }>('SELECT league_id FROM teams WHERE id = $1', [p.fromTeamId]))!.league_id);
  let problems: unknown = null;
  try { await validateAll(app, app.db, league, p.fromTeamId, p.toTeamId, p.assets, p.proposerDrops, [], 'propose'); } catch (e) { problems = { message: (e as Error).message, details: (e as any).details ?? null }; }
  const analysis = league.settings.trades.analysisMode === 'off' ? null : await buildAnalysis(app, app.db, league, p.fromTeamId, p.toTeamId, p.assets);
  return { analysis, problems, disclaimer: FLAG_DISCLAIMER };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function insertTrade(app: App, db: Db, league: LeagueRow, p: z.infer<typeof proposeSchema>, actor: Actor, parentId: string | null) {
  await validateAll(app, db, league, p.fromTeamId, p.toTeamId, p.assets, p.proposerDrops, [], 'propose');
  const sig = signature(p.assets);
  const analysis = league.settings.trades.analysisMode === 'off' ? null : await buildAnalysis(app, db, league, p.fromTeamId, p.toTeamId, p.assets);
  const flags = await computeFlags(app, db, league, p.fromTeamId, p.toTeamId, p.assets, analysis, sig, null);
  if (flags.some((f) => f.code === 'duplicate')) throw conflict('An identical trade between these teams is already open.');
  const expires = new Date(app.clock.now().getTime() + league.settings.trades.offerExpiryHours * 3_600_000).toISOString();
  const t = await db.one<{ id: string }>(`INSERT INTO trades (league_id, proposer_team_id, recipient_team_id, parent_trade_id, status, message, proposer_drops, flags, analysis, expires_at, created_by, signature)
    VALUES ($1,$2,$3,$4,'proposed',$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [league.id, p.fromTeamId, p.toTeamId, parentId, p.message, JSON.stringify(p.proposerDrops), JSON.stringify(flags), analysis ? JSON.stringify(analysis) : null, expires, actor.kind === 'user' ? actor.userId : null, sig]);
  for (const a of p.assets) {
    await db.query(`INSERT INTO trade_assets (trade_id, from_team_id, to_team_id, asset_type, player_id, faab_amount, draft_round, draft_season, draft_original_team_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [t!.id, a.fromTeamId, a.toTeamId, a.type, a.playerId ?? null, a.faabAmount ?? null, a.draftRound ?? null, a.draftSeason ?? null, a.type === 'draft_pick' ? a.draftOriginalTeamId ?? a.fromTeamId : null]);
  }
  return t!.id;
}

export async function proposeTrade(app: App, actor: Actor, input: unknown) {
  const p = proposeSchema.parse(input);
  const { team } = await requireTeamControl(app.db, actor, p.fromTeamId);
  await requirePermission(app.db, actor, team.league_id, 'trade.propose');
  const to = await app.db.one<{ league_id: string; is_ai: boolean }>('SELECT league_id, is_ai FROM teams WHERE id = $1', [p.toTeamId]);
  if (!to || to.league_id !== team.league_id) throw badRequest('Both teams must be in the same league.');
  const id = await withTx(app, async (db) => {
    const league = await getLeague(db, team.league_id);
    const tradeId = await insertTrade(app, db, league, p, actor, null);
    await activity(app, db, league.id, 'trade_proposed', `${team.name} proposed a trade.`, { tradeId });
    await notifyTeamOwner(app, db, p.toTeamId, { leagueId: league.id, kind: 'trade_proposal', title: `New trade offer from ${team.name}`, link: `/league/${league.id}/trades` });
    publishLeague(app, db, league.id, 'trades', {});
    return tradeId;
  });
  if (to.is_ai) await aiRespond(app, id);
  return { tradeId: id };
}

async function lockTrade(db: Db, id: string): Promise<TradeRow> {
  const t = await db.one<TradeRow>('SELECT * FROM trades WHERE id = $1 FOR UPDATE', [id]);
  if (!t) throw notFound('Trade');
  return t;
}

export async function acceptTrade(app: App, actor: Actor, input: { tradeId: string; recipientDrops?: string[] }) {
  const t0 = await app.db.one<TradeRow>('SELECT * FROM trades WHERE id = $1', [input.tradeId]);
  if (!t0) throw notFound('Trade');
  await requireTeamControl(app.db, actor, t0.recipient_team_id);
  const result = await withTx(app, async (db) => {
    const t = await lockTrade(db, input.tradeId);
    if (t.status !== 'proposed') throw conflict(`This trade is ${t.status.replace('_', ' ')}.`);
    if (Date.parse(t.expires_at) <= app.clock.now().getTime()) throw badRequest('This offer has expired.');
    const league = await getLeague(db, t.league_id);
    const assets = await tradeAssets(db, t.id);
    const drops = input.recipientDrops ?? [];
    await validateAll(app, db, league, t.proposer_team_id, t.recipient_team_id, assets, t.proposer_drops, drops, 'accept');
    const flags = await computeFlags(app, db, league, t.proposer_team_id, t.recipient_team_id, assets, t.analysis, t.signature, t.id);
    const playerCount = assets.filter((a) => a.type === 'player').length;
    let route = reviewRoute(league.settings.trades, t.analysis, playerCount, flags);
    let eligibleVoters = 0;
    if (route.route === 'league_vote') {
      eligibleVoters = (await voters(db, league, t)).length;
      if (eligibleVoters === 0) route = { route: 'commissioner', reason: 'League vote has no eligible voters; sent to the commissioner.' };
    }
    const now = app.clock.now();
    await db.query(`UPDATE trades SET recipient_drops = $2, accepted_at = $3, flags = $4, review_route = $5, review_reason = $6, status = $7, review_ends_at = $8 WHERE id = $1`,
      [t.id, JSON.stringify(drops), now.toISOString(), JSON.stringify(flags), route.route, route.reason, route.route === 'auto' ? 'approved' : 'in_review',
        route.route === 'auto' ? null : new Date(now.getTime() + league.settings.trades.reviewHours * 3_600_000).toISOString()]);
    const names = await teamNames(db, [t.proposer_team_id, t.recipient_team_id]);
    await activity(app, db, league.id, 'trade_accepted', `${names[1]} accepted a trade with ${names[0]}. ${route.reason}`, { tradeId: t.id });
    await notifyTeamOwner(app, db, t.proposer_team_id, { leagueId: league.id, kind: 'trade_decision', title: `${names[1]} accepted your trade`, body: route.reason, link: `/league/${league.id}/trades` });
    if (route.route === 'commissioner') {
      const exceptions = (await db.query<{ owner_user_id: string }>('SELECT owner_user_id FROM teams WHERE id = ANY($1) AND owner_user_id IS NOT NULL', [[t.proposer_team_id, t.recipient_team_id]])).map((r) => r.owner_user_id);
      await notifyCommissioners(app, db, league.id, { kind: 'commissioner_queue', title: 'A trade needs your review', body: route.reason, link: `/league/${league.id}/commissioner` }, exceptions);
    }
    if (route.route === 'league_vote') {
      for (const v of await voters(db, league, t)) await notify(app, db, { userId: v, leagueId: league.id, kind: 'trade_vote', title: 'Vote on a pending trade', link: `/league/${league.id}/trades` });
    }
    publishLeague(app, db, league.id, 'trades', {});
    return { route: route.route, reason: route.reason };
  });
  if (result.route === 'auto') await executeTrade(app, input.tradeId);
  return result;
}

async function teamNames(db: Db, ids: string[]): Promise<string[]> {
  const rows = await db.query<{ id: string; name: string }>('SELECT id, name FROM teams WHERE id = ANY($1)', [ids]);
  return ids.map((id) => rows.find((r) => r.id === id)?.name ?? 'A team');
}

export async function rejectTrade(app: App, actor: Actor, input: { tradeId: string; reason?: string }) {
  const t0 = await app.db.one<TradeRow>('SELECT * FROM trades WHERE id = $1', [input.tradeId]);
  if (!t0) throw notFound('Trade');
  await requireTeamControl(app.db, actor, t0.recipient_team_id);
  return withTx(app, async (db) => {
    const t = await lockTrade(db, input.tradeId);
    if (t.status !== 'proposed') throw conflict(`This trade is ${t.status}.`);
    await db.query("UPDATE trades SET status = 'rejected', decision_reason = $2, decided_at = now() WHERE id = $1", [t.id, input.reason?.slice(0, 300) ?? null]);
    const names = await teamNames(db, [t.proposer_team_id, t.recipient_team_id]);
    await notifyTeamOwner(app, db, t.proposer_team_id, { leagueId: t.league_id, kind: 'trade_decision', title: `${names[1]} declined your trade`, body: input.reason ?? '', link: `/league/${t.league_id}/trades` });
    publishLeague(app, db, t.league_id, 'trades', {});
    return { ok: true };
  });
}

export async function counterTrade(app: App, actor: Actor, input: { tradeId: string; assets: unknown; proposerDrops?: string[]; message?: string }) {
  const t0 = await app.db.one<TradeRow>('SELECT * FROM trades WHERE id = $1', [input.tradeId]);
  if (!t0) throw notFound('Trade');
  const { team } = await requireTeamControl(app.db, actor, t0.recipient_team_id);
  const p = proposeSchema.parse({ fromTeamId: t0.recipient_team_id, toTeamId: t0.proposer_team_id, assets: input.assets, proposerDrops: input.proposerDrops ?? [], message: input.message ?? '' });
  const to = await app.db.one<{ is_ai: boolean }>('SELECT is_ai FROM teams WHERE id = $1', [t0.proposer_team_id]);
  const id = await withTx(app, async (db) => {
    const t = await lockTrade(db, input.tradeId);
    if (t.status !== 'proposed') throw conflict(`This trade is ${t.status}.`);
    await db.query("UPDATE trades SET status = 'countered', decided_at = now() WHERE id = $1", [t.id]);
    const league = await getLeague(db, t.league_id);
    const newId = await insertTrade(app, db, league, p, actor, t.id);
    await notifyTeamOwner(app, db, t.proposer_team_id, { leagueId: league.id, kind: 'trade_counter', title: `${team.name} sent a counteroffer`, link: `/league/${league.id}/trades` });
    publishLeague(app, db, league.id, 'trades', {});
    return newId;
  });
  if (to?.is_ai) await aiRespond(app, id);
  return { tradeId: id };
}

export async function cancelTrade(app: App, actor: Actor, input: { tradeId: string }) {
  const t0 = await app.db.one<TradeRow>('SELECT * FROM trades WHERE id = $1', [input.tradeId]);
  if (!t0) throw notFound('Trade');
  await requireTeamControl(app.db, actor, t0.proposer_team_id);
  return withTx(app, async (db) => {
    const t = await lockTrade(db, input.tradeId);
    if (t.status !== 'proposed') throw conflict('Only offers that have not been accepted can be canceled.');
    await db.query("UPDATE trades SET status = 'canceled', decided_at = now() WHERE id = $1", [t.id]);
    publishLeague(app, db, t.league_id, 'trades', {});
    return { ok: true };
  });
}

/** Managers (not observers) with a human-owned team; involved managers only if the league allows it. */
async function voters(db: Db, league: LeagueRow, t: TradeRow): Promise<string[]> {
  const rows = await db.query<{ owner_user_id: string; id: string }>(`SELECT t.owner_user_id, t.id FROM teams t JOIN league_members m ON m.user_id = t.owner_user_id AND m.league_id = t.league_id
    WHERE t.league_id = $1 AND t.owner_user_id IS NOT NULL AND m.role <> 'observer'`, [league.id]);
  return rows.filter((r) => league.settings.trades.involvedManagersCanVote || (r.id !== t.proposer_team_id && r.id !== t.recipient_team_id)).map((r) => r.owner_user_id);
}

export async function voteTrade(app: App, actor: Actor, input: { tradeId: string; vote: 'approve' | 'veto' }) {
  const userId = actor.kind === 'user' ? actor.userId : null;
  if (!userId) throw forbidden();
  const t0 = await app.db.one<TradeRow>('SELECT * FROM trades WHERE id = $1', [input.tradeId]);
  if (!t0) throw notFound('Trade');
  await requirePermission(app.db, actor, t0.league_id, 'trade.vote');
  const decided = await withTx(app, async (db) => {
    const t = await lockTrade(db, input.tradeId);
    if (t.status !== 'in_review' || t.review_route !== 'league_vote') throw badRequest('This trade is not open for voting.');
    const league = await getLeague(db, t.league_id);
    const eligible = await voters(db, league, t);
    if (!eligible.includes(userId)) throw forbidden('You are not eligible to vote on this trade.');
    try {
      await db.query('INSERT INTO trade_votes (trade_id, user_id, vote) VALUES ($1,$2,$3)', [t.id, userId, input.vote]);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('You have already voted on this trade.');
      throw e;
    }
    publishLeague(app, db, t.league_id, 'trades', {});
    return finalizeVoteIfDecided(app, db, league, t, false);
  });
  if (decided === 'approved') await executeTrade(app, input.tradeId);
  return { ok: true, outcome: decided };
}

async function finalizeVoteIfDecided(app: App, db: Db, league: LeagueRow, t: TradeRow, closed: boolean) {
  const eligible = (await voters(db, league, t)).length;
  const counts = await db.one<{ approve: number; veto: number }>("SELECT count(*) FILTER (WHERE vote = 'approve')::int AS approve, count(*) FILTER (WHERE vote = 'veto')::int AS veto FROM trade_votes WHERE trade_id = $1", [t.id]);
  const outcome = decideVote({ approve: counts!.approve, veto: counts!.veto, eligible }, league.settings.trades.vetoThreshold, closed);
  if (outcome === 'pending') return outcome;
  const reason = `League vote: ${counts!.approve} approve, ${counts!.veto} veto of ${eligible} eligible (veto needs ${Math.ceil(league.settings.trades.vetoThreshold * eligible)}).`;
  await db.query('UPDATE trades SET status = $2, decision_reason = $3, decided_at = now() WHERE id = $1', [t.id, outcome === 'approved' ? 'approved' : 'vetoed', reason]);
  await audit(db, { leagueId: league.id, actor: { kind: 'system' }, action: `trade.vote_${outcome}`, target: t.id, reason });
  if (outcome === 'vetoed') await tradeDecisionNotices(app, db, t, 'vetoed', reason);
  return outcome;
}

async function tradeDecisionNotices(app: App, db: Db, t: TradeRow, outcome: string, reason: string) {
  for (const team of [t.proposer_team_id, t.recipient_team_id]) {
    await notifyTeamOwner(app, db, team, { leagueId: t.league_id, kind: 'trade_decision', title: `Trade ${outcome}`, body: reason, link: `/league/${t.league_id}/trades` });
  }
  await activity(app, db, t.league_id, `trade_${outcome}`, `A trade was ${outcome}. ${reason}`, { tradeId: t.id });
}

export async function commissionerDecision(app: App, actor: Actor, input: { tradeId: string; decision: 'approve' | 'veto'; reason: string }) {
  const t0 = await app.db.one<TradeRow>('SELECT * FROM trades WHERE id = $1', [input.tradeId]);
  if (!t0) throw notFound('Trade');
  await requirePermission(app.db, actor, t0.league_id, 'trade.review');
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 3) throw badRequest('Explain the decision; it is shown to the league.');
  const userId = actor.kind === 'user' ? actor.userId : null;
  await withTx(app, async (db) => {
    const t = await lockTrade(db, input.tradeId);
    if (t.status !== 'in_review') throw conflict(`This trade is ${t.status}.`);
    let selfReview = false;
    if (userId) {
      const involved = await db.one('SELECT 1 FROM teams WHERE id = ANY($1) AND owner_user_id = $2', [[t.proposer_team_id, t.recipient_team_id], userId]);
      if (involved) {
        const others = await db.one("SELECT 1 FROM league_members WHERE league_id = $1 AND role IN ('commissioner','co_commissioner') AND user_id <> $2 LIMIT 1", [t.league_id, userId]);
        if (others) throw forbidden('You are part of this trade; another commissioner must review it.');
        selfReview = true;
      }
    }
    const status = input.decision === 'approve' ? 'approved' : 'vetoed';
    await db.query('UPDATE trades SET status = $2, decision_reason = $3, decided_by = $4, decided_at = now() WHERE id = $1', [t.id, status, reason, userId]);
    await audit(db, { leagueId: t.league_id, actor, action: `trade.commissioner_${input.decision}`, target: t.id, reason, payload: { selfReview, flags: t.flags } });
    if (status === 'vetoed') await tradeDecisionNotices(app, db, t, 'vetoed', `Commissioner: ${reason}`);
    publishLeague(app, db, t.league_id, 'trades', {});
  });
  if (input.decision === 'approve') await executeTrade(app, input.tradeId);
  return { ok: true };
}

/** Atomic execution. If players are locked the trade stays approved and executes after the week ends. */
export async function executeTrade(app: App, tradeId: string): Promise<'executed' | 'waiting' | 'failed'> {
  try {
    return await withTx(app, async (db) => {
      const t = await lockTrade(db, tradeId);
      if (t.status !== 'approved') return t.status === 'executed' ? 'executed' : 'failed';
      const league = await getLeague(db, t.league_id);
      await db.query('SELECT id FROM teams WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[t.proposer_team_id, t.recipient_team_id]]);
      const assets = await tradeAssets(db, t.id);
      let v: { locked: boolean };
      try {
        v = await validateAll(app, db, league, t.proposer_team_id, t.recipient_team_id, assets, t.proposer_drops, t.recipient_drops, 'execute');
      } catch (e) {
        const reason = `Could not execute: ${(e as Error).message}`;
        await db.query("UPDATE trades SET status = 'failed', decision_reason = $2 WHERE id = $1", [t.id, reason]);
        await tradeDecisionNotices(app, db, t, 'failed', reason);
        return 'failed';
      }
      if (v.locked) return 'waiting';
      for (const d of t.proposer_drops) await dropInternal(app, db, league, t.proposer_team_id, d, 'trade_drop');
      for (const d of t.recipient_drops) await dropInternal(app, db, league, t.recipient_team_id, d, 'trade_drop');
      const moved: string[] = [];
      for (const a of assets) {
        if (a.type === 'player') {
          const r = await db.query("UPDATE roster_entries SET team_id = $3, slot = 'BN', acquired_via = 'trade', acquired_at = now() WHERE league_id = $1 AND player_id = $2 AND team_id = $4 RETURNING id", [league.id, a.playerId, a.toTeamId, a.fromTeamId]);
          if (!r.length) throw conflict('A player in this trade moved before it could execute.');
          moved.push(a.playerId!);
        } else if (a.type === 'faab') {
          await db.query('UPDATE teams SET faab_remaining = faab_remaining - $2 WHERE id = $1', [a.fromTeamId, a.faabAmount]);
          await db.query('UPDATE teams SET faab_remaining = faab_remaining + $2 WHERE id = $1', [a.toTeamId, a.faabAmount]);
        } else {
          await db.query(`INSERT INTO draft_pick_ownership (league_id, season, round, original_team_id, owner_team_id) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (league_id, season, round, original_team_id) DO UPDATE SET owner_team_id = EXCLUDED.owner_team_id`, [league.id, a.draftSeason, a.draftRound, a.draftOriginalTeamId ?? a.fromTeamId, a.toTeamId]);
        }
      }
      await db.query("UPDATE trades SET status = 'executed', executed_at = now() WHERE id = $1", [t.id]);
      const names = await teamNames(db, [t.proposer_team_id, t.recipient_team_id]);
      const pNames = new Map((await db.query<{ id: string; full_name: string }>('SELECT id, full_name FROM nfl_players WHERE id = ANY($1)', [moved])).map((r) => [r.id, r.full_name]));
      const side = (team: string) => assets.filter((a) => a.toTeamId === team).map((a) => a.type === 'player' ? pNames.get(a.playerId!) : a.type === 'faab' ? `$${a.faabAmount} FAAB` : `${a.draftSeason} R${a.draftRound} pick`).join(', ');
      const summary = `${names[0]} receive ${side(t.proposer_team_id)}; ${names[1]} receive ${side(t.recipient_team_id)}.`;
      await db.query(`INSERT INTO transactions (league_id, type, status, team_id, summary, details, idempotency_key) VALUES ($1,'trade','completed',$2,$3,$4,$5)`,
        [league.id, t.proposer_team_id, `Trade: ${summary}`, JSON.stringify({ tradeId: t.id }), `trade:${t.id}`]);
      // Other open offers that include moved players can no longer be honored.
      const stale = await db.query<{ id: string }>(`SELECT DISTINCT tr.id FROM trades tr JOIN trade_assets ta ON ta.trade_id = tr.id
        WHERE tr.league_id = $1 AND tr.id <> $2 AND tr.status IN ('proposed','in_review','approved') AND ta.player_id = ANY($3)`, [league.id, t.id, moved]);
      for (const s of stale) await db.query("UPDATE trades SET status = 'failed', decision_reason = 'A player in this offer was traded elsewhere.' WHERE id = $1", [s.id]);
      await tradeDecisionNotices(app, db, t, 'completed', summary);
      publishLeague(app, db, league.id, 'roster', {});
      publishLeague(app, db, league.id, 'trades', {});
      return 'executed';
    });
  } catch (e) {
    const msg = isUniqueViolation(e) ? 'A roster conflict prevented execution.' : (e as Error).message;
    app.log(`trade ${tradeId} execution error: ${msg}`);
    await app.db.query("UPDATE trades SET status = 'failed', decision_reason = $2 WHERE id = $1 AND status = 'approved'", [tradeId, `Could not execute: ${msg}`]);
    return 'failed';
  }
}

async function aiRespond(app: App, tradeId: string) {
  const t = await app.db.one<TradeRow>('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (!t || t.status !== 'proposed') return;
  const team = await app.db.one<{ is_ai: boolean; ai_difficulty: 'easy' | 'medium' | 'hard' }>('SELECT is_ai, ai_difficulty FROM teams WHERE id = $1', [t.recipient_team_id]);
  if (!team?.is_ai) return;
  const league = await getLeague(app.db, t.league_id);
  const assets = await tradeAssets(app.db, t.id);
  const analysis = t.analysis ?? await buildAnalysis(app, app.db, league, t.proposer_team_id, t.recipient_team_id, assets);
  const mine = analysis.sides.find((s) => s.teamId === t.recipient_team_id)!;
  const decision = aiAcceptsTrade(team.ai_difficulty, mine.valueIn, mine.valueOut);
  const actor: Actor = { kind: 'ai', teamId: t.recipient_team_id };
  if (!decision.accept) { await rejectTrade(app, actor, { tradeId, reason: decision.reason }); return; }
  // Choose drops if needed: lowest-projection bench players not involved in the trade.
  const incoming = assets.filter((a) => a.type === 'player' && a.toTeamId === t.recipient_team_id).length;
  const outgoing = assets.filter((a) => a.type === 'player' && a.fromTeamId === t.recipient_team_id).length;
  const rows = await rosterRows(app.db, t.recipient_team_id);
  const need = rows.filter((r) => r.slot !== 'IR').length + incoming - outgoing - activeRosterSize(league.settings.roster);
  const drops: string[] = [];
  if (need > 0) {
    const proj = await projectionsFor(app.db, league, league.current_week, rows.map((r) => r.player_id));
    const candidates = rows.filter((r) => r.slot === 'BN' && !assets.some((a) => a.playerId === r.player_id)).sort((a, b) => (proj.get(a.player_id)?.points ?? 0) - (proj.get(b.player_id)?.points ?? 0));
    drops.push(...candidates.slice(0, need).map((c) => c.player_id));
  }
  try { await acceptTrade(app, actor, { tradeId, recipientDrops: drops }); }
  catch (e) { await rejectTrade(app, actor, { tradeId, reason: `AI manager could not accept: ${(e as Error).message}` }).catch(() => {}); }
}

export async function listTrades(app: App, actor: Actor, input: { leagueId: string; scope?: 'open' | 'all' }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  const league = await getLeague(app.db, input.leagueId);
  const rows = await app.db.query<TradeRow>(`SELECT * FROM trades WHERE league_id = $1 ${input.scope === 'all' ? '' : "AND (status IN ('proposed','in_review','approved') OR decided_at > now() - interval '14 days')"} ORDER BY created_at DESC LIMIT 100`, [league.id]);
  const userId = actor.kind === 'user' ? actor.userId : null;
  const out = [];
  for (const t of rows) {
    const assets = await app.db.query(`SELECT ta.*, p.full_name, p.position, p.nfl_team_id, p.injury_status FROM trade_assets ta LEFT JOIN nfl_players p ON p.id = ta.player_id WHERE ta.trade_id = $1`, [t.id]);
    const votes = await app.db.query<{ user_id: string; vote: string }>('SELECT user_id, vote FROM trade_votes WHERE trade_id = $1', [t.id]);
    const closed = t.status !== 'in_review';
    const showCounts = league.settings.trades.showVoteCounts === 'live' || (league.settings.trades.showVoteCounts === 'after_close' && closed);
    const eligible = t.review_route === 'league_vote' ? await voters(app.db, league, t) : [];
    const dropNames = await app.db.query<{ id: string; full_name: string }>('SELECT id, full_name FROM nfl_players WHERE id = ANY($1)', [[...t.proposer_drops, ...t.recipient_drops]]);
    out.push({
      id: t.id, status: t.status, proposerTeamId: t.proposer_team_id, recipientTeamId: t.recipient_team_id, parentTradeId: t.parent_trade_id,
      message: t.message, createdAt: t.created_at, expiresAt: t.expires_at, acceptedAt: t.accepted_at, reviewRoute: t.review_route,
      reviewReason: t.review_reason, reviewEndsAt: t.review_ends_at, decisionReason: t.decision_reason, flags: t.flags, flagDisclaimer: FLAG_DISCLAIMER,
      analysis: t.analysis, assets, proposerDrops: t.proposer_drops, recipientDrops: t.recipient_drops, dropNames,
      votes: showCounts ? { approve: votes.filter((v) => v.vote === 'approve').length, veto: votes.filter((v) => v.vote === 'veto').length } : null,
      votesCast: votes.length, eligibleVoters: eligible.length, myVote: votes.find((v) => v.user_id === userId)?.vote ?? null, canVote: Boolean(userId && eligible.includes(userId)),
    });
  }
  return out;
}

/** Expiry, vote closing, and execution of approved trades waiting on locks. */
export async function tradeTick(app: App): Promise<void> {
  const now = app.clock.now().toISOString();
  const expired = await app.db.query<{ id: string; league_id: string; proposer_team_id: string }>("UPDATE trades SET status = 'expired', decided_at = now() WHERE status = 'proposed' AND expires_at <= $1 RETURNING id, league_id, proposer_team_id", [now]);
  for (const e of expired) { await notifyTeamOwner(app, app.db, e.proposer_team_id, { leagueId: e.league_id, kind: 'trade_decision', title: 'Your trade offer expired' }); app.bus.publish(`league:${e.league_id}`, { type: 'trades' }); }
  const closing = await app.db.query<{ id: string }>("SELECT id FROM trades WHERE status = 'in_review' AND review_route = 'league_vote' AND review_ends_at <= $1", [now]);
  for (const c of closing) {
    const outcome = await withTx(app, async (db) => {
      const t = await lockTrade(db, c.id);
      if (t.status !== 'in_review') return 'pending';
      return finalizeVoteIfDecided(app, db, await getLeague(db, t.league_id), t, true);
    });
    if (outcome === 'approved') await executeTrade(app, c.id);
  }
  const waiting = await app.db.query<{ id: string }>("SELECT id FROM trades WHERE status = 'approved'");
  for (const w of waiting) await executeTrade(app, w.id);
}

export async function pendingCommissionerTrades(app: App, leagueId: string) {
  return app.db.query("SELECT id, proposer_team_id, recipient_team_id, review_reason, review_ends_at, flags FROM trades WHERE league_id = $1 AND status = 'in_review' AND review_route = 'commissioner' ORDER BY accepted_at", [leagueId]);
}

export async function myRoleInTrade(app: App, actor: Actor, tradeId: string) {
  const t = await app.db.one<TradeRow>('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (!t) throw notFound('Trade');
  return actor.kind === 'user' ? roleIn(app.db, t.league_id, actor.userId) : null;
}
