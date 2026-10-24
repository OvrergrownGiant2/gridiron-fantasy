import { useQueryClient } from '@tanstack/react-query';
import { Clock3, FastForward } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { dateTime } from '../lib/format';
import { useCall } from '../lib/hooks';
import { Button, Modal, useToast } from './ui';

/** Demo-only time travel: lets testers move simulated time forward to watch games go live and final. */
export function DemoClock() {
  const { data } = useCall<any>(['nflStatus', 'demo'], 'demo.state', {}, { refetchInterval: 30_000 });
  const { data: board } = useCall<any>(['nflStatus', 'board'], 'nfl.scoreboard', {});
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  if (!data) return null;
  const travel = async (key: string, input: any) => {
    setBusy(key);
    try {
      const r = await api().call<any>('demo.travel', input);
      await qc.invalidateQueries();
      toast('good', `Demo time is now ${dateTime(r.now)}.`);
      setOpen(false);
    } catch (e: any) { toast('bad', e.message); } finally { setBusy(null); }
  };
  const now = Date.parse(data.now);
  const next = (board?.games ?? []).filter((g: any) => Date.parse(g.kickoffAt) > now).sort((a: any, b: any) => Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt))[0];
  return (
    <>
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-md bg-surface px-2 py-1 text-[12px] font-semibold hairline hover:bg-raised">
        <Clock3 className="h-3.5 w-3.5" /> Demo time {dateTime(data.now)}{data.offsetMs > 60_000 ? ' (advanced)' : ''}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Demo time travel">
        <div className="space-y-4 text-[14px]">
          <p className="text-muted">The demo season follows the clock. Move simulated time forward to watch games kick off, scores update live, weeks finalize and waivers process. Time only moves forward, because games that have finished stay finished. To start over, reset the demo from Profile & Settings.</p>
          <div className="rounded-lg bg-sunken px-3 py-2"><span className="label">Simulated now</span><div className="font-display text-2xl font-semibold">{dateTime(data.now)}</div></div>
          <div className="grid grid-cols-2 gap-2">
            {next && <Button variant="primary" className="col-span-2" icon={<FastForward className="h-4 w-4" />} loading={busy === 'kick'} onClick={() => travel('kick', { to: new Date(Date.parse(next.kickoffAt) + 75 * 60_000).toISOString() })}>
              Into the next game ({next.awayTeamId} @ {next.homeTeamId})
            </Button>}
            <Button loading={busy === 'h'} onClick={() => travel('h', { minutes: 60 })}>+1 hour</Button>
            <Button loading={busy === 'h4'} onClick={() => travel('h4', { minutes: 240 })}>+4 hours</Button>
            <Button loading={busy === 'd'} onClick={() => travel('d', { minutes: 1440 })}>+1 day</Button>
            <Button loading={busy === 'w'} onClick={() => travel('w', { minutes: 7 * 1440 })}>+1 week</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
