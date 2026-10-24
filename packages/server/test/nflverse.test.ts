import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scoreStatLine, scoringPreset } from '@gridiron/core';
import { buildNflverseDataset, DatasetProvider, parseCsv } from '../src/providers/nflverse';
import { mapSleeperStats, SleeperOverlayProvider } from '../src/providers/sleeper';

const F = (n: string) => readFileSync(new URL(`./fixtures/nflverse/${n}`, import.meta.url), 'utf8');
const ds = buildNflverseDataset({ season: 2026, players: F('players.csv'), games: F('games.csv'), playerStats: F('stats_player_week_2026.csv'), teamStats: F('stats_team_week_2026.csv'), asOf: '2026-10-24T19:40:00Z' });

describe('nflverse adapter (real 2026 data fixtures)', () => {
  it('parses quoted CSV fields', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\r\n1,2\n')).toEqual([{ a: 'x, y', b: 'he said "hi"' }, { a: '1', b: '2' }]);
  });
  it('uses GSIS ids, normalizes team codes and converts Eastern kickoffs to UTC', () => {
    expect(ds.players.every((p) => /^nflverse:(00-|DST-)/.test(p.id))).toBe(true);
    expect(ds.games.some((g) => g.homeTeamId === 'LA' || g.awayTeamId === 'LA')).toBe(false);
    const tnf = ds.games.find((g) => g.id === 'nflverse:2026_07_NE_CHI')!;
    expect(tnf).toMatchObject({ kickoffAt: '2026-10-23T00:15:00.000Z', status: 'final', homeScore: 30, awayScore: 24 });
  });
  it('our PPR scoring reproduces nflverse fantasy_points_ppr for real stat lines', () => {
    const rows = parseCsv(F('stats_player_week_2026.csv')).filter((r) => r.position !== 'K');
    const ppr = scoringPreset('ppr');
    let compared = 0;
    for (const r of rows) {
      const line = ds.stats.find((s) => s.playerId === `nflverse:${r.player_id}` && s.week === Number(r.week));
      if (!line) continue;
      const pos = ds.players.find((p) => p.id === line.playerId)!.position;
      expect(scoreStatLine(line.stats, ppr, pos).total).toBeCloseTo(Number(r.fantasy_points_ppr), 1);
      compared++;
    }
    expect(compared).toBeGreaterThan(200);
  });
  it('builds team defense lines with points and yards allowed', () => {
    const d = ds.stats.filter((s) => s.playerId.startsWith('nflverse:DST-'));
    expect(d.length).toBe(32 * 2 - ds.games.filter((g) => g.week <= 2 && g.status !== 'final').length * 2);
    for (const x of d) { expect(x.stats.def_pts_allowed).toBeGreaterThanOrEqual(0); expect(x.stats.def_yds_allowed).toBeGreaterThan(50); }
  });
  it('replays the season against the clock without revealing future results', async () => {
    let now = new Date('2026-09-01T00:00:00Z');
    const p = new DatasetProvider(async () => ds, { now: () => now }, { id: 'snap', label: 'snap', snapshotAsOf: ds.asOf });
    expect((await p.weekGames(2026, 1)).every((g) => g.status === 'scheduled' && g.homeScore === null)).toBe(true);
    expect(await p.weekStats(2026, 1)).toHaveLength(0);
    now = new Date('2026-09-16T00:00:00Z');
    expect((await p.weekGames(2026, 1)).every((g) => g.status === 'final')).toBe(true);
    expect((await p.weekStats(2026, 1)).length).toBeGreaterThan(50);
    expect((await p.currentSeason(now)).week).toBe(2);
    now = new Date('2026-10-25T15:00:00Z'); // a week-7 Sunday game has kicked off but the snapshot has no result
    const pitNo = (await p.weekGames(2026, 7)).find((g) => g.id === 'nflverse:2026_07_PIT_NO')!;
    expect(pitNo.status).toBe('in_progress');
    expect(pitNo.clock).toMatch(/No live data/);
  });
});

describe('Sleeper overlay (fixture responses; unofficial API)', () => {
  it('maps Sleeper stat keys', () => {
    expect(mapSleeperStats({ pass_yd: 251, pass_td: 2, rush_yd: 12, fgm_20_29: 1 }, false)).toEqual({ pass_yd: 251, pass_td: 2, rush_yd: 12, fgm_0_39: 1 });
    expect(mapSleeperStats({ sack: 2, pts_allow: 0, yds_allow: 280 }, true)).toEqual({ def_sack: 2, def_pts_allowed: 0, def_yds_allowed: 280 });
  });
  it('overlays injuries by GSIS id and adds provisional in-game stats; falls back when unreachable', async () => {
    const now = new Date('2026-10-25T15:00:00Z');
    const base = new DatasetProvider(async () => ds, { now: () => now }, { id: 'nflverse', label: 'nflverse' });
    const someone = ds.players.find((p) => p.position === 'QB' && p.nflTeamId === 'PIT') ?? ds.players.find((p) => p.position !== 'DST')!;
    const fake = (async (url: string) => {
      if (url.endsWith('/players/nfl')) return new Response(JSON.stringify({ '9999': { gsis_id: someone.providerPlayerId, injury_status: 'Questionable', injury_body_part: 'Ankle' } }));
      if (url.includes('/stats/nfl/regular/2026/7')) return new Response(JSON.stringify({ '9999': { pass_yd: 120, pass_td: 1 }, PIT: { sack: 1, pts_allow: 7 } }));
      return new Response('', { status: 404 });
    }) as any;
    const p = new SleeperOverlayProvider(base, fake);
    const players = await p.players();
    expect(players.find((x) => x.id === someone.id)!.injuryStatus).toBe('questionable');
    const stats = await p.weekStats(2026, 7);
    const mine = stats.find((s) => s.playerId === someone.id);
    if (someone.nflTeamId === 'PIT') { expect(mine).toMatchObject({ isFinal: false, stats: { pass_yd: 120, pass_td: 1 } }); }
    expect(stats.find((s) => s.playerId === 'nflverse:DST-PIT')?.stats.def_sack).toBe(1);
    const down = new SleeperOverlayProvider(base, (async () => { throw new Error('offline'); }) as any);
    expect((await down.players()).length).toBe(ds.players.length);
    expect(down.lastError).toBe('offline');
  });
});
