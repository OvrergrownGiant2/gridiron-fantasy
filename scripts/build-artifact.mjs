// Converts the demo build into a page body suitable for hosting as a single page with sibling assets
// (no <html>/<head>/<body> wrapper; relative asset paths).
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
const src = 'packages/web/dist-demo';
const out = 'artifact-build';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(`${src}/assets`, `${out}/assets`, { recursive: true });
import { existsSync } from 'node:fs';
if (existsSync(`${src}/nfl-snapshot.json`)) cpSync(`${src}/nfl-snapshot.json`, `${out}/nfl-snapshot.json`);
// Artifact hosting serves only common web types: ship PGlite's filesystem bundle under a served extension.
import { readdirSync, renameSync } from 'node:fs';
const data = readdirSync(`${out}/assets`).find((f) => f.endsWith('.data'));
if (data) renameSync(`${out}/assets/${data}`, `${out}/assets/pglite-fs.woff2`);
const html = readFileSync(`${src}/index.html`, 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1].replace(/<meta charset[^>]*>/, '').replace(/<meta name="viewport"[^>]*>/, '');
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
writeFileSync(`${out}/index.html`, `${head.trim()}\n${body.trim()}\n`);
console.log('artifact page written to', out);
