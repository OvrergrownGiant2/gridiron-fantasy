// Prints the `files` map for publishing artifact-build/ (every file except the page itself).
// Usage: node scripts/artifact-manifest.mjs [previously-published paths...]
// Paths passed as arguments that no longer exist in the build are mapped to null (removed).
import { readdirSync, statSync } from 'node:fs';
const root = 'artifact-build';
const walk = (d) => readdirSync(`${root}/${d}`).flatMap((f) => {
  const p = d ? `${d}/${f}` : f;
  return statSync(`${root}/${p}`).isDirectory() ? walk(p) : [p];
});
const files = Object.fromEntries(walk('').filter((p) => p !== 'index.html').map((p) => [p, p]));
for (const old of process.argv.slice(2)) if (old !== 'index.html' && !(old in files)) files[old] = null;
console.log(JSON.stringify(files, null, 2));
