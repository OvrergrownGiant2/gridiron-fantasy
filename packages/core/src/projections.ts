import type { InjuryStatus, Position } from './types';

/**
 * Transparent, rule-based projection model. It is an estimate built only from
 * data the app actually holds (this season's scored games under the league's own
 * rules, positional rank, opponent strength, bye and injury designations).
 * It is NOT provider projection data and is labeled as an estimate everywhere.
 */

export interface ProjectionInput {
  position: Position;
  positionalRank: number;            // 1 = best at position by draft rank
  history: number[];                 // fantasy points in games played this season, oldest → newest
  onBye: boolean;
  injuryStatus: InjuryStatus;
  /** Ratio of points this opponent allows to the position vs. league average (1 = average). */
  opponentFactor?: number | null;
}

export interface Projection { points: number; low: number; high: number; basis: string[] }

const PRIOR_CURVE: Record<Position, { top: number; floor: number; decay: number }> = {
  QB: { top: 24, floor: 12, decay: 0.35 },
  RB: { top: 21, floor: 4, decay: 0.3 },
  WR: { top: 20, floor: 4, decay: 0.25 },
  TE: { top: 15, floor: 3, decay: 0.45 },
  K: { top: 10, floor: 6, decay: 0.12 },
  DST: { top: 10, floor: 4, decay: 0.2 },
};

export function priorProjection(position: Position, positionalRank: number): number {
  const c = PRIOR_CURVE[position];
  return Math.max(c.floor, c.top - c.decay * (positionalRank - 1));
}

function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function projectPlayer(i: ProjectionInput): Projection {
  const basis: string[] = [];
  if (i.onBye) return { points: 0, low: 0, high: 0, basis: ['On bye'] };
  if (['out', 'ir', 'suspended', 'pup'].includes(i.injuryStatus)) {
    return { points: 0, low: 0, high: 0, basis: [`Designated ${i.injuryStatus.toUpperCase()}`] };
  }
  const prior = priorProjection(i.position, i.positionalRank);
  const n = i.history.length;
  let pts: number;
  if (n === 0) {
    pts = prior;
    basis.push('No games yet this season — based on positional rank');
  } else {
    const recent = mean(i.history.slice(-3));
    const season = mean(i.history);
    const wPrior = Math.max(0.1, 0.6 - n * 0.1);
    const wRecent = (1 - wPrior) * 0.55;
    const wSeason = (1 - wPrior) * 0.45;
    pts = wPrior * prior + wRecent * recent + wSeason * season;
    basis.push(`Recent avg ${recent.toFixed(1)}, season avg ${season.toFixed(1)} over ${n} game${n === 1 ? '' : 's'}`);
  }
  if (i.opponentFactor && Number.isFinite(i.opponentFactor)) {
    const f = Math.min(1.15, Math.max(0.85, i.opponentFactor));
    pts *= f;
    if (f >= 1.06) basis.push('Favorable matchup');
    else if (f <= 0.94) basis.push('Tough matchup');
  }
  if (i.injuryStatus === 'questionable') { pts *= 0.9; basis.push('Questionable designation'); }
  if (i.injuryStatus === 'doubtful') { pts *= 0.4; basis.push('Doubtful designation'); }
  const sd = n >= 3 ? stdev(i.history) : pts * 0.45;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { points: r(pts), low: r(Math.max(0, pts - sd)), high: r(pts + sd), basis };
}

// ---------------------------------------------------------------------------
// Player value (used by trade analysis and AI managers)
// ---------------------------------------------------------------------------

export interface ValuedPlayer { id: string; position: Position; weeklyProjection: number }

/** Replacement level per position = projection of the first player beyond league starter demand. */
export function replacementLevels(players: ValuedPlayer[], starterDemand: Record<Position, number>): Record<Position, number> {
  const out = {} as Record<Position, number>;
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as Position[]) {
    const sorted = players.filter((p) => p.position === pos).map((p) => p.weeklyProjection).sort((a, b) => b - a);
    const idx = Math.min(sorted.length - 1, Math.max(0, starterDemand[pos]));
    out[pos] = sorted.length ? sorted[idx] : 0;
  }
  return out;
}

/** Value over replacement across `weeks`, never below a small floor so bench depth counts. */
export function playerValue(p: ValuedPlayer, repl: Record<Position, number>, weeks: number): number {
  const vor = Math.max(0, p.weeklyProjection - (repl[p.position] ?? 0));
  return Math.round((vor * weeks + p.weeklyProjection * 0.15 * weeks) * 10) / 10;
}

/** Normal-approximation win probability. Labeled as an estimate in the UI. */
export function winProbability(projA: number, projB: number, remainingSdA: number, remainingSdB: number): number {
  const sd = Math.sqrt(remainingSdA ** 2 + remainingSdB ** 2);
  if (sd < 0.01) return projA > projB ? 1 : projA < projB ? 0 : 0.5;
  const z = (projA - projB) / sd;
  // Abramowitz–Stegun approximation of the standard normal CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
