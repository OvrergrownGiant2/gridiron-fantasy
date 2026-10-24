import type { RosterConfig } from './settings';
import { activeRosterSize } from './settings';
import type { InjuryStatus, Position, Slot, StarterSlot } from './types';

export const STARTER_SLOTS: StarterSlot[] = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPERFLEX', 'K', 'DST'];

export function slotAccepts(slot: Slot, pos: Position, cfg: RosterConfig): boolean {
  switch (slot) {
    case 'BN': return true;
    case 'IR': return true; // IR eligibility is checked separately against injury status
    case 'FLEX': return (cfg.flexEligible as Position[]).includes(pos);
    case 'SUPERFLEX': return pos === 'QB' || pos === 'RB' || pos === 'WR' || pos === 'TE';
    default: return slot === pos;
  }
}

export function eligibleSlots(pos: Position, cfg: RosterConfig): Slot[] {
  const out: Slot[] = [];
  for (const s of STARTER_SLOTS) if (cfg[s] > 0 && slotAccepts(s, pos, cfg)) out.push(s);
  out.push('BN');
  if (cfg.IR > 0) out.push('IR');
  return out;
}

export function irEligible(status: InjuryStatus, cfg: RosterConfig): boolean {
  return (cfg.irEligible as string[]).includes(status);
}

export interface RosterPlayer {
  playerId: string;
  position: Position;
  slot: Slot;
  injuryStatus: InjuryStatus;
  locked: boolean;
}

export interface RosterIssue { code: string; message: string; playerId?: string }

/** Validates a full roster/lineup against league configuration. */
export function validateRoster(players: RosterPlayer[], cfg: RosterConfig): RosterIssue[] {
  const issues: RosterIssue[] = [];
  const counts = new Map<Slot, number>();
  const ids = new Set<string>();
  for (const p of players) {
    if (ids.has(p.playerId)) issues.push({ code: 'duplicate', message: 'Player listed twice.', playerId: p.playerId });
    ids.add(p.playerId);
    counts.set(p.slot, (counts.get(p.slot) ?? 0) + 1);
    if (!slotAccepts(p.slot, p.position, cfg)) {
      issues.push({ code: 'ineligible_slot', message: `${p.position} cannot play ${p.slot}.`, playerId: p.playerId });
    }
    if (p.slot === 'IR' && !irEligible(p.injuryStatus, cfg)) {
      issues.push({ code: 'ir_ineligible', message: `Player with status "${p.injuryStatus}" is not IR-eligible.`, playerId: p.playerId });
    }
  }
  for (const s of [...STARTER_SLOTS, 'IR'] as Slot[]) {
    const cap = cfg[s as keyof RosterConfig] as number;
    const n = counts.get(s) ?? 0;
    if (n > cap) issues.push({ code: 'slot_overfilled', message: `${s} has ${n} players but allows ${cap}.` });
  }
  const active = players.filter((p) => p.slot !== 'IR').length;
  const max = activeRosterSize(cfg);
  if (active > max) issues.push({ code: 'roster_full', message: `Active roster has ${active} players; maximum is ${max}.` });
  for (const [pos, limit] of Object.entries(cfg.positionLimits)) {
    if (!limit) continue;
    const n = players.filter((p) => p.position === pos).length;
    if (n > limit) issues.push({ code: 'position_limit', message: `${pos} limit is ${limit}; roster has ${n}.` });
  }
  return issues;
}

/** Is there room to add `incoming` players to the active roster after dropping `outgoing`? */
export function hasRoomFor(players: RosterPlayer[], cfg: RosterConfig, incoming: Position[], outgoingIds: string[]): RosterIssue | null {
  const remaining = players.filter((p) => !outgoingIds.includes(p.playerId));
  const active = remaining.filter((p) => p.slot !== 'IR').length + incoming.length;
  const max = activeRosterSize(cfg);
  if (active > max) return { code: 'roster_full', message: `Roster would have ${active} active players; maximum is ${max}. Choose a player to drop.` };
  for (const [pos, limit] of Object.entries(cfg.positionLimits)) {
    if (!limit) continue;
    const n = remaining.filter((p) => p.position === pos).length + incoming.filter((x) => x === pos).length;
    if (n > limit) return { code: 'position_limit', message: `League allows at most ${limit} ${pos}.` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lineup optimizer (optional, never applied silently)
// ---------------------------------------------------------------------------

export interface OptimizerPlayer extends RosterPlayer {
  name: string;
  projected: number;
  onBye: boolean;
  gameStarted: boolean;
  opponentRankVsPos?: number | null; // 1 = toughest defense vs. position, 32 = easiest
}

export interface LineupChange { playerId: string; name: string; from: Slot; to: Slot; reasons: string[] }
export interface OptimizedLineup {
  assignment: { playerId: string; slot: Slot }[];
  changes: LineupChange[];
  projectedBefore: number;
  projectedAfter: number;
}

function availabilityPenalty(p: OptimizerPlayer): number {
  if (p.onBye) return 0;
  switch (p.injuryStatus) {
    case 'out': case 'ir': case 'suspended': case 'pup': return 0;
    case 'doubtful': return 0.25;
    case 'questionable': return 0.85;
    default: return 1;
  }
}

/** Expected points used for ranking: projection × availability. */
export function effectiveProjection(p: OptimizerPlayer): number {
  return p.projected * availabilityPenalty(p);
}

/**
 * Fill the narrowest slots first (QB/RB/WR/TE/K/DST), then FLEX, then SUPERFLEX.
 * Because eligibility sets are nested (dedicated ⊂ FLEX ⊂ SUPERFLEX), this greedy
 * order yields the maximum total projection. Locked players keep their slots.
 */
export function optimizeLineup(players: OptimizerPlayer[], cfg: RosterConfig): OptimizedLineup {
  const assignment = new Map<string, Slot>();
  const capacity = new Map<Slot, number>();
  for (const s of STARTER_SLOTS) capacity.set(s, cfg[s]);

  // Locked players stay put (including locked bench players).
  for (const p of players) {
    if (p.locked || p.slot === 'IR') {
      assignment.set(p.playerId, p.slot);
      if (p.slot !== 'BN' && p.slot !== 'IR') capacity.set(p.slot, (capacity.get(p.slot) ?? 0) - 1);
    }
  }
  const pool = players.filter((p) => !assignment.has(p.playerId))
    .sort((a, b) => effectiveProjection(b) - effectiveProjection(a) || a.playerId.localeCompare(b.playerId));

  const order: StarterSlot[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'FLEX', 'SUPERFLEX'];
  for (const slot of order) {
    let cap = capacity.get(slot) ?? 0;
    for (const p of pool) {
      if (cap <= 0) break;
      if (assignment.has(p.playerId)) continue;
      if (!slotAccepts(slot, p.position, cfg)) continue;
      assignment.set(p.playerId, slot);
      cap--;
    }
    capacity.set(slot, cap);
  }
  for (const p of pool) if (!assignment.has(p.playerId)) assignment.set(p.playerId, 'BN');

  const isStarter = (s: Slot) => s !== 'BN' && s !== 'IR';
  const projectedBefore = players.filter((p) => isStarter(p.slot)).reduce((a, p) => a + effectiveProjection(p), 0);
  const projectedAfter = players.filter((p) => isStarter(assignment.get(p.playerId)!)).reduce((a, p) => a + effectiveProjection(p), 0);

  const changes: LineupChange[] = [];
  for (const p of players) {
    const to = assignment.get(p.playerId)!;
    if (to === p.slot) continue;
    const reasons: string[] = [];
    if (isStarter(to) && !isStarter(p.slot)) {
      reasons.push(`Projected ${p.projected.toFixed(1)} pts (estimate)`);
      if (p.opponentRankVsPos && p.opponentRankVsPos >= 24) reasons.push('Favorable matchup');
      if (p.injuryStatus === 'healthy') reasons.push('No injury designation');
    }
    if (!isStarter(to) && isStarter(p.slot)) {
      if (p.onBye) reasons.push('On bye this week');
      else if (['out', 'ir', 'suspended', 'pup'].includes(p.injuryStatus)) reasons.push(`Ruled ${p.injuryStatus.toUpperCase()}`);
      else if (p.injuryStatus === 'doubtful') reasons.push('Doubtful — high risk of missing the game');
      else if (p.injuryStatus === 'questionable') reasons.push('Questionable — some risk of missing the game');
      else reasons.push(`Lower projection (${p.projected.toFixed(1)} pts)`);
    }
    if (isStarter(to) && isStarter(p.slot)) reasons.push(`Moved ${p.slot} → ${to} to open a better fit`);
    changes.push({ playerId: p.playerId, name: p.name, from: p.slot, to, reasons });
  }

  return {
    assignment: players.map((p) => ({ playerId: p.playerId, slot: assignment.get(p.playerId)! })),
    changes,
    projectedBefore: Math.round(projectedBefore * 10) / 10,
    projectedAfter: Math.round(projectedAfter * 10) / 10,
  };
}
