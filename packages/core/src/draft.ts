import type { RosterConfig } from './settings';
import { activeRosterSize } from './settings';
import type { Position } from './types';

export type DraftType = 'snake' | 'linear' | 'auction' | 'manual';

/** Team index (into `order`) that owns overall pick `overall` (1-based). */
export function teamIndexForPick(type: DraftType, teamCount: number, overall: number): number {
  const round = Math.ceil(overall / teamCount);
  const idx = (overall - 1) % teamCount;
  if (type === 'snake' && round % 2 === 0) return teamCount - 1 - idx;
  return idx;
}

export function pickLabel(teamCount: number, overall: number): { round: number; pickInRound: number } {
  return { round: Math.ceil(overall / teamCount), pickInRound: ((overall - 1) % teamCount) + 1 };
}

export function totalPicks(teamCount: number, cfg: RosterConfig): number {
  return teamCount * activeRosterSize(cfg);
}

export interface DraftablePlayer { id: string; position: Position; rank: number; projectedSeason: number }

/** Starter requirements per position a team still needs to fill, accounting for FLEX. */
export function positionalNeeds(cfg: RosterConfig, have: Position[]): Record<Position, number> {
  const count = (p: Position) => have.filter((x) => x === p).length;
  const needs: Record<Position, number> = {
    QB: Math.max(0, cfg.QB - count('QB')),
    RB: Math.max(0, cfg.RB - count('RB')),
    WR: Math.max(0, cfg.WR - count('WR')),
    TE: Math.max(0, cfg.TE - count('TE')),
    K: Math.max(0, cfg.K - count('K')),
    DST: Math.max(0, cfg.DST - count('DST')),
  };
  return needs;
}

/**
 * Chooses an automatic pick: first available player from the queue, otherwise the
 * best-ranked player that does not overload a position. K and DST are deferred to
 * the final rounds, which mirrors common draft practice.
 */
export function chooseAutoPick(opts: {
  cfg: RosterConfig;
  available: DraftablePlayer[];
  queue: string[];
  have: Position[];
  picksRemainingForTeam: number;
}): DraftablePlayer | null {
  const { cfg, available, queue, have, picksRemainingForTeam } = opts;
  if (available.length === 0) return null;
  const byId = new Map(available.map((p) => [p.id, p]));
  const needs = positionalNeeds(cfg, have);
  const unfilledRequired = Object.values(needs).reduce((a, b) => a + b, 0);
  const mustFill = unfilledRequired >= picksRemainingForTeam;
  const count = (pos: Position) => have.filter((x) => x === pos).length;

  /** Sensible roster-construction caps so automatic picks build a balanced team. */
  const cap = (pos: Position): number => {
    const explicit = cfg.positionLimits[pos];
    const flexFor = (cfg.flexEligible as Position[]).includes(pos) ? cfg.FLEX : 0;
    const soft = pos === 'QB' ? cfg.QB + cfg.SUPERFLEX + 1
      : pos === 'TE' ? cfg.TE + 1 + Math.min(1, flexFor)
      : pos === 'K' || pos === 'DST' ? cfg[pos]
      : cfg[pos] + flexFor + Math.ceil(cfg.BN / 2) + cfg.SUPERFLEX;
    return explicit ? Math.min(explicit, soft) : soft;
  };

  const allowed = (p: DraftablePlayer) => {
    if (count(p.position) >= cap(p.position)) return false;
    if (mustFill && needs[p.position] === 0) return false;
    // Defer K/DST until the last picks.
    if ((p.position === 'K' || p.position === 'DST') && picksRemainingForTeam > (needs.K + needs.DST)) return false;
    return true;
  };

  for (const id of queue) {
    const p = byId.get(id);
    if (p && (allowed(p) || !mustFill)) return p;
  }
  const sorted = [...available].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const legal = sorted.filter(allowed);
  const best = legal[0];
  if (!best) return sorted.find((p) => needs[p.position] > 0) ?? sorted.find((p) => count(p.position) < cap(p.position)) ?? sorted[0];
  // Prefer filling an open starting slot when a comparable player is available.
  const needPick = legal.slice(0, 10).find((p) => needs[p.position] > 0 && p.rank <= best.rank + 12);
  return needPick ?? best;
}

// ---------------------------------------------------------------------------
// Auction
// ---------------------------------------------------------------------------

/** Maximum a team may bid while keeping $1 for every remaining open roster spot. */
export function maxAuctionBid(budgetRemaining: number, openSpots: number): number {
  if (openSpots <= 0) return 0;
  return Math.max(0, budgetRemaining - (openSpots - 1));
}

export function validateBid(bid: number, currentHigh: number, budgetRemaining: number, openSpots: number): string | null {
  if (!Number.isInteger(bid) || bid < 1) return 'Bids must be whole dollars of at least $1.';
  if (bid <= currentHigh) return `Bid must exceed the current high bid of $${currentHigh}.`;
  const max = maxAuctionBid(budgetRemaining, openSpots);
  if (bid > max) return `Maximum bid is $${max} (you must keep $1 for each remaining roster spot).`;
  return null;
}
