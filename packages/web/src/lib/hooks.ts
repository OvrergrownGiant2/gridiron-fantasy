import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api, EVENT_KEYS } from '../api/client';
import { useToast } from '../components/ui';

export function useCall<T = any>(key: unknown[], method: string, input?: unknown, opts: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({ queryKey: key, queryFn: () => api().call<T>(method, input), ...opts });
}

/** Mutation helper: toasts success/failure and invalidates query families by their first key. */
export function useAction<I = any, O = any>(method: string, opts: { invalidate?: string[]; success?: string | ((o: O) => string); onSuccess?: (o: O, i: I) => void; quiet?: boolean } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<O, any, I>({
    mutationFn: (input: I) => api().call<O>(method, input),
    onSuccess: (o, i) => {
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: [k] });
      if (opts.success) toast('good', typeof opts.success === 'function' ? opts.success(o) : opts.success);
      opts.onSuccess?.(o, i);
    },
    onError: (e) => { if (!opts.quiet) toast('bad', e?.message ?? 'Something went wrong.'); },
  });
}

export function useMe() {
  return useQuery<{ user: any }>({ queryKey: ['me'], queryFn: () => api().call('auth.me'), staleTime: 60_000 });
}

const LS_KEY = 'gridiron.currentLeague';
export function rememberLeague(id: string) { try { localStorage.setItem(LS_KEY, id); } catch { /* ignore */ } }
export function rememberedLeague(): string | null { try { return localStorage.getItem(LS_KEY); } catch { return null; } }

export function useLeagueId(): string | null {
  const { leagueId } = useParams();
  return leagueId ?? rememberedLeague();
}

export function useLeague(leagueId: string | null | undefined) {
  return useQuery<any>({ queryKey: ['league', leagueId], queryFn: () => api().call('leagues.get', { leagueId }), enabled: Boolean(leagueId) });
}

export function useMyLeagues(enabled = true) {
  return useQuery<any[]>({ queryKey: ['league', 'mine'], queryFn: () => api().call('leagues.mine'), enabled });
}

export function useDataStatus() {
  return useQuery<any>({ queryKey: ['nflStatus'], queryFn: () => api().call('nfl.status'), refetchInterval: 30_000 });
}

/** Subscribes to realtime events and invalidates the affected queries. */
export function useLiveEvents(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => { for (const k of pending) qc.invalidateQueries({ queryKey: [k] }); pending = new Set(); timer = null; };
    const off = api().subscribe((ev) => {
      for (const k of EVENT_KEYS[ev.type] ?? []) pending.add(k);
      if (ev.type === 'scores') pending.add('nflStatus');
      if (!timer) timer = setTimeout(flush, 250); // coalesce bursts
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [enabled, qc]);
}

export function teamMap(league: any): Map<string, any> {
  return new Map((league?.teams ?? []).map((t: any) => [t.id, t]));
}
