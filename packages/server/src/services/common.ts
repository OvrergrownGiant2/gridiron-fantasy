import { can, leagueSettingsSchema, scoringRulesSchema, type LeagueSettings, type Permission, type Role, type ScoringRules } from '@gridiron/core';
import { forbidden, leagueChannel, notFound, unauthorized, userChannel, type Actor, type App } from '../app';
import type { Db } from '../db/db';

export interface LeagueRow {
  id: string; name: string; description: string; visibility: 'private' | 'public'; season: number;
  max_teams: number; invite_code: string; logo_media_id: string | null; created_by: string;
  status: 'setup' | 'drafting' | 'in_season' | 'playoffs' | 'complete';
  settings: LeagueSettings; settings_version: number; scoring_version: number; current_week: number;
  waiver_next_run_at: string | null; created_at: string;
}

export async function getLeague(db: Db, leagueId: string, forUpdate = false): Promise<LeagueRow> {
  const row = await db.one<LeagueRow>(`SELECT * FROM leagues WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [leagueId]);
  if (!row) throw notFound('League');
  row.settings = leagueSettingsSchema.parse(row.settings);
  return row;
}

export async function getScoringRules(db: Db, leagueId: string, version?: number): Promise<{ version: number; rules: ScoringRules }> {
  const row = version
    ? await db.one<{ version: number; rules: unknown }>('SELECT version, rules FROM scoring_configs WHERE league_id = $1 AND version = $2', [leagueId, version])
    : await db.one<{ version: number; rules: unknown }>('SELECT version, rules FROM scoring_configs WHERE league_id = $1 ORDER BY version DESC LIMIT 1', [leagueId]);
  if (!row) throw notFound('Scoring configuration');
  return { version: row.version, rules: scoringRulesSchema.parse(row.rules) };
}

export function userIdOf(actor: Actor): string | null {
  return actor.kind === 'user' ? actor.userId : null;
}

export function requireUser(actor: Actor): string {
  if (actor.kind !== 'user') throw unauthorized();
  return actor.userId;
}

export async function roleIn(db: Db, leagueId: string, userId: string): Promise<Role | null> {
  const m = await db.one<{ role: Role }>('SELECT role FROM league_members WHERE league_id = $1 AND user_id = $2', [leagueId, userId]);
  return m?.role ?? null;
}

/**
 * Server-side authorization. The role always comes from the database, never from
 * the client. System and AI actors are trusted internal callers; AI actors are
 * additionally restricted to their own team by `requireTeamControl`.
 */
export async function requirePermission(db: Db, actor: Actor, leagueId: string, perm: Permission): Promise<Role | 'system'> {
  if (actor.kind === 'system') return 'system';
  if (actor.kind === 'ai') {
    const t = await db.one<{ league_id: string; is_ai: boolean }>('SELECT league_id, is_ai FROM teams WHERE id = $1', [actor.teamId]);
    if (!t || t.league_id !== leagueId || !t.is_ai) throw forbidden();
    const aiPerms: Permission[] = ['league.view', 'team.manage_own', 'trade.propose', 'waiver.claim', 'draft.pick_own'];
    if (!aiPerms.includes(perm)) throw forbidden();
    return 'manager';
  }
  const role = await roleIn(db, leagueId, actor.userId);
  if (!role) throw notFound('League'); // do not reveal private leagues to non-members
  if (!can(role, perm)) throw forbidden();
  return role;
}

export interface TeamRow {
  id: string; league_id: string; owner_user_id: string | null; is_ai: boolean; ai_difficulty: 'easy' | 'medium' | 'hard' | null;
  name: string; abbrev: string; description: string; primary_color: string; secondary_color: string;
  logo_media_id: string | null; logo_preset: string | null; banner_media_id: string | null;
  waiver_priority: number; faab_remaining: number; draft_slot: number | null;
}

export async function getTeam(db: Db, teamId: string, forUpdate = false): Promise<TeamRow> {
  const t = await db.one<TeamRow>(`SELECT * FROM teams WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [teamId]);
  if (!t) throw notFound('Team');
  return t;
}

/**
 * The actor controls `teamId` if they own it, are the AI driving it, or are a
 * commissioner using an explicit override (callers must audit-log overrides).
 */
export async function requireTeamControl(db: Db, actor: Actor, teamId: string, opts: { allowCommissioner?: boolean } = {}): Promise<{ team: TeamRow; override: boolean }> {
  const team = await getTeam(db, teamId);
  if (actor.kind === 'system') return { team, override: false };
  if (actor.kind === 'ai') {
    if (actor.teamId !== teamId || !team.is_ai) throw forbidden('AI managers can only act for their own team.');
    return { team, override: false };
  }
  const role = await roleIn(db, team.league_id, actor.userId);
  if (!role) throw notFound('Team');
  if (team.owner_user_id === actor.userId && can(role, 'team.manage_own')) return { team, override: false };
  if (opts.allowCommissioner && can(role, 'team.manage_any')) return { team, override: true };
  throw forbidden('You can only manage your own team.');
}

export async function myTeam(db: Db, leagueId: string, userId: string): Promise<TeamRow | null> {
  return db.one<TeamRow>('SELECT * FROM teams WHERE league_id = $1 AND owner_user_id = $2', [leagueId, userId]);
}

// ---------------------------------------------------------------------------
// Audit log, activity feed, notifications
// ---------------------------------------------------------------------------

export async function audit(db: Db, a: { leagueId: string | null; actor: Actor; action: string; target?: string | null; reason?: string | null; payload?: unknown }) {
  await db.query(
    'INSERT INTO audit_log (league_id, actor_user_id, actor_kind, action, target, reason, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [a.leagueId, userIdOf(a.actor), a.actor.kind, a.action, a.target ?? null, a.reason ?? null, JSON.stringify(a.payload ?? {})],
  );
}

export async function activity(app: App, db: Db, leagueId: string, kind: string, summary: string, payload: unknown = {}) {
  await db.query('INSERT INTO activity (league_id, kind, summary, payload) VALUES ($1,$2,$3,$4)', [leagueId, kind, summary, JSON.stringify(payload)]);
  queueEvent(db, () => app.bus.publish(leagueChannel(leagueId), { type: 'activity', leagueId, payload: { kind, summary } }));
}

export const NOTIFICATION_KINDS = {
  trade_proposal: 'Trade proposals',
  trade_counter: 'Trade counteroffers',
  trade_decision: 'Trade decisions',
  trade_vote: 'Trades awaiting your vote',
  waiver_result: 'Waiver results',
  draft_turn: 'Your draft turn',
  player_injury: 'Injuries on your roster',
  lineup_lock: 'Lineup lock reminders',
  matchup_result: 'Matchup results',
  announcement: 'Commissioner announcements',
  commissioner_queue: 'Commissioner review queue',
  chat_mention: 'Chat mentions',
} as const;
export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

export async function notify(app: App, db: Db, n: { userId: string; leagueId: string | null; kind: NotificationKind; title: string; body?: string; link?: string }) {
  const u = await db.one<{ notification_prefs: Record<string, boolean> }>('SELECT notification_prefs FROM users WHERE id = $1', [n.userId]);
  if (!u) return;
  if (u.notification_prefs?.[n.kind] === false) return; // opted out
  await db.query('INSERT INTO notifications (user_id, league_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5,$6)', [n.userId, n.leagueId, n.kind, n.title, n.body ?? '', n.link ?? null]);
  queueEvent(db, () => app.bus.publish(userChannel(n.userId), { type: 'notification', userId: n.userId, payload: { title: n.title } }));
}

export async function notifyTeamOwner(app: App, db: Db, teamId: string, n: Omit<Parameters<typeof notify>[2], 'userId'>) {
  const t = await db.one<{ owner_user_id: string | null }>('SELECT owner_user_id FROM teams WHERE id = $1', [teamId]);
  if (t?.owner_user_id) await notify(app, db, { ...n, userId: t.owner_user_id });
}

export async function notifyCommissioners(app: App, db: Db, leagueId: string, n: Omit<Parameters<typeof notify>[2], 'userId' | 'leagueId'>, exceptUserIds: string[] = []) {
  const rows = await db.query<{ user_id: string }>("SELECT user_id FROM league_members WHERE league_id = $1 AND role IN ('commissioner','co_commissioner')", [leagueId]);
  for (const r of rows) if (!exceptUserIds.includes(r.user_id)) await notify(app, db, { ...n, userId: r.user_id, leagueId });
}

/**
 * Realtime events must only fire after the transaction commits, otherwise clients
 * could refetch and see nothing. Events raised inside a transaction are queued on
 * the Db object and flushed by `flushEvents` after commit.
 */
const pending = new WeakMap<object, (() => void)[]>();
export function queueEvent(db: Db, fn: () => void) {
  if (!db.inTx) { fn(); return; }
  const list = pending.get(db) ?? [];
  list.push(fn);
  pending.set(db, list);
}

/** Transaction helper that flushes queued realtime events after a successful commit. */
export async function withTx<T>(app: App, fn: (db: Db) => Promise<T>): Promise<T> {
  if (app.db.inTx) return fn(app.db);
  let txDb: Db | null = null;
  const out = await app.db.tx(async (db) => { txDb = db; return fn(db); });
  if (txDb) {
    const list = pending.get(txDb) ?? [];
    pending.delete(txDb);
    for (const f of list) { try { f(); } catch { /* ignore */ } }
  }
  return out;
}

export function publishLeague(app: App, db: Db, leagueId: string, type: string, payload?: unknown) {
  queueEvent(db, () => app.bus.publish(leagueChannel(leagueId), { type, leagueId, payload }));
}
