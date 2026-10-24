import { z } from 'zod';
import { badRequest, type App } from './app';
import { devRoutes } from './api/router';
import type { OffsetClock } from './clock';
import { draftTick } from './services/drafts';
import { aiLineups } from './services/jobs';
import { runSync } from './services/nfl';
import { tradeTick } from './services/trades';
import { waiverTick } from './services/waivers';

/** Registers demo-only controls. Never registered when a real provider is active. */
export function registerDemoRoutes(app: App, clock: OffsetClock) {
  if (!app.provider.isDemo) return;
  devRoutes['demo.state'] = { auth: true, rate: 'read', handler: async () => ({ offsetMs: clock.offsetMs, now: clock.now().toISOString(), realNow: new Date().toISOString() }) };
  devRoutes['demo.travel'] = {
    auth: true, rate: 'write',
    handler: async (_a, _actor, input) => {
      const p = z.object({ to: z.string().datetime().optional(), minutes: z.number().int().min(-60 * 24 * 60).max(60 * 24 * 60).optional(), reset: z.boolean().optional() }).parse(input);
      let target = clock.now().getTime();
      if (p.reset) {
        if (clock.offsetMs > 60_000) throw badRequest('Demo time has moved past the real time; finished games cannot be un-played. Reset the demo data instead.');
        target = Date.now();
      }
      else if (p.to) target = Date.parse(p.to);
      else if (p.minutes !== undefined) target += p.minutes * 60_000;
      else throw badRequest('Provide "to", "minutes" or "reset".');
      if (target < clock.now().getTime() - 60_000 && !p.reset) throw badRequest('Demo time can only move forward (or reset to the real time).');
      clock.set(target - Date.now());
      await app.db.query("INSERT INTO app_kv (key, value) VALUES ('demo_clock', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify({ offsetMs: clock.offsetMs })]);
      await runSync(app, { force: true });
      await draftTick(app); await tradeTick(app); await waiverTick(app); await aiLineups(app);
      await runSync(app, { force: true });
      return { now: clock.now().toISOString(), offsetMs: clock.offsetMs };
    },
  };
}

export async function restoreDemoClock(app: App, clock: OffsetClock) {
  const r = await app.db.one<{ value: { offsetMs: number } }>("SELECT value FROM app_kv WHERE key = 'demo_clock'");
  if (r) clock.set(r.value.offsetMs);
}
