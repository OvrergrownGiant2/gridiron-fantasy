import type { GameStatus, InjuryStatus, NflGame, NflPlayer, NflTeam, PlayerGameStat, Position, StatLine } from '@gridiron/core';
import type { Clock } from '../app';
import { easternToUtc, NFL_TEAMS } from './demo';
import { ProviderError, type NflProvider } from './provider';

/**
 * nflverse adapter — real NFL players, schedules, final scores, weekly player and
 * team stats, and injury reports, published as open data on GitHub
 * (https://github.com/nflverse/nflverse-data). Data refreshes after games, usually
 * overnight. It is NOT a live in-game feed: games in progress show as live with no
 * stats until nflverse publishes them (pair with the Sleeper overlay for in-game stats).
 */

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180 CSV → array of objects keyed by header. Handles quotes, escaped quotes and CRLF. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => { const o: Record<string, string> = {}; head.forEach((h, j) => { o[h] = r[j] ?? ''; }); return o; });
}

// ---------------------------------------------------------------------------
// Normalized dataset (what the snapshot JSON contains)
// ---------------------------------------------------------------------------

export interface NflDataset {
  source: 'nflverse';
  season: number;
  asOf: string;                     // ISO time the source files were fetched
  teams: NflTeam[];
  players: NflPlayer[];
  games: NflGame[];                 // scores only for completed games
  stats: PlayerGameStat[];          // final stats for completed games
}

const TEAM_FIX: Record<string, string> = { LA: 'LAR', STL: 'LAR', SD: 'LAC', OAK: 'LV' };
const team = (t: string) => TEAM_FIX[t] ?? t;
const n = (v: string | undefined) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const POS: Record<string, Position> = { QB: 'QB', RB: 'RB', FB: 'RB', HB: 'RB', WR: 'WR', TE: 'TE', K: 'K', PK: 'K' };

function compact(s: StatLine): StatLine {
  for (const k of Object.keys(s) as (keyof StatLine)[]) if (!s[k]) delete s[k];
  return s;
}

export function mapNflversePlayerStats(r: Record<string, string>): StatLine {
  return compact({
    pass_yd: n(r.passing_yards), pass_td: n(r.passing_tds), pass_int: n(r.passing_interceptions), pass_2pt: n(r.passing_2pt_conversions),
    rush_yd: n(r.rushing_yards), rush_td: n(r.rushing_tds), rush_2pt: n(r.rushing_2pt_conversions),
    rec: n(r.receptions), rec_yd: n(r.receiving_yards), rec_td: n(r.receiving_tds), rec_2pt: n(r.receiving_2pt_conversions),
    // Standard fantasy convention (matches nflverse's own fantasy points): fumbles lost on plays from scrimmage.
    fum_lost: n(r.sack_fumbles_lost) + n(r.rushing_fumbles_lost) + n(r.receiving_fumbles_lost),
    ret_td: n(r.special_teams_tds), off_fum_rec_td: n(r.fumble_recovery_tds),
    fgm_0_39: n(r.fg_made_0_19) + n(r.fg_made_20_29) + n(r.fg_made_30_39),
    fgm_40_49: n(r.fg_made_40_49), fgm_50p: n(r.fg_made_50_59) + n(r.fg_made_60_),
    fg_miss: n(r.fg_missed), xpm: n(r.pat_made), xp_miss: n(r.pat_missed),
  });
}

export function mapNflverseDefense(teamRow: Record<string, string>, opponentRow: Record<string, string> | undefined, pointsAllowed: number | null): StatLine {
  const s: StatLine = compact({
    def_sack: n(teamRow.def_sacks), def_int: n(teamRow.def_interceptions), def_fum_rec: n(teamRow.fumble_recovery_opp),
    def_td: n(teamRow.def_tds), st_td: n(teamRow.special_teams_tds), def_safety: n(teamRow.def_safeties),
    def_blk_kick: n(teamRow.def_punt_blocks) + n(teamRow.def_fg_blocks) + n(teamRow.def_pat_blocks),
  });
  if (pointsAllowed !== null) s.def_pts_allowed = pointsAllowed;
  if (opponentRow) s.def_yds_allowed = Math.max(0, n(opponentRow.passing_yards) - n(opponentRow.sack_yards_lost) + n(opponentRow.rushing_yards));
  return s;
}

function injuryFrom(report: string | undefined, rosterStatus: string): { status: InjuryStatus; note: string | null } {
  if (rosterStatus === 'RES' || rosterStatus === 'RSR' || rosterStatus === 'RSN') return { status: 'ir', note: 'Reserve list' };
  if (rosterStatus === 'PUP') return { status: 'pup', note: 'Physically unable to perform' };
  if (rosterStatus === 'SUS') return { status: 'suspended', note: 'Suspended' };
  switch ((report ?? '').toLowerCase()) {
    case 'out': return { status: 'out', note: null };
    case 'doubtful': return { status: 'doubtful', note: null };
    case 'questionable': return { status: 'questionable', note: null };
    default: return { status: 'healthy', note: null };
  }
}

/**
 * Builds the normalized dataset from nflverse CSV files.
 * `priorSeasonStats` (last season's weekly stats) drives preseason-style draft ranks
 * so drafts are not based on hindsight from the current season.
 */
export function buildNflverseDataset(input: {
  season: number;
  players: string; games: string; playerStats: string; teamStats: string; injuries?: string; priorSeasonStats?: string;
  asOf: string;
}): NflDataset {
  const season = input.season;
  const gamesRaw = parseCsv(input.games).filter((g) => Number(g.season) === season);
  const games: NflGame[] = gamesRaw.map((g) => {
    const [y, m, d] = g.gameday.split('-').map(Number);
    const [hh, mm] = (g.gametime || '13:00').split(':').map(Number);
    const hasScore = g.home_score !== '' && g.away_score !== '';
    return {
      id: `nflverse:${g.game_id}`, season, seasonType: (g.game_type === 'REG' ? 'REG' : 'POST') as 'REG' | 'POST', week: Number(g.week),
      homeTeamId: team(g.home_team), awayTeamId: team(g.away_team), kickoffAt: easternToUtc(y, m - 1, d, hh, mm).toISOString(),
      status: (hasScore ? 'final' : 'scheduled') as GameStatus,
      homeScore: hasScore ? Number(g.home_score) : null, awayScore: hasScore ? Number(g.away_score) : null, quarter: hasScore ? 'F' : null, clock: null,
    };
  }).filter((g) => g.seasonType === 'REG');
  const gameById = new Map(games.map((g) => [g.id, g]));

  const statsRows = parseCsv(input.playerStats).filter((r) => Number(r.season) === season && r.season_type === 'REG');
  const teamRows = parseCsv(input.teamStats).filter((r) => Number(r.season) === season && r.season_type === 'REG');
  const injuries = input.injuries ? parseCsv(input.injuries).filter((r) => Number(r.season) === season) : [];
  const latestInjury = new Map<string, { week: number; status: string; injury: string }>();
  for (const r of injuries) {
    const w = Number(r.week);
    const prev = latestInjury.get(r.gsis_id);
    if (!prev || w >= prev.week) latestInjury.set(r.gsis_id, { week: w, status: r.report_status, injury: r.report_primary_injury });
  }
  const maxInjuryWeek = Math.max(0, ...[...latestInjury.values()].map((x) => x.week));

  // Draft-style rank: last season's PPR points (rookies and newcomers after veterans).
  const prior = new Map<string, number>();
  if (input.priorSeasonStats) {
    for (const r of parseCsv(input.priorSeasonStats)) if (r.season_type === 'REG') prior.set(r.player_id, (prior.get(r.player_id) ?? 0) + n(r.fantasy_points_ppr));
  }
  const currentTeam = new Map<string, { week: number; team: string }>();
  for (const r of statsRows) {
    const w = Number(r.week);
    const c = currentTeam.get(r.player_id);
    if (!c || w >= c.week) currentTeam.set(r.player_id, { week: w, team: team(r.team) });
  }

  const players: NflPlayer[] = [];
  const ACTIVE = new Set(['ACT', 'RES', 'RSR', 'RSN', 'PUP', 'SUS']);
  for (const p of parseCsv(input.players)) {
    const pos = POS[p.position];
    if (!pos || !p.gsis_id) continue;
    const played = currentTeam.get(p.gsis_id);
    const recent = Number(p.last_season) >= season - 1;
    if (!played && !(ACTIVE.has(p.status) && recent && p.latest_team)) continue;
    if (!played && p.status === 'CUT') continue;
    const inj = latestInjury.get(p.gsis_id);
    const injury = injuryFrom(inj && inj.week === maxInjuryWeek ? inj.status : undefined, p.status);
    players.push({
      id: `nflverse:${p.gsis_id}`, provider: 'nflverse', providerPlayerId: p.gsis_id,
      fullName: p.display_name || `${p.first_name} ${p.last_name}`, position: pos,
      nflTeamId: played?.team ?? (p.latest_team ? team(p.latest_team) : null),
      jersey: p.jersey_number ? Number(p.jersey_number) : null,
      injuryStatus: injury.status, injuryNote: injury.status !== 'healthy' ? (inj?.injury || injury.note) : null,
      active: true, rank: 0,
    });
  }
  const teamName = new Map(NFL_TEAMS.map((t) => [t.id, t]));
  for (const t of NFL_TEAMS) {
    players.push({ id: `nflverse:DST-${t.id}`, provider: 'nflverse', providerPlayerId: `DST-${t.id}`, fullName: `${t.city} ${t.name} D/ST`, position: 'DST', nflTeamId: t.id, jersey: null, injuryStatus: 'healthy', injuryNote: null, active: true, rank: 0 });
  }
  // Ranks: veterans by last season's points; DSTs and kickers are placed late like typical boards.
  const priorPts = (p: NflPlayer) => prior.get(p.providerPlayerId) ?? -1;
  const posPenalty: Record<Position, number> = { QB: -60, RB: 0, WR: 0, TE: -20, K: -150, DST: -140 };
  players.sort((a, b) => (priorPts(b) + posPenalty[b.position]) - (priorPts(a) + posPenalty[a.position]) || a.fullName.localeCompare(b.fullName));
  players.forEach((p, i) => { p.rank = i + 1; });

  const stats: PlayerGameStat[] = [];
  const known = new Set(players.map((p) => p.id));
  for (const r of statsRows) {
    const id = `nflverse:${r.player_id}`;
    if (!known.has(id)) continue;
    const gameId = `nflverse:${r.game_id}`;
    if (!gameById.has(gameId)) continue;
    stats.push({ playerId: id, gameId, season, week: Number(r.week), stats: mapNflversePlayerStats(r), isFinal: true });
  }
  const teamByGame = new Map<string, Record<string, string>[]>();
  for (const r of teamRows) teamByGame.set(r.game_id, [...(teamByGame.get(r.game_id) ?? []), r]);
  for (const [gid, rows] of teamByGame) {
    const g = gameById.get(`nflverse:${gid}`);
    if (!g || g.status !== 'final') continue;
    for (const r of rows) {
      const t = team(r.team);
      if (!teamName.has(t)) continue;
      const opp = rows.find((x) => x !== r);
      const allowed = t === g.homeTeamId ? g.awayScore : g.homeScore;
      stats.push({ playerId: `nflverse:DST-${t}`, gameId: g.id, season, week: g.week, stats: mapNflverseDefense(r, opp, allowed), isFinal: true });
    }
  }
  return { source: 'nflverse', season, asOf: input.asOf, teams: NFL_TEAMS, players, games, stats };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const GAME_MINUTES = 200;

/**
 * Serves a normalized dataset against a clock. Games only become visible as played
 * once the clock passes their kickoff, so the same dataset can replay the season
 * (used to seed leagues) without revealing future results.
 */
export class DatasetProvider implements NflProvider {
  readonly id: string;
  readonly label: string;
  readonly isDemo = false;
  readonly configured = true;
  readonly livePollSeconds: number;
  readonly idlePollSeconds: number;
  /** Snapshot providers never receive new data; the UI says so. */
  snapshotAsOf: string | null;
  readonly replayable = true;

  constructor(protected data: () => Promise<NflDataset>, protected clock: Clock, opts: { id: string; label: string; snapshotAsOf?: string | null; livePollSeconds?: number; idlePollSeconds?: number }) {
    this.id = opts.id; this.label = opts.label; this.snapshotAsOf = opts.snapshotAsOf ?? null;
    this.livePollSeconds = opts.livePollSeconds ?? 300; this.idlePollSeconds = opts.idlePollSeconds ?? 1800;
  }

  private state(g: NflGame, now: number): NflGame {
    const kick = Date.parse(g.kickoffAt);
    if (now < kick) return { ...g, status: 'scheduled', homeScore: null, awayScore: null, quarter: null, clock: null };
    if (g.status === 'final' && now >= kick + GAME_MINUTES * 60_000) return g;
    // Kicked off but no final data yet from this source.
    return { ...g, status: 'in_progress', homeScore: null, awayScore: null, quarter: null, clock: this.snapshotAsOf ? 'No live data in this snapshot' : 'Stats publish after the game' };
  }

  async currentSeason(now: Date) {
    const d = await this.data();
    const weeks = [...new Set(d.games.map((g) => g.week))].sort((a, b) => a - b);
    for (const w of weeks) {
      const last = Math.max(...d.games.filter((g) => g.week === w).map((g) => Date.parse(g.kickoffAt)));
      if (now.getTime() < last + (GAME_MINUTES + 60) * 60_000) return { season: d.season, week: w, seasonType: 'REG' as const };
    }
    return { season: d.season, week: weeks[weeks.length - 1] ?? 1, seasonType: 'REG' as const };
  }
  async teams() { return (await this.data()).teams; }
  async players() { return (await this.data()).players; }
  async schedule(season: number) {
    const d = await this.data();
    if (season !== d.season) return [];
    const now = this.clock.now().getTime();
    return d.games.map((g) => this.state(g, now));
  }
  async weekGames(season: number, week: number) { return (await this.schedule(season)).filter((g) => g.week === week); }
  async weekStats(season: number, week: number) {
    const d = await this.data();
    if (season !== d.season) return [];
    const now = this.clock.now().getTime();
    const visible = new Set(d.games.filter((g) => g.week === week && this.state(g, now).status === 'final').map((g) => g.id));
    return d.stats.filter((s) => s.week === week && visible.has(s.gameId));
  }
}

export const NFLVERSE_BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

/** Fetches the CSV releases from GitHub, caching the built dataset for an hour. */
export class NflverseProvider extends DatasetProvider {
  private cache: { at: number; data: NflDataset } | null = null;
  private inflight: Promise<NflDataset> | null = null;

  constructor(clock: Clock, private season: number, private http: typeof fetch = fetch, private cacheMs = 3_600_000) {
    super(() => this.load(), clock, { id: 'nflverse', label: 'nflverse (open NFL data, updated after games)', livePollSeconds: 900, idlePollSeconds: 3600 });
  }

  private async get(path: string, optional = false): Promise<string | undefined> {
    let res: Response;
    try { res = await this.http(`${NFLVERSE_BASE}/${path}`, { redirect: 'follow' }); }
    catch (e) { throw new ProviderError(`Network error fetching nflverse ${path}: ${(e as Error).message}`, 'network'); }
    if (res.status === 404 && optional) return undefined;
    if (res.status === 429) throw new ProviderError('GitHub rate limit reached while fetching nflverse data.', 'rate_limited', 600);
    if (!res.ok) throw new ProviderError(`nflverse returned HTTP ${res.status} for ${path}.`, 'http');
    return res.text();
  }

  private async load(): Promise<NflDataset> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.cacheMs) return this.cache.data;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const s = this.season;
      const [players, games, playerStats, teamStats, injuries, prior] = await Promise.all([
        this.get('players/players.csv'), this.get('schedules/games.csv'),
        this.get(`stats_player/stats_player_week_${s}.csv`, true), this.get(`stats_team/stats_team_week_${s}.csv`, true),
        this.get(`injuries/injuries_${s}.csv`, true), this.get(`stats_player/stats_player_week_${s - 1}.csv`, true),
      ]);
      const data = buildNflverseDataset({ season: s, players: players!, games: games!, playerStats: playerStats ?? '', teamStats: teamStats ?? '', injuries, priorSeasonStats: prior, asOf: new Date().toISOString() });
      this.cache = { at: Date.now(), data };
      return data;
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }
}

/** Default NFL season for a date: the season that began in September of that year (Jan–Feb belong to the prior one). */
export function seasonForDate(d: Date): number {
  return d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}
