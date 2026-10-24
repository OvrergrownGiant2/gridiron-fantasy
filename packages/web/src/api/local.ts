/**
 * DEMO TRANSPORT — runs the real server services in the browser on PGlite
 * (PostgreSQL compiled to WebAssembly), persisted in IndexedDB. Used only by the
 * self-contained demo build. Data is simulated and stays in this browser.
 */
import { PGlite } from '@electric-sql/pglite';
import { simpleBus, type App } from '@gridiron/server/src/app';
import { call, toErrorBody } from '@gridiron/server/src/api/router';
import { OffsetClock } from '@gridiron/server/src/clock';
import { migrate, TYPE_PARSERS } from '@gridiron/server/src/db/db';
import { wrapPglite } from '@gridiron/server/src/db/pglite';
import { registerDemoRoutes, restoreDemoClock } from '@gridiron/server/src/demoRoutes';
import { webPlatform } from '@gridiron/server/src/platform/web';
import { DemoProvider } from '@gridiron/server/src/providers/demo';
import { DatasetProvider, type NflDataset } from '@gridiron/server/src/providers/nflverse';
import { resolveSession } from '@gridiron/server/src/services/auth';
import { startJobs } from '@gridiron/server/src/services/jobs';
import { seedDemo } from '@gridiron/server/src/services/seed';
import { getMedia } from '@gridiron/server/src/services/social';
import { ApiError, type AppEventMsg, type Transport } from './transport';

const TOKEN_KEY = 'gridiron.demo.session';
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

/**
 * Hosts that only serve common web file types cannot serve PGlite's `.data` filesystem
 * bundle, so the artifact build ships a copy under a served extension and we pass it in.
 */
async function loadFsBundle(): Promise<Blob | undefined> {
  try {
    const r = await fetch('./assets/pglite-fs.woff2');
    if (r.ok && (r.headers.get('content-length') ?? '1') !== '0') return await r.blob();
  } catch { /* fall back to PGlite's default loader */ }
  return undefined;
}

async function fetchSnapshot(): Promise<NflDataset | null> {
  try { const r = await fetch('./nfl-snapshot.json', { cache: 'no-store' }); if (r.ok) return await r.json(); } catch { /* no snapshot: simulated demo */ }
  return null;
}

/**
 * One database per season, so leagues survive when a newer data snapshot is published.
 * Earlier builds used one database per snapshot date; reuse the newest of those if present.
 */
async function realDbName(season: number): Promise<string> {
  const stable = `gridiron-real-${season}`;
  try {
    const names = ((await (indexedDB as any).databases?.()) ?? []).map((d: any) => String(d.name ?? '').replace(/^\/pglite\//, ''));
    if (names.includes(stable)) return stable;
    const legacy = names.filter((n: string) => n.startsWith(`${stable}-`)).sort().pop();
    if (legacy) return legacy;
  } catch { /* databases() unsupported */ }
  return stable;
}

export interface BootInfo { persistent: boolean; seeded: boolean }

export async function createLocalTransport(onProgress: (msg: string, pct: number) => void): Promise<{ transport: Transport; info: BootInfo; reset: () => Promise<void> }> {
  onProgress('Loading real NFL data snapshot', 1);
  let snapshot: NflDataset | null = await fetchSnapshot();
  const dbName = snapshot ? await realDbName(snapshot.season) : 'gridiron-demo-v1';
  onProgress('Starting the in-browser database', 2);
  let pg: PGlite;
  let persistent = true;
  const fsBundle = await loadFsBundle();
  const opts: any = { parsers: TYPE_PARSERS as any, ...(fsBundle ? { fsBundle } : {}) };
  try {
    pg = await PGlite.create(`idb://${dbName}`, { ...opts, relaxedDurability: true });
  } catch {
    persistent = false;
    pg = await PGlite.create(opts);
  }
  const db = wrapPglite(pg);
  const clock = new OffsetClock();
  const bus = simpleBus();
  const listeners = new Set<(e: AppEventMsg) => void>();
  const origPublish = bus.publish.bind(bus);
  bus.publish = (ch, ev) => { origPublish(ch, ev); listeners.forEach((l) => l(ev)); };
  const app: App = {
    db, platform: webPlatform, clock, bus,
    provider: snapshot
      ? new DatasetProvider(async () => snapshot!, clock, { id: 'nflverse-snapshot', label: 'nflverse snapshot', snapshotAsOf: snapshot.asOf, livePollSeconds: 300, idlePollSeconds: 900 })
      : new DemoProvider(clock),
    mailer: { async sendPasswordReset(_to, link) { return { delivered: false, devLink: link }; } },
    config: { mode: 'demo', publicUrl: location.href.split('#')[0].replace(/\/$/, ''), sessionDays: 30, aiProvider: null },
    log: (m) => console.info(`[gridiron demo] ${m}`),
  };
  await migrate(db);
  registerDemoRoutes(app, clock);
  await restoreDemoClock(app, clock);
  const r = await seedDemo(app, clock, (m, p) => onProgress(m, 5 + Math.round(p * 0.93)));
  startJobs(app);
  onProgress('Ready', 100);

  /** A republished page may carry a newer snapshot than the one loaded at boot. */
  const pullNewerSnapshot = async () => {
    const next = await fetchSnapshot();
    if (next && next.season === snapshot!.season && next.asOf > snapshot!.asOf) {
      snapshot = next;
      (app.provider as DatasetProvider).snapshotAsOf = next.asOf;
    }
  };

  const transport: Transport = {
    mode: 'demo',
    async call(method, input) {
      const token = ls.get(TOKEN_KEY);
      try {
        if (method === 'leagues.refresh' && snapshot) await pullNewerSnapshot();
        const user = await resolveSession(app, token);
        const out = await call(app, method, input ?? {}, { user, token, ip: 'local', userAgent: navigator.userAgent });
        if (out.setToken) ls.set(TOKEN_KEY, out.setToken.token);
        if (out.clearToken) ls.set(TOKEN_KEY, null);
        return JSON.parse(JSON.stringify(out.data ?? null));
      } catch (e) {
        const { status, body } = toErrorBody(e);
        if (status >= 500) console.error(e);
        throw new ApiError(status, body.error.code, body.error.message, body.error.details);
      }
    },
    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    async mediaUrl(id) {
      const m = await getMedia(app, id);
      if (!m) return '';
      return URL.createObjectURL(new Blob([m.bytes as BlobPart], { type: m.mime }));
    },
    sessionChanged() {},
  };
  const reset = async () => {
    ls.set(TOKEN_KEY, null);
    await pg.close();
    await new Promise<void>((res) => { const rq = indexedDB.deleteDatabase(`/pglite/${dbName}`); rq.onsuccess = rq.onerror = rq.onblocked = () => res(); });
    location.reload();
  };
  return { transport, info: { persistent, seeded: !r.skipped }, reset };
}
