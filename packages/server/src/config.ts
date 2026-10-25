import type { AppConfig, Mailer } from './app';
import { DemoProvider } from './providers/demo';
import { UnconfiguredProvider, type NflProvider } from './providers/provider';
import { SportsDataIoProvider } from './providers/sportsdataio';
import { readFileSync } from 'node:fs';
import { DatasetProvider, NflverseProvider, seasonForDate, type NflDataset } from './providers/nflverse';
import { SleeperOverlayProvider } from './providers/sleeper';
import type { Clock } from './app';

export interface ServerEnv {
  port: number; databaseUrl: string; config: AppConfig; jobsEnabled: boolean; trustProxy: boolean; webDist: string | null;
  providerKind: string; allowDemoInProduction: boolean;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const mode = (env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development') as AppConfig['mode'];
  const aiKey = env.ANTHROPIC_API_KEY?.trim();
  return {
    port: Number(env.PORT ?? 8787),
    databaseUrl: env.DATABASE_URL ?? 'postgresql://gridiron:gridiron@localhost:5432/gridiron',
    jobsEnabled: env.JOBS_ENABLED !== 'false',
    trustProxy: env.TRUST_PROXY === 'true',
    webDist: env.WEB_DIST ?? null,
    providerKind: (env.NFL_PROVIDER ?? (mode === 'production' ? 'none' : 'demo')).toLowerCase(),
    allowDemoInProduction: env.ALLOW_DEMO_DATA === 'true',
    config: {
      mode,
      // Render (and similar hosts) provide the public address automatically.
      publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT ?? 8787}`).replace(/\/$/, ''),
      sessionDays: Number(env.SESSION_DAYS ?? 30),
      aiProvider: aiKey ? { kind: 'anthropic', apiKey: aiKey, model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5' } : null,
    },
  };
}

export function createProvider(e: ServerEnv, clock: Clock, env: NodeJS.ProcessEnv = process.env): NflProvider {
  switch (e.providerKind) {
    case 'sportsdataio':
      return new SportsDataIoProvider(env.SPORTSDATAIO_API_KEY, fetch, Number(env.SPORTSDATAIO_LIVE_POLL_SECONDS ?? 60));
    case 'nflverse': {
      const base = new NflverseProvider(clock, Number(env.NFL_SEASON || seasonForDate(clock.now())));
      return env.SLEEPER_LIVE === 'false' ? base : new SleeperOverlayProvider(base);
    }
    case 'snapshot': {
      const file = env.NFL_SNAPSHOT ?? 'nfl-snapshot.json';
      const data = JSON.parse(readFileSync(file, 'utf8')) as NflDataset;
      return new DatasetProvider(async () => data, clock, { id: 'nflverse-snapshot', label: 'nflverse snapshot', snapshotAsOf: data.asOf, livePollSeconds: 300, idlePollSeconds: 900 });
    }
    case 'demo':
      if (e.config.mode === 'production' && !e.allowDemoInProduction) {
        throw new Error('Refusing to serve simulated demo data in production. Set NFL_PROVIDER=sportsdataio, or ALLOW_DEMO_DATA=true for a clearly labeled demo deployment.');
      }
      return new DemoProvider(clock);
    default:
      return new UnconfiguredProvider();
  }
}

/** Mail transport: Resend HTTP API when RESEND_API_KEY is set; otherwise logs (dev) or drops (production). */
export function createMailer(config: AppConfig, log: (m: string) => void, env: NodeJS.ProcessEnv = process.env): Mailer {
  const key = env.RESEND_API_KEY;
  const from = env.MAIL_FROM ?? 'Gridiron <no-reply@example.com>';
  return {
    async sendPasswordReset(to, link) {
      if (key) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to, subject: 'Reset your Gridiron password', text: `Use this link within one hour to reset your password:\n\n${link}\n\nIf you did not request this, ignore this email.` }),
        });
        if (!res.ok) log(`mail delivery failed: HTTP ${res.status}`);
        return { delivered: res.ok };
      }
      if (config.mode === 'production') { log('password reset requested but no mail transport is configured (RESEND_API_KEY)'); return { delivered: false }; }
      log(`[dev mail] password reset for ${to}: ${link}`);
      return { delivered: false, devLink: link };
    },
  };
}
