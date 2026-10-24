import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { Db } from './db';

type Q = Pick<PGlite, 'query' | 'exec'> | Transaction;

function wrap(q: Q, root: PGlite | null): Db {
  const db: Db = {
    inTx: root === null,
    async query(sql, params) { return (await q.query(sql, params as any[])).rows as any[]; },
    async one(sql, params) { return ((await q.query(sql, params as any[])).rows[0] as any) ?? null; },
    async exec(sql) { await q.exec(sql); },
    async tx(fn) {
      if (!root) return fn(db);
      return root.transaction(async (t) => fn(wrap(t, null)));
    },
    async close() { if (root) await root.close(); },
  };
  return db;
}

export function wrapPglite(pg: PGlite): Db { return wrap(pg, pg); }
