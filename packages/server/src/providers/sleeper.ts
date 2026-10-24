import type { InjuryStatus, NflPlayer, PlayerGameStat, StatLine } from '@gridiron/core';
import type { NflProvider } from './provider';

/**
 * Sleeper overlay — adds fresher injury designations and in-game (provisional) stats
 * on top of a base provider such as nflverse. Uses Sleeper's public, read-only,
 * UNOFFICIAL endpoints (no key; Sleeper asks clients to stay under 1000 calls/min and
 * to cache the 5 MB player file). Players are joined on the NFL GSIS id, never on
 * names. If Sleeper is unreachable the base provider's data is used unchanged.
 */

const BASE = 'https://api.sleeper.app/v1';

const INJ: Record<string, InjuryStatus> = { questionable: 'questionable', doubtful: 'doubtful', out: 'out', ir: 'ir', pup: 'pup', sus: 'suspended', na: 'out', dnr: 'out', cov: 'out' };

export function mapSleeperStats(s: Record<string, number>, isDst: boolean): StatLine {
  const g = (...keys: string[]) => keys.reduce((a, k) => a + (Number(s[k]) || 0), 0);
  const out: StatLine = isDst ? {
    def_sack: g('sack'), def_int: g('int'), def_fum_rec: g('fum_rec'), def_td: g('def_td'), st_td: g('def_st_td', 'st_td'),
    def_safety: g('safe'), def_blk_kick: g('blk_kick'), def_pts_allowed: g('pts_allow'), def_yds_allowed: g('yds_allow'),
  } : {
    pass_yd: g('pass_yd'), pass_td: g('pass_td'), pass_int: g('pass_int'), pass_2pt: g('pass_2pt'),
    rush_yd: g('rush_yd'), rush_td: g('rush_td'), rush_2pt: g('rush_2pt'),
    rec: g('rec'), rec_yd: g('rec_yd'), rec_td: g('rec_td'), rec_2pt: g('rec_2pt'),
    fum_lost: g('fum_lost'), ret_td: g('kr_td', 'pr_td', 'st_td'), off_fum_rec_td: g('fum_rec_td'),
    fgm_0_39: g('fgm_0_19', 'fgm_20_29', 'fgm_30_39'), fgm_40_49: g('fgm_40_49'), fgm_50p: g('fgm_50p', 'fgm_50_59', 'fgm_60p'),
    fg_miss: g('fgmiss'), xpm: g('xpm'), xp_miss: g('xpmiss'),
  };
  for (const k of Object.keys(out) as (keyof StatLine)[]) if (!out[k] && !(isDst && (k === 'def_pts_allowed'))) delete out[k];
  return out;
}

export class SleeperOverlayProvider implements NflProvider {
  readonly id: string;
  readonly label: string;
  readonly isDemo = false;
  readonly configured = true;
  readonly livePollSeconds = 60;
  readonly idlePollSeconds: number;
  private index: { at: number; byGsis: Map<string, { sleeperId: string; injury: InjuryStatus | null; note: string | null }>; bySleeper: Map<string, string> } | null = null;
  lastError: string | null = null;

  constructor(private base: NflProvider, private http: typeof fetch = fetch) {
    this.id = `${base.id}+sleeper`;
    this.label = `${base.label} + Sleeper live stats (unofficial)`;
    this.idlePollSeconds = Math.min(base.idlePollSeconds, 1800);
  }

  private async json(path: string): Promise<any> {
    const res = await this.http(`${BASE}/${path}`);
    if (!res.ok) throw new Error(`Sleeper HTTP ${res.status}`);
    return res.json();
  }

  private async playerIndex() {
    if (this.index && Date.now() - this.index.at < 6 * 3_600_000) return this.index;
    const all: Record<string, any> = await this.json('players/nfl');
    const byGsis = new Map(), bySleeper = new Map<string, string>();
    for (const [sid, p] of Object.entries(all)) {
      if (!p?.gsis_id) continue;
      const gsis = String(p.gsis_id).trim();
      byGsis.set(gsis, { sleeperId: sid, injury: p.injury_status ? INJ[String(p.injury_status).toLowerCase()] ?? null : null, note: p.injury_body_part ?? null });
      bySleeper.set(sid, gsis);
    }
    this.index = { at: Date.now(), byGsis, bySleeper };
    return this.index;
  }

  currentSeason(now: Date) { return this.base.currentSeason(now); }
  teams() { return this.base.teams(); }
  schedule(season: number) { return this.base.schedule(season); }
  weekGames(season: number, week: number) { return this.base.weekGames(season, week); }

  async players(): Promise<NflPlayer[]> {
    const base = await this.base.players();
    try {
      const idx = await this.playerIndex();
      this.lastError = null;
      return base.map((p) => {
        const s = idx.byGsis.get(p.providerPlayerId);
        if (!s || p.injuryStatus === 'ir') return p;
        return { ...p, injuryStatus: s.injury ?? 'healthy', injuryNote: s.injury ? s.note : null };
      });
    } catch (e) { this.lastError = (e as Error).message; return base; }
  }

  async weekStats(season: number, week: number): Promise<PlayerGameStat[]> {
    const base = await this.base.weekStats(season, week);
    const games = await this.base.weekGames(season, week);
    const live = games.filter((g) => g.status === 'in_progress');
    if (!live.length) return base;
    try {
      const idx = await this.playerIndex();
      const raw: Record<string, Record<string, number>> = await this.json(`stats/nfl/regular/${season}/${week}`);
      const players = new Map((await this.base.players()).map((p) => [p.providerPlayerId, p]));
      const gameByTeam = new Map<string, string>();
      for (const g of live) { gameByTeam.set(g.homeTeamId, g.id); gameByTeam.set(g.awayTeamId, g.id); }
      const have = new Set(base.map((s) => s.playerId));
      const out = [...base];
      for (const [sid, stats] of Object.entries(raw)) {
        const isDst = /^[A-Z]{2,3}$/.test(sid);
        const gsis = isDst ? `DST-${sid === 'LA' ? 'LAR' : sid}` : idx.bySleeper.get(sid);
        if (!gsis) continue;
        const p = players.get(gsis);
        if (!p?.nflTeamId) continue;
        const gameId = gameByTeam.get(p.nflTeamId);
        if (!gameId || have.has(p.id)) continue;
        out.push({ playerId: p.id, gameId, season, week, stats: mapSleeperStats(stats, isDst), isFinal: false });
      }
      this.lastError = null;
      return out;
    } catch (e) { this.lastError = (e as Error).message; return base; }
  }
}
