import { useState } from 'react';
import { api } from '../api/client';
import { dateTime, newRequestId } from '../lib/format';
import { useCall } from '../lib/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { Button, ErrorNote, Field, Input, LoadingBlock, Modal, Select, useToast } from './ui';

/**
 * Add a free agent or submit a waiver claim, with an optional drop. The server
 * decides availability; the UI never reports success before it confirms.
 */
export function AcquireModal({ leagueId, teamId, player, onClose, faab }: { leagueId: string; teamId: string; player: any; onClose: () => void; faab?: { mode: string; remaining: number; allowZero: boolean } }) {
  const waiver = player.availability?.status === 'waivers';
  const { data: roster } = useCall<any>(['roster', teamId], 'rosters.get', { teamId });
  const [drop, setDrop] = useState('');
  const [bid, setBid] = useState(0);
  const [group, setGroup] = useState('');
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [reqId] = useState(newRequestId);
  const qc = useQueryClient();
  const toast = useToast();
  const players = roster ? [...roster.starters, ...roster.bench].filter((p: any) => p.slot !== 'IR') : [];
  const full = roster ? players.length >= roster.maxActive : false;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (waiver) {
        const r = await api().call<any>('waivers.claim', { teamId, addPlayerId: player.id, dropPlayerId: drop || null, bid, groupId: group || null });
        toast('good', `Claim submitted for ${player.name}.${r.processesAt ? ` Processes ${dateTime(r.processesAt)}.` : ''}`);
      } else {
        const r = await api().call<any>('rosters.addFreeAgent', { teamId, addPlayerId: player.id, dropPlayerId: drop || null, requestId: reqId });
        toast('good', r.summary);
      }
      for (const k of ['roster', 'players', 'waivers', 'transactions', 'dashboard']) qc.invalidateQueries({ queryKey: [k] });
      onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={waiver ? `Claim ${player.name}` : `Add ${player.name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={full && !drop} onClick={submit}>{waiver ? 'Submit claim' : drop ? 'Add and drop' : 'Add player'}</Button></>}>
      {!roster ? <LoadingBlock rows={2} /> : (
        <div className="space-y-4">
          <p className="text-[14px] text-muted">
            {waiver ? <>{player.name} is on waivers ({player.availability.reason}) Claims are resolved together{player.availability.clearsAt ? ` at ${dateTime(player.availability.clearsAt)}` : ' at the next waiver run'}{faab?.mode === 'faab' ? ': the highest bid wins, ties go to waiver priority.' : ' in waiver priority order.'}</> : <>{player.name} is a free agent. Adding is immediate and first come, first served.</>}
          </p>
          <Field label={full ? 'Drop a player (required — your roster is full)' : 'Drop a player (optional)'} htmlFor="acq-drop">
            <Select id="acq-drop" value={drop} onChange={(e) => setDrop(e.target.value)}>
              <option value="">{full ? 'Choose a player to drop…' : 'No drop'}</option>
              {players.map((p: any) => <option key={p.playerId} value={p.playerId} disabled={p.locked}>{p.name} · {p.position} · {p.slot}{p.locked ? ' (locked)' : ''}</option>)}
            </Select>
          </Field>
          {waiver && faab?.mode === 'faab' && (
            <Field label={`FAAB bid (you have $${faab.remaining})`} htmlFor="acq-bid" hint={faab.allowZero ? '$0 bids are allowed.' : 'Minimum bid is $1.'}>
              <Input id="acq-bid" type="number" min={faab.allowZero ? 0 : 1} max={faab.remaining} value={bid} onChange={(e) => setBid(Math.max(0, Math.min(faab.remaining, Math.round(Number(e.target.value) || 0))))} />
            </Field>
          )}
          {waiver && (
            <Field label="Conditional group (optional)" htmlFor="acq-group" hint="Claims with the same group name are alternatives: at most one of them can succeed.">
              <Input id="acq-group" value={group} maxLength={40} onChange={(e) => setGroup(e.target.value)} placeholder="e.g. backup-rb" />
            </Field>
          )}
          {drop && <p className="rounded-lg bg-warn/10 px-3 py-2 text-[13px]">Dropped players go on waivers and can be claimed by other teams.</p>}
          <ErrorNote error={err} />
        </div>
      )}
    </Modal>
  );
}
