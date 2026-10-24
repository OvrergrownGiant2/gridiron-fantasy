import type { Position } from './types';

/**
 * Madden-style player ratings (overall + position attributes) computed from REAL stats.
 * These are Gridiron ratings, not EA Madden ratings: every number is a percentile of an actual
 * stat against the player's position group, mapped onto a familiar 40–99 scale.
 */

/** Season totals for one player. Missing fields count as 0. */
export interface UsageLine {
  g: number;
  cmp?: number; att?: number; passYd?: number; passTd?: number; int?: number; sacked?: number;
  car?: number; rushYd?: number; rushTd?: number;
  tgt?: number; rec?: number; recYd?: number; recTd?: number; yac?: number;
  fumLost?: number;
  fgm?: number; fga?: number; fgLong?: number; fg50?: number; xpm?: number; xpa?: number;
  dSack?: number; dInt?: number; dFr?: number; dTd?: number; ptsAllowed?: number; ydsAllowed?: number;
  ppr?: number;
}

export interface RatingAttr { k: string; label: string; v: number; detail: string }
export interface StatCell { k: string; label: string; value: string }
export interface PlayerCard {
  /** null when the player has no NFL stats yet (shown as "NR", not rated). */
  ovr: number | null;
  attrs: RatingAttr[];
  /** Season stat line for display (current season when available, else last season). */
  line: StatCell[];
  lineSeason: number | null;
  basis: string;
}

export interface PlayerBio { height: number | null; weight: number | null; college: string | null; age: number | null; experience: number | null; draft: string | null }
export interface PlayerProfile { headshot: string | null; bio: PlayerBio | null; card: PlayerCard | null }

const z = (u: UsageLine, k: keyof UsageLine) => Number(u[k] ?? 0);
const div = (a: number, b: number) => (b > 0 ? a / b : 0);
const fmt1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const fmtInt = (x: number) => Math.round(x).toLocaleString('en-US');
const pct = (x: number) => `${Math.round(x * 100)}%`;

interface AttrDef { k: string; label: string; metric: (u: UsageLine) => number; higher?: boolean; detail: (u: UsageLine) => string }
interface PosDef {
  pool: number;
  /** Volume used to pick the comparison pool and shrink small samples. */
  volume: (u: UsageLine) => number;
  /** Per-game volume at which a sample counts fully. */
  fullVolumePerGame: number;
  attrs: AttrDef[];
  line: (u: UsageLine) => StatCell[];
}

const QB: PosDef = {
  pool: 34, volume: (u) => z(u, 'att'), fullVolumePerGame: 20,
  attrs: [
    { k: 'ACC', label: 'Accuracy', metric: (u) => div(z(u, 'cmp'), z(u, 'att')), detail: (u) => `${pct(div(z(u, 'cmp'), z(u, 'att')))} completions` },
    { k: 'DEP', label: 'Deep ball', metric: (u) => div(z(u, 'passYd'), z(u, 'att')), detail: (u) => `${fmt1(div(z(u, 'passYd'), z(u, 'att')))} yds/att` },
    { k: 'THP', label: 'Volume', metric: (u) => div(z(u, 'passYd'), u.g), detail: (u) => `${fmtInt(div(z(u, 'passYd'), u.g))} pass yds/g` },
    { k: 'TDS', label: 'Touchdowns', metric: (u) => div(z(u, 'passTd'), z(u, 'att')), detail: (u) => `${fmt1(div(z(u, 'passTd'), u.g))} TD/g` },
    { k: 'SEC', label: 'Ball security', metric: (u) => div(z(u, 'int'), z(u, 'att')), higher: false, detail: (u) => `${fmt1(div(z(u, 'int') * 100, z(u, 'att')))}% INT rate` },
    { k: 'MOB', label: 'Mobility', metric: (u) => div(z(u, 'rushYd'), u.g), detail: (u) => `${fmtInt(div(z(u, 'rushYd'), u.g))} rush yds/g` },
  ],
  line: (u) => [
    { k: 'GP', label: 'Games', value: fmtInt(u.g) }, { k: 'CMP', label: 'Comp %', value: pct(div(z(u, 'cmp'), z(u, 'att'))) },
    { k: 'YDS', label: 'Pass yds', value: fmtInt(z(u, 'passYd')) }, { k: 'TD', label: 'Pass TD', value: fmtInt(z(u, 'passTd')) },
    { k: 'INT', label: 'INT', value: fmtInt(z(u, 'int')) }, { k: 'RUSH', label: 'Rush yds', value: fmtInt(z(u, 'rushYd')) },
  ],
};
const RB: PosDef = {
  pool: 70, volume: (u) => z(u, 'car') + z(u, 'tgt'), fullVolumePerGame: 10,
  attrs: [
    { k: 'RSH', label: 'Rushing', metric: (u) => div(z(u, 'rushYd'), u.g), detail: (u) => `${fmtInt(div(z(u, 'rushYd'), u.g))} rush yds/g` },
    { k: 'ELU', label: 'Elusiveness', metric: (u) => div(z(u, 'rushYd'), z(u, 'car')), detail: (u) => `${fmt1(div(z(u, 'rushYd'), z(u, 'car')))} yds/carry` },
    { k: 'CTH', label: 'Receiving', metric: (u) => div(z(u, 'recYd'), u.g), detail: (u) => `${fmt1(div(z(u, 'rec'), u.g))} rec, ${fmtInt(div(z(u, 'recYd'), u.g))} yds/g` },
    { k: 'TDS', label: 'Scoring', metric: (u) => div(z(u, 'rushTd') + z(u, 'recTd'), u.g), detail: (u) => `${fmtInt(z(u, 'rushTd') + z(u, 'recTd'))} total TD` },
    { k: 'WRK', label: 'Workload', metric: (u) => div(z(u, 'car') + z(u, 'rec'), u.g), detail: (u) => `${fmt1(div(z(u, 'car') + z(u, 'rec'), u.g))} touches/g` },
    { k: 'CAR', label: 'Ball security', metric: (u) => div(z(u, 'fumLost'), z(u, 'car') + z(u, 'rec')), higher: false, detail: (u) => `${fmtInt(z(u, 'fumLost'))} fumbles lost` },
  ],
  line: (u) => [
    { k: 'GP', label: 'Games', value: fmtInt(u.g) }, { k: 'CAR', label: 'Carries', value: fmtInt(z(u, 'car')) },
    { k: 'YDS', label: 'Rush yds', value: fmtInt(z(u, 'rushYd')) }, { k: 'YPC', label: 'Yds/carry', value: fmt1(div(z(u, 'rushYd'), z(u, 'car'))) },
    { k: 'REC', label: 'Receptions', value: fmtInt(z(u, 'rec')) }, { k: 'TD', label: 'Total TD', value: fmtInt(z(u, 'rushTd') + z(u, 'recTd')) },
  ],
};
const receiver = (pool: number, full: number): PosDef => ({
  pool, volume: (u) => z(u, 'tgt'), fullVolumePerGame: full,
  attrs: [
    { k: 'CTH', label: 'Hands', metric: (u) => div(z(u, 'rec'), z(u, 'tgt')), detail: (u) => `${pct(div(z(u, 'rec'), z(u, 'tgt')))} catch rate` },
    { k: 'TGT', label: 'Target share', metric: (u) => div(z(u, 'tgt'), u.g), detail: (u) => `${fmt1(div(z(u, 'tgt'), u.g))} targets/g` },
    { k: 'YDS', label: 'Production', metric: (u) => div(z(u, 'recYd'), u.g), detail: (u) => `${fmtInt(div(z(u, 'recYd'), u.g))} rec yds/g` },
    { k: 'BIG', label: 'Big play', metric: (u) => div(z(u, 'recYd'), z(u, 'rec')), detail: (u) => `${fmt1(div(z(u, 'recYd'), z(u, 'rec')))} yds/catch` },
    { k: 'YAC', label: 'After catch', metric: (u) => div(z(u, 'yac'), z(u, 'rec')), detail: (u) => `${fmt1(div(z(u, 'yac'), z(u, 'rec')))} YAC/catch` },
    { k: 'RZN', label: 'Red zone', metric: (u) => div(z(u, 'recTd'), u.g), detail: (u) => `${fmtInt(z(u, 'recTd'))} rec TD` },
  ],
  line: (u) => [
    { k: 'GP', label: 'Games', value: fmtInt(u.g) }, { k: 'TGT', label: 'Targets', value: fmtInt(z(u, 'tgt')) },
    { k: 'REC', label: 'Receptions', value: fmtInt(z(u, 'rec')) }, { k: 'YDS', label: 'Rec yds', value: fmtInt(z(u, 'recYd')) },
    { k: 'TD', label: 'Rec TD', value: fmtInt(z(u, 'recTd')) }, { k: 'YPR', label: 'Yds/catch', value: fmt1(div(z(u, 'recYd'), z(u, 'rec'))) },
  ],
});
const K: PosDef = {
  pool: 34, volume: (u) => z(u, 'fga') + z(u, 'xpa') / 2, fullVolumePerGame: 2.5,
  attrs: [
    { k: 'ACC', label: 'Accuracy', metric: (u) => div(z(u, 'fgm'), z(u, 'fga')), detail: (u) => `${fmtInt(z(u, 'fgm'))}/${fmtInt(z(u, 'fga'))} field goals` },
    { k: 'PWR', label: 'Leg power', metric: (u) => z(u, 'fgLong') + 4 * div(z(u, 'fg50'), u.g), detail: (u) => `Long ${fmtInt(z(u, 'fgLong'))} · ${fmtInt(z(u, 'fg50'))} from 50+` },
    { k: 'XPT', label: 'Extra points', metric: (u) => div(z(u, 'xpm'), z(u, 'xpa')), detail: (u) => `${fmtInt(z(u, 'xpm'))}/${fmtInt(z(u, 'xpa'))} extra points` },
    { k: 'VOL', label: 'Chances', metric: (u) => div(z(u, 'fga'), u.g), detail: (u) => `${fmt1(div(z(u, 'fga'), u.g))} FG tries/g` },
  ],
  line: (u) => [
    { k: 'GP', label: 'Games', value: fmtInt(u.g) }, { k: 'FG', label: 'FG', value: `${fmtInt(z(u, 'fgm'))}/${fmtInt(z(u, 'fga'))}` },
    { k: 'LNG', label: 'Long', value: fmtInt(z(u, 'fgLong')) }, { k: '50+', label: '50+ made', value: fmtInt(z(u, 'fg50')) },
    { k: 'XP', label: 'Extra pts', value: `${fmtInt(z(u, 'xpm'))}/${fmtInt(z(u, 'xpa'))}` },
  ],
};
const DST: PosDef = {
  pool: 32, volume: (u) => u.g, fullVolumePerGame: 1,
  attrs: [
    { k: 'PRS', label: 'Pass rush', metric: (u) => div(z(u, 'dSack'), u.g), detail: (u) => `${fmt1(div(z(u, 'dSack'), u.g))} sacks/g` },
    { k: 'TKW', label: 'Takeaways', metric: (u) => div(z(u, 'dInt') + z(u, 'dFr'), u.g), detail: (u) => `${fmtInt(z(u, 'dInt'))} INT · ${fmtInt(z(u, 'dFr'))} fumble rec.` },
    { k: 'PTS', label: 'Scoring D', metric: (u) => div(z(u, 'ptsAllowed'), u.g), higher: false, detail: (u) => `${fmt1(div(z(u, 'ptsAllowed'), u.g))} pts allowed/g` },
    { k: 'YDS', label: 'Yards D', metric: (u) => div(z(u, 'ydsAllowed'), u.g), higher: false, detail: (u) => `${fmtInt(div(z(u, 'ydsAllowed'), u.g))} yds allowed/g` },
    { k: 'BIG', label: 'Big plays', metric: (u) => div(z(u, 'dTd'), u.g), detail: (u) => `${fmtInt(z(u, 'dTd'))} defensive/ST TD` },
  ],
  line: (u) => [
    { k: 'GP', label: 'Games', value: fmtInt(u.g) }, { k: 'SCK', label: 'Sacks', value: fmtInt(z(u, 'dSack')) },
    { k: 'INT', label: 'INT', value: fmtInt(z(u, 'dInt')) }, { k: 'FR', label: 'Fum. rec.', value: fmtInt(z(u, 'dFr')) },
    { k: 'TD', label: 'TD', value: fmtInt(z(u, 'dTd')) }, { k: 'PA', label: 'Pts allowed/g', value: fmt1(div(z(u, 'ptsAllowed'), u.g)) },
  ],
};
export const RATING_DEFS: Record<Position, PosDef> = { QB, RB, WR: receiver(100, 6), TE: receiver(44, 4), K, DST };

/** Last season counts half as much as this season. */
const PRIOR_WEIGHT = 0.5;
function blend(cur: UsageLine | null, prior: UsageLine | null): UsageLine | null {
  if (!cur && !prior) return null;
  const out: UsageLine = { g: 0 };
  for (const [src, w] of [[cur, 1], [prior, PRIOR_WEIGHT]] as const) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (k === 'fgLong') { out.fgLong = Math.max(out.fgLong ?? 0, Number(v)); continue; }
      (out as any)[k] = ((out as any)[k] ?? 0) + Number(v) * w;
    }
  }
  return out.g > 0 ? out : null;
}

/** Fraction of `sorted` (ascending) strictly below x, with ties counted half. */
function percentile(sorted: number[], x: number): number {
  if (!sorted.length) return 0.5;
  let lo = 0, eq = 0;
  for (const s of sorted) { if (s < x) lo++; else if (s === x) eq++; }
  return Math.min(1, (lo + eq / 2) / sorted.length);
}
const toRating = (p: number) => Math.max(25, Math.min(99, Math.round(40 + 59 * p)));

export interface RatingInput { id: string; position: Position; cur: UsageLine | null; prior: UsageLine | null; curSeason: number }

/** Rates every player against their position group. Deterministic for the same input. */
export function computeRatings(players: RatingInput[]): Map<string, PlayerCard> {
  const out = new Map<string, PlayerCard>();
  const byPos = new Map<Position, (RatingInput & { u: UsageLine | null })[]>();
  for (const p of players) {
    const list = byPos.get(p.position) ?? [];
    list.push({ ...p, u: blend(p.cur, p.prior) });
    byPos.set(p.position, list);
  }
  for (const [pos, list] of byPos) {
    const def = RATING_DEFS[pos];
    const withStats = list.filter((p) => p.u);
    const pool = [...withStats].sort((a, b) => def.volume(b.u!) - def.volume(a.u!)).slice(0, def.pool);
    const poolIds = new Set(pool.map((p) => p.id));
    const volFactor = (u: UsageLine) => Math.min(1, def.volume(u) / Math.max(1e-9, def.fullVolumePerGame * Math.max(u.g, 3)));
    const attrDist = def.attrs.map((a) => pool.map((p) => a.metric(p.u!)).sort((x, y) => x - y));
    const ppgPool = pool.map((p) => div(z(p.u!, 'ppr'), p.u!.g)).sort((x, y) => x - y);
    const baseline = ppgPool.length ? ppgPool[Math.floor(ppgPool.length * 0.3)] : 0;
    const scored = withStats.map((p) => {
      const u = p.u!;
      const vf = poolIds.has(p.id) ? Math.max(0.6, volFactor(u)) : volFactor(u);
      const attrs: RatingAttr[] = def.attrs.map((a, i) => {
        let q = percentile(attrDist[i], a.metric(u));
        if (a.higher === false) q = 1 - q;
        q = q * vf + 0.2 * (1 - vf);
        return { k: a.k, label: a.label, v: toRating(q), detail: a.detail(u) };
      });
      // Production per game, pulled toward a low baseline when few games were played.
      const ppg = (z(u, 'ppr') + 2 * baseline) / (u.g + 2);
      const comp = 0.6 * percentile(ppgPool, ppg) + 0.4 * (attrs.reduce((s, a) => s + (a.v - 40) / 59, 0) / attrs.length);
      return { p, attrs, comp };
    });
    const compPool = scored.filter((s) => poolIds.has(s.p.id)).map((s) => s.comp).sort((x, y) => x - y);
    for (const s of scored) {
      const shown = s.p.cur && s.p.cur.g > 0 ? s.p.cur : s.p.prior!;
      const basis = [s.p.cur?.g ? `${s.p.curSeason}: ${s.p.cur.g} GP` : null, s.p.prior?.g ? `${s.p.curSeason - 1}: ${s.p.prior.g} GP` : null].filter(Boolean).join(' · ');
      out.set(s.p.id, {
        ovr: toRating(percentile(compPool, s.comp)), attrs: s.attrs, line: def.line(shown),
        lineSeason: s.p.cur && s.p.cur.g > 0 ? s.p.curSeason : s.p.curSeason - 1, basis,
      });
    }
    for (const p of list) if (!p.u) out.set(p.id, { ovr: null, attrs: [], line: [], lineSeason: null, basis: 'No NFL games yet' });
  }
  return out;
}

/** Display tier for an overall rating, used for colors. */
export function ratingTier(ovr: number | null): 'elite' | 'great' | 'good' | 'average' | 'low' | 'none' {
  if (ovr === null) return 'none';
  return ovr >= 90 ? 'elite' : ovr >= 80 ? 'great' : ovr >= 70 ? 'good' : ovr >= 60 ? 'average' : 'low';
}
