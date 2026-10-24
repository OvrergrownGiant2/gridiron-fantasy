import { seededRandom, shuffle, type NflGame, type NflPlayer, type NflTeam, type PlayerGameStat, type Position, type StatLine, type InjuryStatus, type StatKey } from '@gridiron/core';
import type { Clock } from '../app';
import type { NflProvider } from './provider';

/**
 * DEMO PROVIDER — SIMULATED DATA ONLY.
 *
 * Generates a deterministic, fictional 2026 season: real NFL team abbreviations,
 * invented player names, a generated schedule with realistic kickoff windows, and
 * simulated stats. Games "happen" according to the clock, so live, upcoming and
 * final states can be exercised end to end. It must never be presented as real
 * NFL data; every UI surface shows a DEMO DATA label when this provider is active.
 */

export const NFL_TEAMS: NflTeam[] = [
  ['ARI', 'Arizona', 'Cardinals', 'NFC', 'West'], ['ATL', 'Atlanta', 'Falcons', 'NFC', 'South'],
  ['BAL', 'Baltimore', 'Ravens', 'AFC', 'North'], ['BUF', 'Buffalo', 'Bills', 'AFC', 'East'],
  ['CAR', 'Carolina', 'Panthers', 'NFC', 'South'], ['CHI', 'Chicago', 'Bears', 'NFC', 'North'],
  ['CIN', 'Cincinnati', 'Bengals', 'AFC', 'North'], ['CLE', 'Cleveland', 'Browns', 'AFC', 'North'],
  ['DAL', 'Dallas', 'Cowboys', 'NFC', 'East'], ['DEN', 'Denver', 'Broncos', 'AFC', 'West'],
  ['DET', 'Detroit', 'Lions', 'NFC', 'North'], ['GB', 'Green Bay', 'Packers', 'NFC', 'North'],
  ['HOU', 'Houston', 'Texans', 'AFC', 'South'], ['IND', 'Indianapolis', 'Colts', 'AFC', 'South'],
  ['JAX', 'Jacksonville', 'Jaguars', 'AFC', 'South'], ['KC', 'Kansas City', 'Chiefs', 'AFC', 'West'],
  ['LV', 'Las Vegas', 'Raiders', 'AFC', 'West'], ['LAC', 'Los Angeles', 'Chargers', 'AFC', 'West'],
  ['LAR', 'Los Angeles', 'Rams', 'NFC', 'West'], ['MIA', 'Miami', 'Dolphins', 'AFC', 'East'],
  ['MIN', 'Minnesota', 'Vikings', 'NFC', 'North'], ['NE', 'New England', 'Patriots', 'AFC', 'East'],
  ['NO', 'New Orleans', 'Saints', 'NFC', 'South'], ['NYG', 'New York', 'Giants', 'NFC', 'East'],
  ['NYJ', 'New York', 'Jets', 'AFC', 'East'], ['PHI', 'Philadelphia', 'Eagles', 'NFC', 'East'],
  ['PIT', 'Pittsburgh', 'Steelers', 'AFC', 'North'], ['SF', 'San Francisco', '49ers', 'NFC', 'West'],
  ['SEA', 'Seattle', 'Seahawks', 'NFC', 'West'], ['TB', 'Tampa Bay', 'Buccaneers', 'NFC', 'South'],
  ['TEN', 'Tennessee', 'Titans', 'AFC', 'South'], ['WAS', 'Washington', 'Commanders', 'NFC', 'East'],
].map(([id, city, name, conference, division]) => ({ id, city, name, conference: conference as 'AFC' | 'NFC', division }));

const FIRST = ['Avery', 'Bennett', 'Calder', 'Dashiell', 'Emory', 'Fenwick', 'Gideon', 'Hollis', 'Ignatius', 'Jasper', 'Kellan', 'Lorcan', 'Merritt', 'Nolan', 'Orrin', 'Peregrine', 'Quillon', 'Rowan', 'Sterling', 'Thaddeus', 'Ulric', 'Vaughn', 'Wendell', 'Xander', 'Yates', 'Zebulon', 'Anders', 'Bram', 'Cyprian', 'Dorian', 'Ellison', 'Fitz', 'Granger', 'Hale', 'Ives', 'Jory', 'Kipling', 'Linus', 'Mercer', 'Nash', 'Osric', 'Pax', 'Ridley', 'Sully', 'Tobin', 'Upton', 'Vance', 'Wilder'];
const LAST = ['Ashgrove', 'Brightwater', 'Coldbrook', 'Dunmore', 'Emberly', 'Fallowfield', 'Glenhaven', 'Hollowell', 'Ironwood', 'Juniperson', 'Kettleby', 'Larkspur', 'Mossgrave', 'Northcote', 'Oakhurst', 'Pemberton', 'Quarrington', 'Ravensworth', 'Stonebridge', 'Thornbury', 'Underhill', 'Vexley', 'Westbrook', 'Yarrowby', 'Zellweger', 'Amberley', 'Blackthorn', 'Cresswell', 'Draycott', 'Elmsworth', 'Foxhollow', 'Greystone', 'Harrowgate', 'Inglewood', 'Kingsley', 'Lockridge', 'Marchbanks', 'Nettleton', 'Ormsby', 'Pickering', 'Redmayne', 'Silverton', 'Tunstall', 'Upshaw', 'Wainwright', 'Wexford', 'Briarcliff', 'Copperfield', 'Dewhurst', 'Fairbairn'];

export const DEMO_SEASON = 2026;

/** US Eastern time → UTC, honoring daylight saving (2nd Sun of March → 1st Sun of November). */
export function easternToUtc(y: number, m: number, d: number, hh: number, mm: number): Date {
  const nthSunday = (year: number, month: number, n: number) => {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  const dstStart = Date.UTC(y, 2, nthSunday(y, 2, 2), 7);  // 2:00 EST = 07:00 UTC
  const dstEnd = Date.UTC(y, 10, nthSunday(y, 10, 1), 6);  // 2:00 EDT = 06:00 UTC
  const guess = Date.UTC(y, m, d, hh + 5, mm);
  const offset = guess >= dstStart && guess < dstEnd ? 4 : 5;
  return new Date(Date.UTC(y, m, d, hh + offset, mm));
}

const GAME_MINUTES = 195;

interface Talent { position: Position; talent: number; team: string }

function hashStr(s: string): number { let h = 7; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0; return h; }

export class DemoProvider implements NflProvider {
  id = 'demo';
  label = 'Demo data (simulated)';
  isDemo = true;
  configured = true;
  livePollSeconds = 15;
  idlePollSeconds = 300;
  replayable = true;

  private playersCache: (NflPlayer & Talent)[] | null = null;
  private scheduleCache: NflGame[] | null = null;

  constructor(private clock: Clock) {}

  async currentSeason(now: Date) {
    const games = this.buildSchedule();
    for (let w = 1; w <= 18; w++) {
      const last = games.filter((g) => g.week === w).reduce((a, g) => Math.max(a, Date.parse(g.kickoffAt)), 0);
      if (now.getTime() < last + (GAME_MINUTES + 60) * 60_000) return { season: DEMO_SEASON, week: w, seasonType: 'REG' as const };
    }
    return { season: DEMO_SEASON, week: 18, seasonType: 'REG' as const };
  }

  async teams() { return NFL_TEAMS; }

  private buildPlayers(): (NflPlayer & Talent)[] {
    if (this.playersCache) return this.playersCache;
    const rand = seededRandom('demo-players-v1');
    const used = new Set<string>();
    const out: (NflPlayer & Talent)[] = [];
    const depth: [Position, number][] = [['QB', 2], ['RB', 4], ['WR', 5], ['TE', 2], ['K', 1]];
    let n = 0;
    for (const t of NFL_TEAMS) {
      const jerseys = new Set<number>();
      for (const [pos, count] of depth) {
        for (let i = 0; i < count; i++) {
          let name = '';
          do { name = `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`; } while (used.has(name));
          used.add(name);
          // depth chart: starters are much better than backups
          const base = i === 0 ? 0.75 + rand() * 0.5 : i === 1 ? (pos === 'QB' ? 0.12 : 0.45 + rand() * 0.35) : 0.15 + rand() * 0.3;
          const range = pos === 'QB' ? [1, 19] : pos === 'RB' ? [20, 49] : pos === 'WR' ? [10, 89] : pos === 'TE' ? [80, 89] : [1, 19];
          let jersey = 0;
          do { jersey = range[0] + Math.floor(rand() * (range[1] - range[0] + 1)); } while (jerseys.has(jersey));
          jerseys.add(jersey);
          n++;
          out.push({
            id: `demo:${1000 + n}`, provider: 'demo', providerPlayerId: String(1000 + n), fullName: name,
            position: pos, nflTeamId: t.id, jersey, injuryStatus: 'healthy', injuryNote: null, active: true,
            rank: 0, talent: base, team: t.id,
          });
        }
      }
      n++;
      out.push({ id: `demo:${1000 + n}`, provider: 'demo', providerPlayerId: String(1000 + n), fullName: `${t.city} ${t.name} D/ST`, position: 'DST', nflTeamId: t.id, jersey: null, injuryStatus: 'healthy', injuryNote: null, active: true, rank: 0, talent: 0.6 + rand() * 0.6, team: t.id });
    }
    // Consensus-style rank by expected weekly points.
    // Value over a typical replacement player, so ranks resemble real draft boards (QBs are deep, RBs scarce).
    const expected = (p: Talent) => p.talent * ({ QB: 20, RB: 15, WR: 14, TE: 9, K: 8, DST: 7 }[p.position]) - ({ QB: 9, RB: 4, WR: 4.5, TE: 3, K: 5, DST: 4 }[p.position]);
    const sorted = [...out].sort((a, b) => expected(b) - expected(a));
    sorted.forEach((p, i) => { p.rank = i + 1; });
    this.playersCache = out;
    return out;
  }

  private injuryFor(p: NflPlayer & Talent, week: number): { status: InjuryStatus; note: string | null } {
    if (p.position === 'DST') return { status: 'healthy', note: null };
    const r = seededRandom(`inj:${p.id}:${week}`)();
    const longTerm = seededRandom(`ir:${p.id}`)();
    if (longTerm < 0.025 && week >= 4) return { status: 'ir', note: 'Simulated long-term injury (demo)' };
    if (r < 0.03) return { status: 'out', note: 'Simulated injury (demo)' };
    if (r < 0.05) return { status: 'doubtful', note: 'Simulated injury (demo)' };
    if (r < 0.12) return { status: 'questionable', note: 'Simulated injury (demo)' };
    return { status: 'healthy', note: null };
  }

  async players(): Promise<NflPlayer[]> {
    const { week } = await this.currentSeason(this.clock.now());
    return this.buildPlayers().map(({ talent: _t, team: _team, ...p }) => {
      const inj = this.injuryFor({ ...p, talent: 0, team: '' }, week);
      return { ...p, injuryStatus: inj.status, injuryNote: inj.note };
    });
  }

  private buildSchedule(): NflGame[] {
    if (this.scheduleCache) return this.scheduleCache;
    const rand = seededRandom('demo-schedule-v1');
    const ids = NFL_TEAMS.map((t) => t.id);
    // Byes: 4 teams per week in weeks 5–12.
    const byeOrder = shuffle(ids, rand);
    const bye = new Map<string, number>();
    byeOrder.forEach((id, i) => bye.set(id, 5 + Math.floor(i / 4)));
    const met = new Map<string, number>();
    const games: NflGame[] = [];
    // Week 1 Thursday: Sep 10, 2026
    for (let week = 1; week <= 18; week++) {
      const playing = ids.filter((id) => bye.get(id) !== week);
      let pairs: [string, string][] = [];
      for (let attempt = 0; attempt < 200; attempt++) {
        const pool = shuffle(playing, rand);
        pairs = [];
        let ok = true;
        while (pool.length) {
          const a = pool.shift()!;
          const idx = pool.findIndex((b) => (met.get([a, b].sort().join()) ?? 0) < (attempt < 150 ? 1 : 2));
          if (idx < 0) { ok = false; break; }
          pairs.push([a, pool.splice(idx, 1)[0]]);
        }
        if (ok) break;
      }
      for (const [a, b] of pairs) met.set([a, b].sort().join(), (met.get([a, b].sort().join()) ?? 0) + 1);
      const thu = new Date(Date.UTC(2026, 8, 10 + (week - 1) * 7));
      const slot = (i: number): Date => {
        const dayOffset = i === 0 ? 0 : i === pairs.length - 1 ? 4 : 3; // Thu / Mon / Sun
        const d = new Date(thu.getTime() + dayOffset * 86_400_000);
        const [hh, mm] = i === 0 ? [20, 15] : i === pairs.length - 1 ? [20, 15] : i === pairs.length - 2 ? [20, 20] : i <= pairs.length - 6 ? [13, 0] : [16, 25];
        return easternToUtc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm);
      };
      pairs.forEach(([a, b], i) => {
        const home = rand() < 0.5 ? a : b;
        const away = home === a ? b : a;
        games.push({
          id: `demo-${DEMO_SEASON}-${String(week).padStart(2, '0')}-${away}-${home}`,
          season: DEMO_SEASON, seasonType: 'REG', week, homeTeamId: home, awayTeamId: away,
          kickoffAt: slot(i).toISOString(), status: 'scheduled', homeScore: null, awayScore: null, quarter: null, clock: null,
        });
      });
    }
    this.scheduleCache = games;
    return games;
  }

  /** One deterministic game per few weeks starts 40 minutes late to exercise the DELAYED state. */
  private delayMinutes(g: NflGame): number {
    return hashStr(g.id) % 23 === 0 ? 40 : 0;
  }

  private progress(g: NflGame, now: Date): number {
    const start = Date.parse(g.kickoffAt) + this.delayMinutes(g) * 60_000;
    return Math.max(0, Math.min(1, (now.getTime() - start) / (GAME_MINUTES * 60_000)));
  }

  private finalScores(g: NflGame): [number, number] {
    const r = seededRandom(`score:${g.id}`);
    const pts = () => { const opts = [3, 6, 7, 10, 13, 14, 16, 17, 20, 21, 23, 24, 27, 28, 30, 31, 34, 35, 38, 41]; return opts[Math.floor(r() * opts.length)]; };
    let h = pts(), a = pts();
    if (h === a) h += 3; // demo games never end tied
    return [h, a];
  }

  private gameState(g: NflGame, now: Date): NflGame {
    const kick = Date.parse(g.kickoffAt);
    const delay = this.delayMinutes(g);
    const p = this.progress(g, now);
    const [hs, as] = this.finalScores(g);
    if (now.getTime() < kick) return { ...g, status: 'scheduled' };
    if (delay && now.getTime() < kick + delay * 60_000) return { ...g, status: 'delayed', homeScore: 0, awayScore: 0, quarter: null, clock: 'Weather delay (demo)' };
    if (p >= 1) return { ...g, status: 'final', homeScore: hs, awayScore: as, quarter: 'F', clock: null };
    const q = Math.min(4, Math.floor(p * 4) + 1);
    const inQ = p * 4 - (q - 1);
    const secLeft = Math.round((1 - inQ) * 900);
    return {
      ...g, status: 'in_progress', homeScore: Math.floor(hs * p), awayScore: Math.floor(as * p),
      quarter: `Q${q}`, clock: `${Math.floor(secLeft / 60)}:${String(secLeft % 60).padStart(2, '0')}`,
    };
  }

  async schedule(season: number) {
    if (season !== DEMO_SEASON) return [];
    const now = this.clock.now();
    return this.buildSchedule().map((g) => this.gameState(g, now));
  }

  async weekGames(season: number, week: number) {
    return (await this.schedule(season)).filter((g) => g.week === week);
  }

  private finalLine(p: NflPlayer & Talent, g: NflGame): StatLine {
    const r = seededRandom(`stat:${p.id}:${g.id}`);
    const t = p.talent * (0.55 + r() * 0.9);
    const pois = (lambda: number) => { let L = Math.exp(-lambda), k = 0, q = 1; do { k++; q *= r(); } while (q > L); return k - 1; };
    const s: StatLine = {};
    switch (p.position) {
      case 'QB': {
        if (p.talent < 0.3) return {};
        s.pass_yd = Math.round(150 + 170 * t + (r() - 0.5) * 60); s.pass_td = pois(1.7 * t); s.pass_int = pois(0.75);
        s.rush_yd = Math.round(r() * 30 * t); s.rush_td = r() < 0.08 * t ? 1 : 0; s.fum_lost = r() < 0.08 ? 1 : 0; s.pass_2pt = r() < 0.05 ? 1 : 0;
        break;
      }
      case 'RB': {
        s.rush_yd = Math.round(Math.max(0, 25 + 85 * t + (r() - 0.5) * 50)); s.rush_td = pois(0.65 * t);
        s.rec = pois(2.8 * t); s.rec_yd = Math.round(s.rec * (5 + r() * 6)); s.rec_td = pois(0.12 * t); s.fum_lost = r() < 0.05 ? 1 : 0;
        break;
      }
      case 'WR': {
        s.rec = pois(5.5 * t); s.rec_yd = Math.round(s.rec * (9 + r() * 8)); s.rec_td = pois(0.5 * t);
        s.rush_yd = r() < 0.1 ? Math.round(r() * 15) : 0; s.fum_lost = r() < 0.02 ? 1 : 0; s.ret_td = r() < 0.01 ? 1 : 0;
        break;
      }
      case 'TE': {
        s.rec = pois(4 * t); s.rec_yd = Math.round(s.rec * (8 + r() * 5)); s.rec_td = pois(0.35 * t);
        break;
      }
      case 'K': {
        const att = pois(2.1);
        for (let i = 0; i < att; i++) {
          const dist = 20 + Math.floor(r() * 38);
          const make = r() < (dist >= 50 ? 0.7 : 0.88);
          if (!make) s.fg_miss = (s.fg_miss ?? 0) + 1;
          else if (dist >= 50) s.fgm_50p = (s.fgm_50p ?? 0) + 1;
          else if (dist >= 40) s.fgm_40_49 = (s.fgm_40_49 ?? 0) + 1;
          else s.fgm_0_39 = (s.fgm_0_39 ?? 0) + 1;
        }
        s.xpm = pois(2.4); s.xp_miss = r() < 0.06 ? 1 : 0;
        break;
      }
      case 'DST': {
        const [hs, as] = this.finalScores(g);
        s.def_pts_allowed = p.team === g.homeTeamId ? as : hs;
        s.def_sack = pois(2.4 * t); s.def_int = pois(0.8 * t); s.def_fum_rec = pois(0.6 * t);
        s.def_td = r() < 0.1 * t ? 1 : 0; s.st_td = r() < 0.03 ? 1 : 0; s.def_safety = r() < 0.03 ? 1 : 0;
        s.def_yds_allowed = Math.round(250 + (1.2 - t) * 120 + (r() - 0.5) * 80);
        break;
      }
    }
    return s;
  }

  /** Partial line at progress p: yards accrue linearly, discrete events at seeded times. */
  private partialLine(final: StatLine, p: number, seed: string): StatLine {
    if (p >= 1) return final;
    const r = seededRandom(`times:${seed}`);
    const out: StatLine = {};
    for (const [k, v] of Object.entries(final) as [StatKey, number][]) {
      if (k === 'def_pts_allowed') { out[k] = Math.floor(v * p); continue; }
      if (k.endsWith('_yd') || k === 'def_yds_allowed') { out[k] = Math.round(v * p); continue; }
      let c = 0;
      for (let i = 0; i < v; i++) if (r() <= p) c++;
      out[k] = c;
    }
    return out;
  }

  async weekStats(season: number, week: number): Promise<PlayerGameStat[]> {
    if (season !== DEMO_SEASON) return [];
    const now = this.clock.now();
    const games = this.buildSchedule().filter((g) => g.week === week);
    const byTeam = new Map<string, NflGame>();
    for (const g of games) { byTeam.set(g.homeTeamId, g); byTeam.set(g.awayTeamId, g); }
    const out: PlayerGameStat[] = [];
    for (const p of this.buildPlayers()) {
      const g = byTeam.get(p.team);
      if (!g) continue; // bye
      const state = this.gameState(g, now);
      if (state.status === 'scheduled' || state.status === 'delayed') continue;
      const inj = this.injuryFor(p, week);
      if (['out', 'ir'].includes(inj.status)) continue;
      const prog = this.progress(g, now);
      const final = this.finalLine(p, g);
      out.push({ playerId: p.id, gameId: g.id, season, week, stats: this.partialLine(final, prog, `${p.id}:${g.id}`), isFinal: state.status === 'final' });
    }
    return out;
  }
}
