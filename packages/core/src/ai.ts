import { chooseAutoPick, type DraftablePlayer } from './draft';
import type { RosterConfig } from './settings';
import type { AiDifficulty, Position } from './types';
import { seededRandom } from './util';

/**
 * Computer-controlled managers. They only *decide*; every decision is executed
 * through the same server services (and validations) used by human managers.
 */

export function aiDraftPick(opts: {
  difficulty: AiDifficulty;
  cfg: RosterConfig;
  available: DraftablePlayer[];
  have: Position[];
  picksRemainingForTeam: number;
  seed: string;
}): DraftablePlayer | null {
  const { difficulty } = opts;
  const rand = seededRandom(opts.seed);
  const best = chooseAutoPick({ cfg: opts.cfg, available: opts.available, queue: [], have: opts.have, picksRemainingForTeam: opts.picksRemainingForTeam });
  if (!best || difficulty === 'hard') return best;
  // Easier AIs sometimes reach: choose among the next few legal players.
  const window = difficulty === 'easy' ? 8 : 3;
  const candidates: DraftablePlayer[] = [best];
  let pool = opts.available.filter((p) => p.id !== best.id);
  for (let i = 0; i < window - 1 && pool.length; i++) {
    const next = chooseAutoPick({ cfg: opts.cfg, available: pool, queue: [], have: opts.have, picksRemainingForTeam: opts.picksRemainingForTeam });
    if (!next) break;
    candidates.push(next);
    pool = pool.filter((p) => p.id !== next.id);
  }
  return candidates[Math.floor(rand() * candidates.length)];
}

export function aiAcceptsTrade(difficulty: AiDifficulty, valueIn: number, valueOut: number): { accept: boolean; reason: string } {
  const gain = valueOut > 0 ? (valueIn - valueOut) / valueOut : valueIn > 0 ? 1 : 0;
  const need = difficulty === 'hard' ? 0.08 : difficulty === 'medium' ? 0 : -0.12;
  const accept = gain >= need;
  return {
    accept,
    reason: accept
      ? `AI manager (${difficulty}) accepted: estimated value change ${(gain * 100).toFixed(0)}%.`
      : `AI manager (${difficulty}) declined: estimated value change ${(gain * 100).toFixed(0)}% is below its ${(need * 100).toFixed(0)}% threshold.`,
  };
}

export interface AiWaiverCandidate { playerId: string; position: Position; projection: number }
export interface AiRosterPlayer { playerId: string; position: Position; projection: number; locked: boolean; starter: boolean }

/** Suggest at most one improving add/drop. */
export function aiWaiverClaim(opts: {
  difficulty: AiDifficulty;
  available: AiWaiverCandidate[];
  roster: AiRosterPlayer[];
  faabRemaining: number;
  faabBudget: number;
  cfg: RosterConfig;
}): { addPlayerId: string; dropPlayerId: string; bid: number } | null {
  const margin = opts.difficulty === 'hard' ? 1 : opts.difficulty === 'medium' ? 2 : 4;
  const droppable = opts.roster.filter((p) => !p.locked && !p.starter)
    .filter((p) => {
      // never drop the only player at a required position
      const req = (opts.cfg as unknown as Record<string, number>)[p.position] ?? 0;
      return opts.roster.filter((q) => q.position === p.position).length > req;
    })
    .sort((a, b) => a.projection - b.projection);
  const worst = droppable[0];
  if (!worst) return null;
  const best = [...opts.available].sort((a, b) => b.projection - a.projection)
    .find((c) => c.projection >= worst.projection + margin);
  if (!best) return null;
  const share = opts.difficulty === 'hard' ? 0.12 : opts.difficulty === 'medium' ? 0.06 : 0.02;
  const bid = Math.min(opts.faabRemaining, Math.max(0, Math.round(opts.faabBudget * share * (best.projection - worst.projection) / 5)));
  return { addPlayerId: best.playerId, dropPlayerId: worst.playerId, bid };
}

export const AI_TEAM_NAMES = [
  'Iron Algorithm', 'Silicon Stampede', 'Neural Nine', 'Gradient Descent', 'Backprop Bandits',
  'Turing Titans', 'Monte Carlo Mustangs', 'Bayesian Blitz', 'Quantum Quarterbacks', 'Random Forest Rangers',
];
