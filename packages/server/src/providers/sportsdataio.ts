import type { GameStatus, InjuryStatus, NflGame, NflPlayer, NflTeam, PlayerGameStat, Position, StatLine } from '@gridiron/core';
import { ProviderError, type NflProvider } from './provider';

/**
 * SportsDataIO NFL adapter (https://sportsdata.io/developers/api-documentation/nfl).
 *
 * Endpoint paths and field names follow SportsDataIO's v3 NFL documentation as of
 * October 2026. Verify them against your subscription before production use:
 * free trials return scrambled data, and live (in-game) feeds require a paid plan.
 * The key is sent in the `Ocp-Apim-Subscription-Key` header and never reaches the browser.
 */

type Json = Record<string, any>;

const BASE = 'https://api.sportsdata.io/v3/nfl';

export function mapStatus(s: string | null | undefined): GameStatus {
  switch ((s ?? '').toLowerCase()) {
    case 'scheduled': return 'scheduled';
    case 'inprogress': return 'in_progress';
    case 'final': case 'f/ot': return 'final';
    case 'suspended': case 'delayed': return 'delayed';
    case 'postponed': return 'postponed';
    case 'canceled': case 'cancelled': case 'forfeit': return 'canceled';
    default: return 'scheduled';
  }
}

export function mapInjury(s: string | null | undefined): InjuryStatus {
  switch ((s ?? '').toLowerCase()) {
    case 'questionable': return 'questionable';
    case 'doubtful': return 'doubtful';
    case 'out': return 'out';
    case 'injured reserve': case 'ir': return 'ir';
    case 'suspended': return 'suspended';
    case 'physically unable to perform': case 'pup': return 'pup';
    default: return 'healthy';
  }
}

const POS: Record<string, Position> = { QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE', K: 'K' };

/** SportsDataIO dates without offset are US Eastern; DateTimeUTC (when present) is preferred. */
function kickoffIso(g: Json): string {
  if (g.DateTimeUTC) return new Date(g.DateTimeUTC + 'Z').toISOString();
  if (g.Date) return new Date(g.Date).toISOString();
  return new Date(0).toISOString();
}

export function mapGame(g: Json, season: number): NflGame {
  return {
    id: `sdio-${g.GlobalGameID ?? g.GameKey ?? g.ScoreID}`,
    season, seasonType: g.SeasonType === 3 ? 'POST' : 'REG', week: Number(g.Week),
    homeTeamId: g.HomeTeam, awayTeamId: g.AwayTeam, kickoffAt: kickoffIso(g),
    status: mapStatus(g.Status),
    homeScore: g.HomeScore ?? null, awayScore: g.AwayScore ?? null,
    quarter: g.Quarter ?? null, clock: g.TimeRemaining ?? null,
  };
}

export function mapPlayerStat(r: Json, season: number): PlayerGameStat | null {
  const pos = POS[r.Position ?? r.FantasyPosition];
  if (!pos) return null;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const stats: StatLine = {
    pass_yd: n(r.PassingYards), pass_td: n(r.PassingTouchdowns), pass_int: n(r.PassingInterceptions), pass_2pt: n(r.TwoPointConversionPasses),
    rush_yd: n(r.RushingYards), rush_td: n(r.RushingTouchdowns), rush_2pt: n(r.TwoPointConversionRuns),
    rec: n(r.Receptions), rec_yd: n(r.ReceivingYards), rec_td: n(r.ReceivingTouchdowns), rec_2pt: n(r.TwoPointConversionReceptions),
    fum_lost: n(r.FumblesLost),
    ret_td: n(r.PuntReturnTouchdowns) + n(r.KickReturnTouchdowns),
    off_fum_rec_td: n(r.FumbleReturnTouchdowns),
    fgm_0_39: n(r.FieldGoalsMade0to19) + n(r.FieldGoalsMade20to29) + n(r.FieldGoalsMade30to39),
    fgm_40_49: n(r.FieldGoalsMade40to49), fgm_50p: n(r.FieldGoalsMade50Plus),
    fg_miss: Math.max(0, n(r.FieldGoalsAttempted) - n(r.FieldGoalsMade)),
    xpm: n(r.ExtraPointsMade), xp_miss: Math.max(0, n(r.ExtraPointsAttempted) - n(r.ExtraPointsMade)),
  };
  for (const k of Object.keys(stats) as (keyof StatLine)[]) if (!stats[k]) delete stats[k];
  return {
    playerId: `sportsdataio:${r.PlayerID}`, gameId: `sdio-${r.GlobalGameID ?? r.GameKey}`, season, week: Number(r.Week),
    stats, isFinal: Boolean(r.IsGameOver),
  };
}

export function mapDefenseStat(r: Json, season: number): PlayerGameStat {
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    playerId: `sportsdataio:DST-${r.Team}`, gameId: `sdio-${r.GlobalGameID ?? r.GameKey}`, season, week: Number(r.Week),
    stats: {
      def_sack: n(r.Sacks), def_int: n(r.Interceptions), def_fum_rec: n(r.FumblesRecovered),
      def_td: n(r.DefensiveTouchdowns), st_td: n(r.SpecialTeamsTouchdowns), def_safety: n(r.Safeties),
      def_blk_kick: n(r.BlockedKicks), def_pts_allowed: n(r.PointsAllowed), def_yds_allowed: n(r.OffensiveYardsAllowed),
    },
    isFinal: Boolean(r.IsGameOver),
  };
}

export class SportsDataIoProvider implements NflProvider {
  id = 'sportsdataio';
  label = 'SportsDataIO';
  isDemo = false;
  configured: boolean;
  livePollSeconds: number;
  idlePollSeconds = 900;

  constructor(private apiKey: string | undefined, private http: typeof fetch = fetch, livePollSeconds = 60) {
    this.configured = Boolean(apiKey);
    this.livePollSeconds = Math.max(15, livePollSeconds);
  }

  private async get(path: string): Promise<any> {
    if (!this.apiKey) throw new ProviderError('SPORTSDATAIO_API_KEY is not set.', 'unconfigured');
    let res: Response;
    try {
      res = await this.http(`${BASE}/${path}`, { headers: { 'Ocp-Apim-Subscription-Key': this.apiKey, Accept: 'application/json' } });
    } catch (e) {
      throw new ProviderError(`Network error contacting SportsDataIO: ${(e as Error).message}`, 'network');
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after') ?? '60');
      throw new ProviderError('SportsDataIO rate limit reached.', 'rate_limited', Number.isFinite(ra) ? ra : 60);
    }
    if (res.status === 401 || res.status === 403) throw new ProviderError(`SportsDataIO rejected the API key or plan (HTTP ${res.status}).`, 'http');
    if (!res.ok) throw new ProviderError(`SportsDataIO returned HTTP ${res.status} for ${path}.`, 'http');
    try { return await res.json(); } catch { throw new ProviderError(`Could not parse SportsDataIO response for ${path}.`, 'parse'); }
  }

  async currentSeason() {
    const [season, week] = await Promise.all([this.get('scores/json/CurrentSeason'), this.get('scores/json/CurrentWeek')]);
    return { season: Number(season), week: Number(week) || 1, seasonType: 'REG' as const };
  }

  async teams(): Promise<NflTeam[]> {
    const rows: Json[] = await this.get('scores/json/Teams');
    return rows.map((t) => ({ id: t.Key, city: t.City, name: t.Name, conference: t.Conference, division: t.Division }));
  }

  async players(): Promise<NflPlayer[]> {
    const rows: Json[] = await this.get('scores/json/PlayersByAvailable');
    const out: NflPlayer[] = [];
    for (const r of rows) {
      const pos = POS[r.FantasyPosition ?? r.Position];
      if (!pos || r.Status === 'Inactive') continue;
      out.push({
        id: `sportsdataio:${r.PlayerID}`, provider: 'sportsdataio', providerPlayerId: String(r.PlayerID),
        fullName: r.Name ?? `${r.FirstName} ${r.LastName}`, position: pos, nflTeamId: r.Team ?? null,
        jersey: r.Number ?? null, injuryStatus: mapInjury(r.InjuryStatus), injuryNote: r.InjuryBodyPart ?? null,
        active: r.Status === 'Active', rank: Number(r.AverageDraftPosition) || 9999,
      });
    }
    // Team defenses are synthesized from the teams list with stable ids.
    for (const t of await this.teams()) {
      out.push({ id: `sportsdataio:DST-${t.id}`, provider: 'sportsdataio', providerPlayerId: `DST-${t.id}`, fullName: `${t.city} ${t.name} D/ST`, position: 'DST', nflTeamId: t.id, jersey: null, injuryStatus: 'healthy', injuryNote: null, active: true, rank: 9000 });
    }
    return out;
  }

  async schedule(season: number) {
    const rows: Json[] = await this.get(`scores/json/Schedules/${season}`);
    return rows.filter((g) => g.HomeTeam !== 'BYE' && g.Week).map((g) => mapGame(g, season));
  }

  async weekGames(season: number, week: number) {
    const rows: Json[] = await this.get(`scores/json/ScoresByWeek/${season}/${week}`);
    return rows.map((g) => mapGame(g, season));
  }

  async weekStats(season: number, week: number) {
    const [players, defenses]: [Json[], Json[]] = await Promise.all([
      this.get(`stats/json/PlayerGameStatsByWeek/${season}/${week}`),
      this.get(`stats/json/FantasyDefenseByGame/${season}/${week}`),
    ]);
    const out: PlayerGameStat[] = [];
    for (const r of players) { const m = mapPlayerStat(r, season); if (m) out.push(m); }
    for (const r of defenses) out.push(mapDefenseStat(r, season));
    return out;
  }
}
