import { simpleBus, type App } from './app';
import { OffsetClock, systemClock } from './clock';
import { createMailer, createProvider, readEnv, type ServerEnv } from './config';
import { migrate, type Db } from './db/db';
import { createPgDb } from './db/pg';
import { registerDemoRoutes, restoreDemoClock } from './demoRoutes';
import { nodePlatform } from './platform/node';

export async function createNodeApp(overrides: Partial<ServerEnv> & { db?: Db } = {}): Promise<{ app: App; env: ServerEnv; clock: OffsetClock | null }> {
  const env = { ...readEnv(), ...overrides };
  const log = (m: string, extra?: unknown) => console.log(`[gridiron] ${m}`, extra ?? '');
  const demoClock = env.providerKind === 'demo' || env.providerKind === 'snapshot' ? new OffsetClock() : null;
  const clock = demoClock ?? systemClock;
  const provider = createProvider(env, clock);
  const db = overrides.db ?? createPgDb(env.databaseUrl);
  const app: App = {
    db, platform: nodePlatform, clock, bus: simpleBus(), provider, config: env.config, log,
    mailer: createMailer(env.config, log), fetch: env.config.aiProvider ? fetch : undefined,
  };
  await migrate(db, log);
  if (demoClock) { registerDemoRoutes(app, demoClock); await restoreDemoClock(app, demoClock); }
  return { app, env, clock: demoClock };
}
