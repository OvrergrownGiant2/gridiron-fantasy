import { ImagePlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Avatar } from '../components/Shell';
import { Badge, Button, Card, ConfirmDialog, ErrorNote, Field, Input, PageHeader, SectionTitle, Segmented, Select, Toggle, useToast } from '../components/ui';
import { browserTimeZone, dateTime, relative, setUserTimeZone } from '../lib/format';
import { useAction, useCall, useDataStatus, useMe } from '../lib/hooks';
import { applyTheme } from '../theme';

const NOTE_LABELS: Record<string, string> = {
  trade_proposal: 'Trade proposals', trade_counter: 'Trade counteroffers', trade_decision: 'Trade decisions', trade_vote: 'Trades awaiting your vote',
  waiver_result: 'Waiver results', draft_turn: 'Your draft turn', player_injury: 'Injuries on your roster', lineup_lock: 'Lineup lock reminders',
  matchup_result: 'Matchup results', announcement: 'Commissioner announcements', commissioner_queue: 'Commissioner review queue', chat_mention: 'Chat mentions',
};

function zones(): string[] {
  try { return (Intl as any).supportedValuesOf('timeZone'); } catch { return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Rome']; }
}

export function Settings({ resetDemo }: { resetDemo?: () => Promise<void> }) {
  const { data: me } = useMe();
  const u = me?.user;
  const toast = useToast();
  const save = useAction('profile.update', { invalidate: ['me'], success: 'Settings saved.' });
  const [name, setName] = useState('');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [pwErr, setPwErr] = useState<any>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const { data: status } = useDataStatus();
  const { data: ai } = useCall<any>(['assistant', 'status'], 'assistant.status', {});
  useEffect(() => { if (u) setName(u.displayName); }, [u?.displayName]);
  if (!u) return null;
  const update = (patch: any) => save.mutate(patch, {
    onSuccess: (nu: any) => { if ('theme' in patch) applyTheme(nu.theme); if ('timezone' in patch) setUserTimeZone(nu.timezone); },
  });
  const uploadAvatar = async (f?: File) => {
    if (!f) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type) || f.size > 2 * 1024 * 1024) { toast('bad', 'Use a PNG, JPEG or WebP image up to 2 MB.'); return; }
    const b64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });
    try { const m = await api().call<any>('media.upload', { dataBase64: b64, purpose: 'avatar' }); update({ avatarMediaId: m.id }); } catch (e: any) { toast('bad', e.message); }
  };
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="Profile & Settings" sub={`Signed in as @${u.username}`} />
      <Card>
        <SectionTitle>Profile</SectionTitle>
        <div className="flex flex-wrap items-center gap-4">
          <Avatar user={u} size={64} />
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg px-4 text-sm font-semibold hairline hover:bg-raised"><ImagePlus className="h-4 w-4" />Change photo<input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => uploadAvatar(e.target.files?.[0])} /></label>
          {u.avatarMediaId && <Button variant="ghost" onClick={() => update({ avatarMediaId: null })}>Remove photo</Button>}
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Display name" htmlFor="st-name"><div className="flex gap-2"><Input id="st-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /><Button disabled={!name.trim() || name === u.displayName} onClick={() => update({ displayName: name })}>Save</Button></div></Field>
          <Field label="Account email" hint="Private. Never shown to other managers."><Input value={u.email} disabled /></Field>
        </div>
        <p className="mt-3 text-[12px] text-faint">Member since {dateTime(u.createdAt)}</p>
      </Card>
      <Card>
        <SectionTitle>Display</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Theme"><Segmented value={u.theme} onChange={(v) => update({ theme: v })} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} /></Field>
          <Field label="Time zone" htmlFor="st-tz" hint={`Game times display in this zone. Your browser reports ${browserTimeZone()}.`}>
            <Select id="st-tz" value={u.timezone ?? ''} onChange={(e) => update({ timezone: e.target.value || null })}>
              <option value="">Use browser time zone</option>
              {zones().map((z) => <option key={z} value={z}>{z}</option>)}
            </Select>
          </Field>
        </div>
      </Card>
      <Card>
        <SectionTitle sub="Choose which events create notifications.">Notifications</SectionTitle>
        <div className="grid gap-x-8 sm:grid-cols-2">
          {Object.entries(NOTE_LABELS).map(([k, label]) => <Toggle key={k} id={`np-${k}`} label={label} checked={u.notificationPrefs[k] !== false} onChange={(v) => update({ notificationPrefs: { ...u.notificationPrefs, [k]: v } })} />)}
        </div>
      </Card>
      <Card>
        <SectionTitle>Password</SectionTitle>
        <form className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={async (e) => {
          e.preventDefault(); setPwErr(null);
          try { await api().call('auth.changePassword', pw); setPw({ currentPassword: '', newPassword: '' }); toast('good', 'Password updated.'); } catch (x) { setPwErr(x); }
        }}>
          <Field label="Current password" htmlFor="pw-cur"><Input id="pw-cur" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label="New password" htmlFor="pw-new"><Input id="pw-new" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          <Button type="submit" disabled={!pw.currentPassword || pw.newPassword.length < 8}>Update</Button>
        </form>
        {pwErr && <div className="mt-3"><ErrorNote error={pwErr} /></div>}
      </Card>
      <Card>
        <SectionTitle>Data & services</SectionTitle>
        {status && (
          <div className="space-y-2 text-[13px]">
            <div className="flex flex-wrap items-center gap-2"><span className="label w-32">NFL data</span><b>{status.provider.label}</b><Badge tone={status.provider.isDemo ? 'accent' : status.health === 'ok' ? 'good' : status.health === 'stale' ? 'warn' : 'bad'}>{status.provider.isDemo ? 'simulated' : status.health}</Badge></div>
            <div className="pl-0 text-muted sm:pl-[136px]">{status.message} Last update {relative(status.lastUpdatedAt, Date.parse(status.now))}.</div>
            <div className="flex flex-wrap items-center gap-2"><span className="label w-32">AI assistant</span><Badge tone={ai?.aiAvailable ? 'good' : 'neutral'}>{ai?.aiAvailable ? 'available' : 'not configured'}</Badge><span className="text-muted">{ai?.message}</span></div>
          </div>
        )}
        {resetDemo && (
          <div className="mt-4 border-t border-line pt-4">
            <p className="mb-2 text-[13px] text-muted">This demo runs entirely in your browser. Resetting deletes every league, account and message stored here and re-creates the sample season.</p>
            <Button variant="danger" onClick={() => setConfirmReset(true)}>Reset demo data</Button>
          </div>
        )}
      </Card>
      <ConfirmDialog open={confirmReset} onClose={() => setConfirmReset(false)} danger title="Reset all demo data?" confirmLabel="Reset" body="All local demo data will be deleted and rebuilt. This cannot be undone." onConfirm={() => resetDemo?.()} />
    </div>
  );
}
