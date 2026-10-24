// Downloads every player's headshot (from the NFL's image CDN, via nflverse URLs) into
// packages/web/public-demo/headshots/<id>.jpg so the website serves the photos itself.
// Already-downloaded photos are skipped. Writes headshots/report.json with the results.
//   node scripts/fetch-headshots.mjs [snapshot.json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const snap = JSON.parse(readFileSync(process.argv[2] ?? 'packages/web/public-demo/nfl-snapshot.json', 'utf8'));
const dir = 'packages/web/public-demo/headshots';
mkdirSync(dir, { recursive: true });
const urls = [...new Set(snap.players.map((p) => p.profile?.headshot).filter(Boolean))];
// Ask the CDN for a small square crop around the face; fall back to the original image.
const small = (u) => u.replace(/\/image\/upload\/[^/]*\//, '/image/upload/c_fill,g_face,w_192,h_192,f_jpg,q_auto/');
const report = { total: urls.length, cached: 0, downloaded: 0, failed: 0, bytes: 0, errors: {} };

async function get(u) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await fetch(u, { signal: ctl.signal, headers: { 'user-agent': 'gridiron-fantasy-build' } });
    const type = r.headers.get('content-type') ?? '';
    if (!r.ok || !type.startsWith('image/')) throw new Error(`HTTP ${r.status} ${type}`);
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(t); }
}

let next = 0;
async function worker() {
  while (next < urls.length) {
    const u = urls[next++];
    const id = u.split('?')[0].split('/').pop();
    const file = `${dir}/${id}.jpg`;
    if (existsSync(file)) { report.cached++; continue; }
    try {
      let buf;
      try { buf = await get(small(u)); } catch { buf = await get(u.replace('f_auto', 'f_jpg')); }
      writeFileSync(file, buf);
      report.downloaded++; report.bytes += buf.length;
    } catch (e) {
      report.failed++;
      const k = String(e.message).slice(0, 60);
      report.errors[k] = (report.errors[k] ?? 0) + 1;
    }
  }
}
await Promise.all(Array.from({ length: 12 }, worker));
report.at = new Date().toISOString();
writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
console.log(`headshots: ${report.total} players, ${report.cached} cached, ${report.downloaded} downloaded (${Math.round(report.bytes / 1024)} KB), ${report.failed} failed`, report.errors);
