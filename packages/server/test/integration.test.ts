import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTemplate, defaultLeagueSettings, scoringPreset } from '@gridiron/core';
import { expectError, mkUser, setTime, setupApp, type TestCtx } from './helpers';
import * as auth from '../src/services/auth';
import * as leagues from '../src/services/leagues';
import * as drafts from '../src/services/drafts';
import * as rosters from '../src/services/rosters';
import * as waivers from '../src/services/waivers';
import * as trades from '../src/services/trades';
import * as views from '../src/services/views';
import * as social from '../src/services/social';
import * as assistant from '../src/services/assistant';
import { runSync, dataStatus } from '../src/services/nfl';
import { call } from '../src/api/router';
import { UnconfiguredProvider, ProviderError } from '../src/providers/provider';

let ctx: TestCtx;
beforeAll(async () => { ctx = await setupApp(); }, 60_000);
afterAll(async () => { await ctx.app.db.close?.(); });

async function freeAgents(app = ctx.app, leagueId: string, n = 5, position?: string) {
  return app.db.query<{ id: string; position: string }>(`SELECT p.id, p.position FROM nfl_players p WHERE p.active ${position ? `AND p.position = '${position}'` : ''}
    AND NOT EXISTS (SELECT 1 FROM roster_entries r WHERE r.league_id = $1 AND r.player_id = p.id) ORDER BY p.rank LIMIT $2`, [leagueId, n]);
}

async function soloLeague(owner: { actor: any }, opts: Partial<Parameters<typeof leagues.createLeague>[2] & object> = {}) {
  const s = defaultLeagueSettings();
  s.season.regularSeasonWeeks = 6; s.season.playoffTeams = 2; s.trades.tradeDeadlineWeek = 5;
  return leagues.createLeague(ctx.app, owner.actor, { name: 'Test League', teamCount: 4, aiTeams: 3, teamName: 'Mine', settings: s, ...opts });
}

describe('1. accounts and profiles', () => {
  it('registers, logs in, maintains a profile and rejects bad credentials', async () => {
    const r = await auth.register(ctx.app, { username: 'Sam_Q', email: 'sam@example.com', password: 'letmein123', displayName: 'Sam Q' });
    expect(r.user.username).toBe('Sam_Q');
    const stored = await ctx.app.db.one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [r.user.id]);
    expect(stored!.password_hash).toMatch(/^scrypt\$/);           // never plaintext
    expect(stored!.password_hash).not.toContain('letmein123');
    const me = await auth.resolveSession(ctx.app, r.token);
    expect(me?.id).toBe(r.user.id);
    const l = await auth.login(ctx.app, { identifier: 'sam@example.com', password: 'letmein123' });
    expect(l.token).not.toBe(r.token);
    await expectError(auth.login(ctx.app, { identifier: 'Sam_Q', password: 'wrong-pass1' }), 401);
    await expectError(auth.register(ctx.app, { username: 'sam_q', email: 'x@example.com', password: 'letmein123' }), 409, /taken/);
    const up = await auth.updateProfile(ctx.app, r.user.id, { displayName: 'Samuel', timezone: 'America/Chicago', theme: 'dark', notificationPrefs: { chat_mention: false } });
    expect(up.displayName).toBe('Samuel');
    expect(up.notificationPrefs.chat_mention).toBe(false);
    await expectError(auth.updateProfile(ctx.app, r.user.id, { timezone: 'Mars/Olympus' }), 400);
    await auth.logout(ctx.app, l.token);
    expect(await auth.resolveSession(ctx.app, l.token)).toBeNull();
  });

  it('saves a personal appearance to the account, validates it, and can reset it', async () => {
    const u = await mkUser(ctx.app);
    const look = { primary: '#0B4F6C', accent: '#2DD4BF', tint: 0.5, font: 'nunito', radius: 20, scale: 1.1, overrides: { dark: { bg: '#000000' } } };
    const saved = await auth.updateProfile(ctx.app, u.userId, { appearance: look });
    expect(saved.appearance).toEqual(look);
    expect((await auth.getUser(ctx.app, u.userId))!.appearance).toEqual(look);
    await expectError(auth.updateProfile(ctx.app, u.userId, { appearance: { primary: 'blue' } }), 400);
    await expectError(auth.updateProfile(ctx.app, u.userId, { appearance: { overrides: { light: { bg: '#000000; color:red' } } } }), 400);
    expect((await auth.updateProfile(ctx.app, u.userId, { appearance: null })).appearance).toBeNull();
  });

  it('supports account recovery without revealing whether an email exists', async () => {
    const unknown = await auth.requestPasswordReset(ctx.app, { email: 'nobody@example.com' });
    const known = await auth.requestPasswordReset(ctx.app, { email: 'sam@example.com' });
    expect(unknown.message).toBe(known.message);
    const token = new URL(known.devLink!.replace('/#/', '/')).searchParams.get('token')!;
    await auth.resetPassword(ctx.app, { token, newPassword: 'brandnew456' });
    await auth.login(ctx.app, { identifier: 'sam_q', password: 'brandnew456' });
    await expectError(auth.resetPassword(ctx.app, { token, newPassword: 'another789' }), 400, /invalid or has expired/);
  });
});

describe('2–6. leagues, membership, isolation', () => {
  it('creates multiple independent leagues with 1–10 managers, AI opponents and invitations', async () => {
    const a = await mkUser(ctx.app);
    const solo = await leagues.createLeague(ctx.app, a.actor, { name: 'Solo Practice', teamCount: 1, aiTeams: 0, teamName: 'Just Me', settings: (() => { const s = defaultLeagueSettings(); s.season.standingsMode = 'total_points'; s.season.playoffTeams = 0; s.trades.review = 'auto'; return s; })() });
    const ten = await leagues.createLeague(ctx.app, a.actor, { name: 'Big Ten', teamCount: 10, aiTeams: 2, teamName: 'Tens', scoringPreset: 'standard' });
    const withAi = await soloLeague(a);
    const mine = await leagues.listMyLeagues(ctx.app, a.actor);
    expect(mine.map((l: any) => l.id).sort()).toEqual([solo.id, ten.id, withAi.id].sort());
    const det = await leagues.leagueDetail(ctx.app, a.actor, { leagueId: withAi.id });
    expect(det.teams.filter((t: any) => t.is_ai)).toHaveLength(3);
    expect(det.role).toBe('commissioner');
    // join via invite; duplicate membership rejected
    const b = await mkUser(ctx.app);
    await leagues.joinLeague(ctx.app, b.actor, { inviteCode: ten.inviteCode, teamName: 'Joiners' });
    await expectError(leagues.joinLeague(ctx.app, b.actor, { inviteCode: ten.inviteCode }), 409, /already a member/);
    await expectError(leagues.joinLeague(ctx.app, b.actor, { inviteCode: 'NOPE1234' }), 404);
    // full league: joining takes over an AI seat
    const c = await mkUser(ctx.app);
    const jr = await leagues.joinLeague(ctx.app, c.actor, { inviteCode: withAi.inviteCode, teamName: 'Took Over' });
    const t = await ctx.app.db.one<{ is_ai: boolean; owner_user_id: string }>('SELECT is_ai, owner_user_id FROM teams WHERE id = $1', [jr.teamId]);
    expect(t).toMatchObject({ is_ai: false, owner_user_id: c.userId });
    // non-members cannot see private leagues
    const stranger = await mkUser(ctx.app);
    await expectError(leagues.leagueDetail(ctx.app, stranger.actor, { leagueId: ten.id }), 404);
    // invite code hidden from plain managers
    expect((await leagues.leagueDetail(ctx.app, b.actor, { leagueId: ten.id })).league.inviteCode).toBeNull();
  });

  it('validates incompatible settings before creating a league', async () => {
    const a = await mkUser(ctx.app);
    const s = defaultLeagueSettings(); s.season.playoffTeams = 8;
    const e = await expectError(leagues.createLeague(ctx.app, a.actor, { name: 'Bad', teamCount: 4, aiTeams: 0, teamName: 'xx', settings: s }), 400);
    expect(JSON.stringify(e.details)).toMatch(/exceed league size/);
  });

  it('persists team customization (name, two colors, image) and enforces ownership', async () => {
    const a = await mkUser(ctx.app);
    const l = await soloLeague(a);
    const det = await leagues.leagueDetail(ctx.app, a.actor, { leagueId: l.id });
    // 1x1 PNG is rejected (too small); a valid 16x16 PNG header is accepted
    const png = (w: number, h: number) => {
      const b = new Uint8Array(64); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8); b.set([0, 0, 0, w, 0, 0, 0, h], 16);
      return Buffer.from(b).toString('base64');
    };
    await expectError(social.uploadMedia(ctx.app, a.actor, { dataBase64: png(1, 1), purpose: 'team_logo' }), 400, /between 16 and 4096/);
    await expectError(social.uploadMedia(ctx.app, a.actor, { dataBase64: Buffer.from('<svg onload=alert(1)>').toString('base64') + 'AAAA', purpose: 'team_logo' }), 400, /Only PNG/);
    const media = await social.uploadMedia(ctx.app, a.actor, { dataBase64: png(64, 64), purpose: 'team_logo' });
    await leagues.updateTeam(ctx.app, a.actor, { teamId: det.myTeamId, name: 'Thunder Ducks', abbrev: 'thd', primaryColor: '#123abc', secondaryColor: '#FFEEDD', logoMediaId: media.id });
    const again = await leagues.leagueDetail(ctx.app, a.actor, { leagueId: l.id });
    const mine = again.teams.find((t: any) => t.id === det.myTeamId);
    expect(mine).toMatchObject({ name: 'Thunder Ducks', abbrev: 'THD', primary_color: '#123ABC', secondary_color: '#FFEEDD', logo_media_id: media.id });
    const other = again.teams.find((t: any) => t.is_ai);
    const b = await mkUser(ctx.app);
    await leagues.joinLeague(ctx.app, b.actor, { inviteCode: l.inviteCode });
    await expectError(leagues.updateTeam(ctx.app, b.actor, { teamId: det.myTeamId, name: 'Hacked' }), 403);
    await expectError(leagues.updateTeam(ctx.app, a.actor, { teamId: other!.id, name: 'Renamed AI' }), 400, /require a reason/);
    await expectError(leagues.updateTeam(ctx.app, a.actor, { teamId: det.myTeamId, primaryColor: 'red' }), 400);
  });
});

describe('9, 20. commissioner configuration and authorization', () => {
  it('commissioner edits scoring/roster rules with versioning; managers and observers cannot', async () => {
    const a = await mkUser(ctx.app);
    const b = await mkUser(ctx.app);
    const obs = await mkUser(ctx.app);
    const l = await soloLeague(a, { aiTeams: 2 });
    await leagues.joinLeague(ctx.app, b.actor, { inviteCode: l.inviteCode });
    await leagues.addObserver(ctx.app, a.actor, { leagueId: l.id, username: obs.username });
    const rules = scoringPreset('half_ppr');
    await expectError(leagues.updateScoring(ctx.app, b.actor, { leagueId: l.id, rules, reason: 'please' }), 403);
    await expectError(leagues.updateScoring(ctx.app, a.actor, { leagueId: l.id, rules, reason: '' }), 400, /reason/);
    const v = await leagues.updateScoring(ctx.app, a.actor, { leagueId: l.id, rules, reason: 'Switching to half PPR' });
    expect(v.version).toBe(2);
    const det = await leagues.leagueDetail(ctx.app, a.actor, { leagueId: l.id });
    const s = { ...det.settings, roster: { ...det.settings.roster, BN: 7, SUPERFLEX: 1 } };
    await expectError(leagues.updateSettings(ctx.app, b.actor, { leagueId: l.id, settings: s }), 403);
    expect((await leagues.updateSettings(ctx.app, a.actor, { leagueId: l.id, settings: s, reason: 'deeper benches' })).version).toBe(2);
    await expectError(social.postMessage(ctx.app, obs.actor, { leagueId: l.id, body: 'hi' }), 403);
    await expectError(leagues.setMemberRole(ctx.app, b.actor, { leagueId: l.id, userId: b.userId, role: 'co_commissioner' }), 403);
    await leagues.setMemberRole(ctx.app, a.actor, { leagueId: l.id, userId: b.userId, role: 'co_commissioner' });
    // co-commissioner can edit settings but not scoring
    await leagues.updateSettings(ctx.app, b.actor, { leagueId: l.id, settings: s });
    await expectError(leagues.updateScoring(ctx.app, b.actor, { leagueId: l.id, rules, reason: 'x y z' }), 403);
    const audit = await social.auditLog(ctx.app, a.actor, { leagueId: l.id });
    expect(audit.map((x: any) => x.action)).toEqual(expect.arrayContaining(['league.update_scoring', 'league.update_settings', 'member.set_role']));
  });

  it('audit log is append-only at the database level', async () => {
    await expect(ctx.app.db.query("UPDATE audit_log SET reason = 'tampered'")).rejects.toThrow(/append-only/);
    await expect(ctx.app.db.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
  });
});

describe('10–14. draft, scoring, matchups and standings', () => {
  let owner: any, leagueId: string, myTeamId: string;
  it('a draft pick updates the roster and removes the player from the pool; duplicates and out-of-turn picks fail', async () => {
    setTime(ctx, '2026-09-01T12:00:00Z');
    owner = await mkUser(ctx.app);
    const l = await soloLeague(owner);
    leagueId = l.id;
    myTeamId = (await leagues.leagueDetail(ctx.app, owner.actor, { leagueId })).myTeamId!;
    const human2 = await mkUser(ctx.app);
    await leagues.joinLeague(ctx.app, human2.actor, { inviteCode: l.inviteCode }); // takes an AI seat
    const human2Team = (await leagues.leagueDetail(ctx.app, human2.actor, { leagueId })).myTeamId!;
    const human2TeamRow = { id: human2Team };
    const myTeamRow = { id: myTeamId };
    await drafts.configureDraft(ctx.app, owner.actor, { leagueId, type: 'snake', pickSeconds: 60, order: await (async () => {
      const ids = (await ctx.app.db.query<{ id: string }>('SELECT id FROM teams WHERE league_id = $1 ORDER BY id', [leagueId])).map((t) => t.id).filter((id) => id !== myTeamRow.id && id !== human2TeamRow.id);
      return [myTeamRow.id, human2TeamRow.id, ...ids];
    })() });
    await drafts.startDraft(ctx.app, owner.actor, { leagueId });
    const st = await drafts.getDraft(ctx.app, owner.actor, { leagueId });
    expect(st.draft!.onClockTeamId).toBe(myTeamId);
    const [p1, p2] = await freeAgents(ctx.app, leagueId, 2);
    await expectError(drafts.makePick(ctx.app, human2.actor, { leagueId, draftId: st.draft!.id, playerId: p1.id, expectedPick: 1 }), 403, /isn't your turn/);
    await drafts.makePick(ctx.app, owner.actor, { leagueId, draftId: st.draft!.id, playerId: p1.id, expectedPick: 1 });
    const roster = await ctx.app.db.query('SELECT player_id FROM roster_entries WHERE team_id = $1', [myTeamId]);
    expect(roster.map((r: any) => r.player_id)).toEqual([p1.id]);
    const pool = await drafts.draftAvailable(ctx.app, owner.actor, { leagueId, draftId: st.draft!.id, limit: 300 });
    expect(pool.find((x: any) => x.id === p1.id)).toBeUndefined();
    await expectError(drafts.makePick(ctx.app, human2.actor, { leagueId, draftId: st.draft!.id, playerId: p1.id, expectedPick: 2 }), 409, /already been drafted/);
    await expectError(drafts.makePick(ctx.app, owner.actor, { leagueId, draftId: st.draft!.id, playerId: p2.id, expectedPick: 1 }), 409);
    // commissioner can pause, undo with a reason, and resume
    await drafts.pauseDraft(ctx.app, owner.actor, { leagueId, paused: true });
    await expectError(drafts.makePick(ctx.app, human2.actor, { leagueId, draftId: st.draft!.id, playerId: p2.id, expectedPick: 2 }), 400, /paused/);
    await drafts.pauseDraft(ctx.app, owner.actor, { leagueId, paused: false });
    await expectError(drafts.undoPick(ctx.app, human2.actor, { leagueId, reason: 'mine' }), 403);
    // timer expiry → autopick for the human on the clock
    setTime(ctx, '2026-09-01T12:30:00Z');
    expect(await drafts.draftTick(ctx.app)).toBe(1);
    const after = await drafts.getDraft(ctx.app, owner.actor, { leagueId });
    expect(after.picks!).toHaveLength(2);
    expect((after.picks![1] as any).is_auto).toBe(true);
  });

  it('finishes the draft automatically and builds the schedule', async () => {
    await drafts.autoDraftAll(ctx.app, owner.actor, { leagueId });
    const l = await ctx.app.db.one<{ status: string; current_week: number }>('SELECT status, current_week FROM leagues WHERE id = $1', [leagueId]);
    expect(l).toMatchObject({ status: 'in_season', current_week: 1 });
    const counts = await ctx.app.db.query<{ team_id: string; c: number }>('SELECT team_id, count(*)::int AS c FROM roster_entries WHERE league_id = $1 GROUP BY team_id', [leagueId]);
    expect(counts).toHaveLength(4);
    for (const c of counts) expect(c.c).toBe(15);
    const dupes = await ctx.app.db.query('SELECT player_id FROM roster_entries WHERE league_id = $1 GROUP BY player_id HAVING count(*) > 1', [leagueId]);
    expect(dupes).toHaveLength(0);
    const sched = await views.schedule(ctx.app, owner.actor, { leagueId });
    expect(sched.filter((m: any) => m.week === 1)).toHaveLength(2);
  });

  it('live scores are provisional, finalized scores match the scoring engine, and standings update', async () => {
    // Thursday night of week 1, mid-game
    const firstGame = await ctx.app.db.one<{ kickoff_at: string }>("SELECT kickoff_at FROM nfl_games WHERE season = 2026 AND week = 1 ORDER BY kickoff_at LIMIT 1");
    setTime(ctx, new Date(Date.parse(firstGame!.kickoff_at) + 90 * 60_000).toISOString());
    await runSync(ctx.app, { force: true });
    const live = await views.weekMatchups(ctx.app, owner.actor, { leagueId, week: 1 });
    expect(live.matchups.every((m: any) => m.status === 'live')).toBe(true);
    const liveGames = await ctx.app.db.query("SELECT 1 FROM nfl_games WHERE week = 1 AND status = 'in_progress'");
    expect(liveGames.length).toBeGreaterThan(0);
    const provisional = await ctx.app.db.query('SELECT 1 FROM player_game_stats WHERE week = 1 AND NOT is_final');
    expect(provisional.length).toBeGreaterThan(0);
    // lineup lock: a player whose game started cannot be benched
    const roster = await rosters.getRoster(ctx.app, owner.actor, { teamId: myTeamId });
    const lockedStarter = roster.starters.find((p: any) => p.locked);
    if (lockedStarter) {
      await expectError(rosters.setLineup(ctx.app, owner.actor, { teamId: myTeamId, assignments: [{ playerId: lockedStarter.playerId, slot: 'BN' }] }), 400, /locked/);
    }
    // jump to Tuesday after week 1
    setTime(ctx, '2026-09-15T12:00:00Z');
    await runSync(ctx.app, { force: true });
    const fin = await views.weekMatchups(ctx.app, owner.actor, { leagueId, week: 1 });
    expect(fin.matchups.every((m: any) => m.status === 'final')).toBe(true);
    for (const m of fin.matchups) {
      const sum = Math.round(m.home.starters.reduce((a: number, p: any) => a + p.points, 0) * 100) / 100;
      expect(sum).toBeCloseTo(m.home.points, 2);
    }
    const lg = await ctx.app.db.one<{ current_week: number }>('SELECT current_week FROM leagues WHERE id = $1', [leagueId]);
    expect(lg!.current_week).toBe(2);
    const st = await views.standings(ctx.app, owner.actor, { leagueId });
    expect(st.standings.reduce((a: number, r: any) => a + r.wins + r.losses + r.ties, 0)).toBe(4);
  });

  it('provider stat corrections re-score finalized weeks transparently (auto policy)', async () => {
    const m = await ctx.app.db.one<{ id: string; home_points: number; home_team_id: string }>("SELECT id, home_points, home_team_id FROM matchups WHERE league_id = $1 AND week = 1 LIMIT 1", [leagueId]);
    const starter = await ctx.app.db.one<{ player_id: string }>(`SELECT ml.player_id FROM matchup_lineups ml JOIN nfl_players p ON p.id = ml.player_id
      WHERE ml.matchup_id = $1 AND ml.team_id = $2 AND ml.slot NOT IN ('BN','IR') AND p.position IN ('WR','RB','TE')
        AND EXISTS (SELECT 1 FROM player_game_stats s WHERE s.player_id = ml.player_id AND s.week = 1) LIMIT 1`, [m!.id, m!.home_team_id]);
    const { upsertStats } = await import('../src/services/nfl');
    const row = await ctx.app.db.one<any>("SELECT * FROM player_game_stats WHERE player_id = $1 AND week = 1", [starter!.player_id]);
    expect(row).toBeTruthy();
    const corrected = { ...row.stats, rec_td: (row.stats.rec_td ?? 0) + 1 };
    const res = await upsertStats(ctx.app.db, [{ playerId: row.player_id, gameId: row.game_id, season: 2026, week: 1, stats: corrected, isFinal: true }]);
    expect(res.changed).toBe(1);
    const again = await upsertStats(ctx.app.db, [{ playerId: row.player_id, gameId: row.game_id, season: 2026, week: 1, stats: corrected, isFinal: true }]);
    expect(again.changed).toBe(0); // duplicate delivery is a no-op
    const { onNflDataChanged } = await import('../src/services/scoring');
    await onNflDataChanged(ctx.app, 2026, [1]);
    const after = await ctx.app.db.one<{ home_points: number }>('SELECT home_points FROM matchups WHERE id = $1', [m!.id]);
    expect(after!.home_points).toBeCloseTo(Number(m!.home_points) + 6, 2);
    const corr = await ctx.app.db.query("SELECT * FROM score_corrections WHERE matchup_id = $1 AND status = 'applied'", [m!.id]);
    expect(corr).toHaveLength(1);
  });

  it('scoring changes never silently rewrite finalized weeks; commissioner recalculation is explicit and audited', async () => {
    const before = await ctx.app.db.query<{ id: string; home_points: number }>("SELECT id, home_points FROM matchups WHERE league_id = $1 AND week = 1 ORDER BY id", [leagueId]);
    const rules = scoringPreset('standard'); // league is PPR by default → fewer points
    await leagues.updateScoring(ctx.app, owner.actor, { leagueId, rules, reason: 'Testing standard scoring' });
    const unchanged = await ctx.app.db.query<{ home_points: number }>("SELECT home_points FROM matchups WHERE league_id = $1 AND week = 1 ORDER BY id", [leagueId]);
    expect(unchanged.map((x) => x.home_points)).toEqual(before.map((x) => x.home_points));
    await views.recalculateWeeks(ctx.app, owner.actor, { leagueId, fromWeek: 1, toWeek: 1, useCurrentScoring: true, reason: 'Apply new scoring retroactively' });
    const changed = await ctx.app.db.query<{ home_points: number }>("SELECT home_points FROM matchups WHERE league_id = $1 AND week = 1 ORDER BY id", [leagueId]);
    expect(changed.some((x, i) => x.home_points !== before[i].home_points)).toBe(true);
    const log = await social.auditLog(ctx.app, owner.actor, { leagueId });
    expect(log.find((x: any) => x.action === 'scores.recalculate')?.reason).toBe('Apply new scoring retroactively');
  });
});

describe('template drafts: you pick every player', () => {
  it('a solo High Score Challenge draft is drafted pick by pick by the player and completes the season setup', async () => {
    setTime(ctx, '2026-09-01T12:00:00Z');
    const u = await mkUser(ctx.app);
    const t = buildTemplate('solo', { currentWeek: 1, scoring: 'ppr' });
    const l = await leagues.createLeague(ctx.app, u.actor, { name: 'Solo draft', teamName: 'Me', teamCount: t.teamCount, aiTeams: t.aiTeams, settings: t.settings, scoringPreset: t.scoringPreset });
    await drafts.configureDraft(ctx.app, u.actor, { leagueId: l.id });
    await drafts.startDraft(ctx.app, u.actor, { leagueId: l.id });
    let st = await drafts.getDraft(ctx.app, u.actor, { leagueId: l.id });
    const total = st.draft!.totalPicks;
    expect(total).toBe(15);
    for (let i = 1; i <= total; i++) {
      const pool = await drafts.draftAvailable(ctx.app, u.actor, { leagueId: l.id, draftId: st.draft!.id, limit: 300 });
      // follow positional needs the way a person would: one K and one DST, at the end
      const pick = i === total - 1 ? pool.find((x: any) => x.position === 'K') : i === total ? pool.find((x: any) => x.position === 'DST') : pool.find((x: any) => x.position !== 'K' && x.position !== 'DST');
      await drafts.makePick(ctx.app, u.actor, { leagueId: l.id, draftId: st.draft!.id, playerId: pick!.id, expectedPick: i });
    }
    st = await drafts.getDraft(ctx.app, u.actor, { leagueId: l.id });
    expect(st.draft!.status).toBe('complete');
    expect(st.picks!.every((p: any) => !p.is_auto)).toBe(true);
    const lg = await ctx.app.db.one<{ status: string }>('SELECT status FROM leagues WHERE id = $1', [l.id]);
    expect(lg!.status).toBe('in_season');
  });

  it('a duel against an AI is a live draft; "finish for me" completes it, but never on behalf of other people', async () => {
    setTime(ctx, '2026-09-01T12:00:00Z');
    const u = await mkUser(ctx.app);
    const t = buildTemplate('duel', { currentWeek: 1, scoring: 'ppr', opponent: 'ai' });
    expect(t.settings.draft.pickSeconds).toBe(300);
    const l = await leagues.createLeague(ctx.app, u.actor, { name: 'Duel draft', teamName: 'Me', teamCount: t.teamCount, aiTeams: t.aiTeams, settings: t.settings, scoringPreset: t.scoringPreset });
    await drafts.configureDraft(ctx.app, u.actor, { leagueId: l.id });
    await drafts.startDraft(ctx.app, u.actor, { leagueId: l.id });
    const r = await drafts.finishForMe(ctx.app, u.actor, { leagueId: l.id });
    expect(r.picks).toBe(30);
    expect((await drafts.getDraft(ctx.app, u.actor, { leagueId: l.id })).draft!.status).toBe('complete');

    const friendLeague = buildTemplate('duel', { currentWeek: 1, scoring: 'ppr', opponent: 'friend' });
    const l2 = await leagues.createLeague(ctx.app, u.actor, { name: 'Friend duel', teamName: 'Me', teamCount: 2, aiTeams: 0, settings: friendLeague.settings, scoringPreset: 'ppr' });
    const friend = await mkUser(ctx.app);
    await leagues.joinLeague(ctx.app, friend.actor, { inviteCode: l2.inviteCode, teamName: 'Pal' });
    await drafts.configureDraft(ctx.app, u.actor, { leagueId: l2.id });
    await drafts.startDraft(ctx.app, u.actor, { leagueId: l2.id });
    await expectError(drafts.finishForMe(ctx.app, u.actor, { leagueId: l2.id }), 403, /Other people/);
  });
});

describe('leaving and deleting leagues', () => {
  it('a person who leaves is replaced by an AI manager; their offers are cancelled; the last one out deletes the league', async () => {
    setTime(ctx, '2026-09-01T12:00:00Z');
    const boss = await mkUser(ctx.app), pal = await mkUser(ctx.app);
    const l = await soloLeague(boss, { name: 'Leavers', teamCount: 3, aiTeams: 1 });
    await leagues.joinLeague(ctx.app, pal.actor, { inviteCode: l.inviteCode, teamName: 'Pal FC' });
    await drafts.autoDraftAll(ctx.app, boss.actor, { leagueId: l.id });
    const bossTeam = (await leagues.leagueDetail(ctx.app, boss.actor, { leagueId: l.id })).myTeamId!;
    const palTeam = (await leagues.leagueDetail(ctx.app, pal.actor, { leagueId: l.id })).myTeamId!;
    const give = (await ctx.app.db.one<{ player_id: string }>('SELECT player_id FROM roster_entries WHERE team_id = $1 LIMIT 1', [palTeam]))!.player_id;
    const get = (await ctx.app.db.one<{ player_id: string }>('SELECT player_id FROM roster_entries WHERE team_id = $1 LIMIT 1', [bossTeam]))!.player_id;
    const offer = await trades.proposeTrade(ctx.app, pal.actor, { fromTeamId: palTeam, toTeamId: bossTeam, assets: [
      { type: 'player', fromTeamId: palTeam, toTeamId: bossTeam, playerId: give }, { type: 'player', fromTeamId: bossTeam, toTeamId: palTeam, playerId: get }] });

    const r1 = await leagues.leaveLeague(ctx.app, pal.actor, { leagueId: l.id });
    expect(r1).toMatchObject({ leagueDeleted: false, newCommissionerId: null });
    const t = await ctx.app.db.one<any>('SELECT is_ai, owner_user_id, ai_difficulty FROM teams WHERE id = $1', [palTeam]);
    expect(t).toMatchObject({ is_ai: true, owner_user_id: null, ai_difficulty: 'medium' });
    expect((await ctx.app.db.one<any>('SELECT status FROM trades WHERE id = $1', [offer.tradeId]))!.status).toBe('canceled');
    expect((await ctx.app.db.one<{ c: number }>('SELECT count(*)::int AS c FROM roster_entries WHERE team_id = $1', [palTeam]))!.c).toBe(15); // roster kept
    await expectError(leagues.leagueDetail(ctx.app, pal.actor, { leagueId: l.id }), 404); // private leagues are hidden from non-members

    const r2 = await leagues.leaveLeague(ctx.app, boss.actor, { leagueId: l.id });
    expect(r2.leagueDeleted).toBe(true);
    expect(await ctx.app.db.one('SELECT id FROM leagues WHERE id = $1', [l.id])).toBeNull();
    // the history survives, detached from the deleted league
    const trail = await ctx.app.db.query<{ action: string }>("SELECT action FROM audit_log WHERE target = $1 OR payload->>'teamId' = $2", [l.id, palTeam]);
    expect(trail.map((x) => x.action)).toEqual(expect.arrayContaining(['league.delete', 'member.leave']));
    await expect(ctx.app.db.query("UPDATE audit_log SET action = 'x' WHERE target = $1", [l.id])).rejects.toThrow(/append-only/);
  });

  it('a commissioner who leaves hands the league to the next person; only the commissioner can delete it', async () => {
    setTime(ctx, '2026-09-01T12:00:00Z');
    const boss = await mkUser(ctx.app), pal = await mkUser(ctx.app);
    const l = await soloLeague(boss, { name: 'Handover', teamCount: 3, aiTeams: 0 });
    await leagues.joinLeague(ctx.app, pal.actor, { inviteCode: l.inviteCode });
    const r = await leagues.leaveLeague(ctx.app, boss.actor, { leagueId: l.id });
    expect(r.newCommissionerId).toBe(pal.userId);
    const d = await leagues.leagueDetail(ctx.app, pal.actor, { leagueId: l.id });
    expect(d.role).toBe('commissioner');
    expect(d.league.createdBy).toBe(pal.userId);
    expect(d.teams.find((x: any) => x.owner_user_id === null)?.is_ai).toBe(true); // the old seat is AI-run
    const other = await mkUser(ctx.app);
    await leagues.joinLeague(ctx.app, other.actor, { inviteCode: l.inviteCode });
    await expectError(leagues.deleteLeague(ctx.app, other.actor, { leagueId: l.id, confirmName: 'Handover' }), 403);
    await expectError(leagues.deleteLeague(ctx.app, pal.actor, { leagueId: l.id, confirmName: 'wrong' }), 400);
    await leagues.deleteLeague(ctx.app, pal.actor, { leagueId: l.id, confirmName: 'Handover' });
    expect(await ctx.app.db.one('SELECT id FROM leagues WHERE id = $1', [l.id])).toBeNull();
  });
});

describe('11, 18, 19. acquisitions, waivers and race conditions', () => {
  it('simultaneous free-agent adds of the same player roster him exactly once; requests are idempotent', async () => {
    setTime(ctx, '2026-09-16T12:00:00Z'); // Wednesday of week 2, no games started
    const a = await mkUser(ctx.app); const b = await mkUser(ctx.app);
    const l = await soloLeague(a, { aiTeams: 2 });
    await leagues.joinLeague(ctx.app, b.actor, { inviteCode: l.inviteCode });
    await drafts.autoDraftAll(ctx.app, a.actor, { leagueId: l.id });
    const ta = (await leagues.leagueDetail(ctx.app, a.actor, { leagueId: l.id })).myTeamId!;
    const tb = (await leagues.leagueDetail(ctx.app, b.actor, { leagueId: l.id })).myTeamId!;
    const [fa] = await freeAgents(ctx.app, l.id, 1);
    const dropA = (await ctx.app.db.one<{ player_id: string }>("SELECT player_id FROM roster_entries WHERE team_id = $1 AND slot = 'BN' LIMIT 1", [ta]))!.player_id;
    const dropB = (await ctx.app.db.one<{ player_id: string }>("SELECT player_id FROM roster_entries WHERE team_id = $1 AND slot = 'BN' LIMIT 1", [tb]))!.player_id;
    const results = await Promise.allSettled([
      rosters.addFreeAgent(ctx.app, a.actor, { teamId: ta, addPlayerId: fa.id, dropPlayerId: dropA, requestId: 'req-aaaaaaaa' }),
      rosters.addFreeAgent(ctx.app, b.actor, { teamId: tb, addPlayerId: fa.id, dropPlayerId: dropB, requestId: 'req-bbbbbbbb' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.status).toBe(409);
    const owners = await ctx.app.db.query('SELECT team_id FROM roster_entries WHERE league_id = $1 AND player_id = $2', [l.id, fa.id]);
    expect(owners).toHaveLength(1);
    // the loser's drop was rolled back with the failed transaction
    const winner = owners[0].team_id === ta ? 'a' : 'b';
    const loserDrop = winner === 'a' ? dropB : dropA;
    expect(await ctx.app.db.one('SELECT 1 FROM roster_entries WHERE player_id = $1 AND league_id = $2', [loserDrop, l.id])).toBeTruthy();
    // replaying the winning request id is a no-op
    const replay = await rosters.addFreeAgent(ctx.app, winner === 'a' ? a.actor : b.actor, { teamId: winner === 'a' ? ta : tb, addPlayerId: fa.id, dropPlayerId: winner === 'a' ? dropA : dropB, requestId: winner === 'a' ? 'req-aaaaaaaa' : 'req-bbbbbbbb' });
    expect(replay.duplicate).toBe(true);
    // dropped players go on waivers, so they cannot be added as free agents
    const dropped = winner === 'a' ? dropA : dropB;
    await expectError(rosters.addFreeAgent(ctx.app, winner === 'a' ? b.actor : a.actor, { teamId: winner === 'a' ? tb : ta, addPlayerId: dropped, dropPlayerId: winner === 'a' ? dropB : dropA, requestId: 'req-cccccccc' }), 400, /on waivers/);
  });

  it('FAAB waivers: highest bid wins, budgets update, results are explained and notified', async () => {
    setTime(ctx, '2026-09-16T12:00:00Z');
    const a = await mkUser(ctx.app); const b = await mkUser(ctx.app);
    const l = await soloLeague(a, { aiTeams: 2 });
    await leagues.joinLeague(ctx.app, b.actor, { inviteCode: l.inviteCode });
    await drafts.autoDraftAll(ctx.app, a.actor, { leagueId: l.id });
    // AI managers would also file claims; make them unable to (no FAAB) so the test is about A vs B.
    await ctx.app.db.query('UPDATE teams SET faab_remaining = 0 WHERE league_id = $1 AND is_ai', [l.id]);
    const ta = (await leagues.leagueDetail(ctx.app, a.actor, { leagueId: l.id })).myTeamId!;
    const tb = (await leagues.leagueDetail(ctx.app, b.actor, { leagueId: l.id })).myTeamId!;
    const [target] = await freeAgents(ctx.app, l.id, 1);
    await ctx.app.db.query('INSERT INTO player_waivers (league_id, player_id, clears_at) VALUES ($1,$2,$3)', [l.id, target.id, '2026-09-23T08:00:00Z']);
    await expectError(rosters.addFreeAgent(ctx.app, a.actor, { teamId: ta, addPlayerId: target.id, requestId: 'x-12345678' }), 400, /waivers/);
    const bench = async (t: string) => (await ctx.app.db.one<{ player_id: string }>("SELECT player_id FROM roster_entries WHERE team_id = $1 AND slot = 'BN' LIMIT 1", [t]))!.player_id;
    await expectError(waivers.submitClaim(ctx.app, a.actor, { teamId: ta, addPlayerId: target.id, bid: 500, dropPlayerId: await bench(ta) }), 400, /FAAB remaining/);
    await waivers.submitClaim(ctx.app, a.actor, { teamId: ta, addPlayerId: target.id, bid: 17, dropPlayerId: await bench(ta) });
    await waivers.submitClaim(ctx.app, b.actor, { teamId: tb, addPlayerId: target.id, bid: 23, dropPlayerId: await bench(tb) });
    await expectError(waivers.submitClaim(ctx.app, b.actor, { teamId: tb, addPlayerId: target.id, bid: 30, dropPlayerId: await bench(tb) }), 409, /already have a pending claim/);
    await expectError(waivers.processWaivers(ctx.app, l.id, b.actor), 403); // managers cannot force processing
    setTime(ctx, '2026-09-23T09:00:00Z');
    await runSync(ctx.app, { force: true }); // the sync job keeps game state current; week 2 is final by now
    const r = await waivers.processWaivers(ctx.app, l.id);
    expect(r.awarded).toBeGreaterThanOrEqual(1); // AI managers may also win $0 claims on other players
    expect((await ctx.app.db.one<{ team_id: string }>('SELECT team_id FROM roster_entries WHERE league_id = $1 AND player_id = $2', [l.id, target.id]))!.team_id).toBe(tb);
    expect((await ctx.app.db.one<{ faab_remaining: number }>('SELECT faab_remaining FROM teams WHERE id = $1', [tb]))!.faab_remaining).toBe(77);
    const lost = await ctx.app.db.one<{ status: string; result_reason: string }>('SELECT status, result_reason FROM waiver_claims WHERE team_id = $1', [ta]);
    expect(lost).toMatchObject({ status: 'lost' });
    expect(lost!.result_reason).toMatch(/Outbid/);
    const notes = await social.listNotifications(ctx.app, a.actor, {});
    expect(notes.notifications.some((n: any) => n.kind === 'waiver_result')).toBe(true);
  });
});

describe('15–17. trades and the digital commissioner', () => {
  let a: any, b: any, c: any, l: any, ta: string, tb: string;
  const bench = async (t: string, n = 1) => (await ctx.app.db.query<{ player_id: string }>("SELECT player_id FROM roster_entries WHERE team_id = $1 AND slot = 'BN' ORDER BY player_id LIMIT $2", [t, n])).map((r) => r.player_id);
  const swap = async (x: string, y: string) => {
    const [px] = await bench(x); const [py] = await bench(y);
    return [{ fromTeamId: x, toTeamId: y, type: 'player', playerId: px }, { fromTeamId: y, toTeamId: x, type: 'player', playerId: py }];
  };
  beforeAll(async () => {
    setTime(ctx, '2026-09-16T12:00:00Z');
    a = await mkUser(ctx.app); b = await mkUser(ctx.app); c = await mkUser(ctx.app);
    l = await soloLeague(a, { aiTeams: 1 });
    await leagues.joinLeague(ctx.app, b.actor, { inviteCode: l.inviteCode });
    await leagues.joinLeague(ctx.app, c.actor, { inviteCode: l.inviteCode });
    await drafts.autoDraftAll(ctx.app, a.actor, { leagueId: l.id });
    ta = (await leagues.leagueDetail(ctx.app, a.actor, { leagueId: l.id })).myTeamId!;
    tb = (await leagues.leagueDetail(ctx.app, b.actor, { leagueId: l.id })).myTeamId!;
  });

  it('propose → reject, propose → counter → accept → commissioner approves → executes atomically', async () => {
    const t1 = await trades.proposeTrade(ctx.app, a.actor, { fromTeamId: ta, toTeamId: tb, assets: await swap(ta, tb) });
    await expectError(trades.acceptTrade(ctx.app, a.actor, { tradeId: t1.tradeId }), 403); // proposer cannot accept own offer
    await trades.rejectTrade(ctx.app, b.actor, { tradeId: t1.tradeId, reason: 'No thanks' });
    const t2 = await trades.proposeTrade(ctx.app, a.actor, { fromTeamId: ta, toTeamId: tb, assets: await swap(ta, tb) });
    const [pa] = await bench(ta); const [pb1, pb2] = await bench(tb, 2);
    const counter = await trades.counterTrade(ctx.app, b.actor, { tradeId: t2.tradeId, assets: [
      { fromTeamId: tb, toTeamId: ta, type: 'player', playerId: pb1 }, { fromTeamId: tb, toTeamId: ta, type: 'player', playerId: pb2 },
      { fromTeamId: ta, toTeamId: tb, type: 'player', playerId: pa },
    ] });
    expect((await ctx.app.db.one<{ status: string }>('SELECT status FROM trades WHERE id = $1', [t2.tradeId]))!.status).toBe('countered');
    // A receives 2 players for 1 with a full roster → must choose a drop
    await expectError(trades.acceptTrade(ctx.app, a.actor, { tradeId: counter.tradeId }), 400, /drop/i);
    const dropForA = (await bench(ta, 3)).find((x) => x !== pa)!;
    const acc = await trades.acceptTrade(ctx.app, a.actor, { tradeId: counter.tradeId, recipientDrops: [dropForA] });
    expect(acc.route).toBe('commissioner');
    // a manager cannot approve; the commissioner is party to the trade and is the only commissioner → allowed but audited
    await expectError(trades.commissionerDecision(ctx.app, c.actor, { tradeId: counter.tradeId, decision: 'approve', reason: 'looks fine' }), 403);
    await trades.commissionerDecision(ctx.app, a.actor, { tradeId: counter.tradeId, decision: 'approve', reason: 'Fair depth swap' });
    const t = await ctx.app.db.one<{ status: string }>('SELECT status FROM trades WHERE id = $1', [counter.tradeId]);
    expect(t!.status).toBe('executed');
    const owner = async (p: string) => (await ctx.app.db.one<{ team_id: string }>('SELECT team_id FROM roster_entries WHERE league_id = $1 AND player_id = $2', [l.id, p]))?.team_id;
    expect(await owner(pb1)).toBe(ta); expect(await owner(pb2)).toBe(ta); expect(await owner(pa)).toBe(tb);
    expect(await owner(dropForA)).toBeUndefined();
    const log = await social.auditLog(ctx.app, a.actor, { leagueId: l.id });
    expect(log.find((x: any) => x.action === 'trade.commissioner_approve')?.payload.selfReview).toBe(true);
  });

  it('league vote: duplicate votes are rejected, observers cannot vote, veto threshold enforced', async () => {
    const det = await leagues.leagueDetail(ctx.app, a.actor, { leagueId: l.id });
    const s = { ...det.settings, trades: { ...det.settings.trades, review: 'league_vote', vetoThreshold: 0.5, involvedManagersCanVote: true, showVoteCounts: 'live' } };
    await leagues.updateSettings(ctx.app, a.actor, { leagueId: l.id, settings: s });
    const obs = await mkUser(ctx.app);
    await leagues.addObserver(ctx.app, a.actor, { leagueId: l.id, username: obs.username });
    const tc = (await leagues.leagueDetail(ctx.app, c.actor, { leagueId: l.id })).myTeamId!;
    const t = await trades.proposeTrade(ctx.app, b.actor, { fromTeamId: tb, toTeamId: tc, assets: await swap(tb, tc) });
    const acc = await trades.acceptTrade(ctx.app, c.actor, { tradeId: t.tradeId });
    expect(acc.route).toBe('league_vote');
    await expectError(trades.voteTrade(ctx.app, obs.actor, { tradeId: t.tradeId, vote: 'approve' }), 403);
    const v1 = await trades.voteTrade(ctx.app, a.actor, { tradeId: t.tradeId, vote: 'veto' });
    expect(v1.outcome).toBe('pending');
    await expectError(trades.voteTrade(ctx.app, a.actor, { tradeId: t.tradeId, vote: 'approve' }), 409, /already voted/);
    const list = await trades.listTrades(ctx.app, a.actor, { leagueId: l.id });
    expect(list.find((x: any) => x.id === t.tradeId)!.votes).toEqual({ approve: 0, veto: 1 });
    // 3 eligible voters; veto needs ceil(0.5 × 3) = 2
    const v2 = await trades.voteTrade(ctx.app, c.actor, { tradeId: t.tradeId, vote: 'veto' });
    expect(v2.outcome).toBe('vetoed');
    const row = await ctx.app.db.one<{ status: string; decision_reason: string }>('SELECT status, decision_reason FROM trades WHERE id = $1', [t.tradeId]);
    expect(row!.status).toBe('vetoed');
    expect(row!.decision_reason).toMatch(/2 veto of 3 eligible/);
  });

  it('auto approval executes immediately; AI managers respond through the same rules', async () => {
    const det = await leagues.leagueDetail(ctx.app, a.actor, { leagueId: l.id });
    await leagues.updateSettings(ctx.app, a.actor, { leagueId: l.id, settings: { ...det.settings, trades: { ...det.settings.trades, review: 'auto' } } });
    const tc = (await leagues.leagueDetail(ctx.app, c.actor, { leagueId: l.id })).myTeamId!;
    const t = await trades.proposeTrade(ctx.app, c.actor, { fromTeamId: tc, toTeamId: tb, assets: await swap(tc, tb) });
    await trades.acceptTrade(ctx.app, b.actor, { tradeId: t.tradeId });
    expect((await ctx.app.db.one<{ status: string }>('SELECT status FROM trades WHERE id = $1', [t.tradeId]))!.status).toBe('executed');
    const aiTeam = det.teams.find((x: any) => x.is_ai)!.id;
    const ai = await trades.proposeTrade(ctx.app, a.actor, { fromTeamId: ta, toTeamId: aiTeam, assets: await swap(ta, aiTeam) });
    const after = await ctx.app.db.one<{ status: string; decision_reason: string | null }>('SELECT status, decision_reason FROM trades WHERE id = $1', [ai.tradeId]);
    expect(['executed', 'rejected']).toContain(after!.status);
  });

  it('trade deadline is enforced', async () => {
    await ctx.app.db.query('UPDATE leagues SET current_week = 6 WHERE id = $1', [l.id]);
    await expectError(trades.proposeTrade(ctx.app, a.actor, { fromTeamId: ta, toTeamId: tb, assets: await swap(ta, tb) }), 400, /deadline/);
    await ctx.app.db.query('UPDATE leagues SET current_week = 2 WHERE id = $1', [l.id]);
  });
});

describe('21–23. notifications, honest data-provider failures, optional AI', () => {
  it('notifications and activity persist and can be marked read', async () => {
    const a = await mkUser(ctx.app);
    const l = await soloLeague(a);
    const act = await social.listActivity(ctx.app, a.actor, { leagueId: l.id });
    expect(act[0].summary).toMatch(/was created/);
    await social.announce(ctx.app, a.actor, { leagueId: l.id, title: 'Draft tonight', body: '8pm sharp' });
    const n = await social.listNotifications(ctx.app, a.actor, {});
    expect(n.unread).toBeGreaterThan(0);
    await social.markNotificationsRead(ctx.app, a.actor, { all: true });
    expect((await social.listNotifications(ctx.app, a.actor, {})).unread).toBe(0);
  });

  it('reports unconfigured and failing providers honestly, with backoff', async () => {
    const original = ctx.app.provider;
    try {
      ctx.app.provider = new UnconfiguredProvider();
      const s = await dataStatus(ctx.app);
      expect(s.health).toBe('unconfigured');
      expect(s.message).toMatch(/No NFL data provider is configured/);
      ctx.app.provider = Object.assign(Object.create(original), { id: 'flaky', label: 'Flaky Provider', isDemo: false, configured: true, livePollSeconds: 30, idlePollSeconds: 300,
        currentSeason: async () => { throw new ProviderError('HTTP 503 from provider', 'http'); } });
      const r1 = await runSync(ctx.app, { force: true });
      const r2 = await runSync(ctx.app, { force: true });
      expect(r1.ok).toBe(false);
      expect(r2.nextRunInSeconds).toBeGreaterThan(r1.nextRunInSeconds); // exponential backoff
      const s2 = await dataStatus(ctx.app);
      expect(['stale', 'error']).toContain(s2.health);
      expect(s2.lastError).toMatch(/503/);
    } finally {
      ctx.app.provider = original;
      await runSync(ctx.app, { force: true });
    }
  });

  it('core features work without an AI provider; the assistant falls back to grounded rule-based insights', async () => {
    const a = await mkUser(ctx.app);
    const l = await soloLeague(a);
    await drafts.autoDraftAll(ctx.app, a.actor, { leagueId: l.id });
    expect(assistant.assistantStatus(ctx.app).aiAvailable).toBe(false);
    const r = await assistant.ask(ctx.app, a.actor, { leagueId: l.id, question: 'Who should I start?' });
    expect(r.mode).toBe('rule_based');
    expect(r.insights.some((i) => i.kind === 'missing' && /simulated demo data/.test(i.detail))).toBe(true);
    expect(r.insights.some((i) => i.kind === 'projection')).toBe(true);
  });
});

describe('refresh league (creator only)', () => {
  it('lets only the creator refresh, enforces a cooldown and finalizes completed weeks', async () => {
    const { refreshLeague } = await import('../src/services/refresh');
    setTime(ctx, '2026-09-01T12:00:00Z');
    const creator = await mkUser(ctx.app); const other = await mkUser(ctx.app);
    const l = await soloLeague(creator, { aiTeams: 2 });
    await leagues.joinLeague(ctx.app, other.actor, { inviteCode: l.inviteCode });
    await leagues.setMemberRole(ctx.app, creator.actor, { leagueId: l.id, userId: other.userId, role: 'co_commissioner' });
    await drafts.autoDraftAll(ctx.app, creator.actor, { leagueId: l.id });
    await expectError(refreshLeague(ctx.app, other.actor, { leagueId: l.id }), 403, /Only the league creator/);
    const stranger = await mkUser(ctx.app);
    await expectError(refreshLeague(ctx.app, stranger.actor, { leagueId: l.id }), 404);
    const start = (await ctx.app.db.one<{ current_week: number }>('SELECT current_week FROM leagues WHERE id = $1', [l.id]))!.current_week;
    const last = (await ctx.app.db.one<{ k: string }>('SELECT max(kickoff_at) AS k FROM nfl_games WHERE season = 2026 AND week = $1', [start]))!.k;
    const after = Date.parse(last) + 24 * 3_600_000;
    setTime(ctx, new Date(after).toISOString()); // the league's first week is complete
    const r = await refreshLeague(ctx.app, creator.actor, { leagueId: l.id });
    expect(r.ok).toBe(true);
    expect(r.currentWeek).toBe(start + 1);
    expect(r.weeksFinalized).toBe(1);
    const finals = await ctx.app.db.query("SELECT 1 FROM matchups WHERE league_id = $1 AND week = $2 AND status = 'final'", [l.id, start]);
    expect(finals.length).toBe(2);
    await expectError(refreshLeague(ctx.app, creator.actor, { leagueId: l.id }), 429, /moments ago/);
    setTime(ctx, new Date(after + 120_000).toISOString());
    expect((await refreshLeague(ctx.app, creator.actor, { leagueId: l.id })).ok).toBe(true);
    const log = await social.auditLog(ctx.app, creator.actor, { leagueId: l.id });
    expect(log.filter((x: any) => x.action === 'league.refresh')).toHaveLength(2);
  });
});

describe('league isolation', () => {
  it('the same NFL player can be rostered in different leagues, but only once within a league', async () => {
    const shared = await ctx.app.db.query("SELECT player_id FROM roster_entries GROUP BY player_id HAVING count(DISTINCT league_id) > 1 LIMIT 1");
    expect(shared.length).toBe(1);
    const dupes = await ctx.app.db.query('SELECT 1 FROM roster_entries GROUP BY league_id, player_id HAVING count(*) > 1');
    expect(dupes).toHaveLength(0);
  });
});

describe('API layer', () => {
  it('requires authentication and rejects unknown methods', async () => {
    await expectError(call(ctx.app, 'leagues.mine', {}, { user: null, token: null, ip: 't' }), 401);
    await expectError(call(ctx.app, 'leagues.nope', {}, { user: null, token: null, ip: 't' }), 404);
    const r = await call(ctx.app, 'auth.register', { username: 'apiuser', email: 'api@example.com', password: 'password123' }, { user: null, token: null, ip: 't' });
    expect(r.setToken?.token).toBeTruthy();
    expect(JSON.stringify(r.data)).not.toMatch(/password_hash|scrypt/);
  });
});
