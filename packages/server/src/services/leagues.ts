import {
  AI_TEAM_NAMES, DEFAULT_COLORS, INVITE_ALPHABET, PRESET_PALETTES, ROLE_PERMISSIONS, defaultLeagueSettings, doubleHeaderSchedule,
  isHex, leagueSettingsSchema, playoffRounds, roundRobin, scoringPreset, scoringRulesSchema, validateLeagueSettings,
  type LeagueSettings, type Role, type ScoringRules,
} from '@gridiron/core';
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound, type Actor, type App } from '../app';
import { isUniqueViolation, type Db } from '../db/db';
import {
  activity, audit, getLeague, getScoringRules, myTeam, notify, requirePermission, requireTeamControl, requireUser, roleIn, withTx, type LeagueRow,
} from './common';
import { currentNflWeek, seasonOf } from './nfl';

export const createLeagueSchema = z.object({
  name: z.string().trim().min(3).max(50),
  description: z.string().trim().max(500).default(''),
  visibility: z.enum(['private', 'public']).default('private'),
  teamCount: z.number().int().min(1).max(10),
  aiTeams: z.number().int().min(0).max(9).default(0),
  aiDifficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  teamName: z.string().trim().min(2).max(40),
  settings: leagueSettingsSchema.optional(),
  scoring: scoringRulesSchema.optional(),
  scoringPreset: z.enum(['standard', 'half_ppr', 'ppr']).optional(),
});

async function uniqueInviteCode(app: App, db: Db): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const raw = app.platform.randomToken(16);
    let code = '';
    for (let j = 0; j < 8; j++) code += INVITE_ALPHABET[raw.charCodeAt(j) % INVITE_ALPHABET.length];
    if (!(await db.one('SELECT 1 FROM leagues WHERE invite_code = $1', [code]))) return code;
  }
  throw new Error('Could not allocate an invite code.');
}

function abbrevFrom(name: string, taken: Set<string>): string {
  const letters = name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  let base = (letters.length >= 2 ? letters.map((w) => w[0]).join('') : (letters[0] ?? 'TEAM')).toUpperCase().slice(0, 4) || 'TEAM';
  if (base.length < 2) base = (letters[0] ?? 'TM').toUpperCase().slice(0, 3);
  let a = base, n = 2;
  while (taken.has(a)) a = `${base.slice(0, 3)}${n++}`;
  taken.add(a);
  return a;
}

export async function activeSeason(app: App): Promise<{ season: number; week: number }> {
  const season = await seasonOf(app.db);
  if (season) return { season, week: await currentNflWeek(app.db, season) };
  try {
    const cs = await app.provider.currentSeason(app.clock.now());
    return { season: cs.season, week: cs.week };
  } catch {
    const d = app.clock.now();
    return { season: d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(), week: 1 };
  }
}

/** Fit a requested season into the weeks that remain on the NFL calendar. */
export function fitSeasonToCalendar(s: LeagueSettings, firstWeek: number): { settings: LeagueSettings; adjusted: string | null } {
  const out = structuredClone(s);
  const notes: string[] = [];
  if (out.season.startWeek < firstWeek) { notes.push(`start week moved from ${out.season.startWeek} to ${firstWeek}`); out.season.startWeek = firstWeek; }
  const maxReg = 18 - out.season.startWeek + 1 - playoffRounds(out.season.playoffTeams);
  if (out.season.regularSeasonWeeks > maxReg) {
    if (maxReg < 1) { out.season.playoffTeams = 0; out.season.regularSeasonWeeks = Math.max(1, 18 - out.season.startWeek + 1); notes.push('playoffs disabled: not enough weeks remain'); }
    else { notes.push(`regular season shortened from ${out.season.regularSeasonWeeks} to ${maxReg} weeks`); out.season.regularSeasonWeeks = maxReg; }
  }
  const regEnd = out.season.startWeek + out.season.regularSeasonWeeks - 1;
  if (out.trades.tradeDeadlineWeek > regEnd) out.trades.tradeDeadlineWeek = regEnd;
  if (out.trades.tradeDeadlineWeek > 0 && out.trades.tradeDeadlineWeek < out.season.startWeek) out.trades.tradeDeadlineWeek = Math.min(regEnd, out.season.startWeek + Math.floor(out.season.regularSeasonWeeks * 0.7));
  return { settings: out, adjusted: notes.length ? notes.join('; ') : null };
}

export async function createLeague(app: App, actor: Actor, input: unknown) {
  const userId = requireUser(actor);
  const p = createLeagueSchema.parse(input);
  if (p.aiTeams > p.teamCount - 1) throw badRequest('AI teams must leave at least one seat for you.');
  const settings = p.settings ?? defaultLeagueSettings();
  const scoring: ScoringRules = p.scoring ?? scoringPreset(p.scoringPreset ?? 'ppr');
  const { season, week } = await activeSeason(app);
  const issues = validateLeagueSettings(settings, p.teamCount);
  if (issues.length) throw badRequest('Some league settings are incompatible.', issues);
  return withTx(app, async (db) => {
    const code = await uniqueInviteCode(app, db);
    const league = await db.one<{ id: string }>(
      `INSERT INTO leagues (name, description, visibility, season, max_teams, invite_code, created_by, settings, current_week)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [p.name, p.description, p.visibility, season, p.teamCount, code, userId, JSON.stringify(settings), Math.max(settings.season.startWeek, week)]);
    const leagueId = league!.id;
    await db.query('INSERT INTO league_settings_versions (league_id, version, settings, changed_by, reason) VALUES ($1,1,$2,$3,$4)', [leagueId, JSON.stringify(settings), userId, 'League created']);
    await db.query('INSERT INTO scoring_configs (league_id, version, rules, changed_by, reason) VALUES ($1,1,$2,$3,$4)', [leagueId, JSON.stringify(scoring), userId, 'League created']);
    await db.query("INSERT INTO league_members (league_id, user_id, role) VALUES ($1,$2,'commissioner')", [leagueId, userId]);
    const taken = new Set<string>();
    const faab = settings.waivers.mode === 'faab' ? settings.waivers.faabBudget : 0;
    await db.query(`INSERT INTO teams (league_id, owner_user_id, name, abbrev, primary_color, secondary_color, waiver_priority, faab_remaining)
      VALUES ($1,$2,$3,$4,$5,$6,1,$7)`, [leagueId, userId, p.teamName, abbrevFrom(p.teamName, taken), DEFAULT_COLORS.primary, DEFAULT_COLORS.secondary, faab]);
    for (let i = 0; i < p.aiTeams; i++) await insertAiTeam(db, leagueId, i, p.aiDifficulty, taken, faab, i + 2);
    await activity(app, db, leagueId, 'league_created', `League "${p.name}" was created.`);
    await audit(db, { leagueId, actor, action: 'league.create', payload: { teamCount: p.teamCount, aiTeams: p.aiTeams } });
    return { id: leagueId, inviteCode: code };
  });
}

async function insertAiTeam(db: Db, leagueId: string, i: number, difficulty: 'easy' | 'medium' | 'hard', taken: Set<string>, faab: number, priority: number) {
  const existing = new Set((await db.query<{ name: string }>('SELECT name FROM teams WHERE league_id = $1', [leagueId])).map((r) => r.name));
  const name = AI_TEAM_NAMES.find((n) => !existing.has(n)) ?? `AI Team ${i + 1}`;
  const pal = PRESET_PALETTES[(i + 1) % PRESET_PALETTES.length];
  (await db.query<{ abbrev: string }>('SELECT abbrev FROM teams WHERE league_id = $1', [leagueId])).forEach((r) => taken.add(r.abbrev));
  await db.query(`INSERT INTO teams (league_id, is_ai, ai_difficulty, name, abbrev, primary_color, secondary_color, waiver_priority, faab_remaining, logo_preset)
    VALUES ($1, true, $2, $3, $4, $5, $6, $7, $8, $9)`, [leagueId, difficulty, name, abbrevFrom(name, taken), pal.primary, pal.secondary, priority, faab, `preset-${(i % 12) + 1}`]);
}

export async function addAiTeams(app: App, actor: Actor, input: { leagueId: string; count: number; difficulty: 'easy' | 'medium' | 'hard' }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.manage_members');
  return withTx(app, async (db) => {
    const league = await getLeague(db, input.leagueId, true);
    if (league.status !== 'setup') throw badRequest('AI managers can only be added before the draft.');
    const n = (await db.one<{ c: number }>('SELECT count(*)::int AS c FROM teams WHERE league_id = $1', [league.id]))!.c;
    const count = Math.max(0, Math.min(input.count, league.max_teams - n));
    if (!count) throw badRequest('The league is already full.');
    const faab = league.settings.waivers.mode === 'faab' ? league.settings.waivers.faabBudget : 0;
    for (let i = 0; i < count; i++) await insertAiTeam(db, league.id, n + i, input.difficulty, new Set(), faab, n + i + 1);
    await activity(app, db, league.id, 'ai_added', `${count} AI manager${count === 1 ? '' : 's'} joined the league.`);
    await audit(db, { leagueId: league.id, actor, action: 'league.add_ai', payload: { count, difficulty: input.difficulty } });
    return { added: count };
  });
}

export async function setAiDifficulty(app: App, actor: Actor, input: { teamId: string; difficulty: 'easy' | 'medium' | 'hard' }) {
  const t = await app.db.one<{ league_id: string; is_ai: boolean }>('SELECT league_id, is_ai FROM teams WHERE id = $1', [input.teamId]);
  if (!t) throw notFound('Team');
  await requirePermission(app.db, actor, t.league_id, 'league.manage_members');
  if (!t.is_ai) throw badRequest('Only AI teams have a difficulty.');
  await app.db.query('UPDATE teams SET ai_difficulty = $2 WHERE id = $1', [input.teamId, input.difficulty]);
  await audit(app.db, { leagueId: t.league_id, actor, action: 'team.ai_difficulty', target: input.teamId, payload: input });
  return { ok: true };
}

export async function joinLeague(app: App, actor: Actor, input: { inviteCode: string; teamName?: string; leagueId?: string }) {
  const userId = requireUser(actor);
  return withTx(app, async (db) => {
    const code = String(input.inviteCode ?? '').trim().toUpperCase();
    const row = code
      ? await db.one<{ id: string }>('SELECT id FROM leagues WHERE invite_code = $1 FOR UPDATE', [code])
      : input.leagueId ? await db.one<{ id: string }>("SELECT id FROM leagues WHERE id = $1 AND visibility = 'public' FOR UPDATE", [input.leagueId]) : null;
    if (!row) throw notFound('League for that invite code');
    const league = await getLeague(db, row.id);
    if (await roleIn(db, league.id, userId)) throw conflict('You are already a member of this league.');
    if (league.status === 'complete') throw badRequest('This league has finished its season.');
    const teamCount = (await db.one<{ c: number }>('SELECT count(*)::int AS c FROM teams WHERE league_id = $1', [league.id]))!.c;
    const teamName = (input.teamName ?? '').trim().slice(0, 40);
    let teamId: string;
    if (teamCount < league.max_teams) {
      const name = teamName || `Team ${teamCount + 1}`;
      const taken = new Set((await db.query<{ abbrev: string }>('SELECT abbrev FROM teams WHERE league_id = $1', [league.id])).map((r) => r.abbrev));
      const faab = league.settings.waivers.mode === 'faab' ? league.settings.waivers.faabBudget : 0;
      const t = await db.one<{ id: string }>(`INSERT INTO teams (league_id, owner_user_id, name, abbrev, primary_color, secondary_color, waiver_priority, faab_remaining)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [league.id, userId, name, abbrevFrom(name, taken), DEFAULT_COLORS.primary, DEFAULT_COLORS.secondary, teamCount + 1, faab]);
      teamId = t!.id;
    } else {
      // League is full of teams: take over an AI-managed seat (roster and record are kept).
      const ai = await db.one<{ id: string }>('SELECT id FROM teams WHERE league_id = $1 AND is_ai ORDER BY waiver_priority DESC LIMIT 1 FOR UPDATE', [league.id]);
      if (!ai) throw conflict('This league is full.');
      await db.query('UPDATE teams SET is_ai = false, ai_difficulty = NULL, owner_user_id = $2, name = COALESCE(NULLIF($3, \'\'), name), updated_at = now() WHERE id = $1', [ai.id, userId, teamName]);
      teamId = ai.id;
    }
    try {
      await db.query("INSERT INTO league_members (league_id, user_id, role) VALUES ($1,$2,'manager')", [league.id, userId]);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('You are already a member of this league.');
      throw e;
    }
    const u = await db.one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [userId]);
    await activity(app, db, league.id, 'member_joined', `${u?.display_name ?? 'A manager'} joined the league.`);
    return { leagueId: league.id, teamId };
  });
}

/**
 * Leave a league. Your team stays in the league, run by an AI manager, so schedules and
 * standings never break. Your pending trade offers and waiver claims are cancelled.
 * A commissioner who leaves hands the role to the next person (co-commissioner first, then
 * the longest-serving manager). When no people are left, the league is deleted.
 */
export async function leaveLeague(app: App, actor: Actor, input: { leagueId: string }) {
  const userId = requireUser(actor);
  const out = await withTx(app, async (db) => {
    const league = await getLeague(db, input.leagueId, true);
    const role = await roleIn(db, league.id, userId);
    if (!role) throw notFound('League');
    const team = await myTeam(db, league.id, userId);
    const u = await db.one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [userId]);
    if (team) await handTeamToAi(db, team.id);
    await db.query('DELETE FROM league_members WHERE league_id = $1 AND user_id = $2', [league.id, userId]);
    await audit(db, { leagueId: league.id, actor, action: 'member.leave', target: userId, payload: { teamId: team?.id ?? null } });
    const people = await db.query<{ user_id: string; role: Role }>(
      "SELECT user_id, role FROM league_members WHERE league_id = $1 AND role <> 'observer' ORDER BY (role = 'co_commissioner') DESC, joined_at, user_id", [league.id]);
    if (people.length === 0) {
      await audit(db, { leagueId: null, actor, action: 'league.delete', target: league.id, payload: { name: league.name, reason: 'Last person left the league' } });
      await db.query('DELETE FROM leagues WHERE id = $1', [league.id]);
      return { ok: true, leagueDeleted: true, newCommissionerId: null as string | null };
    }
    let newCommissionerId: string | null = null;
    if (role === 'commissioner') {
      newCommissionerId = people[0].user_id;
      await db.query("UPDATE league_members SET role = 'commissioner' WHERE league_id = $1 AND user_id = $2", [league.id, newCommissionerId]);
      // The creator-only tools (like Refresh league) follow the commissioner role.
      await db.query('UPDATE leagues SET created_by = $2 WHERE id = $1', [league.id, newCommissionerId]);
      await audit(db, { leagueId: league.id, actor, action: 'commissioner.transfer', target: newCommissionerId, reason: 'Previous commissioner left the league' });
    }
    const who = u?.display_name ?? 'A manager';
    await activity(app, db, league.id, 'member_left', `${who} left the league${team ? '; an AI manager now runs their team' : ''}.`);
    if (newCommissionerId) {
      const nu = await db.one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [newCommissionerId]);
      await activity(app, db, league.id, 'commissioner_changed', `${nu?.display_name ?? 'A manager'} is now the commissioner.`);
    }
    return { ok: true, leagueDeleted: false, newCommissionerId };
  });
  if (!out.leagueDeleted) app.bus.publish(`league:${input.leagueId}`, { type: 'league', leagueId: input.leagueId });
  return out;
}

/** An AI manager takes over the team; the person's pending offers, claims and queue are cancelled. */
async function handTeamToAi(db: Db, teamId: string) {
  await db.query("UPDATE teams SET owner_user_id = NULL, is_ai = true, ai_difficulty = COALESCE(ai_difficulty, 'medium'), updated_at = now() WHERE id = $1", [teamId]);
  await db.query("UPDATE trades SET status = 'canceled', decided_at = now() WHERE status IN ('proposed','countered') AND proposer_team_id = $1", [teamId]);
  await db.query("UPDATE waiver_claims SET status = 'canceled' WHERE status = 'pending' AND team_id = $1", [teamId]);
  await db.query('DELETE FROM draft_queue WHERE team_id = $1', [teamId]);
}

export async function listMyLeagues(app: App, actor: Actor) {
  const userId = requireUser(actor);
  return app.db.query(
    `SELECT l.id, l.name, l.status, l.season, l.current_week, l.max_teams, l.logo_media_id, l.visibility, l.created_by = $1 AS is_creator,
            m.role, t.id AS team_id, t.name AS team_name, t.abbrev, t.primary_color, t.secondary_color, t.logo_media_id AS team_logo_media_id, t.logo_preset,
            (SELECT count(*)::int FROM teams x WHERE x.league_id = l.id) AS team_count,
            (SELECT count(*)::int FROM league_members x WHERE x.league_id = l.id AND x.role <> 'observer') AS people,
            (SELECT count(*)::int FROM notifications n WHERE n.user_id = $1 AND n.league_id = l.id AND n.read_at IS NULL) AS unread,
            (SELECT count(*)::int FROM trades tr WHERE tr.league_id = l.id AND tr.status = 'proposed' AND tr.recipient_team_id = t.id) AS pending_offers,
            (SELECT count(*)::int FROM waiver_claims c WHERE c.team_id = t.id AND c.status = 'pending') AS pending_claims
     FROM league_members m JOIN leagues l ON l.id = m.league_id LEFT JOIN teams t ON t.league_id = l.id AND t.owner_user_id = $1
     WHERE m.user_id = $1 ORDER BY l.created_at DESC`, [userId]);
}

export async function listPublicLeagues(app: App, actor: Actor) {
  const userId = requireUser(actor);
  return app.db.query(
    `SELECT l.id, l.name, l.description, l.status, l.max_teams,
            (SELECT count(*)::int FROM teams t WHERE t.league_id = l.id AND NOT t.is_ai) AS humans,
            (SELECT count(*)::int FROM teams t WHERE t.league_id = l.id) AS teams
     FROM leagues l WHERE l.visibility = 'public' AND l.status <> 'complete'
       AND NOT EXISTS (SELECT 1 FROM league_members m WHERE m.league_id = l.id AND m.user_id = $1)
     ORDER BY l.created_at DESC LIMIT 50`, [userId]);
}

/** League detail visible to members. Never includes other members' emails. */
export async function leagueDetail(app: App, actor: Actor, input: { leagueId: string }) {
  const role = await requirePermission(app.db, actor, input.leagueId, 'league.view');
  const league = await getLeague(app.db, input.leagueId);
  const { rules, version } = await getScoringRules(app.db, league.id);
  const members = await app.db.query(
    `SELECT m.user_id, m.role, m.joined_at, m.muted_until, u.username, u.display_name, u.avatar_media_id
     FROM league_members m JOIN users u ON u.id = m.user_id WHERE m.league_id = $1 ORDER BY m.joined_at`, [league.id]);
  const teams = await app.db.query(
    `SELECT t.id, t.owner_user_id, t.is_ai, t.ai_difficulty, t.name, t.abbrev, t.description, t.primary_color, t.secondary_color,
            t.logo_media_id, t.logo_preset, t.banner_media_id, t.waiver_priority, t.faab_remaining, t.draft_slot,
            u.display_name AS owner_name
     FROM teams t LEFT JOIN users u ON u.id = t.owner_user_id WHERE t.league_id = $1 ORDER BY t.waiver_priority`, [league.id]);
  const userId = actor.kind === 'user' ? actor.userId : null;
  const mine = teams.find((t: any) => t.owner_user_id === userId) ?? null;
  const r = role === 'system' ? 'commissioner' : role;
  return {
    league: {
      id: league.id, name: league.name, description: league.description, visibility: league.visibility, season: league.season,
      maxTeams: league.max_teams, status: league.status, currentWeek: league.current_week, logoMediaId: league.logo_media_id,
      createdBy: league.created_by, settingsVersion: league.settings_version, scoringVersion: version,
      waiverNextRunAt: league.waiver_next_run_at,
      // only members with member-management rights see the invite code
      inviteCode: ROLE_PERMISSIONS[r as Role]?.has('league.manage_members') || league.visibility === 'public' ? league.invite_code : null,
    },
    settings: league.settings, scoring: rules, members, teams, myTeamId: mine?.id ?? null, role: r,
    permissions: [...(ROLE_PERMISSIONS[r as Role] ?? [])],
  };
}

const editableLeagueSchema = z.object({
  leagueId: z.string().uuid(),
  name: z.string().trim().min(3).max(50).optional(),
  description: z.string().trim().max(500).optional(),
  visibility: z.enum(['private', 'public']).optional(),
  logoMediaId: z.string().uuid().nullable().optional(),
  maxTeams: z.number().int().min(1).max(10).optional(),
});

export async function updateLeagueInfo(app: App, actor: Actor, input: unknown) {
  const p = editableLeagueSchema.parse(input);
  await requirePermission(app.db, actor, p.leagueId, 'league.edit_settings');
  return withTx(app, async (db) => {
    const league = await getLeague(db, p.leagueId, true);
    if (p.maxTeams !== undefined) {
      const n = (await db.one<{ c: number }>('SELECT count(*)::int AS c FROM teams WHERE league_id = $1', [league.id]))!.c;
      if (p.maxTeams < n) throw badRequest(`The league already has ${n} teams.`);
      if (league.status !== 'setup') throw badRequest('League size can only change before the draft.');
    }
    await db.query(`UPDATE leagues SET name = COALESCE($2, name), description = COALESCE($3, description), visibility = COALESCE($4, visibility),
      logo_media_id = CASE WHEN $6 THEN $5::uuid ELSE logo_media_id END, max_teams = COALESCE($7, max_teams), updated_at = now() WHERE id = $1`,
      [league.id, p.name ?? null, p.description ?? null, p.visibility ?? null, p.logoMediaId ?? null, p.logoMediaId !== undefined, p.maxTeams ?? null]);
    await audit(db, { leagueId: league.id, actor, action: 'league.update_info', payload: p });
    return { ok: true };
  });
}

/**
 * Settings changes are versioned. Some settings are locked once the season starts
 * because changing them would rewrite history (roster shape, schedule length).
 */
export async function updateSettings(app: App, actor: Actor, input: { leagueId: string; settings: unknown; reason?: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.edit_settings');
  const next = leagueSettingsSchema.parse(input.settings);
  return withTx(app, async (db) => {
    const league = await getLeague(db, input.leagueId, true);
    const n = (await db.one<{ c: number }>('SELECT count(*)::int AS c FROM teams WHERE league_id = $1', [league.id]))!.c;
    const issues = validateLeagueSettings(next, Math.max(n, league.max_teams));
    if (issues.length) throw badRequest('Some league settings are incompatible.', issues);
    const prev = league.settings;
    if (league.status !== 'setup') {
      const locked: string[] = [];
      if (JSON.stringify(prev.season.startWeek) !== JSON.stringify(next.season.startWeek) || prev.season.regularSeasonWeeks !== next.season.regularSeasonWeeks) locked.push('season length');
      if (prev.season.doubleHeaders !== next.season.doubleHeaders) locked.push('double headers');
      if (prev.draft.type !== next.draft.type) locked.push('draft type');
      if (league.status === 'playoffs' && (prev.season.playoffTeams !== next.season.playoffTeams)) locked.push('playoff teams');
      if (prev.waivers.mode !== next.waivers.mode && prev.waivers.mode === 'faab') locked.push('waiver mode (FAAB budgets already in use)');
      if (locked.length) throw badRequest(`These settings are locked after the draft: ${locked.join(', ')}.`);
    }
    const version = league.settings_version + 1;
    await db.query('UPDATE leagues SET settings = $2, settings_version = $3, updated_at = now() WHERE id = $1', [league.id, JSON.stringify(next), version]);
    await db.query('INSERT INTO league_settings_versions (league_id, version, settings, changed_by, reason) VALUES ($1,$2,$3,$4,$5)', [league.id, version, JSON.stringify(next), actor.kind === 'user' ? actor.userId : null, input.reason ?? null]);
    if (league.status === 'setup' && prev.waivers.faabBudget !== next.waivers.faabBudget) {
      await db.query('UPDATE teams SET faab_remaining = $2 WHERE league_id = $1', [league.id, next.waivers.mode === 'faab' ? next.waivers.faabBudget : 0]);
    }
    await activity(app, db, league.id, 'rules_changed', `League settings were updated (version ${version}).${input.reason ? ` Reason: ${input.reason}` : ''}`);
    await audit(db, { leagueId: league.id, actor, action: 'league.update_settings', reason: input.reason ?? null, payload: { version } });
    return { version };
  });
}

/** New scoring applies to open weeks only. Finalized weeks change only through an explicit recalculation. */
export async function updateScoring(app: App, actor: Actor, input: { leagueId: string; rules: unknown; reason: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.edit_scoring');
  const rules = scoringRulesSchema.parse(input.rules);
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 3) throw badRequest('Please give a reason for the scoring change; it is shown to the league.');
  return withTx(app, async (db) => {
    const league = await getLeague(db, input.leagueId, true);
    const { version } = await getScoringRules(db, league.id);
    const next = version + 1;
    await db.query('INSERT INTO scoring_configs (league_id, version, rules, changed_by, reason) VALUES ($1,$2,$3,$4,$5)', [league.id, next, JSON.stringify(rules), actor.kind === 'user' ? actor.userId : null, reason]);
    await db.query('UPDATE leagues SET scoring_version = $2, updated_at = now() WHERE id = $1', [league.id, next]);
    await activity(app, db, league.id, 'rules_changed', `Scoring rules changed (version ${next}): ${reason}. Finalized weeks are unchanged.`);
    await audit(db, { leagueId: league.id, actor, action: 'league.update_scoring', reason, payload: { version: next } });
    return { version: next };
  });
}

export async function scoringHistory(app: App, actor: Actor, input: { leagueId: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  return app.db.query(`SELECT s.version, s.rules, s.reason, s.created_at, u.display_name AS changed_by
    FROM scoring_configs s LEFT JOIN users u ON u.id = s.changed_by WHERE s.league_id = $1 ORDER BY s.version DESC`, [input.leagueId]);
}

export async function setMemberRole(app: App, actor: Actor, input: { leagueId: string; userId: string; role: Role; reason?: string }) {
  const myRole = await requirePermission(app.db, actor, input.leagueId, 'league.manage_members');
  if (input.role === 'commissioner') throw badRequest('Use "transfer commissioner" to hand over the league.');
  const isCommish = myRole === 'commissioner' || myRole === 'system';
  if (input.role === 'co_commissioner' && !isCommish) throw forbidden('Only the commissioner can assign or revoke co-commissioners.');
  return withTx(app, async (db) => {
    const target = await roleIn(db, input.leagueId, input.userId);
    if (!target) throw notFound('Member');
    if (target === 'commissioner') throw badRequest('The commissioner role cannot be changed here.');
    if (target === 'co_commissioner' && !isCommish) throw forbidden('Only the commissioner can revoke a co-commissioner.');
    if (input.role === 'observer') {
      const team = await myTeam(db, input.leagueId, input.userId);
      if (team) throw badRequest('Managers with a team cannot become observers. Remove their team first.');
    }
    await db.query('UPDATE league_members SET role = $3 WHERE league_id = $1 AND user_id = $2', [input.leagueId, input.userId, input.role]);
    await audit(db, { leagueId: input.leagueId, actor, action: 'member.set_role', target: input.userId, reason: input.reason ?? null, payload: { from: target, to: input.role } });
    await activity(app, db, input.leagueId, 'role_changed', `A member's role changed to ${input.role.replace('_', '-')}.`);
    await notify(app, db, { userId: input.userId, leagueId: input.leagueId, kind: 'announcement', title: `Your league role is now ${input.role.replace('_', '-')}.` });
    return { ok: true };
  });
}

export async function transferCommissioner(app: App, actor: Actor, input: { leagueId: string; userId: string; reason: string }) {
  const myRole = await requirePermission(app.db, actor, input.leagueId, 'league.assign_co_commissioner');
  if (myRole !== 'commissioner') throw forbidden();
  const me = requireUser(actor);
  return withTx(app, async (db) => {
    const target = await roleIn(db, input.leagueId, input.userId);
    if (!target || target === 'observer') throw badRequest('Choose a manager in this league.');
    await db.query("UPDATE league_members SET role = 'co_commissioner' WHERE league_id = $1 AND user_id = $2", [input.leagueId, me]);
    await db.query("UPDATE league_members SET role = 'commissioner' WHERE league_id = $1 AND user_id = $2", [input.leagueId, input.userId]);
    await audit(db, { leagueId: input.leagueId, actor, action: 'member.transfer_commissioner', target: input.userId, reason: input.reason });
    await activity(app, db, input.leagueId, 'role_changed', 'The commissioner role was transferred.');
    return { ok: true };
  });
}

export async function addObserver(app: App, actor: Actor, input: { leagueId: string; username: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.manage_members');
  const u = await app.db.one<{ id: string }>('SELECT id FROM users WHERE lower(username) = lower($1)', [input.username]);
  if (!u) throw notFound('User');
  try {
    await app.db.query("INSERT INTO league_members (league_id, user_id, role) VALUES ($1,$2,'observer')", [input.leagueId, u.id]);
  } catch (e) { if (isUniqueViolation(e)) throw conflict('That user is already a member.'); throw e; }
  await audit(app.db, { leagueId: input.leagueId, actor, action: 'member.add_observer', target: u.id });
  return { ok: true };
}

export async function removeMember(app: App, actor: Actor, input: { leagueId: string; userId: string; reason: string }) {
  const myRole = await requirePermission(app.db, actor, input.leagueId, 'league.manage_members');
  if (!input.reason || input.reason.trim().length < 3) throw badRequest('A reason is required.');
  return withTx(app, async (db) => {
    const target = await roleIn(db, input.leagueId, input.userId);
    if (!target) throw notFound('Member');
    if (target === 'commissioner') throw forbidden('The commissioner cannot be removed.');
    if (target === 'co_commissioner' && myRole !== 'commissioner') throw forbidden('Only the commissioner can remove a co-commissioner.');
    const league = await getLeague(db, input.leagueId, true);
    const team = await myTeam(db, input.leagueId, input.userId);
    if (team) await handTeamToAi(db, team.id);
    void league;
    await db.query('DELETE FROM league_members WHERE league_id = $1 AND user_id = $2', [input.leagueId, input.userId]);
    await audit(db, { leagueId: input.leagueId, actor, action: 'member.remove', target: input.userId, reason: input.reason });
    await activity(app, db, input.leagueId, 'member_removed', 'A member was removed by the commissioner.');
    return { ok: true };
  });
}

export async function regenerateInvite(app: App, actor: Actor, input: { leagueId: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.manage_members');
  return withTx(app, async (db) => {
    const code = await uniqueInviteCode(app, db);
    await db.query('UPDATE leagues SET invite_code = $2 WHERE id = $1', [input.leagueId, code]);
    await audit(db, { leagueId: input.leagueId, actor, action: 'league.regenerate_invite' });
    return { inviteCode: code };
  });
}

export async function deleteLeague(app: App, actor: Actor, input: { leagueId: string; confirmName: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.delete');
  const league = await getLeague(app.db, input.leagueId);
  if (input.confirmName !== league.name) throw badRequest('Type the league name exactly to confirm deletion.');
  await audit(app.db, { leagueId: null, actor, action: 'league.delete', target: league.id, payload: { name: league.name } });
  await app.db.query('DELETE FROM leagues WHERE id = $1', [league.id]);
  return { ok: true };
}

/** Builds the regular-season schedule once the draft is complete. */
export async function startSeason(app: App, db: Db, leagueId: string) {
  const league = await getLeague(db, leagueId, true);
  if (league.status === 'in_season' || league.status === 'playoffs') return;
  const season = league.season;
  const nflWeek = await currentNflWeek(db, season);
  const started = await db.one("SELECT 1 FROM nfl_games WHERE season = $1 AND week = $2 AND kickoff_at <= $3 LIMIT 1", [season, nflWeek, app.clock.now().toISOString()]);
  const firstWeek = started ? nflWeek + 1 : nflWeek;
  const { settings, adjusted } = fitSeasonToCalendar(league.settings, firstWeek);
  if (adjusted) {
    const version = league.settings_version + 1;
    await db.query('UPDATE leagues SET settings = $2, settings_version = $3 WHERE id = $1', [leagueId, JSON.stringify(settings), version]);
    await db.query('INSERT INTO league_settings_versions (league_id, version, settings, reason) VALUES ($1,$2,$3,$4)', [leagueId, version, JSON.stringify(settings), `Automatic: ${adjusted}`]);
    await activity(app, db, leagueId, 'rules_changed', `Season adjusted to fit the NFL calendar: ${adjusted}.`);
  }
  const teams = (await db.query<{ id: string }>('SELECT id FROM teams WHERE league_id = $1 ORDER BY draft_slot NULLS LAST, id', [leagueId])).map((t) => t.id);
  const se = settings.season;
  const sched = teams.length === 1
    ? Array.from({ length: se.regularSeasonWeeks }, (_, i) => ({ week: se.startWeek + i, homeTeamId: teams[0], awayTeamId: null }))
    : se.doubleHeaders ? doubleHeaderSchedule(teams, se.regularSeasonWeeks, se.startWeek) : roundRobin(teams, se.regularSeasonWeeks, se.startWeek);
  await db.query('DELETE FROM matchups WHERE league_id = $1', [leagueId]);
  for (const m of sched) {
    await db.query("INSERT INTO matchups (league_id, week, kind, home_team_id, away_team_id) VALUES ($1,$2,'regular',$3,$4)", [leagueId, m.week, m.homeTeamId, m.awayTeamId]);
  }
  await db.query("UPDATE leagues SET status = 'in_season', current_week = $2, updated_at = now() WHERE id = $1", [leagueId, se.startWeek]);
  await activity(app, db, leagueId, 'season_started', `The season schedule is set: weeks ${se.startWeek}–${se.startWeek + se.regularSeasonWeeks - 1}.`);
}

// ---------------------------------------------------------------------------
// Team customization
// ---------------------------------------------------------------------------

const teamUpdateSchema = z.object({
  teamId: z.string().uuid(),
  name: z.string().trim().min(2).max(40).optional(),
  abbrev: z.string().trim().min(2).max(4).regex(/^[A-Za-z0-9]+$/, 'Letters and numbers only.').optional(),
  description: z.string().trim().max(300).optional(),
  primaryColor: z.string().refine(isHex, 'Use a #RRGGBB color.').optional(),
  secondaryColor: z.string().refine(isHex, 'Use a #RRGGBB color.').optional(),
  logoMediaId: z.string().uuid().nullable().optional(),
  logoPreset: z.string().regex(/^preset-\d{1,2}$/).nullable().optional(),
  bannerMediaId: z.string().uuid().nullable().optional(),
  reason: z.string().max(200).optional(),
});

export async function updateTeam(app: App, actor: Actor, input: unknown) {
  const p = teamUpdateSchema.parse(input);
  const { team, override } = await requireTeamControl(app.db, actor, p.teamId, { allowCommissioner: true });
  if (override && (!p.reason || p.reason.trim().length < 3)) throw badRequest('Commissioner edits to another team require a reason.');
  for (const mid of [p.logoMediaId, p.bannerMediaId]) {
    if (!mid) continue;
    const m = await app.db.one<{ owner_user_id: string }>('SELECT owner_user_id FROM media WHERE id = $1', [mid]);
    if (!m) throw badRequest('Image not found.');
    if (actor.kind === 'user' && m.owner_user_id !== actor.userId) throw forbidden('You can only use images you uploaded.');
  }
  return withTx(app, async (db) => {
    try {
      await db.query(`UPDATE teams SET
        name = COALESCE($2, name), abbrev = COALESCE(upper($3), abbrev), description = COALESCE($4, description),
        primary_color = COALESCE(upper($5), primary_color), secondary_color = COALESCE(upper($6), secondary_color),
        logo_media_id = CASE WHEN $8 THEN $7::uuid ELSE logo_media_id END,
        logo_preset = CASE WHEN $10 THEN $9 ELSE logo_preset END,
        banner_media_id = CASE WHEN $12 THEN $11::uuid ELSE banner_media_id END,
        updated_at = now() WHERE id = $1`,
        [team.id, p.name ?? null, p.abbrev ?? null, p.description ?? null, p.primaryColor ?? null, p.secondaryColor ?? null,
          p.logoMediaId ?? null, p.logoMediaId !== undefined, p.logoPreset ?? null, p.logoPreset !== undefined, p.bannerMediaId ?? null, p.bannerMediaId !== undefined]);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Another team in this league already uses that abbreviation.');
      throw e;
    }
    if (override) await audit(db, { leagueId: team.league_id, actor, action: 'team.override_edit', target: team.id, reason: p.reason, payload: p });
    if (p.name && p.name !== team.name) await activity(app, db, team.league_id, 'team_renamed', `${team.name} is now ${p.name}.`);
    return { ok: true };
  });
}

export type { LeagueRow };
