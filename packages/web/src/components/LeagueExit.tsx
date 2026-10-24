import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Button, ErrorNote, Input, Modal, cx, useToast } from './ui';

export interface ExitLeague { id: string; name: string; role: string; people: number; teamName?: string | null }

/**
 * Leave a league (an AI manager takes over your team) or, as commissioner, delete it.
 * When you are the last person in the league, leaving deletes it.
 */
export function LeagueExitButtons({ league, className, size = 'md' }: { league: ExitLeague; className?: string; size?: 'sm' | 'md' }) {
  const [mode, setMode] = useState<null | 'leave' | 'delete'>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const isCommish = league.role === 'commissioner';
  const lastOne = league.people <= 1 && league.role !== 'observer';
  const close = () => { setMode(null); setTyped(''); setErr(null); };

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      if (mode === 'delete') {
        await api().call('leagues.delete', { leagueId: league.id, confirmName: typed });
        toast('good', `${league.name} was deleted.`);
      } else {
        const r = await api().call<any>('leagues.leave', { leagueId: league.id });
        toast('good', r.leagueDeleted ? `You left ${league.name}. Nobody was left, so it was deleted.` : `You left ${league.name}. An AI manager now runs your team.`);
      }
      close();
      await qc.invalidateQueries();
      nav('/leagues');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  const needsName = mode === 'delete' || (mode === 'leave' && lastOne);
  return (
    <div className={cx('flex flex-wrap gap-2', className)}>
      <Button size={size} variant="ghost" className="text-bad" icon={<LogOut className="h-4 w-4" />} onClick={() => setMode('leave')}>{lastOne ? 'Leave & delete' : 'Leave league'}</Button>
      {isCommish && !lastOne && <Button size={size} variant="ghost" className="text-bad" icon={<Trash2 className="h-4 w-4" />} onClick={() => setMode('delete')}>Delete league</Button>}
      <Modal open={mode !== null} onClose={close} title={mode === 'delete' || lastOne ? `Delete ${league.name}?` : `Leave ${league.name}?`}
        footer={<>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={needsName && typed !== league.name} onClick={run}>{mode === 'delete' || lastOne ? 'Delete league' : 'Leave league'}</Button>
        </>}>
        <div className="space-y-3 text-[14px]">
          {mode === 'delete' ? (
            <p>This permanently deletes the league for all {league.people} {league.people === 1 ? 'person' : 'people'} in it: rosters, results, trades and chat.</p>
          ) : lastOne ? (
            <p>You're the only person in this league, so leaving deletes it for good: rosters, results and chat.</p>
          ) : (
            <>
              <p>An AI manager takes over {league.teamName ? <b>{league.teamName}</b> : 'your team'}, keeping its roster and record, so the schedule and standings carry on. Your pending trade offers and waiver claims are cancelled.</p>
              {isCommish && <p>You're the commissioner, so the role passes to the next person in the league (a co-commissioner first, otherwise the longest-serving manager).</p>}
              <p className="text-muted">You can rejoin later with the invite code if a seat is open.</p>
            </>
          )}
          {needsName && (
            <label className="block">
              <span className="label">Type the league name to confirm</span>
              <Input className="mt-1" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={league.name} aria-label="League name" autoFocus />
            </label>
          )}
          {err && <ErrorNote error={err} />}
        </div>
      </Modal>
    </div>
  );
}
