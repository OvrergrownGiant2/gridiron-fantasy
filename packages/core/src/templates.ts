import { defaultLeagueSettings, playoffRounds, type LeagueSettings } from './settings';
import type { AiDifficulty } from './types';

/** Quick-start league templates. Each returns settings that pass validateLeagueSettings. */
export type LeagueTemplateId = 'solo' | 'duel' | 'league';

export interface TemplateOptions {
  /** NFL week the season would start in (the server moves it later if that week has begun). */
  currentWeek: number;
  scoring: 'ppr' | 'half_ppr' | 'standard';
  /** duel: who you play against. */
  opponent?: 'ai' | 'friend';
  /** league: total teams, 3–10. */
  teamCount?: number;
  /** league: fill seats nobody has taken with AI managers right away. */
  fillWithAi?: boolean;
  difficulty?: AiDifficulty;
}

export interface TemplateResult {
  teamCount: number;
  aiTeams: number;
  settings: LeagueSettings;
  scoringPreset: 'ppr' | 'half_ppr' | 'standard';
  /** True when every opponent is an AI, so rosters can be drafted automatically right away. */
  canStartImmediately: boolean;
  summary: string[];
}

export const TEMPLATE_INFO: Record<LeagueTemplateId, { title: string; tagline: string; defaultName: string }> = {
  solo: { title: 'High Score Challenge', tagline: 'Just you. Build a roster and chase the highest weekly totals.', defaultName: 'High Score Challenge' },
  duel: { title: 'Head-to-Head Duel', tagline: 'You against one rival, every week.', defaultName: 'The Duel' },
  league: { title: 'League', tagline: '3 to 10 teams with standings, playoffs, waivers and trades.', defaultName: 'Sunday League' },
};

/** Fit the regular season (and playoffs, if any) between `start` and NFL week 18. */
function fitSeason(s: LeagueSettings, start: number, wantWeeks: number, wantPlayoffs: number) {
  const startWeek = Math.min(18, Math.max(1, start));
  let playoffTeams = wantPlayoffs;
  let weeks = Math.min(wantWeeks, 18 - startWeek + 1 - playoffRounds(playoffTeams));
  if (weeks < 3 && playoffTeams > 0) { playoffTeams = 0; weeks = Math.min(wantWeeks, 18 - startWeek + 1); }
  weeks = Math.max(1, weeks);
  s.season.startWeek = startWeek;
  s.season.regularSeasonWeeks = weeks;
  s.season.playoffTeams = playoffTeams;
  const regEnd = startWeek + weeks - 1;
  s.trades.tradeDeadlineWeek = weeks >= 3 ? Math.min(regEnd, startWeek + Math.floor(weeks * 0.7)) : 0;
}

export function buildTemplate(id: LeagueTemplateId, o: TemplateOptions): TemplateResult {
  const s = defaultLeagueSettings();
  const difficulty = o.difficulty ?? 'medium';
  s.draft = { ...s.draft, type: 'snake', pickSeconds: 90, orderMode: 'random' };

  if (id === 'solo') {
    s.season.standingsMode = 'total_points';
    s.season.tieBreakers = ['points_for'];
    fitSeason(s, o.currentWeek, 17, 0);
    s.trades = { ...s.trades, review: 'auto', tradeDeadlineWeek: 0, analysisMode: 'off' };
    s.waivers = { ...s.waivers, mode: 'rolling', waiverPeriodHours: 0, continuous: false };
    s.draft = { ...s.draft, type: 'linear', pickSeconds: 3600 };
    return {
      teamCount: 1, aiTeams: 0, settings: s, scoringPreset: o.scoring, canStartImmediately: true,
      summary: [`${s.season.regularSeasonWeeks} scoring weeks`, 'Ranked by total points', 'Instant free-agent pickups', 'No trades or playoffs'],
    };
  }

  if (id === 'duel') {
    const ai = (o.opponent ?? 'ai') === 'ai';
    s.season.standingsMode = 'head_to_head';
    s.season.tieBreakers = ['points_for', 'coin_flip'];
    fitSeason(s, o.currentWeek, 14, 0);
    s.trades = { ...s.trades, review: 'auto', analysisMode: 'advisory' };
    s.waivers = { ...s.waivers, mode: 'rolling', waiverPeriodHours: 24 };
    return {
      teamCount: 2, aiTeams: ai ? 1 : 0, settings: s, scoringPreset: o.scoring, canStartImmediately: ai,
      summary: [`${s.season.regularSeasonWeeks} weekly matchups`, 'Best record wins (points break ties)', 'Rolling waivers', ai ? `AI opponent (${difficulty})` : 'Invite one friend with a code'],
    };
  }

  const n = Math.min(10, Math.max(3, o.teamCount ?? 8));
  const fill = Boolean(o.fillWithAi);
  const playoffs = n >= 6 ? 4 : n >= 4 ? 2 : 0;
  s.season.standingsMode = 'head_to_head';
  fitSeason(s, o.currentWeek, 14, playoffs);
  s.trades = { ...s.trades, review: fill ? 'auto' : 'hybrid', analysisMode: 'advisory' };
  s.waivers = { ...s.waivers, mode: 'faab', faabBudget: 100 };
  const p = s.season.playoffTeams;
  return {
    teamCount: n, aiTeams: fill ? n - 1 : 0, settings: s, scoringPreset: o.scoring, canStartImmediately: fill,
    summary: [
      `${n} teams · ${s.season.regularSeasonWeeks}-week regular season`,
      p ? `Top ${p} make the playoffs` : 'No playoffs (best record wins)',
      '$100 FAAB waivers',
      fill ? `AI managers fill the other ${n - 1} seats (${difficulty})` : 'Invite friends; add AI for empty seats before the draft',
    ],
  };
}
