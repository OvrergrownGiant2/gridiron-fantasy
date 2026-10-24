import { describe, expect, it } from 'vitest';
import { mapDefenseStat, mapGame, mapInjury, mapPlayerStat, mapStatus, SportsDataIoProvider } from '../src/providers/sportsdataio';
import { DemoProvider, easternToUtc } from '../src/providers/demo';
import { backoffSeconds } from '../src/services/nfl';

describe('SportsDataIO adapter (fixture-based; no network)', () => {
  it('maps game status vocabulary', () => {
    expect(['Scheduled', 'InProgress', 'Final', 'F/OT', 'Postponed', 'Canceled', 'Suspended'].map(mapStatus))
      .toEqual(['scheduled', 'in_progress', 'final', 'final', 'postponed', 'canceled', 'delayed']);
    expect(mapInjury('Injured Reserve')).toBe('ir');
    expect(mapInjury(null)).toBe('healthy');
  });
  it('maps a game using UTC kickoff and stable ids', () => {
    const g = mapGame({ GlobalGameID: 18431, Week: 8, HomeTeam: 'KC', AwayTeam: 'BUF', DateTimeUTC: '2026-10-25T20:25:00', Status: 'InProgress', HomeScore: 14, AwayScore: 10, Quarter: '3', TimeRemaining: '08:12' }, 2026);
    expect(g).toMatchObject({ id: 'sdio-18431', week: 8, kickoffAt: '2026-10-25T20:25:00.000Z', status: 'in_progress', homeScore: 14 });
  });
  it('maps player stat lines by provider PlayerID (never by name)', () => {
    const s = mapPlayerStat({ PlayerID: 99, Name: 'Same Name', Position: 'WR', GlobalGameID: 5, Week: 8, Receptions: 6, ReceivingYards: 88, ReceivingTouchdowns: 1, FumblesLost: 0, FieldGoalsAttempted: 0, IsGameOver: false }, 2026)!;
    expect(s.playerId).toBe('sportsdataio:99');
    expect(s.stats).toEqual({ rec: 6, rec_yd: 88, rec_td: 1 });
    expect(s.isFinal).toBe(false);
    expect(mapPlayerStat({ PlayerID: 1, Position: 'OL' }, 2026)).toBeNull();
    const k = mapPlayerStat({ PlayerID: 7, Position: 'K', GlobalGameID: 5, Week: 8, FieldGoalsMade20to29: 1, FieldGoalsMade40to49: 2, FieldGoalsAttempted: 4, FieldGoalsMade: 3, ExtraPointsMade: 2, ExtraPointsAttempted: 2 }, 2026)!;
    expect(k.stats).toEqual({ fgm_0_39: 1, fgm_40_49: 2, fg_miss: 1, xpm: 2 });
    const d = mapDefenseStat({ Team: 'KC', GlobalGameID: 5, Week: 8, Sacks: 3, Interceptions: 1, PointsAllowed: 17, OffensiveYardsAllowed: 301, IsGameOver: true }, 2026);
    expect(d).toMatchObject({ playerId: 'sportsdataio:DST-KC', isFinal: true, stats: { def_sack: 3, def_int: 1, def_pts_allowed: 17 } });
  });
  it('sends the key in a header, surfaces rate limits and missing keys honestly', async () => {
    let seenHeader = '';
    const fake = (async (_url: string, init: any) => { seenHeader = init.headers['Ocp-Apim-Subscription-Key']; return new Response('[]', { status: 429, headers: { 'retry-after': '120' } }); }) as any;
    const p = new SportsDataIoProvider('secret-key', fake);
    await expect(p.teams()).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 120 });
    expect(seenHeader).toBe('secret-key');
    await expect(new SportsDataIoProvider(undefined, fake).teams()).rejects.toMatchObject({ kind: 'unconfigured' });
    expect(backoffSeconds(60, 3, 120)).toBe(480);
    expect(backoffSeconds(60, 20)).toBe(1800);
  });
});

describe('demo provider', () => {
  it('handles daylight saving when converting Eastern kickoffs', () => {
    expect(easternToUtc(2026, 9, 25, 13, 0).toISOString()).toBe('2026-10-25T17:00:00.000Z'); // EDT
    expect(easternToUtc(2026, 10, 8, 13, 0).toISOString()).toBe('2026-11-08T18:00:00.000Z'); // EST
  });
  it('is deterministic and progresses with the clock', async () => {
    let now = new Date('2026-09-10T00:00:00Z');
    const p = new DemoProvider({ now: () => now });
    const g = (await p.weekGames(2026, 1))[0];
    expect(g.status).toBe('scheduled');
    now = new Date(Date.parse(g.kickoffAt) + 90 * 60_000);
    const live = (await p.weekGames(2026, 1)).find((x) => x.id === g.id)!;
    expect(['in_progress', 'delayed']).toContain(live.status);
    now = new Date(Date.parse(g.kickoffAt) + 6 * 3600_000);
    const fin = (await p.weekGames(2026, 1)).find((x) => x.id === g.id)!;
    expect(fin.status).toBe('final');
    const again = (await new DemoProvider({ now: () => now }).weekGames(2026, 1)).find((x) => x.id === g.id)!;
    expect(again).toEqual(fin);
    const sched = await p.schedule(2026);
    const teams = new Set(sched.flatMap((x) => [x.homeTeamId, x.awayTeamId]));
    expect(teams.size).toBe(32);
    for (const t of teams) expect(sched.filter((x) => x.homeTeamId === t || x.awayTeamId === t)).toHaveLength(17); // one bye each
  });
});
