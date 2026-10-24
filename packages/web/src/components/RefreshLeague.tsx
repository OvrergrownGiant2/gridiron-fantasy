import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { dateOnly } from '../lib/format';
import { useMe } from '../lib/hooks';
import { Button, useToast } from './ui';

/** Creator-only: pull the latest NFL data and recalculate this league's scores and standings. */
export function RefreshLeagueButton({ L, size = 'md' }: { L: any; size?: 'sm' | 'md' }) {
  const { data: me } = useMe();
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  if (!L || !me?.user || L.league.createdBy !== me.user.id) return null;
  const go = async () => {
    setBusy(true);
    try {
      const r = await api().call<any>('leagues.refresh', { leagueId: L.league.id });
      await qc.invalidateQueries();
      if (!r.ok) toast('bad', `Could not reach ${r.providerLabel}: ${r.error ?? 'unknown error'}. Scores were recalculated from the data already loaded.`);
      else if (r.snapshotAsOf && !r.changedStats && !r.weeksFinalized) toast('info', `Scores recalculated. This copy uses a data snapshot from ${dateOnly(r.snapshotAsOf)}, so there are no newer NFL results to load here.`);
      else {
        const parts = [
          r.changedStats ? `${r.changedStats} new or corrected stat lines` : null,
          r.changedGames ? `${r.changedGames} game updates` : null,
          r.weeksFinalized ? `${r.weeksFinalized} week${r.weeksFinalized === 1 ? '' : 's'} finalized` : null,
        ].filter(Boolean);
        toast('good', parts.length ? `League refreshed: ${parts.join(', ')}.` : 'League refreshed. Everything was already up to date.');
      }
    } catch (e: any) { toast('bad', e.message); } finally { setBusy(false); }
  };
  return <Button size={size} variant="turf" icon={<RefreshCw className={busy ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />} disabled={busy} onClick={go} title="Pull the latest NFL data and recalculate scores and standings">{busy ? 'Refreshing…' : 'Refresh league'}</Button>;
}
