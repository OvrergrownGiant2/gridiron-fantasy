import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Loads the repository-root .env (if present) without overriding real environment variables. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
for (const file of [path.join(process.cwd(), '.env'), path.join(root, '.env')]) {
  if (existsSync(file)) { try { process.loadEnvFile(file); } catch { /* ignore malformed */ } break; }
}
