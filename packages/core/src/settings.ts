import { z } from 'zod';
import { STAT_KEYS, type StatKey } from './types';

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const tier = z.object({ max: z.number().nullable(), points: z.number() }); // max null = infinity
export const bonusSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  stat: z.enum(STAT_KEYS),
  threshold: z.number(),
  /** 'gte' rewards reaching the threshold, 'lte' is used for penalties such as "≤ 0 passing yards" */
  comparator: z.enum(['gte', 'lte']).default('gte'),
  points: z.number().min(-100).max(100),
});
export type Bonus = z.infer<typeof bonusSchema>;

export const scoringRulesSchema = z.object({
  preset: z.enum(['standard', 'half_ppr', 'ppr', 'custom']),
  perStat: z.record(z.enum(STAT_KEYS), z.number().min(-100).max(100)),
  pointsAllowedTiers: z.array(tier).min(1),
  yardsAllowedTiers: z.array(tier).default([]),
  bonuses: z.array(bonusSchema).max(30).default([]),
});
export type ScoringRules = z.infer<typeof scoringRulesSchema>;

const BASE_PER_STAT: Partial<Record<StatKey, number>> = {
  pass_yd: 0.04, pass_td: 4, pass_int: -2, pass_2pt: 2,
  rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
  rec: 0, rec_yd: 0.1, rec_td: 6, rec_2pt: 2,
  fum_lost: -2, ret_td: 6, off_fum_rec_td: 6,
  fgm_0_39: 3, fgm_40_49: 4, fgm_50p: 5, fg_miss: -1, xpm: 1, xp_miss: -1,
  def_sack: 1, def_int: 2, def_fum_rec: 2, def_td: 6, st_td: 6, def_safety: 2, def_blk_kick: 2,
};

const DEFAULT_PA_TIERS = [
  { max: 0, points: 10 }, { max: 6, points: 7 }, { max: 13, points: 4 }, { max: 20, points: 1 },
  { max: 27, points: 0 }, { max: 34, points: -1 }, { max: null, points: -4 },
];

export function scoringPreset(preset: 'standard' | 'half_ppr' | 'ppr'): ScoringRules {
  const rec = preset === 'ppr' ? 1 : preset === 'half_ppr' ? 0.5 : 0;
  return {
    preset,
    perStat: { ...BASE_PER_STAT, rec } as ScoringRules['perStat'],
    pointsAllowedTiers: DEFAULT_PA_TIERS.map((t) => ({ ...t })),
    yardsAllowedTiers: [],
    bonuses: [],
  };
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export const rosterConfigSchema = z.object({
  QB: z.number().int().min(0).max(3),
  RB: z.number().int().min(0).max(5),
  WR: z.number().int().min(0).max(5),
  TE: z.number().int().min(0).max(3),
  FLEX: z.number().int().min(0).max(4),
  SUPERFLEX: z.number().int().min(0).max(2),
  K: z.number().int().min(0).max(2),
  DST: z.number().int().min(0).max(2),
  BN: z.number().int().min(0).max(12),
  IR: z.number().int().min(0).max(4),
  /** Which positions FLEX accepts. */
  flexEligible: z.array(z.enum(['RB', 'WR', 'TE'])).min(1).default(['RB', 'WR', 'TE']),
  /** Injury designations allowed on IR. */
  irEligible: z.array(z.enum(['out', 'ir', 'pup', 'suspended', 'doubtful'])).min(1).default(['out', 'ir', 'pup']),
  /** Optional per-position maximums across the whole roster (0 = unlimited). */
  positionLimits: z.record(z.enum(['QB', 'RB', 'WR', 'TE', 'K', 'DST']), z.number().int().min(0).max(20)).default({}),
});
export type RosterConfig = z.infer<typeof rosterConfigSchema>;

export const DEFAULT_ROSTER: RosterConfig = {
  QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 0, K: 1, DST: 1, BN: 6, IR: 1,
  flexEligible: ['RB', 'WR', 'TE'], irEligible: ['out', 'ir', 'pup'], positionLimits: {},
};

export function starterCount(r: RosterConfig): number {
  return r.QB + r.RB + r.WR + r.TE + r.FLEX + r.SUPERFLEX + r.K + r.DST;
}
/** Active roster size (starters + bench). IR slots are additional. */
export function activeRosterSize(r: RosterConfig): number {
  return starterCount(r) + r.BN;
}

// ---------------------------------------------------------------------------
// Season, waivers, trades, draft
// ---------------------------------------------------------------------------

export const seasonSettingsSchema = z.object({
  regularSeasonWeeks: z.number().int().min(1).max(17),
  playoffTeams: z.number().int().min(0).max(10),
  playoffWeeksPerRound: z.literal(1).default(1),
  consolationBracket: z.boolean().default(false),
  standingsMode: z.enum(['head_to_head', 'total_points']).default('head_to_head'),
  /** Teams play two opponents each week when enabled (requires ≥ 3 teams). */
  doubleHeaders: z.boolean().default(false),
  tieBreakers: z.array(z.enum(['points_for', 'head_to_head', 'points_against_low', 'coin_flip'])).min(1)
    .default(['points_for', 'head_to_head', 'coin_flip']),
  /** NFL week the fantasy season starts. */
  startWeek: z.number().int().min(1).max(18).default(1),
  lineupLock: z.enum(['game_time', 'first_game_of_week']).default('game_time'),
  /** How provider stat corrections to already-finalized weeks are handled. */
  statCorrections: z.enum(['auto', 'review']).default('auto'),
});
export type SeasonSettings = z.infer<typeof seasonSettingsSchema>;

export const waiverSettingsSchema = z.object({
  mode: z.enum(['faab', 'rolling', 'reverse_standings']),
  faabBudget: z.number().int().min(0).max(10000).default(100),
  allowZeroBids: z.boolean().default(true),
  waiverPeriodHours: z.number().int().min(0).max(168).default(48),
  /** Continuous waivers: every unrostered player requires a claim. */
  continuous: z.boolean().default(false),
  /** Weekday (0=Sun..6=Sat) and hour (league-local, UTC stored) when claims process. */
  processDay: z.number().int().min(0).max(6).default(3),
  processHourUtc: z.number().int().min(0).max(23).default(8),
});
export type WaiverSettings = z.infer<typeof waiverSettingsSchema>;

export const tradeSettingsSchema = z.object({
  review: z.enum(['auto', 'commissioner', 'league_vote', 'hybrid']),
  reviewHours: z.number().int().min(1).max(96).default(24),
  /** Fraction of eligible voters needed to VETO under league_vote. */
  vetoThreshold: z.number().min(0.1).max(1).default(0.5),
  involvedManagersCanVote: z.boolean().default(false),
  showVoteCounts: z.enum(['live', 'after_close', 'never']).default('after_close'),
  /** Hybrid: send to commissioner when estimated value gap exceeds this fraction. */
  hybridValueGap: z.number().min(0).max(1).default(0.35),
  hybridMaxAutoPlayers: z.number().int().min(1).max(10).default(3),
  tradeDeadlineWeek: z.number().int().min(0).max(18).default(11), // 0 = none
  offerExpiryHours: z.number().int().min(1).max(168).default(48),
  allowDraftPicks: z.boolean().default(true),
  allowFaab: z.boolean().default(true),
  analysisMode: z.enum(['off', 'advisory', 'required']).default('advisory'),
});
export type TradeSettings = z.infer<typeof tradeSettingsSchema>;

export const draftSettingsSchema = z.object({
  type: z.enum(['snake', 'linear', 'auction', 'manual']),
  pickSeconds: z.number().int().min(10).max(86400).default(90),
  auctionBudget: z.number().int().min(10).max(1000).default(200),
  orderMode: z.enum(['random', 'manual']).default('random'),
});
export type DraftSettings = z.infer<typeof draftSettingsSchema>;

export const leagueSettingsSchema = z.object({
  roster: rosterConfigSchema,
  season: seasonSettingsSchema,
  waivers: waiverSettingsSchema,
  trades: tradeSettingsSchema,
  draft: draftSettingsSchema,
  chat: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
});
export type LeagueSettings = z.infer<typeof leagueSettingsSchema>;

export function defaultLeagueSettings(): LeagueSettings {
  return {
    roster: structuredClone(DEFAULT_ROSTER),
    season: {
      regularSeasonWeeks: 14, playoffTeams: 4, playoffWeeksPerRound: 1, consolationBracket: false,
      standingsMode: 'head_to_head', doubleHeaders: false,
      tieBreakers: ['points_for', 'head_to_head', 'coin_flip'], startWeek: 1, lineupLock: 'game_time', statCorrections: 'auto',
    },
    waivers: {
      mode: 'faab', faabBudget: 100, allowZeroBids: true, waiverPeriodHours: 48, continuous: false,
      processDay: 3, processHourUtc: 8,
    },
    trades: {
      review: 'commissioner', reviewHours: 24, vetoThreshold: 0.5, involvedManagersCanVote: false,
      showVoteCounts: 'after_close', hybridValueGap: 0.35, hybridMaxAutoPlayers: 3, tradeDeadlineWeek: 11,
      offerExpiryHours: 48, allowDraftPicks: true, allowFaab: true, analysisMode: 'advisory',
    },
    draft: { type: 'snake', pickSeconds: 90, auctionBudget: 200, orderMode: 'random' },
    chat: { enabled: true },
  };
}

export interface ValidationIssue { path: string; message: string }

/** NFL regular season has 18 weeks; fantasy seasons must fit inside it. */
export const NFL_REGULAR_SEASON_WEEKS = 18;

export function playoffRounds(playoffTeams: number): number {
  if (playoffTeams < 2) return 0;
  return Math.ceil(Math.log2(playoffTeams));
}

/** Cross-field validation that schema parsing cannot express. */
export function validateLeagueSettings(s: LeagueSettings, teamCount: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const r = s.roster;
  const starters = starterCount(r);
  if (starters < 1) issues.push({ path: 'roster', message: 'At least one starting slot is required.' });
  if (activeRosterSize(r) > 30) issues.push({ path: 'roster', message: 'Active roster cannot exceed 30 players.' });
  if (r.SUPERFLEX > 0 && r.QB === 0 && r.SUPERFLEX > 2) issues.push({ path: 'roster.SUPERFLEX', message: 'Too many superflex slots.' });
  // Player pool sanity: there are ~32 starting QBs, 32 K, 32 DST in the NFL.
  const qbDemand = (r.QB + r.SUPERFLEX) * teamCount;
  if (qbDemand > 48) issues.push({ path: 'roster.QB', message: `QB + SUPERFLEX demand (${qbDemand}) exceeds a realistic QB pool for ${teamCount} teams.` });
  if (r.K * teamCount > 32) issues.push({ path: 'roster.K', message: 'More kicker slots than NFL teams.' });
  if (r.DST * teamCount > 32) issues.push({ path: 'roster.DST', message: 'More DST slots than NFL teams.' });
  for (const [pos, limit] of Object.entries(r.positionLimits)) {
    const required = (r as unknown as Record<string, number>)[pos] ?? 0;
    if (limit > 0 && limit < required) issues.push({ path: `roster.positionLimits.${pos}`, message: `${pos} limit (${limit}) is below its required starters (${required}).` });
  }

  const se = s.season;
  if (se.startWeek + se.regularSeasonWeeks - 1 > NFL_REGULAR_SEASON_WEEKS) {
    issues.push({ path: 'season.regularSeasonWeeks', message: 'Regular season extends past NFL week 18.' });
  }
  if (se.playoffTeams > teamCount) issues.push({ path: 'season.playoffTeams', message: `Playoff teams (${se.playoffTeams}) exceed league size (${teamCount}).` });
  if (se.playoffTeams === 1) issues.push({ path: 'season.playoffTeams', message: 'Playoffs need at least 2 teams, or 0 to disable.' });
  const lastWeek = se.startWeek + se.regularSeasonWeeks - 1 + playoffRounds(se.playoffTeams);
  if (lastWeek > NFL_REGULAR_SEASON_WEEKS) {
    issues.push({ path: 'season.playoffTeams', message: `Playoffs would end in NFL week ${lastWeek}; the NFL regular season ends in week 18. Shorten the regular season or reduce playoff teams.` });
  }
  if (se.doubleHeaders && teamCount < 3) issues.push({ path: 'season.doubleHeaders', message: 'Double headers need at least 3 teams.' });
  if (se.standingsMode === 'head_to_head' && teamCount < 2) {
    issues.push({ path: 'season.standingsMode', message: 'Head-to-head needs at least 2 teams. Add AI managers or use total-points mode.' });
  }

  const t = s.trades;
  const regEnd = se.startWeek + se.regularSeasonWeeks - 1;
  if (t.tradeDeadlineWeek > regEnd) issues.push({ path: 'trades.tradeDeadlineWeek', message: 'Trade deadline is after the regular season ends.' });
  if (t.review === 'league_vote' && teamCount < 3) issues.push({ path: 'trades.review', message: 'League voting needs at least 3 teams.' });

  if (s.draft.type === 'auction' && s.draft.auctionBudget < activeRosterSize(r)) {
    issues.push({ path: 'draft.auctionBudget', message: 'Auction budget must allow at least $1 per roster spot.' });
  }
  return issues;
}
