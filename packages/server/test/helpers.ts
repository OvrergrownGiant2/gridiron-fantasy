import pg from 'pg';
import { createNodeApp } from '../src/node';
import type { App, Actor } from '../src/app';
import type { OffsetClock } from '../src/clock';
import { register } from '../src/services/auth';
import { runSync } from '../src/services/nfl';
import { createPgDb } from '../src/db/pg';
import { wrapPglite } from '../src/db/pglite';
import { TYPE_PARSERS } from '../src/db/db';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://gridiron:gridiron@localhost:5432/gridiron_test';

export async function resetDb() {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
}

export interface TestCtx { app: App; clock: OffsetClock }

export async function setupApp(at = '2026-09-01T12:00:00Z'): Promise<TestCtx> {
  let db;
  if (process.env.TEST_DRIVER === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    db = wrapPglite(await PGlite.create({ parsers: TYPE_PARSERS as any }));
  } else {
    await resetDb();
    db = createPgDb(TEST_DB, 5);
  }
  const { app, clock } = await createNodeApp({ databaseUrl: TEST_DB, providerKind: 'demo', db });
  app.log = () => {};
  clock!.set(Date.parse(at) - Date.now());
  await runSync(app, { force: true });
  return { app, clock: clock! };
}

export function setTime(ctx: TestCtx, iso: string) {
  ctx.clock.set(Date.parse(iso) - Date.now());
}

let n = 0;
export async function mkUser(app: App, name?: string): Promise<{ actor: Actor; userId: string; username: string }> {
  const username = name ?? `user${++n}_${Math.floor(Math.random() * 1e6)}`;
  const r = await register(app, { username, email: `${username}@example.com`, password: 'password123' });
  return { actor: { kind: 'user', userId: r.user.id }, userId: r.user.id, username };
}

export async function expectError(p: Promise<unknown>, status: number, match?: RegExp) {
  try {
    await p;
  } catch (e: any) {
    if (e?.name === 'ZodError' || e?.issues) e.status = 400;
    if (e.status !== status) throw new Error(`Expected status ${status}, got ${e.status}: ${e.message}`);
    if (match && !match.test(e.message)) throw new Error(`Error "${e.message}" does not match ${match}`);
    return e;
  }
  throw new Error(`Expected an error with status ${status}, but the call succeeded.`);
}
