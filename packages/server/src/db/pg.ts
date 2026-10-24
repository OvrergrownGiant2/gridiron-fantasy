import pg from 'pg';
import type { Db } from './db';
import { TYPE_PARSERS } from './db';

for (const [oid, fn] of Object.entries(TYPE_PARSERS)) pg.types.setTypeParser(Number(oid), fn as (v: string) => any);

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

function wrap(raw: Queryable, inTx: boolean, pool: pg.Pool | null): Db {
  // A transaction runs on one client; serialize concurrent calls (e.g. Promise.all) onto it.
  let chain: Promise<unknown> = Promise.resolve();
  const q: Queryable = inTx ? {
    query: (sql, params) => {
      const run = chain.then(() => raw.query(sql, params));
      chain = run.catch(() => {});
      return run;
    },
  } : raw;
  const db: Db = {
    inTx,
    async query(sql, params) { return (await q.query(sql, params as unknown[])).rows; },
    async one(sql, params) { return (await q.query(sql, params as unknown[])).rows[0] ?? null; },
    async exec(sql) { await q.query(sql); },
    async tx(fn) {
      if (inTx || !pool) return fn(db);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client, true, null));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async close() { if (pool) await pool.end(); },
  };
  return db;
}

export function createPgDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max });
  return wrap(pool, false, pool);
}
