import { MIGRATIONS } from './migrations';

/** Minimal database port. Implemented by node-postgres (production) and PGlite (tests, browser demo). */
export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Runs `fn` in a transaction. Nested calls join the outer transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  readonly inTx: boolean;
  close?(): Promise<void>;
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint?: string; message?: string };
  if (err?.code !== '23505') return false;
  return !constraint || err.constraint === constraint || (err.message ?? '').includes(constraint);
}

export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await db.tx(async (t) => {
      await t.exec(m.sql);
      await t.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
    });
    log(`applied migration ${m.id}`);
    applied.push(m.id);
  }
  return applied;
}

/** Type parsers shared by both drivers: timestamps as ISO strings, numerics as numbers. */
export const TYPE_PARSERS: Record<number, (v: string) => unknown> = {
  20: (v) => Number(v),                         // int8 (counts, bigserial)
  1700: (v) => Number(v),                       // numeric
  1184: (v) => parseTimestamptz(v),                // timestamptz
};

/** Postgres text timestamptz ("2026-10-24 18:55:00.123+00") → ISO 8601 UTC string. */
export function parseTimestamptz(v: string): string {
  if (v === 'infinity' || v === '-infinity') return v;
  let s = v.includes('T') ? v : v.replace(' ', 'T');
  s = s.replace(/([+-]\d\d)$/, '$1:00').replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}
