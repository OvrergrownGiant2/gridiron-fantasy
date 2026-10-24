import type { SeasonSettings } from './settings';

export interface FinalMatchup {
  week: number;
  homeTeamId: string;
  awayTeamId: string | null;
  homePoints: number;
  awayPoints: number;
  kind: 'regular' | 'playoff' | 'consolation' | 'championship';
}

export interface StandingRow {
  teamId: string;
  rank: number;
  wins: number; losses: number; ties: number;
  pointsFor: number; pointsAgainst: number;
  streak: string;              // e.g. "W3", "L1", "-"
  winPct: number;
  playoffStatus: 'clinched' | 'in_position' | 'alive' | 'eliminated' | 'none';
  tieBreakNote: string | null;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

/**
 * Pure standings computation from finalized regular-season matchups. Because it is
 * derived (never incrementally mutated), score corrections automatically flow
 * into standings the next time they are computed.
 */
export function computeStandings(opts: {
  teamIds: string[];
  matchups: FinalMatchup[];
  settings: Pick<SeasonSettings, 'standingsMode' | 'tieBreakers' | 'playoffTeams' | 'regularSeasonWeeks'>;
  weeksCompleted: number;
  leagueSeed: string;            // deterministic coin flip
}): StandingRow[] {
  const { teamIds, settings } = opts;
  const reg = opts.matchups.filter((m) => m.kind === 'regular');
  const rows = new Map<string, StandingRow & { results: { week: number; r: 'W' | 'L' | 'T' }[] }>();
  for (const id of teamIds) rows.set(id, { teamId: id, rank: 0, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, streak: '-', winPct: 0, playoffStatus: 'none', tieBreakNote: null, results: [] });
  const h2h = new Map<string, number>(); // "a|b" → wins of a over b

  for (const m of reg) {
    const home = rows.get(m.homeTeamId);
    if (!home) continue;
    home.pointsFor += m.homePoints;
    if (m.awayTeamId === null) continue; // bye week: points count, no result
    const away = rows.get(m.awayTeamId);
    if (!away) continue;
    away.pointsFor += m.awayPoints;
    home.pointsAgainst += m.awayPoints;
    away.pointsAgainst += m.homePoints;
    if (settings.standingsMode === 'head_to_head') {
      if (m.homePoints > m.awayPoints) { home.wins++; away.losses++; home.results.push({ week: m.week, r: 'W' }); away.results.push({ week: m.week, r: 'L' }); h2h.set(`${home.teamId}|${away.teamId}`, (h2h.get(`${home.teamId}|${away.teamId}`) ?? 0) + 1); }
      else if (m.homePoints < m.awayPoints) { away.wins++; home.losses++; home.results.push({ week: m.week, r: 'L' }); away.results.push({ week: m.week, r: 'W' }); h2h.set(`${away.teamId}|${home.teamId}`, (h2h.get(`${away.teamId}|${home.teamId}`) ?? 0) + 1); }
      else { home.ties++; away.ties++; home.results.push({ week: m.week, r: 'T' }); away.results.push({ week: m.week, r: 'T' }); }
    }
  }

  for (const r of rows.values()) {
    r.pointsFor = Math.round(r.pointsFor * 100) / 100;
    r.pointsAgainst = Math.round(r.pointsAgainst * 100) / 100;
    const g = r.wins + r.losses + r.ties;
    r.winPct = g ? (r.wins + r.ties / 2) / g : 0;
    const res = r.results.sort((a, b) => a.week - b.week);
    if (res.length) {
      const last = res[res.length - 1].r;
      let n = 0;
      for (let i = res.length - 1; i >= 0 && res[i].r === last; i--) n++;
      r.streak = `${last}${n}`;
    }
  }

  const list = [...rows.values()];
  const notes = new Map<string, string>();
  const cmp = (a: StandingRow, b: StandingRow): number => {
    if (settings.standingsMode === 'total_points') {
      if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
    } else if (b.winPct !== a.winPct) return b.winPct - a.winPct;
    for (const tb of settings.tieBreakers) {
      let d = 0;
      if (tb === 'points_for') d = b.pointsFor - a.pointsFor;
      else if (tb === 'points_against_low') d = a.pointsAgainst - b.pointsAgainst;
      else if (tb === 'head_to_head') d = (h2h.get(`${b.teamId}|${a.teamId}`) ?? 0) - (h2h.get(`${a.teamId}|${b.teamId}`) ?? 0);
      else if (tb === 'coin_flip') d = hash(opts.leagueSeed + a.teamId) - hash(opts.leagueSeed + b.teamId);
      if (d !== 0) {
        const label = { points_for: 'points for', points_against_low: 'fewer points against', head_to_head: 'head-to-head', coin_flip: 'coin flip' }[tb];
        const winner = d < 0 ? a : b;
        notes.set(winner.teamId, `Tiebreak: ${label}`);
        return d;
      }
    }
    return a.teamId.localeCompare(b.teamId);
  };
  list.sort(cmp);
  // Only keep notes where the record was actually tied with a neighbor.
  list.forEach((r, i) => {
    r.rank = i + 1;
    const tiedNeighbor = [list[i - 1], list[i + 1]].some((n) => n && (settings.standingsMode === 'total_points' ? n.pointsFor === r.pointsFor : n.winPct === r.winPct));
    r.tieBreakNote = tiedNeighbor ? notes.get(r.teamId) ?? null : null;
  });

  // Playoff status (head-to-head only; total-points leagues show position only).
  const P = settings.playoffTeams;
  const remaining = Math.max(0, settings.regularSeasonWeeks - opts.weeksCompleted);
  if (P > 0) {
    for (const r of list) {
      if (settings.standingsMode === 'total_points') { r.playoffStatus = r.rank <= P ? 'in_position' : 'alive'; continue; }
      const maxWins = r.wins + remaining;
      // Eliminated: at least P teams already have more wins than this team can reach.
      const ahead = list.filter((o) => o.teamId !== r.teamId && o.wins > maxWins).length;
      // Clinched: fewer than P other teams can still reach this team's current wins.
      const canCatch = list.filter((o) => o.teamId !== r.teamId && o.wins + remaining >= r.wins).length;
      if (ahead >= P) r.playoffStatus = 'eliminated';
      else if (canCatch < P) r.playoffStatus = 'clinched';
      else r.playoffStatus = r.rank <= P ? 'in_position' : 'alive';
    }
  }
  return list.map(({ results: _r, ...rest }) => rest);
}
