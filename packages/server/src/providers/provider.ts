import type { NflGame, NflPlayer, NflTeam, PlayerGameStat } from '@gridiron/core';

/**
 * Provider port. Each adapter maps a vendor's payloads into the normalized core
 * types; nothing vendor-specific crosses this boundary, so the scoring engine never
 * changes when the provider does.
 */
export interface NflProvider {
  readonly id: string;                       // 'sportsdataio' | 'demo' | 'none'
  readonly label: string;
  /** True when the provider serves simulated data. The UI must label it as demo data. */
  readonly isDemo: boolean;
  /** False when credentials are missing; sync jobs then report DATA UNAVAILABLE. */
  readonly configured: boolean;
  /** Seconds between live polls while games are in progress. */
  readonly livePollSeconds: number;
  readonly idlePollSeconds: number;
  /** Set when serving a frozen snapshot of real data (no new results will arrive). */
  readonly snapshotAsOf?: string | null;
  /** True when data is derived from the injected clock, so seeding can replay a season. */
  readonly replayable?: boolean;

  currentSeason(now: Date): Promise<{ season: number; week: number; seasonType: 'REG' | 'POST' }>;
  teams(): Promise<NflTeam[]>;
  players(): Promise<NflPlayer[]>;               // includes injury designations
  schedule(season: number): Promise<NflGame[]>;
  /** Live and final game state for one week. */
  weekGames(season: number, week: number): Promise<NflGame[]>;
  /** Player and team-defense stat lines for one week (provisional while games are live). */
  weekStats(season: number, week: number): Promise<PlayerGameStat[]>;
}

export class ProviderError extends Error {
  constructor(message: string, public kind: 'unconfigured' | 'rate_limited' | 'http' | 'network' | 'parse', public retryAfterSeconds?: number) {
    super(message);
  }
}

/** Used when no provider is configured: every call fails honestly. */
export class UnconfiguredProvider implements NflProvider {
  id = 'none';
  label = 'No NFL data provider configured';
  isDemo = false;
  configured = false;
  livePollSeconds = 300;
  idlePollSeconds = 3600;
  private fail(): never { throw new ProviderError('No NFL data provider is configured. Set NFL_PROVIDER and its API key, or enable demo mode.', 'unconfigured'); }
  async currentSeason(): Promise<never> { this.fail(); }
  async teams(): Promise<never> { this.fail(); }
  async players(): Promise<never> { this.fail(); }
  async schedule(): Promise<never> { this.fail(); }
  async weekGames(): Promise<never> { this.fail(); }
  async weekStats(): Promise<never> { this.fail(); }
}
