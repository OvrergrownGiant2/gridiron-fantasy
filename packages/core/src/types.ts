// Normalized domain types shared by server, web and data providers.
// Provider-specific shapes never leak past the provider adapters.

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;
export type Position = (typeof POSITIONS)[number];

export const SLOTS = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPERFLEX', 'K', 'DST', 'BN', 'IR'] as const;
export type Slot = (typeof SLOTS)[number];
export type StarterSlot = Exclude<Slot, 'BN' | 'IR'>;

/** Normalized statistic keys. Every provider adapter maps into these. */
export const STAT_KEYS = [
  // passing
  'pass_yd', 'pass_td', 'pass_int', 'pass_2pt',
  // rushing
  'rush_yd', 'rush_td', 'rush_2pt',
  // receiving
  'rec', 'rec_yd', 'rec_td', 'rec_2pt',
  // misc offense
  'fum_lost', 'ret_td', 'off_fum_rec_td',
  // kicking
  'fgm_0_39', 'fgm_40_49', 'fgm_50p', 'fg_miss', 'xpm', 'xp_miss',
  // defense / special teams
  'def_sack', 'def_int', 'def_fum_rec', 'def_td', 'st_td', 'def_safety', 'def_blk_kick',
  'def_pts_allowed', 'def_yds_allowed',
] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type StatLine = Partial<Record<StatKey, number>>;

export const STAT_LABELS: Record<StatKey, string> = {
  pass_yd: 'Passing yards', pass_td: 'Passing TD', pass_int: 'Interceptions thrown', pass_2pt: 'Passing 2-pt',
  rush_yd: 'Rushing yards', rush_td: 'Rushing TD', rush_2pt: 'Rushing 2-pt',
  rec: 'Receptions', rec_yd: 'Receiving yards', rec_td: 'Receiving TD', rec_2pt: 'Receiving 2-pt',
  fum_lost: 'Fumbles lost', ret_td: 'Return TD', off_fum_rec_td: 'Fumble recovery TD',
  fgm_0_39: 'FG made 0–39', fgm_40_49: 'FG made 40–49', fgm_50p: 'FG made 50+', fg_miss: 'FG missed',
  xpm: 'Extra point made', xp_miss: 'Extra point missed',
  def_sack: 'Sacks', def_int: 'Interceptions', def_fum_rec: 'Fumble recoveries', def_td: 'Defensive TD',
  st_td: 'Special teams TD', def_safety: 'Safeties', def_blk_kick: 'Blocked kicks',
  def_pts_allowed: 'Points allowed', def_yds_allowed: 'Yards allowed',
};

export type GameStatus = 'scheduled' | 'in_progress' | 'final' | 'delayed' | 'postponed' | 'canceled';
/** UI-facing status vocabulary required by the product spec. */
export type DisplayGameStatus = 'LIVE' | 'UPCOMING' | 'FINAL' | 'DELAYED' | 'POSTPONED' | 'CANCELED' | 'DATA UNAVAILABLE';

export type InjuryStatus = 'healthy' | 'questionable' | 'doubtful' | 'out' | 'ir' | 'suspended' | 'pup';

export interface NflTeam { id: string; city: string; name: string; conference: 'AFC' | 'NFC'; division: string }

export interface NflPlayer {
  id: string;            // stable internal id: `${provider}:${providerPlayerId}`
  provider: string;
  providerPlayerId: string;
  fullName: string;
  position: Position;
  nflTeamId: string | null;
  jersey: number | null;
  injuryStatus: InjuryStatus;
  injuryNote: string | null;
  active: boolean;
  rank: number;          // pre-season / consensus rank for drafts (lower is better)
}

export interface NflGame {
  id: string;
  season: number;
  seasonType: 'REG' | 'POST';
  week: number;
  homeTeamId: string;
  awayTeamId: string;
  kickoffAt: string;     // ISO UTC
  status: GameStatus;
  homeScore: number | null;
  awayScore: number | null;
  quarter: string | null;
  clock: string | null;
}

export interface PlayerGameStat {
  playerId: string;
  gameId: string;
  season: number;
  week: number;
  stats: StatLine;
  isFinal: boolean;
}

export type Role = 'commissioner' | 'co_commissioner' | 'manager' | 'observer';
export type AiDifficulty = 'easy' | 'medium' | 'hard';
