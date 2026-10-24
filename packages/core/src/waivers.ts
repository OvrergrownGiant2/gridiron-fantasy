import type { WaiverSettings } from './settings';

export interface PendingClaim {
  id: string;
  teamId: string;
  addPlayerId: string;
  dropPlayerId: string | null;
  bid: number;
  /** Team's own ordering, 1 = most wanted. */
  rank: number;
  /** Conditional group: at most one claim in a group can succeed. */
  groupId: string | null;
  createdAt: string;
}

export interface TeamWaiverState {
  teamId: string;
  priority: number;          // 1 = first
  faabRemaining: number;
  rosterPlayerIds: string[];
  activeRosterCount: number;
  maxActive: number;
}

export interface ClaimOutcome {
  claimId: string;
  teamId: string;
  status: 'won' | 'lost' | 'invalid';
  reason: string;
  bid: number;
}

export interface WaiverRunResult {
  outcomes: ClaimOutcome[];
  /** Final priority order after the run (teamIds, first = 1). */
  priorityOrder: string[];
  faab: Record<string, number>;
}

/**
 * Deterministic waiver resolution.
 *
 * Runs in rounds. Each round, every team nominates its highest-ranked claim that is
 * still valid. When several teams nominate the same player, the winner is decided by
 * the league's mode (FAAB: highest bid, then priority; otherwise priority). All
 * other claims on an awarded player lose. Rolling and reverse-standings modes move
 * each winner to the back of the priority order. Ties are broken by claim creation
 * time and then id, so the same input always produces the same output.
 *
 * `isAvailable` lets the caller exclude players that are locked or already rostered.
 */
export function resolveWaivers(
  claims: PendingClaim[],
  teams: TeamWaiverState[],
  settings: Pick<WaiverSettings, 'mode' | 'allowZeroBids'>,
  isAvailable: (playerId: string) => boolean = () => true,
): WaiverRunResult {
  const state = new Map(teams.map((t) => [t.teamId, {
    ...t, rosterPlayerIds: new Set(t.rosterPlayerIds),
  }]));
  let order = [...teams].sort((a, b) => a.priority - b.priority).map((t) => t.teamId);
  const awarded = new Set<string>();
  const wonGroups = new Set<string>();
  const outcomes = new Map<string, ClaimOutcome>();
  const pending = new Map(claims.map((c) => [c.id, c]));

  const finish = (c: PendingClaim, status: ClaimOutcome['status'], reason: string) => {
    outcomes.set(c.id, { claimId: c.id, teamId: c.teamId, status, reason, bid: c.bid });
    pending.delete(c.id);
  };

  const validity = (c: PendingClaim): string | null => {
    const t = state.get(c.teamId);
    if (!t) return 'Team no longer exists.';
    if (awarded.has(c.addPlayerId) || !isAvailable(c.addPlayerId)) return 'Player is no longer available.';
    if (c.groupId && wonGroups.has(`${c.teamId}:${c.groupId}`)) return 'Another claim in this conditional group succeeded.';
    if (c.dropPlayerId && !t.rosterPlayerIds.has(c.dropPlayerId)) return 'The player selected to drop is no longer on your roster.';
    if (!c.dropPlayerId && t.activeRosterCount >= t.maxActive) return 'Roster is full and no drop was selected.';
    if (settings.mode === 'faab') {
      if (c.bid < 0 || !Number.isInteger(c.bid)) return 'Invalid bid.';
      if (c.bid === 0 && !settings.allowZeroBids) return '$0 bids are not allowed in this league.';
      if (c.bid > t.faabRemaining) return `Bid of $${c.bid} exceeds remaining budget ($${t.faabRemaining}).`;
    }
    return null;
  };

  const tieKey = (c: PendingClaim) => `${c.createdAt}|${c.id}`;

  for (let guard = 0; guard < claims.length + teams.length + 5 && pending.size > 0; guard++) {
    // Each team nominates its best valid claim; invalid ones are finalized now.
    const nominations: PendingClaim[] = [];
    for (const teamId of order) {
      const mine = [...pending.values()].filter((c) => c.teamId === teamId)
        .sort((a, b) => a.rank - b.rank || tieKey(a).localeCompare(tieKey(b)));
      for (const c of mine) {
        const bad = validity(c);
        if (bad) {
          // Distinguish "lost to another team" from invalid claims for clearer history.
          finish(c, awarded.has(c.addPlayerId) ? 'lost' : 'invalid', bad);
          continue;
        }
        nominations.push(c);
        break;
      }
    }
    if (nominations.length === 0) break;

    // Group nominations by player and pick winners.
    const byPlayer = new Map<string, PendingClaim[]>();
    for (const n of nominations) byPlayer.set(n.addPlayerId, [...(byPlayer.get(n.addPlayerId) ?? []), n]);

    const prio = (teamId: string) => order.indexOf(teamId);
    const winners: PendingClaim[] = [];
    for (const contenders of byPlayer.values()) {
      contenders.sort((a, b) => {
        if (settings.mode === 'faab' && b.bid !== a.bid) return b.bid - a.bid;
        return prio(a.teamId) - prio(b.teamId) || tieKey(a).localeCompare(tieKey(b));
      });
      winners.push(contenders[0]);
    }
    // Apply in priority order so priority updates are deterministic.
    winners.sort((a, b) => prio(a.teamId) - prio(b.teamId));
    for (const w of winners) {
      const t = state.get(w.teamId)!;
      awarded.add(w.addPlayerId);
      if (w.groupId) wonGroups.add(`${w.teamId}:${w.groupId}`);
      if (w.dropPlayerId) { t.rosterPlayerIds.delete(w.dropPlayerId); } else { t.activeRosterCount++; }
      t.rosterPlayerIds.add(w.addPlayerId);
      if (settings.mode === 'faab') t.faabRemaining -= w.bid;
      const contested = (byPlayer.get(w.addPlayerId)?.length ?? 1) > 1;
      const how = settings.mode === 'faab'
        ? (contested ? `Highest bid ($${w.bid})` : `Uncontested claim ($${w.bid})`)
        : (contested ? `Best waiver priority (#${prio(w.teamId) + 1})` : 'Uncontested claim');
      finish(w, 'won', how);
      if (settings.mode !== 'faab') order = [...order.filter((x) => x !== w.teamId), w.teamId];
    }
    // Losers on awarded players
    for (const c of [...pending.values()]) {
      if (awarded.has(c.addPlayerId)) {
        const winner = [...outcomes.values()].find((o) => o.status === 'won' && claims.find((x) => x.id === o.claimId)?.addPlayerId === c.addPlayerId);
        const reason = settings.mode === 'faab'
          ? `Outbid${winner ? ` (winning bid $${winner.bid})` : ''} or lower priority on a tie`
          : 'Another team had better waiver priority';
        finish(c, 'lost', reason);
      }
    }
  }
  for (const c of pending.values()) finish(c, 'invalid', 'Could not be processed.');

  const faab: Record<string, number> = {};
  for (const [id, t] of state) faab[id] = t.faabRemaining;
  return { outcomes: claims.map((c) => outcomes.get(c.id)!), priorityOrder: order, faab };
}

/** Reverse-standings priority: worst record first. `standingsOrder` is best → worst. */
export function reverseStandingsPriority(standingsOrder: string[]): string[] {
  return [...standingsOrder].reverse();
}

/** Next processing instant strictly after `from`, for a weekly schedule in UTC. */
export function nextWaiverRun(from: Date, processDay: number, processHourUtc: number): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), processHourUtc, 0, 0));
  let delta = (processDay - d.getUTCDay() + 7) % 7;
  if (delta === 0 && d.getTime() <= from.getTime()) delta = 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d;
}
