import { describe, expect, it } from 'vitest';
import {
  computeRatings, ratingTier,
  scoringPreset, scoreStatLine, statHash, round2,
  DEFAULT_ROSTER, validateRoster, optimizeLineup, hasRoomFor, eligibleSlots,
  teamIndexForPick, chooseAutoPick, maxAuctionBid, validateBid,
  resolveWaivers, nextWaiverRun,
  roundRobin, playoffFirstRound, seedOrder, doubleHeaderSchedule,
  computeStandings, decideVote, reviewRoute, validateTradeAssets, analyzeTrade, integrityFlags,
  defaultLeagueSettings, validateLeagueSettings, leagueSettingsSchema,
  contrastRatio, ensureContrast, readableTextOn,
  projectPlayer, winProbability, can, aiAcceptsTrade,
  type ScoringRules, type PendingClaim, type TeamWaiverState, type OptimizerPlayer,
} from '../src';

describe('scoring engine', () => {
  const std = scoringPreset('standard');
  const half = scoringPreset('half_ppr');
  const ppr = scoringPreset('ppr');
  const wrLine = { rec: 7, rec_yd: 93, rec_td: 1, fum_lost: 1 };

  it('applies standard / half / full PPR differently to the same stats', () => {
    expect(scoreStatLine(wrLine, std, 'WR').total).toBe(13.3);   // 9.3 + 6 - 2
    expect(scoreStatLine(wrLine, half, 'WR').total).toBe(16.8);
    expect(scoreStatLine(wrLine, ppr, 'WR').total).toBe(20.3);
  });

  it('handles fractional yardage without float drift', () => {
    const r = scoreStatLine({ pass_yd: 333 }, std, 'QB');
    expect(r.total).toBe(13.32);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it('supports negative totals', () => {
    const r = scoreStatLine({ pass_yd: 20, pass_int: 3, fum_lost: 2 }, std, 'QB');
    expect(r.total).toBe(0.8 - 6 - 4);
  });

  it('scores DST points-allowed tiers and ignores offensive stats for DST', () => {
    const r = scoreStatLine({ def_sack: 3, def_int: 1, def_pts_allowed: 0, rush_yd: 50 }, std, 'DST');
    expect(r.total).toBe(3 + 2 + 10);
    expect(scoreStatLine({ def_pts_allowed: 35 }, std, 'DST').total).toBe(-4);
    expect(scoreStatLine({ def_pts_allowed: 27 }, std, 'DST').total).toBe(0);
  });

  it('ignores defensive stats for offensive players', () => {
    expect(scoreStatLine({ def_sack: 2, rush_yd: 10 }, std, 'RB').total).toBe(1);
  });

  it('applies yards-allowed tiers when configured', () => {
    const rules: ScoringRules = { ...std, yardsAllowedTiers: [{ max: 199, points: 5 }, { max: 299, points: 2 }, { max: null, points: -1 }] };
    expect(scoreStatLine({ def_pts_allowed: 14, def_yds_allowed: 250 }, rules, 'DST').total).toBe(1 + 2);
  });

  it('applies bonus thresholds exactly at the boundary, and lte penalties', () => {
    const rules: ScoringRules = {
      ...std,
      bonuses: [
        { id: 'r100', label: '100+ rush yds', stat: 'rush_yd', threshold: 100, comparator: 'gte', points: 3 },
        { id: 'p300', label: '300+ pass yds', stat: 'pass_yd', threshold: 300, comparator: 'gte', points: 2 },
        { id: 'dud', label: 'Under 5 rush yds', stat: 'rush_yd', threshold: 4, comparator: 'lte', points: -1.5 },
      ],
    };
    expect(scoreStatLine({ rush_yd: 100 }, rules, 'RB').total).toBe(13);
    expect(scoreStatLine({ rush_yd: 99 }, rules, 'RB').total).toBe(9.9);
    expect(scoreStatLine({ rush_yd: 3 }, rules, 'RB').total).toBe(0.3 - 1.5);
  });

  it('scores kickers by distance', () => {
    expect(scoreStatLine({ fgm_0_39: 1, fgm_40_49: 1, fgm_50p: 1, fg_miss: 1, xpm: 3 }, std, 'K').total).toBe(3 + 4 + 5 - 1 + 3);
  });

  it('produces an explainable breakdown that sums to the total', () => {
    const r = scoreStatLine({ pass_yd: 287, pass_td: 2, pass_int: 1, rush_yd: 23 }, ppr, 'QB');
    const sum = round2(r.lines.reduce((a, l) => a + l.points, 0));
    expect(sum).toBe(r.total);
    expect(r.lines.map((l) => l.key)).toEqual(['pass_yd', 'pass_td', 'pass_int', 'rush_yd']);
  });

  it('stat hash changes on corrections and on finalization, but is stable for identical deliveries', () => {
    const a = statHash({ rush_yd: 80, rush_td: 1 }, false);
    expect(statHash({ rush_td: 1, rush_yd: 80 }, false)).toBe(a);   // key order independent
    expect(statHash({ rush_yd: 82, rush_td: 1 }, false)).not.toBe(a); // provider correction
    expect(statHash({ rush_yd: 80, rush_td: 1 }, true)).not.toBe(a);  // provisional → final
  });
});

describe('roster rules and lineup optimizer', () => {
  const cfg = { ...DEFAULT_ROSTER, SUPERFLEX: 1 };
  it('computes slot eligibility', () => {
    expect(eligibleSlots('QB', cfg)).toEqual(['QB', 'SUPERFLEX', 'BN', 'IR']);
    expect(eligibleSlots('TE', cfg)).toContain('FLEX');
    expect(eligibleSlots('K', cfg)).toEqual(['K', 'BN', 'IR']);
  });
  it('flags ineligible slots, overfilled slots and IR misuse', () => {
    const issues = validateRoster([
      { playerId: 'a', position: 'K', slot: 'QB', injuryStatus: 'healthy', locked: false },
      { playerId: 'b', position: 'RB', slot: 'IR', injuryStatus: 'healthy', locked: false },
      { playerId: 'c', position: 'TE', slot: 'TE', injuryStatus: 'healthy', locked: false },
      { playerId: 'd', position: 'TE', slot: 'TE', injuryStatus: 'healthy', locked: false },
    ], cfg);
    expect(issues.map((i) => i.code).sort()).toEqual(['ineligible_slot', 'ir_ineligible', 'slot_overfilled']);
  });
  it('requires a drop when the roster is full', () => {
    const full = Array.from({ length: 15 }, (_, i) => ({ playerId: `p${i}`, position: 'WR' as const, slot: 'BN' as const, injuryStatus: 'healthy' as const, locked: false }));
    const room = hasRoomFor(full, DEFAULT_ROSTER, ['RB'], []);
    expect(room?.code).toBe('roster_full');
    expect(hasRoomFor(full, DEFAULT_ROSTER, ['RB'], ['p0'])).toBeNull();
  });

  const mk = (id: string, position: OptimizerPlayer['position'], slot: OptimizerPlayer['slot'], projected: number, extra: Partial<OptimizerPlayer> = {}): OptimizerPlayer =>
    ({ playerId: id, name: id, position, slot, projected, injuryStatus: 'healthy', locked: false, onBye: false, gameStarted: false, ...extra });

  it('fills dedicated slots then FLEX then SUPERFLEX and explains changes', () => {
    const players = [
      mk('qb1', 'QB', 'QB', 20), mk('qb2', 'QB', 'BN', 18),
      mk('rb1', 'RB', 'RB', 15), mk('rb2', 'RB', 'BN', 14), mk('rb3', 'RB', 'RB', 4, { onBye: true }),
      mk('wr1', 'WR', 'WR', 13), mk('wr2', 'WR', 'WR', 12), mk('wr3', 'WR', 'BN', 11),
      mk('te1', 'TE', 'TE', 9), mk('k1', 'K', 'K', 8), mk('d1', 'DST', 'DST', 7),
    ];
    const r = optimizeLineup(players, cfg);
    const slot = (id: string) => r.assignment.find((a) => a.playerId === id)!.slot;
    expect(slot('qb1')).toBe('QB');
    expect(slot('qb2')).toBe('SUPERFLEX');
    expect(slot('rb2')).toBe('RB');
    expect(slot('rb3')).toBe('BN');
    expect(slot('wr3')).toBe('FLEX');
    expect(r.projectedAfter).toBeGreaterThan(r.projectedBefore);
    expect(r.changes.find((c) => c.playerId === 'rb3')!.reasons).toContain('On bye this week');
  });
  it('never moves locked players', () => {
    const players = [mk('rbA', 'RB', 'RB', 2, { locked: true }), mk('rbB', 'RB', 'BN', 20)];
    const r = optimizeLineup(players, { ...DEFAULT_ROSTER, RB: 1, FLEX: 0 });
    expect(r.assignment.find((a) => a.playerId === 'rbA')!.slot).toBe('RB');
    expect(r.assignment.find((a) => a.playerId === 'rbB')!.slot).toBe('BN');
  });
  it('benches players ruled out', () => {
    const r = optimizeLineup([mk('a', 'TE', 'TE', 12, { injuryStatus: 'out' }), mk('b', 'TE', 'BN', 5)], { ...DEFAULT_ROSTER, FLEX: 0 });
    expect(r.assignment.find((x) => x.playerId === 'b')!.slot).toBe('TE');
    expect(r.changes.find((c) => c.playerId === 'a')!.reasons[0]).toMatch(/OUT/);
  });
});

describe('draft', () => {
  it('snake order reverses on even rounds; linear does not', () => {
    const snake = Array.from({ length: 8 }, (_, i) => teamIndexForPick('snake', 4, i + 1));
    expect(snake).toEqual([0, 1, 2, 3, 3, 2, 1, 0]);
    const linear = Array.from({ length: 8 }, (_, i) => teamIndexForPick('linear', 4, i + 1));
    expect(linear).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
  });
  it('autopick honors the queue, then rank, and defers K/DST', () => {
    const available = [
      { id: 'k', position: 'K' as const, rank: 1, projectedSeason: 100 },
      { id: 'rb', position: 'RB' as const, rank: 2, projectedSeason: 200 },
      { id: 'wr', position: 'WR' as const, rank: 3, projectedSeason: 190 },
    ];
    expect(chooseAutoPick({ cfg: DEFAULT_ROSTER, available, queue: ['wr'], have: [], picksRemainingForTeam: 15 })!.id).toBe('wr');
    expect(chooseAutoPick({ cfg: DEFAULT_ROSTER, available, queue: [], have: [], picksRemainingForTeam: 15 })!.id).toBe('rb');
    // With only K/DST needs left and 2 picks remaining, the kicker becomes eligible.
    const have = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'DST', 'RB', 'WR', 'WR', 'RB', 'TE', 'QB', 'WR'] as const;
    expect(chooseAutoPick({ cfg: DEFAULT_ROSTER, available, queue: [], have: [...have], picksRemainingForTeam: 1 })!.id).toBe('k');
  });
  it('auction bids keep $1 per open roster spot', () => {
    expect(maxAuctionBid(200, 16)).toBe(185);
    expect(validateBid(186, 10, 200, 16)).toMatch(/Maximum bid is \$185/);
    expect(validateBid(10, 10, 200, 16)).toMatch(/exceed/);
    expect(validateBid(11, 10, 200, 16)).toBeNull();
  });
});

describe('waivers', () => {
  const teams = (): TeamWaiverState[] => [
    { teamId: 'A', priority: 1, faabRemaining: 100, rosterPlayerIds: ['a1'], activeRosterCount: 10, maxActive: 16 },
    { teamId: 'B', priority: 2, faabRemaining: 100, rosterPlayerIds: ['b1'], activeRosterCount: 10, maxActive: 16 },
    { teamId: 'C', priority: 3, faabRemaining: 30, rosterPlayerIds: ['c1'], activeRosterCount: 16, maxActive: 16 },
  ];
  const claim = (id: string, teamId: string, add: string, bid = 0, rank = 1, extra: Partial<PendingClaim> = {}): PendingClaim =>
    ({ id, teamId, addPlayerId: add, dropPlayerId: null, bid, rank, groupId: null, createdAt: `2026-10-01T00:00:0${id.length}Z`, ...extra });

  it('FAAB: highest bid wins; ties go to waiver priority', () => {
    const r = resolveWaivers([claim('1', 'A', 'X', 20), claim('2', 'B', 'X', 35)], teams(), { mode: 'faab', allowZeroBids: true });
    expect(r.outcomes.find((o) => o.claimId === '2')!.status).toBe('won');
    expect(r.outcomes.find((o) => o.claimId === '1')!.status).toBe('lost');
    expect(r.faab.B).toBe(65);
    const tie = resolveWaivers([claim('1', 'B', 'X', 20), claim('2', 'A', 'X', 20)], teams(), { mode: 'faab', allowZeroBids: true });
    expect(tie.outcomes.find((o) => o.teamId === 'A')!.status).toBe('won');
  });

  it('rolling: priority winner moves to the back; loser falls through to next claim', () => {
    const r = resolveWaivers([claim('1', 'B', 'X', 0, 1), claim('2', 'B', 'Y', 0, 2), claim('3', 'A', 'X', 0, 1)], teams(), { mode: 'rolling', allowZeroBids: true });
    expect(r.outcomes.map((o) => [o.claimId, o.status])).toEqual([['1', 'lost'], ['2', 'won'], ['3', 'won']]);
    expect(r.priorityOrder).toEqual(['C', 'A', 'B']);
  });

  it('conditional groups: only one claim in a group can win', () => {
    const r = resolveWaivers([claim('1', 'A', 'X', 0, 1, { groupId: 'g' }), claim('2', 'A', 'Y', 0, 2, { groupId: 'g' })], teams(), { mode: 'rolling', allowZeroBids: true });
    expect(r.outcomes.map((o) => o.status)).toEqual(['won', 'invalid']);
  });

  it('rejects full rosters without a drop, bids over budget and stale drops', () => {
    const r = resolveWaivers([
      claim('1', 'C', 'X', 5),
      claim('22', 'C', 'Y', 50, 2, { dropPlayerId: 'c1' }),
      claim('333', 'A', 'Z', 1, 1, { dropPlayerId: 'not-mine' }),
    ], teams(), { mode: 'faab', allowZeroBids: true });
    expect(r.outcomes[0].reason).toMatch(/Roster is full/);
    expect(r.outcomes[1].reason).toMatch(/exceeds remaining budget/);
    expect(r.outcomes[2].reason).toMatch(/no longer on your roster/);
  });

  it('is deterministic for identical input', () => {
    const cs = [claim('1', 'A', 'X', 10), claim('2', 'B', 'X', 10), claim('3', 'C', 'Y', 10, 1, { dropPlayerId: 'c1' })];
    const norm = (r: ReturnType<typeof resolveWaivers>) => ({ ...r, outcomes: [...r.outcomes].sort((a, b) => a.claimId.localeCompare(b.claimId)) });
    expect(norm(resolveWaivers(cs, teams(), { mode: 'faab', allowZeroBids: true }))).toEqual(norm(resolveWaivers([...cs].reverse(), teams(), { mode: 'faab', allowZeroBids: true })));
  });

  it('respects availability (locked players)', () => {
    const r = resolveWaivers([claim('1', 'A', 'X', 1)], teams(), { mode: 'faab', allowZeroBids: true }, (id) => id !== 'X');
    expect(r.outcomes[0].status).toBe('invalid');
  });

  it('computes the next weekly processing time in UTC', () => {
    const next = nextWaiverRun(new Date('2026-10-24T12:00:00Z'), 3, 8); // Sat → Wed 08:00
    expect(next.toISOString()).toBe('2026-10-28T08:00:00.000Z');
    expect(nextWaiverRun(new Date('2026-10-28T08:00:00Z'), 3, 8).toISOString()).toBe('2026-11-04T08:00:00.000Z');
  });
});

describe('schedule', () => {
  it('round robin: each team plays once per week and every opponent once per cycle', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const s = roundRobin(ids, 5);
    for (let w = 1; w <= 5; w++) {
      const wk = s.filter((m) => m.week === w);
      const playing = wk.flatMap((m) => [m.homeTeamId, m.awayTeamId]);
      expect(new Set(playing).size).toBe(6);
    }
    const pairs = new Set(s.map((m) => [m.homeTeamId, m.awayTeamId].sort().join('-')));
    expect(pairs.size).toBe(15);
  });
  it('odd team counts produce byes', () => {
    const s = roundRobin(['a', 'b', 'c'], 3);
    expect(s.filter((m) => m.awayTeamId === null)).toHaveLength(3);
  });
  it('double headers give two games per team per week', () => {
    const s = doubleHeaderSchedule(['a', 'b', 'c', 'd'], 2);
    const wk1 = s.filter((m) => m.week === 1);
    expect(wk1.filter((m) => m.homeTeamId === 'a' || m.awayTeamId === 'a')).toHaveLength(2);
  });
  it('playoff brackets give byes to top seeds', () => {
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(playoffFirstRound(6).pairs).toEqual([[1, null], [4, 5], [2, null], [3, 6]]);
    expect(playoffFirstRound(4).pairs).toEqual([[1, 4], [2, 3]]);
  });
});

describe('standings', () => {
  const m = (week: number, h: string, a: string, hp: number, ap: number) => ({ week, homeTeamId: h, awayTeamId: a, homePoints: hp, awayPoints: ap, kind: 'regular' as const });
  const base = { standingsMode: 'head_to_head' as const, tieBreakers: ['points_for', 'head_to_head', 'coin_flip'] as const, playoffTeams: 2, regularSeasonWeeks: 3 };
  it('ranks by record, breaks ties by points for, and tracks streaks', () => {
    const rows = computeStandings({
      teamIds: ['a', 'b', 'c', 'd'],
      matchups: [m(1, 'a', 'b', 100, 90), m(1, 'c', 'd', 80, 120), m(2, 'a', 'c', 70, 110), m(2, 'b', 'd', 130, 60)],
      settings: { ...base, tieBreakers: [...base.tieBreakers] }, weeksCompleted: 2, leagueSeed: 's',
    });
    expect(rows.map((r) => r.teamId)).toEqual(['b', 'c', 'd', 'a']);
    expect(rows[0].tieBreakNote).toBe('Tiebreak: points for');
    expect(rows.find((r) => r.teamId === 'b')!.streak).toBe('W1');
  });
  it('total-points mode ignores wins', () => {
    const rows = computeStandings({ teamIds: ['a', 'b'], matchups: [m(1, 'a', 'b', 50, 60), m(2, 'a', 'b', 200, 10)], settings: { ...base, tieBreakers: ['points_for'], standingsMode: 'total_points' }, weeksCompleted: 2, leagueSeed: 's' });
    expect(rows[0].teamId).toBe('a');
  });
  it('marks clinched and eliminated teams', () => {
    const rows = computeStandings({
      teamIds: ['a', 'b', 'c', 'd'],
      matchups: [m(1, 'a', 'b', 10, 0), m(1, 'c', 'd', 10, 0), m(2, 'a', 'd', 10, 0), m(2, 'c', 'b', 10, 0), m(3, 'a', 'c', 10, 0), m(3, 'b', 'd', 10, 0)],
      settings: { ...base, tieBreakers: ['points_for'] }, weeksCompleted: 3, leagueSeed: 's',
    });
    expect(rows.find((r) => r.teamId === 'a')!.playoffStatus).toBe('clinched');
    expect(rows.find((r) => r.teamId === 'd')!.playoffStatus).toBe('eliminated');
  });
  it('recomputing after a correction changes the result (no stale state)', () => {
    const before = computeStandings({ teamIds: ['a', 'b'], matchups: [m(1, 'a', 'b', 100, 99.5)], settings: { ...base, tieBreakers: ['points_for'] }, weeksCompleted: 1, leagueSeed: 's' });
    const after = computeStandings({ teamIds: ['a', 'b'], matchups: [m(1, 'a', 'b', 99, 99.5)], settings: { ...base, tieBreakers: ['points_for'] }, weeksCompleted: 1, leagueSeed: 's' });
    expect(before[0].teamId).toBe('a');
    expect(after[0].teamId).toBe('b');
  });
});

describe('trades and the digital commissioner', () => {
  const s = defaultLeagueSettings().trades;
  it('vote: vetoes at threshold, approves early when a veto is impossible', () => {
    expect(decideVote({ approve: 0, veto: 2, eligible: 4 }, 0.5, false)).toBe('vetoed');
    expect(decideVote({ approve: 3, veto: 0, eligible: 4 }, 0.5, false)).toBe('approved');
    expect(decideVote({ approve: 1, veto: 1, eligible: 4 }, 0.5, false)).toBe('pending');
    expect(decideVote({ approve: 1, veto: 1, eligible: 4 }, 0.5, true)).toBe('approved');
  });
  it('routes review according to the league policy', () => {
    expect(reviewRoute({ ...s, review: 'auto' }, null, 2, []).route).toBe('auto');
    expect(reviewRoute({ ...s, review: 'commissioner' }, null, 2, []).route).toBe('commissioner');
    expect(reviewRoute({ ...s, review: 'league_vote' }, null, 2, []).route).toBe('league_vote');
    const lopsided = { valueGap: 0.6 } as never;
    expect(reviewRoute({ ...s, review: 'hybrid' }, lopsided, 2, []).route).toBe('commissioner');
    expect(reviewRoute({ ...s, review: 'hybrid' }, { valueGap: 0.1 } as never, 2, []).route).toBe('auto');
    expect(reviewRoute({ ...s, review: 'hybrid' }, { valueGap: 0.1 } as never, 6, []).reason).toMatch(/auto-approve limit/);
  });
  it('validates ownership, deadline, duplicates and FAAB', () => {
    const owner: Record<string, string> = { p1: 'A', p2: 'B' };
    const checks = validateTradeAssets({
      assets: [
        { fromTeamId: 'A', toTeamId: 'B', type: 'player', playerId: 'p1' },
        { fromTeamId: 'A', toTeamId: 'B', type: 'player', playerId: 'p1' },
        { fromTeamId: 'B', toTeamId: 'A', type: 'player', playerId: 'p1' },
        { fromTeamId: 'B', toTeamId: 'A', type: 'faab', faabAmount: 500 },
      ],
      teamA: 'A', teamB: 'B', settings: s, ownerOf: (id) => owner[id] ?? null, faabRemaining: { A: 100, B: 100 }, week: 12, tradeWindowOpen: true,
    });
    expect(checks.map((c) => c.code).sort()).toEqual(['deadline', 'duplicate_player', 'duplicate_player', 'faab_insufficient', 'not_owned'].sort());
  });
  it('does not reject unbalanced trades; flags them for human review with a disclaimer-safe message', () => {
    const analysis = analyzeTrade({
      teamA: 'A', teamB: 'B', horizonWeeks: 4,
      players: [
        { id: 'star', name: 'Star', position: 'RB', teamId: 'A', weeklyProjection: 20, value: 100, injuryStatus: 'healthy', byeWeek: 9, locked: false, isStarter: true },
        { id: 'scrub', name: 'Scrub', position: 'RB', teamId: 'B', weeklyProjection: 4, value: 5, injuryStatus: 'questionable', byeWeek: 9, locked: false, isStarter: false },
      ],
      assets: [{ fromTeamId: 'A', toTeamId: 'B', type: 'player', playerId: 'star' }, { fromTeamId: 'B', toTeamId: 'A', type: 'player', playerId: 'scrub' }],
      teamNeeds: { A: [], B: ['RB'] }, starterByes: { A: [9], B: [] },
    });
    expect(analysis.valueGap).toBeGreaterThan(0.9);
    expect(analysis.sides[0].injuryRisks[0]).toMatch(/questionable/);
    expect(analysis.sides[0].byeConflicts).toHaveLength(1);
    expect(analysis.sides[1].needsAddressed).toEqual(['RB']);
    const flags = integrityFlags({ analysis, priorTradesBetweenPair30d: 0, newestMemberDays: 100, starterShareSentA: 0.1, starterShareSentB: 0, eliminatedTeamSendsTopPlayer: false, duplicateOfOpenTrade: false });
    expect(flags[0].code).toBe('imbalance');
    expect(flags[0].message).toMatch(/allowed/);
    // policy remains "commissioner" review — never auto-reject
    expect(reviewRoute(s, analysis, 2, flags).route).toBe('commissioner');
  });
  it('AI managers evaluate trades by estimated value', () => {
    expect(aiAcceptsTrade('hard', 105, 100).accept).toBe(false);
    expect(aiAcceptsTrade('hard', 110, 100).accept).toBe(true);
    expect(aiAcceptsTrade('easy', 90, 100).accept).toBe(true);
  });
});

describe('league settings validation', () => {
  it('accepts defaults for 2–10 teams', () => {
    for (let n = 2; n <= 10; n++) expect(validateLeagueSettings(defaultLeagueSettings(), Math.max(n, 4))).toEqual([]);
  });
  it('rejects incompatible configurations with clear messages', () => {
    const s = defaultLeagueSettings();
    s.season.regularSeasonWeeks = 17; s.season.playoffTeams = 6;
    s.trades.tradeDeadlineWeek = 18;
    const issues = validateLeagueSettings(s, 4);
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('season.playoffTeams');
    expect(paths).toContain('trades.tradeDeadlineWeek');
    expect(issues.find((i) => i.message.includes('week 18'))).toBeTruthy();
  });
  it('solo leagues need AI opponents or total-points mode', () => {
    const s = defaultLeagueSettings();
    s.season.playoffTeams = 0;
    expect(validateLeagueSettings(s, 1).map((i) => i.path)).toContain('season.standingsMode');
    s.season.standingsMode = 'total_points'; s.trades.review = 'auto';
    expect(validateLeagueSettings(s, 1)).toEqual([]);
  });
  it('schema parsing rejects out-of-range values', () => {
    const s = defaultLeagueSettings() as unknown as { roster: { QB: number } };
    s.roster.QB = 9;
    expect(leagueSettingsSchema.safeParse(s).success).toBe(false);
  });
});

describe('colors, projections, permissions', () => {
  it('computes WCAG contrast and repairs low-contrast team colors', () => {
    expect(Math.round(contrastRatio('#000000', '#FFFFFF'))).toBe(21);
    const fixed = ensureContrast('#FCA311', '#FFFFFF', 4.5);
    expect(contrastRatio(fixed, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(readableTextOn('#14213D')).toBe('#FFFFFF');
    expect(readableTextOn('#FEF3C7')).toBe('#0B0F17');
  });
  it('projects zero for bye/out and labels the basis', () => {
    expect(projectPlayer({ position: 'RB', positionalRank: 1, history: [20], onBye: true, injuryStatus: 'healthy' }).points).toBe(0);
    const p = projectPlayer({ position: 'WR', positionalRank: 5, history: [10, 12, 30], onBye: false, injuryStatus: 'questionable', opponentFactor: 1.2 });
    expect(p.basis.join(' ')).toMatch(/Favorable matchup/);
    expect(p.low).toBeLessThan(p.points);
  });
  it('win probability is symmetric and bounded', () => {
    expect(winProbability(100, 100, 10, 10)).toBeCloseTo(0.5, 5);
    expect(winProbability(120, 100, 10, 10) + winProbability(100, 120, 10, 10)).toBeCloseTo(1, 5);
    expect(winProbability(100, 90, 0, 0)).toBe(1);
  });
  it('role permissions', () => {
    expect(can('manager', 'trade.review')).toBe(false);
    expect(can('co_commissioner', 'trade.review')).toBe(true);
    expect(can('co_commissioner', 'league.assign_co_commissioner')).toBe(false);
    expect(can('observer', 'chat.post')).toBe(false);
    expect(can(null, 'league.view')).toBe(false);
  });
});

describe('auto-draft roster construction', () => {
  it('builds a legal, balanced roster from a QB-heavy pool', async () => {
    const { chooseAutoPick, DEFAULT_ROSTER, activeRosterSize, positionalNeeds } = await import('../src');
    const pool: { id: string; position: any; rank: number; projectedSeason: number }[] = [];
    const order = ['QB', 'QB', 'RB', 'WR', 'QB', 'TE', 'RB', 'WR', 'K', 'DST'];
    for (let i = 0; i < 200; i++) pool.push({ id: `p${i}`, position: order[i % order.length], rank: i + 1, projectedSeason: 0 });
    const have: any[] = [];
    const total = activeRosterSize(DEFAULT_ROSTER);
    for (let pick = 0; pick < total; pick++) {
      const p = chooseAutoPick({ cfg: DEFAULT_ROSTER, available: pool, queue: [], have, picksRemainingForTeam: total - pick })!;
      have.push(p.position);
      pool.splice(pool.findIndex((x) => x.id === p.id), 1);
    }
    const needs = positionalNeeds(DEFAULT_ROSTER, have);
    expect(Object.values(needs).every((n) => n === 0)).toBe(true);
    expect(have.filter((x) => x === 'QB').length).toBeLessThanOrEqual(2);
    expect(have.filter((x) => x === 'K').length).toBe(1);
  });
});

describe('quick-start league templates', () => {
  it('every template is valid for every team count and start week', async () => {
    const { buildTemplate, validateLeagueSettings, leagueSettingsSchema } = await import('../src');
    for (let week = 1; week <= 18; week++) {
      for (const scoring of ['ppr', 'standard'] as const) {
        const solo = buildTemplate('solo', { currentWeek: week, scoring });
        expect(validateLeagueSettings(solo.settings, solo.teamCount)).toEqual([]);
        for (const opponent of ['ai', 'friend'] as const) {
          const d = buildTemplate('duel', { currentWeek: week, scoring, opponent });
          expect(validateLeagueSettings(d.settings, d.teamCount)).toEqual([]);
        }
        for (let n = 3; n <= 10; n++) {
          const l = buildTemplate('league', { currentWeek: week, scoring, teamCount: n, fillWithAi: n % 2 === 0 });
          expect(leagueSettingsSchema.safeParse(l.settings).success).toBe(true);
          expect(validateLeagueSettings(l.settings, l.teamCount)).toEqual([]);
          expect(l.aiTeams).toBe(n % 2 === 0 ? n - 1 : 0);
        }
      }
    }
  });
  it('sets the expected shape for each mode', async () => {
    const { buildTemplate } = await import('../src');
    const solo = buildTemplate('solo', { currentWeek: 1, scoring: 'ppr' });
    expect(solo).toMatchObject({ teamCount: 1, aiTeams: 0, canStartImmediately: true });
    expect(solo.settings.season.standingsMode).toBe('total_points');
    const duel = buildTemplate('duel', { currentWeek: 1, scoring: 'ppr', opponent: 'friend' });
    expect(duel).toMatchObject({ teamCount: 2, aiTeams: 0, canStartImmediately: false });
    expect(duel.settings.season.standingsMode).toBe('head_to_head');
    const big = buildTemplate('league', { currentWeek: 1, scoring: 'ppr', teamCount: 10 });
    expect(big.settings.season.playoffTeams).toBe(4);
    expect(buildTemplate('league', { currentWeek: 1, scoring: 'ppr', teamCount: 3 }).settings.season.playoffTeams).toBe(0);
    expect(buildTemplate('league', { currentWeek: 16, scoring: 'ppr', teamCount: 8 }).settings.season.playoffTeams).toBe(0);
  });
});

describe('player ratings from real stats', () => {
  const qb = (id: string, cmp: number, yds: number, td: number, int: number) =>
    ({ id, position: 'QB' as const, curSeason: 2026, prior: null, cur: { g: 7, att: 245, cmp, passYd: yds, passTd: td, int, rushYd: 70, ppr: yds / 25 + td * 4 - int * 2 } });
  it('rates better production higher, on a 40–99 scale, and leaves players without games unrated', () => {
    const players = [qb('ace', 175, 2100, 18, 2), qb('mid', 155, 1650, 10, 5), qb('low', 130, 1200, 5, 10),
      { id: 'rookie', position: 'QB' as const, curSeason: 2026, cur: null, prior: null }];
    const r = computeRatings(players);
    const ace = r.get('ace')!, mid = r.get('mid')!, low = r.get('low')!;
    expect(ace.ovr!).toBeGreaterThan(mid.ovr!);
    expect(mid.ovr!).toBeGreaterThan(low.ovr!);
    for (const c of [ace, mid, low]) { expect(c.ovr!).toBeGreaterThanOrEqual(40); expect(c.ovr!).toBeLessThanOrEqual(99); expect(c.attrs.length).toBeGreaterThan(3); }
    // fewer interceptions is better: ball security is inverted
    expect(ace.attrs.find((a) => a.k === 'SEC')!.v).toBeGreaterThan(low.attrs.find((a) => a.k === 'SEC')!.v);
    expect(ace.line.find((x) => x.k === 'YDS')!.value).toBe('2,100');
    expect(r.get('rookie')).toMatchObject({ ovr: null, attrs: [] });
    expect(ratingTier(null)).toBe('none');
    expect(computeRatings(players).get('ace')).toEqual(ace); // deterministic
  });
});
