import type { ScoringRules } from './settings';
import { STAT_KEYS, STAT_LABELS, type Position, type StatKey, type StatLine } from './types';

export interface ScoreLine { key: string; label: string; value: number; points: number }
export interface ScoreResult { total: number; lines: ScoreLine[] }

/** Round to hundredths without binary drift (e.g. 0.1 * 3 = 0.30000000000000004). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function tierPoints(tiers: ScoringRules['pointsAllowedTiers'], value: number): number {
  for (const t of tiers) {
    if (t.max === null || value <= t.max) return t.points;
  }
  return 0;
}

/** Stats that only count for team defenses. */
const DST_ONLY: ReadonlySet<StatKey> = new Set([
  'def_sack', 'def_int', 'def_fum_rec', 'def_td', 'st_td', 'def_safety', 'def_blk_kick', 'def_pts_allowed', 'def_yds_allowed',
]);

/**
 * Pure fantasy scoring. Authoritative scores are computed on the server with this
 * function; the browser only ever displays server results.
 */
export function scoreStatLine(stats: StatLine, rules: ScoringRules, position: Position): ScoreResult {
  const lines: ScoreLine[] = [];
  let totalHundredths = 0;
  const add = (key: string, label: string, value: number, points: number) => {
    const p = round2(points);
    if (p === 0 && value === 0) return;
    lines.push({ key, label, value, points: p });
    totalHundredths += Math.round(p * 100);
  };

  for (const key of STAT_KEYS) {
    const raw = stats[key];
    if (raw === undefined || raw === null || Number.isNaN(raw)) continue;
    if (key === 'def_pts_allowed' || key === 'def_yds_allowed') continue; // tiered below
    const isDst = position === 'DST';
    if (DST_ONLY.has(key) !== isDst) continue; // offensive stats never score for DST and vice versa
    const per = rules.perStat[key] ?? 0;
    if (per === 0) continue;
    add(key, STAT_LABELS[key], raw, raw * per);
  }

  if (position === 'DST') {
    if (stats.def_pts_allowed !== undefined) {
      add('def_pts_allowed', STAT_LABELS.def_pts_allowed, stats.def_pts_allowed, tierPoints(rules.pointsAllowedTiers, stats.def_pts_allowed));
    }
    if (stats.def_yds_allowed !== undefined && rules.yardsAllowedTiers.length > 0) {
      add('def_yds_allowed', STAT_LABELS.def_yds_allowed, stats.def_yds_allowed, tierPoints(rules.yardsAllowedTiers, stats.def_yds_allowed));
    }
  }

  for (const b of rules.bonuses) {
    const v = stats[b.stat];
    if (v === undefined) continue;
    const hit = b.comparator === 'lte' ? v <= b.threshold : v >= b.threshold;
    if (hit) add(`bonus:${b.id}`, b.label, v, b.points);
  }

  return { total: totalHundredths / 100, lines };
}

/** Merge stat lines (e.g. a player appearing in two games in one week — rare, but possible across a provider correction). */
export function sumStatLines(lines: StatLine[]): StatLine {
  const out: StatLine = {};
  for (const l of lines) {
    for (const [k, v] of Object.entries(l) as [StatKey, number][]) out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

/**
 * Deterministic content hash for a stat line. The sync pipeline compares hashes to
 * skip duplicate deliveries and to detect provider corrections.
 */
export function statHash(stats: StatLine, isFinal: boolean): string {
  const keys = Object.keys(stats).sort() as StatKey[];
  const s = keys.map((k) => `${k}=${stats[k]}`).join('&') + `|${isFinal ? 'F' : 'P'}`;
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + ':' + s.length;
}
