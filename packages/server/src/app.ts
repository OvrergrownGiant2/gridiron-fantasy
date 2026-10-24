import type { Db } from './db/db';
import type { NflProvider } from './providers/provider';

/** Crypto and environment primitives. Node and browser implementations exist. */
export interface Platform {
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, stored: string): Promise<boolean>;
  randomToken(bytes?: number): string;          // url-safe
  sha256Hex(input: string | Uint8Array): Promise<string>;
}

export interface Clock { now(): Date }

export interface AppEvent { type: string; leagueId?: string; userId?: string; payload?: unknown }
export interface EventBus {
  publish(channel: string, event: AppEvent): void;
  subscribe(channels: string[], cb: (channel: string, event: AppEvent) => void): () => void;
}

export interface Mailer {
  /** Returns a dev link when no real mail transport is configured (never in production). */
  sendPasswordReset(to: string, link: string): Promise<{ delivered: boolean; devLink?: string }>;
}

export interface AppConfig {
  mode: 'production' | 'development' | 'demo' | 'test';
  publicUrl: string;
  sessionDays: number;
  aiProvider: { kind: 'anthropic'; apiKey: string; model: string } | null;
}

export interface App {
  db: Db;
  platform: Platform;
  clock: Clock;
  bus: EventBus;
  provider: NflProvider;
  mailer: Mailer;
  config: AppConfig;
  log: (msg: string, extra?: unknown) => void;
  /** Optional outbound fetch for the AI provider (absent in the browser demo). */
  fetch?: typeof fetch;
}

export type Actor =
  | { kind: 'user'; userId: string }
  | { kind: 'system' }
  | { kind: 'ai'; teamId: string };

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Please sign in.') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have permission to do that.') => new AppError(403, 'forbidden', msg);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found.`);
export const conflict = (msg: string) => new AppError(409, 'conflict', msg);

export function simpleBus(): EventBus {
  const subs = new Set<{ channels: Set<string>; cb: (c: string, e: AppEvent) => void }>();
  return {
    publish(channel, event) {
      for (const s of subs) if (s.channels.has(channel)) { try { s.cb(channel, event); } catch { /* ignore */ } }
    },
    subscribe(channels, cb) {
      const s = { channels: new Set(channels), cb };
      subs.add(s);
      return () => subs.delete(s);
    },
  };
}

export const userChannel = (id: string) => `user:${id}`;
export const leagueChannel = (id: string) => `league:${id}`;
