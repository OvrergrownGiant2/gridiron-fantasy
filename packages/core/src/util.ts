import type { DisplayGameStatus, GameStatus } from './types';

/** Mulberry32 seeded PRNG — deterministic, used for draft order shuffles, AI noise and demo data. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function displayStatus(status: GameStatus | null | undefined, dataAvailable = true): DisplayGameStatus {
  if (!dataAvailable || !status) return 'DATA UNAVAILABLE';
  switch (status) {
    case 'in_progress': return 'LIVE';
    case 'scheduled': return 'UPCOMING';
    case 'final': return 'FINAL';
    case 'delayed': return 'DELAYED';
    case 'postponed': return 'POSTPONED';
    case 'canceled': return 'CANCELED';
  }
}

/** Invite codes avoid ambiguous characters (0/O, 1/I/L). */
export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function formatInTimeZone(iso: string, timeZone: string | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, ...opts }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(new Date(iso));
  }
}
