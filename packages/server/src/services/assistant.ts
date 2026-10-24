import { STAT_LABELS, type Position } from '@gridiron/core';
import { badRequest, type Actor, type App } from '../app';
import { getLeague, getScoringRules, myTeam, requirePermission, requireUser } from './common';
import { dataStatus } from './nfl';
import { rosterRows, suggestLineup } from './rosters';
import { leagueStandings, matchupDetail, projectionsFor, type MatchupRow } from './scoring';

/**
 * Optional assistant. Core fantasy operations never depend on it. Every statement
 * is tagged so the UI can distinguish verified data, model projections, opinions
 * and missing information. When no AI provider is configured, the rule-based
 * insights below are returned instead and the UI says so.
 */

export type InsightKind = 'verified' | 'projection' | 'opinion' | 'missing';
export interface Insight { kind: InsightKind; title: string; detail: string }

export function assistantStatus(app: App) {
  return {
    aiAvailable: Boolean(app.config.aiProvider && app.fetch),
    provider: app.config.aiProvider ? 'Anthropic Claude' : null,
    message: app.config.aiProvider ? 'AI assistant is available.' : 'The AI assistant is not configured on this server. Rule-based insights are available instead.',
  };
}

export async function insights(app: App, actor: Actor, input: { leagueId: string }): Promise<{ insights: Insight[]; context: unknown }> {
  const userId = requireUser(actor);
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  const league = await getLeague(app.db, input.leagueId);
  const team = await myTeam(app.db, league.id, userId);
  const out: Insight[] = [];
  const status = await dataStatus(app);
  if (status.provider.snapshotAsOf) out.push({ kind: 'missing', title: 'Data snapshot', detail: `NFL players, schedules and stats are real nflverse data captured ${status.provider.snapshotAsOf.slice(0, 10)}. Games after that date have no results here.` });
  if (status.provider.isDemo) out.push({ kind: 'missing', title: 'Demo data', detail: 'All NFL players and stats in this app are simulated demo data, not real NFL information.' });
  else if (status.health !== 'ok') out.push({ kind: 'missing', title: 'Data freshness', detail: status.message });

  const { rules } = await getScoringRules(app.db, league.id);
  const notable = (['pass_td', 'rec', 'rush_td', 'pass_int', 'fum_lost'] as const).map((k) => `${STAT_LABELS[k]} ${rules.perStat[k] ?? 0}`).join(', ');
  out.push({ kind: 'verified', title: 'Your scoring rules', detail: `${rules.preset.replace('_', '-').toUpperCase()} scoring. Key values: ${notable}.${rules.bonuses.length ? ` ${rules.bonuses.length} custom bonus rule(s).` : ''}` });

  if (!team || league.status === 'setup' || league.status === 'drafting') {
    if (!team) out.push({ kind: 'missing', title: 'No team', detail: 'You do not manage a team in this league.' });
    else out.push({ kind: 'missing', title: 'Draft first', detail: 'Roster insights become available after the draft.' });
    return { insights: out, context: null };
  }

  const m = await app.db.one<MatchupRow>('SELECT * FROM matchups WHERE league_id = $1 AND week = $2 AND (home_team_id = $3 OR away_team_id = $3) LIMIT 1', [league.id, league.current_week, team.id]);
  let matchup: any = null;
  if (m) {
    matchup = await matchupDetail(app, app.db, league, m);
    const mine = m.home_team_id === team.id ? matchup.home : matchup.away;
    const opp = m.home_team_id === team.id ? matchup.away : matchup.home;
    if (opp) {
      out.push({ kind: 'verified', title: `Week ${m.week} score`, detail: `You have ${mine.points.toFixed(2)} points to ${opp.points.toFixed(2)}, with ${mine.yetToPlay + mine.activePlayers} of your starters still to finish.` });
      const wp = m.home_team_id === team.id ? matchup.winProbabilityHome : matchup.winProbabilityHome === null ? null : 1 - matchup.winProbabilityHome;
      out.push({ kind: 'projection', title: 'Projected finish', detail: `Model estimate: ${mine.projected.toFixed(1)} vs ${opp.projected.toFixed(1)}${wp !== null ? ` (about ${Math.round(wp * 100)}% to win)` : ''}. Estimates, not guarantees.` });
    }
  }
  const sugg = await suggestLineup(app, actor, { teamId: team.id });
  if (sugg.changes.length && sugg.projectedAfter > sugg.projectedBefore + 0.5) {
    const top = sugg.changes.filter((c) => c.to !== 'BN').slice(0, 3).map((c) => `${c.name} → ${c.to} (${c.reasons[0] ?? ''})`).join('; ');
    out.push({ kind: 'projection', title: 'Lineup suggestion', detail: `An optimized lineup projects ${sugg.projectedAfter} vs ${sugg.projectedBefore} now. ${top}. Review it on My Team before saving.` });
  } else out.push({ kind: 'projection', title: 'Lineup', detail: 'Your lineup already matches the highest projected eligible starters.' });

  const rows = await rosterRows(app.db, team.id);
  const proj = await projectionsFor(app.db, league, league.current_week, rows.map((r) => r.player_id));
  const out_ = rows.filter((r) => r.slot !== 'BN' && r.slot !== 'IR' && ['out', 'ir', 'doubtful', 'suspended'].includes(r.injury_status));
  for (const r of out_) out.push({ kind: 'verified', title: 'Injury in lineup', detail: `${r.full_name} (${r.slot}) is listed ${r.injury_status}.` });
  const byPos = new Map<Position, number[]>();
  for (const r of rows) byPos.set(r.position, [...(byPos.get(r.position) ?? []), proj.get(r.player_id)?.points ?? 0]);
  const weakest = (['QB', 'RB', 'WR', 'TE'] as Position[]).map((p) => ({ p, best: Math.max(0, ...(byPos.get(p) ?? [0])) })).sort((a, b) => a.best / ({ QB: 18, RB: 13, WR: 12, TE: 8 } as any)[a.p] - b.best / ({ QB: 18, RB: 13, WR: 12, TE: 8 } as any)[b.p])[0];
  if (weakest) out.push({ kind: 'opinion', title: 'Roster weakness', detail: `Relative to typical starters, ${weakest.p} looks like your thinnest position (best projection ${weakest.best.toFixed(1)}). Consider the waiver wire or a trade.` });

  const avail = await app.db.query<{ id: string; full_name: string; position: Position }>(`SELECT p.id, p.full_name, p.position FROM nfl_players p WHERE p.active AND p.position = $2
    AND NOT EXISTS (SELECT 1 FROM roster_entries r WHERE r.league_id = $1 AND r.player_id = p.id) ORDER BY p.rank LIMIT 15`, [league.id, weakest?.p ?? 'WR']);
  const ap = await projectionsFor(app.db, league, league.current_week, avail.map((a) => a.id));
  const best = avail.map((a) => ({ ...a, pts: ap.get(a.id)?.points ?? 0 })).sort((a, b) => b.pts - a.pts).slice(0, 3);
  if (best.length) out.push({ kind: 'projection', title: `Available ${weakest?.p ?? ''} options`, detail: best.map((b) => `${b.full_name} (${b.pts.toFixed(1)} proj.)`).join(', ') + '.' });

  const st = await leagueStandings(app.db, league);
  const me = st.find((s) => s.teamId === team.id);
  if (me) out.push({ kind: 'verified', title: 'Standings', detail: `Rank ${me.rank} of ${st.length}: ${me.wins}-${me.losses}${me.ties ? `-${me.ties}` : ''}, ${me.pointsFor.toFixed(2)} points for. Playoff status: ${me.playoffStatus.replace('_', ' ')}.` });
  if (league.settings.waivers.mode === 'faab') out.push({ kind: 'verified', title: 'FAAB', detail: `You have $${team.faab_remaining} of $${league.settings.waivers.faabBudget} remaining. Highest bid wins; ties go to waiver priority (you are #${team.waiver_priority}).` });
  else out.push({ kind: 'verified', title: 'Waiver priority', detail: `You are #${team.waiver_priority} in ${league.settings.waivers.mode.replace('_', ' ')} waiver priority. Winning a claim moves you to the back.` });

  return { insights: out, context: { league: { name: league.name, week: league.current_week, settings: league.settings, scoring: rules }, team: { name: team.name }, standings: st, matchup, roster: rows.map((r) => ({ name: r.full_name, position: r.position, slot: r.slot, injury: r.injury_status, projection: proj.get(r.player_id) })) } };
}

const SYSTEM_PROMPT = `You are the assistant inside a fantasy football app. Answer only from the JSON context provided.
Label every claim with one of: [Verified] for data in the context, [Projection] for model estimates, [Opinion] for your recommendations, [Missing] when the context lacks the information.
Never invent statistics, injuries, news or live scores. If the context says data is demo or stale, say so. Keep answers under 200 words.`;

export async function ask(app: App, actor: Actor, input: { leagueId: string; question: string }) {
  const q = String(input.question ?? '').trim().slice(0, 600);
  if (!q) throw badRequest('Ask a question.');
  const base = await insights(app, actor, input);
  const cfg = app.config.aiProvider;
  if (!cfg || !app.fetch) {
    return { mode: 'rule_based' as const, answer: null, insights: base.insights, notice: assistantStatus(app).message };
  }
  try {
    const res = await app.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model, max_tokens: 600, system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Context JSON:\n${JSON.stringify({ insights: base.insights, ...(base.context as object) }).slice(0, 60000)}\n\nQuestion: ${q}` }],
      }),
    });
    if (!res.ok) throw new Error(`AI provider returned HTTP ${res.status}`);
    const body = await res.json() as { content?: { type: string; text?: string }[] };
    const answer = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    return { mode: 'ai' as const, answer, insights: base.insights, notice: null };
  } catch (e) {
    app.log(`assistant error: ${(e as Error).message}`);
    return { mode: 'rule_based' as const, answer: null, insights: base.insights, notice: 'The AI assistant is temporarily unavailable. Showing rule-based insights instead.' };
  }
}
