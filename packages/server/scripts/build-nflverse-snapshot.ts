/**
 * Downloads nflverse CSVs and writes a normalized snapshot JSON for the offline HTML app.
 *   npx tsx scripts/build-nflverse-snapshot.ts <season> <out.json> [csvDir]
 * With csvDir, reads previously downloaded files instead of fetching.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { buildNflverseDataset, NFLVERSE_BASE } from '../src/providers/nflverse';

// The NFL season named for year Y runs September Y – February Y+1.
const today = new Date();
const season = Number(process.argv[2] || (today.getUTCMonth() < 7 ? today.getUTCFullYear() - 1 : today.getUTCFullYear()));
const out = process.argv[3] ?? 'nfl-snapshot.json';
const dir = process.argv[4];
const files: Record<string, string> = {
  players: 'players/players.csv', games: 'schedules/games.csv',
  playerStats: `stats_player/stats_player_week_${season}.csv`, teamStats: `stats_team/stats_team_week_${season}.csv`,
  injuries: `injuries/injuries_${season}.csv`, priorSeasonStats: `stats_player/stats_player_week_${season - 1}.csv`,
};
const text: Record<string, string> = {};
for (const [k, path] of Object.entries(files)) {
  const local = dir ? `${dir}/${path.split('/').pop()}` : null;
  if (local && existsSync(local)) { text[k] = readFileSync(local, 'utf8'); continue; }
  const res = await fetch(`${NFLVERSE_BASE}/${path}`);
  if (!res.ok) { if (k === 'injuries' || k === 'priorSeasonStats') continue; throw new Error(`HTTP ${res.status} for ${path}`); }
  text[k] = await res.text();
}
const ds = buildNflverseDataset({ season, ...(text as any), asOf: new Date().toISOString() });
// Compact: drop zero fields and shorten JSON.
writeFileSync(out, JSON.stringify(ds));
const final = ds.games.filter((g) => g.status === 'final').length;
console.log(`snapshot: ${ds.players.length} players, ${ds.games.length} games (${final} final), ${ds.stats.length} stat lines → ${out}`);
