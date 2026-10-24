import { QueryClient } from '@tanstack/react-query';
import type { Transport } from './transport';

let current: Transport | null = null;
export function setTransport(t: Transport) { current = t; }
export function api(): Transport {
  if (!current) throw new Error('Transport not initialized');
  return current;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: (n, e: any) => (e?.status === 0 || e?.status >= 500) && n < 2, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

/** Map realtime events to the queries they invalidate. */
export const EVENT_KEYS: Record<string, string[]> = {
  scores: ['matchups', 'roster', 'dashboard', 'standings', 'player'],
  roster: ['roster', 'players', 'player', 'waivers', 'trades', 'dashboard', 'transactions', 'league'],
  draft: ['draft', 'draftAvailable', 'roster', 'league'],
  trades: ['trades', 'commish', 'dashboard'],
  waivers: ['waivers', 'transactions'],
  chat: ['chat'],
  notification: ['notifications', 'dashboard'],
  activity: ['activity', 'commish'],
};
