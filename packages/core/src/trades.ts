import type { TradeSettings } from './settings';
import type { InjuryStatus, Position } from './types';

export interface TradeAsset {
  fromTeamId: string;
  toTeamId: string;
  type: 'player' | 'faab' | 'draft_pick';
  playerId?: string | null;
  faabAmount?: number | null;
  draftRound?: number | null;
  draftSeason?: number | null;
}

export interface TradePlayerInfo {
  id: string;
  name: string;
  position: Position;
  teamId: string;               // fantasy team that currently rosters the player
  weeklyProjection: number;
  value: number;
  injuryStatus: InjuryStatus;
  byeWeek: number | null;
  locked: boolean;
  isStarter: boolean;
}

export interface TradeCheck { ok: boolean; code: string; message: string }

/** Structural validation of a proposal. Roster space is checked separately. */
export function validateTradeAssets(opts: {
  assets: TradeAsset[];
  teamA: string;
  teamB: string;
  settings: TradeSettings;
  ownerOf: (playerId: string) => string | null;
  faabRemaining: Record<string, number>;
  week: number;
  tradeWindowOpen: boolean;
}): TradeCheck[] {
  const { assets, teamA, teamB, settings } = opts;
  const out: TradeCheck[] = [];
  const fail = (code: string, message: string) => out.push({ ok: false, code, message });
  if (teamA === teamB) fail('same_team', 'A team cannot trade with itself.');
  if (assets.length === 0) fail('empty', 'A trade must include at least one asset.');
  const sides = new Set(assets.map((a) => `${a.fromTeamId}>${a.toTeamId}`));
  for (const s of sides) {
    if (s !== `${teamA}>${teamB}` && s !== `${teamB}>${teamA}`) fail('third_party', 'Assets must move between the two teams in the trade.');
  }
  if (!assets.some((a) => a.fromTeamId === teamA) || !assets.some((a) => a.fromTeamId === teamB)) {
    // One-sided "gifts" are allowed by some leagues, but they are a classic collusion pattern; require both sides.
    fail('one_sided', 'Both teams must send at least one asset.');
  }
  const seen = new Set<string>();
  const faabOut: Record<string, number> = {};
  for (const a of assets) {
    if (a.type === 'player') {
      if (!a.playerId) { fail('bad_asset', 'Player asset is missing a player.'); continue; }
      if (seen.has(a.playerId)) fail('duplicate_player', 'A player appears twice in the trade.');
      seen.add(a.playerId);
      const owner = opts.ownerOf(a.playerId);
      if (owner !== a.fromTeamId) fail('not_owned', 'A player in this trade is no longer on the sending team.');
    } else if (a.type === 'faab') {
      if (!settings.allowFaab) fail('faab_disabled', 'FAAB cannot be traded in this league.');
      const amt = a.faabAmount ?? 0;
      if (!Number.isInteger(amt) || amt <= 0) fail('bad_faab', 'FAAB amounts must be positive whole numbers.');
      faabOut[a.fromTeamId] = (faabOut[a.fromTeamId] ?? 0) + amt;
    } else if (a.type === 'draft_pick') {
      if (!settings.allowDraftPicks) fail('picks_disabled', 'Draft picks cannot be traded in this league.');
      if (!a.draftRound || a.draftRound < 1 || !a.draftSeason) fail('bad_pick', 'Draft pick needs a season and round.');
    }
  }
  for (const [team, amt] of Object.entries(faabOut)) {
    if (amt > (opts.faabRemaining[team] ?? 0)) fail('faab_insufficient', 'A team is sending more FAAB than it has.');
  }
  if (settings.tradeDeadlineWeek > 0 && opts.week > settings.tradeDeadlineWeek) {
    fail('deadline', `The trade deadline (after week ${settings.tradeDeadlineWeek}) has passed.`);
  }
  if (!opts.tradeWindowOpen) fail('window_closed', 'Trades are closed for this league right now.');
  return out;
}

// ---------------------------------------------------------------------------
// Analysis (advisory unless the league requires it)
// ---------------------------------------------------------------------------

export interface TradeSideAnalysis {
  teamId: string;
  receives: string[];
  sends: string[];
  valueIn: number;
  valueOut: number;
  weeklyPointsChange: number;
  horizonPointsChange: number;
  injuryRisks: string[];
  byeConflicts: string[];
  needsAddressed: string[];
  needsCreated: string[];
}

export interface TradeAnalysis {
  horizonWeeks: number;
  sides: [TradeSideAnalysis, TradeSideAnalysis];
  valueGap: number;      // 0..1, relative difference in value exchanged
  summary: string;
  disclaimer: string;
}

export function analyzeTrade(opts: {
  teamA: string; teamB: string;
  players: TradePlayerInfo[];          // all players involved
  assets: TradeAsset[];
  horizonWeeks: number;
  teamNeeds: Record<string, Position[]>; // positions each team is weakest at
  starterByes: Record<string, number[]>; // bye weeks already occupied by each team's starters
}): TradeAnalysis {
  const byId = new Map(opts.players.map((p) => [p.id, p]));
  const sideFor = (teamId: string): TradeSideAnalysis => {
    const incoming = opts.assets.filter((a) => a.toTeamId === teamId);
    const outgoing = opts.assets.filter((a) => a.fromTeamId === teamId);
    const val = (list: TradeAsset[]) => list.reduce((s, a) => {
      if (a.type === 'player') return s + (byId.get(a.playerId!)?.value ?? 0);
      if (a.type === 'faab') return s + (a.faabAmount ?? 0) * 0.5;
      if (a.type === 'draft_pick') return s + Math.max(5, 60 - (a.draftRound! - 1) * 8);
      return s;
    }, 0);
    const wk = (list: TradeAsset[]) => list.reduce((s, a) => s + (a.type === 'player' ? byId.get(a.playerId!)?.weeklyProjection ?? 0 : 0), 0);
    const inPlayers = incoming.filter((a) => a.type === 'player').map((a) => byId.get(a.playerId!)!).filter(Boolean);
    const outPlayers = outgoing.filter((a) => a.type === 'player').map((a) => byId.get(a.playerId!)!).filter(Boolean);
    const injuryRisks = inPlayers.filter((p) => p.injuryStatus !== 'healthy').map((p) => `${p.name} is listed ${p.injuryStatus}`);
    const byes = opts.starterByes[teamId] ?? [];
    const byeConflicts = inPlayers.filter((p) => p.byeWeek && byes.includes(p.byeWeek)).map((p) => `${p.name}'s bye (week ${p.byeWeek}) overlaps existing starters`);
    const needs = opts.teamNeeds[teamId] ?? [];
    const needsAddressed = [...new Set(inPlayers.filter((p) => needs.includes(p.position)).map((p) => p.position))];
    const needsCreated = [...new Set(outPlayers.filter((p) => p.isStarter && !inPlayers.some((q) => q.position === p.position)).map((p) => p.position))];
    const weeklyChange = Math.round((wk(incoming) - wk(outgoing)) * 10) / 10;
    const label = (a: TradeAsset) => a.type === 'player' ? byId.get(a.playerId!)?.name ?? 'Player'
      : a.type === 'faab' ? `$${a.faabAmount} FAAB` : `${a.draftSeason} round ${a.draftRound} pick`;
    return {
      teamId, receives: incoming.map(label), sends: outgoing.map(label),
      valueIn: Math.round(val(incoming) * 10) / 10, valueOut: Math.round(val(outgoing) * 10) / 10,
      weeklyPointsChange: weeklyChange,
      horizonPointsChange: Math.round(weeklyChange * opts.horizonWeeks * 10) / 10,
      injuryRisks, byeConflicts, needsAddressed, needsCreated,
    };
  };
  const a = sideFor(opts.teamA);
  const b = sideFor(opts.teamB);
  const big = Math.max(a.valueIn, b.valueIn, 1);
  const valueGap = Math.round((Math.abs(a.valueIn - b.valueIn) / big) * 100) / 100;
  const leader = a.valueIn >= b.valueIn ? a : b;
  const summary = valueGap < 0.12
    ? 'Estimated value is roughly balanced.'
    : `Estimated value favors the team receiving ${leader.receives.join(', ')} by about ${Math.round(valueGap * 100)}%.`;
  return {
    horizonWeeks: opts.horizonWeeks, sides: [a, b], valueGap, summary,
    disclaimer: 'Values are model estimates from projections and positional scarcity, not facts. Managers may have valid strategic reasons for any trade.',
  };
}

// ---------------------------------------------------------------------------
// Review routing and integrity flags
// ---------------------------------------------------------------------------

export interface TradeFlag { code: string; severity: 'info' | 'review'; message: string }

export function integrityFlags(opts: {
  analysis: TradeAnalysis | null;
  priorTradesBetweenPair30d: number;
  newestMemberDays: number;
  starterShareSentA: number;   // fraction of team A's starters being sent away
  starterShareSentB: number;
  eliminatedTeamSendsTopPlayer: boolean;
  duplicateOfOpenTrade: boolean;
}): TradeFlag[] {
  const f: TradeFlag[] = [];
  if (opts.duplicateOfOpenTrade) f.push({ code: 'duplicate', severity: 'review', message: 'An identical trade between these teams is already open.' });
  if (opts.analysis && opts.analysis.valueGap >= 0.5) {
    f.push({ code: 'imbalance', severity: 'review', message: `Large estimated value gap (${Math.round(opts.analysis.valueGap * 100)}%). Unbalanced trades are allowed; this only asks for a human look.` });
  }
  if (opts.priorTradesBetweenPair30d >= 2) f.push({ code: 'repeat_partners', severity: 'review', message: `These teams have completed ${opts.priorTradesBetweenPair30d} trades in the last 30 days.` });
  if (opts.newestMemberDays < 3) f.push({ code: 'new_member', severity: 'info', message: 'One manager joined the league in the last 3 days.' });
  if (opts.starterShareSentA >= 0.5 || opts.starterShareSentB >= 0.5) f.push({ code: 'roster_gutting', severity: 'review', message: 'A team would send away half or more of its starting lineup.' });
  if (opts.eliminatedTeamSendsTopPlayer) f.push({ code: 'eliminated_dump', severity: 'review', message: 'A team eliminated from playoff contention is sending away a top player.' });
  return f;
}

export const FLAG_DISCLAIMER = 'Flags are signals for human review. They do not prove collusion or reveal any manager’s intent.';

export type ReviewRoute = 'auto' | 'commissioner' | 'league_vote';

export function reviewRoute(settings: TradeSettings, analysis: TradeAnalysis | null, playerCount: number, flags: TradeFlag[]): { route: ReviewRoute; reason: string } {
  switch (settings.review) {
    case 'auto': return { route: 'auto', reason: 'League setting: trades process automatically once both managers accept.' };
    case 'commissioner': return { route: 'commissioner', reason: 'League setting: the commissioner approves every trade.' };
    case 'league_vote': return { route: 'league_vote', reason: `League setting: managers vote; ${Math.round(settings.vetoThreshold * 100)}% veto votes block the trade.` };
    case 'hybrid': {
      const reasons: string[] = [];
      if (analysis && analysis.valueGap > settings.hybridValueGap) reasons.push(`estimated value gap ${Math.round(analysis.valueGap * 100)}% exceeds ${Math.round(settings.hybridValueGap * 100)}%`);
      if (playerCount > settings.hybridMaxAutoPlayers) reasons.push(`${playerCount} players exceeds the auto-approve limit of ${settings.hybridMaxAutoPlayers}`);
      if (flags.some((x) => x.severity === 'review')) reasons.push('integrity flags raised');
      if (settings.analysisMode === 'required' && !analysis) reasons.push('analysis unavailable');
      return reasons.length
        ? { route: 'commissioner', reason: `Hybrid review: sent to commissioner because ${reasons.join('; ')}.` }
        : { route: 'auto', reason: 'Hybrid review: within auto-approve limits.' };
    }
  }
}

export interface VoteTally { approve: number; veto: number; eligible: number }
export function decideVote(t: VoteTally, vetoThreshold: number, closed: boolean): 'approved' | 'vetoed' | 'pending' {
  const needed = Math.max(1, Math.ceil(vetoThreshold * t.eligible));
  if (t.veto >= needed) return 'vetoed';
  const outstanding = t.eligible - t.approve - t.veto;
  if (t.veto + outstanding < needed) return 'approved'; // veto is mathematically impossible
  return closed ? 'approved' : 'pending';
}
