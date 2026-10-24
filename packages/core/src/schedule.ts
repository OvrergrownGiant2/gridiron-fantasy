/** Fantasy matchup scheduling: round robin, double headers and playoff brackets. */

export interface ScheduledMatchup { week: number; homeTeamId: string; awayTeamId: string | null }

/**
 * Circle-method round robin. With an odd team count a "bye" (null) is inserted.
 * Repeats rotations until `weeks` are filled.
 */
export function roundRobin(teamIds: string[], weeks: number, startWeek = 1): ScheduledMatchup[] {
  if (teamIds.length < 2) return [];
  const teams: (string | null)[] = [...teamIds];
  if (teams.length % 2 === 1) teams.push(null);
  const n = teams.length;
  const rounds: [string | null, string | null][][] = [];
  const arr = [...teams];
  for (let r = 0; r < n - 1; r++) {
    const pairs: [string | null, string | null][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      // alternate home/away for fairness
      pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    // rotate all but the first
    arr.splice(1, 0, arr.pop()!);
  }
  const out: ScheduledMatchup[] = [];
  for (let w = 0; w < weeks; w++) {
    for (const [a, b] of rounds[w % rounds.length]) {
      if (a === null && b === null) continue;
      const home = (a ?? b)!;
      const away = a === null || b === null ? null : b;
      out.push({ week: startWeek + w, homeTeamId: home, awayTeamId: away });
    }
  }
  return out;
}

/** Double headers: each week every team plays two different opponents. */
export function doubleHeaderSchedule(teamIds: string[], weeks: number, startWeek = 1): ScheduledMatchup[] {
  const single = roundRobin(teamIds, weeks * 2, startWeek);
  // Compress pairs of rounds into single weeks.
  return single.map((m) => ({ ...m, week: startWeek + Math.floor((m.week - startWeek) / 2) }));
}

export interface BracketGame { round: number; slot: number; seedA: number | null; seedB: number | null; feederA?: string; feederB?: string }

/**
 * Single-elimination bracket with byes for top seeds when the field is not a power of two.
 * Seeds are 1-based. Returns round-1 pairings; later rounds are created from results.
 */
export function playoffFirstRound(playoffTeams: number): { pairs: [number, number | null][]; rounds: number } {
  if (playoffTeams < 2) return { pairs: [], rounds: 0 };
  const rounds = Math.ceil(Math.log2(playoffTeams));
  const size = 2 ** rounds;
  const order = seedOrder(size);
  const pairs: [number, number | null][] = [];
  for (let i = 0; i < size; i += 2) {
    const a = order[i], b = order[i + 1];
    const ra = a <= playoffTeams ? a : null;
    const rb = b <= playoffTeams ? b : null;
    if (ra === null && rb === null) continue;
    if (ra === null) pairs.push([rb!, null]);
    else if (rb === null) pairs.push([ra, null]);
    else pairs.push(ra < rb ? [ra, rb] : [rb, ra]);
  }
  return { pairs, rounds };
}

/** Standard bracket seeding order, e.g. size 8 → 1,8,4,5,2,7,3,6. */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}
