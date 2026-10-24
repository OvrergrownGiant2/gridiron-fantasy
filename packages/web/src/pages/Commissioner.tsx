import { leagueSettingsSchema, validateLeagueSettings, type LeagueSettings } from '@gridiron/core';
import { AlertTriangle, CalendarClock, ClipboardCheck, Gavel, Megaphone, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { DraftEditor, RosterEditor, ScoringEditor, SeasonEditor, WaiverTradeEditor } from '../components/settingsEditors';
import { TeamChip } from '../components/team';
import { RefreshLeagueButton } from '../components/RefreshLeague';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorNote, Field, Input, LoadingBlock, PageHeader, SectionTitle, Select, Tabs, Textarea, Toggle, cx, useToast } from '../components/ui';
import { dateTime, pts, relative } from '../lib/format';
import { teamMap, useAction, useCall, useLeague } from '../lib/hooks';
import { useQueryClient } from '@tanstack/react-query';

type Tab = 'overview' | 'rules' | 'scoring' | 'members' | 'rosters' | 'audit';

export function Commissioner() {
  const { leagueId } = useParams();
  const { data: L, isLoading } = useLeague(leagueId);
  const [tab, setTab] = useState<Tab>('overview');
  if (isLoading || !L) return <LoadingBlock />;
  if (!L.permissions.includes('trade.review')) return <Empty icon={<ShieldAlert className="h-8 w-8" />} title="Commissioners only" body="Only the commissioner and co-commissioners can open the Digital Commissioner." />;
  const isCommish = L.role === 'commissioner';
  return (
    <div className="space-y-5">
      <PageHeader eyebrow={L.league.name} title="Digital Commissioner" sub="Rule enforcement, reviews and oversight. Every privileged action needs a reason and is written to an append-only audit log." actions={<RefreshLeagueButton L={L} />} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'overview', label: 'Overview' }, { value: 'rules', label: 'League settings' }, ...(isCommish ? [{ value: 'scoring' as const, label: 'Scoring' }] : []),
        { value: 'members', label: 'Members' }, { value: 'rosters', label: 'Roster corrections' }, { value: 'audit', label: 'Audit log' },
      ]} />
      {tab === 'overview' && <Overview L={L} />}
      {tab === 'rules' && <RulesTab L={L} />}
      {tab === 'scoring' && isCommish && <ScoringTab L={L} />}
      {tab === 'members' && <MembersTab L={L} />}
      {tab === 'rosters' && <RostersTab L={L} />}
      {tab === 'audit' && <AuditTab leagueId={L.league.id} />}
    </div>
  );
}

function Overview({ L }: { L: any }) {
  const { data, isLoading, error } = useCall<any>(['commish', L.league.id], 'commish.dashboard', { leagueId: L.league.id }, { refetchInterval: 30_000 });
  const [corr, setCorr] = useState<{ c: any; apply: boolean } | null>(null);
  const [announce, setAnnounce] = useState({ title: '', body: '' });
  const decide = useAction('commish.decideCorrection', { invalidate: ['commish', 'matchups', 'standings'], success: 'Correction decision recorded.' });
  const ann = useAction('announce', { success: (r: any) => `Announcement sent to ${r.sent} members.`, onSuccess: () => setAnnounce({ title: '', body: '' }) });
  const tm = teamMap(L);
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorNote error={error} />;
  const pendingCorr = data.corrections.filter((c: any) => c.status === 'pending');
  const alerts = [
    ...data.trades.filter((t: any) => t.review_route === 'commissioner' && t.status === 'in_review').map((t: any) => ({ tone: 'warn', text: `Trade between ${t.proposer_name} and ${t.recipient_name} awaits your decision.`, to: 'trades' })),
    ...data.trades.filter((t: any) => t.flags?.some((f: any) => f.severity === 'review')).map((t: any) => ({ tone: 'warn', text: `Integrity flags on the ${t.proposer_name} / ${t.recipient_name} trade.`, to: 'trades' })),
    ...pendingCorr.map((c: any) => ({ tone: 'info', text: `Week ${c.week} stat correction is waiting for review.` })),
    ...data.rosterViolations.map((v: any) => ({ tone: 'bad', text: `${v.teamName}: ${v.issues[0]}` })),
  ];
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile icon={Gavel} label="Trades in review" value={data.trades.filter((t: any) => t.status === 'in_review').length} />
        <Tile icon={ClipboardCheck} label="Pending waiver claims" value={data.pendingClaims} />
        <Tile icon={AlertTriangle} label="Roster violations" value={data.rosterViolations.length} tone={data.rosterViolations.length ? 'bad' : undefined} />
        <Tile icon={RefreshCw} label="Corrections to review" value={pendingCorr.length} tone={pendingCorr.length ? 'warn' : undefined} />
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <SectionTitle>Alerts</SectionTitle>
            {alerts.length === 0 ? <p className="text-[13px] text-muted">Nothing needs your attention.</p> : (
              <ul className="space-y-1.5">{alerts.map((a, i) => (
                <li key={i} className={cx('flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]', a.tone === 'bad' ? 'bg-bad/10' : a.tone === 'warn' ? 'bg-warn/10' : 'bg-info/10')}>
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{a.text}</span>{a.to && <Link className="font-semibold text-accent" to={`/league/${L.league.id}/${a.to}`}>Open</Link>}
                </li>))}</ul>
            )}
          </Card>
          <Card>
            <SectionTitle sub="Approve or veto from the Trades page; each decision requires a reason.">Trades awaiting action</SectionTitle>
            {data.trades.length === 0 ? <p className="text-[13px] text-muted">No trades in review.</p> : data.trades.map((t: any) => (
              <div key={t.id} className="flex flex-wrap items-center gap-2 border-t border-line py-2.5 text-[13px] first:border-t-0">
                <Badge tone={t.status === 'approved' ? 'good' : 'warn'}>{t.status === 'approved' ? 'waiting for unlock' : t.review_route.replace('_', ' ')}</Badge>
                <span className="flex-1"><b>{t.proposer_name}</b> ⇄ <b>{t.recipient_name}</b>{t.review_route === 'league_vote' ? ` · ${t.votes_cast} votes` : ''}</span>
                {t.analysis && <span className="text-muted">value gap {Math.round(t.analysis.valueGap * 100)}%</span>}
                {t.review_ends_at && <span className="text-faint">ends {relative(t.review_ends_at)}</span>}
              </div>
            ))}
            <Link to={`/league/${L.league.id}/trades`} className="mt-2 inline-block text-[13px] font-semibold text-accent">Go to trades</Link>
          </Card>
          <Card>
            <SectionTitle sub={L.settings.season.statCorrections === 'auto' ? 'Applied automatically per league policy; listed for transparency.' : 'Provider corrections to finalized weeks wait for your decision.'}>Stat corrections</SectionTitle>
            {data.corrections.length === 0 ? <p className="text-[13px] text-muted">No corrections so far.</p> : data.corrections.map((c: any) => {
              const m = c;
              return (
                <div key={c.id} className="flex flex-wrap items-center gap-2 border-t border-line py-2.5 text-[13px] first:border-t-0">
                  <Badge tone={c.status === 'pending' ? 'warn' : c.status === 'applied' ? 'good' : 'neutral'}>{c.status}</Badge>
                  <span className="flex-1">Week {c.week} · {c.source === 'provider' ? 'provider correction' : 'recalculation'}: {pts(m.old_home)}–{pts(m.old_away)} → <b>{pts(m.new_home)}–{pts(m.new_away)}</b>{c.reason ? <span className="text-muted"> · {c.reason}</span> : null}</span>
                  {c.status === 'pending' && <><Button size="sm" variant="ghost" onClick={() => setCorr({ c, apply: false })}>Dismiss</Button><Button size="sm" variant="primary" onClick={() => setCorr({ c, apply: true })}>Apply</Button></>}
                </div>
              );
            })}
          </Card>
          <Card>
            <SectionTitle sub="Failed transactions and invalid claims from the last two weeks.">Disputes & failures</SectionTitle>
            {data.invalidClaims.length === 0 && data.failedTx.length === 0 ? <p className="text-[13px] text-muted">No disputed transactions.</p> : (
              <div className="space-y-1.5 text-[13px]">
                {data.invalidClaims.map((c: any) => <div key={c.id} className="flex gap-2"><Badge>claim</Badge><span><b>{c.team_name}</b> → {c.full_name}: {c.result_reason}</span></div>)}
                {data.failedTx.map((t: any) => <div key={t.id} className="flex gap-2"><Badge tone="bad">failed</Badge><span>{t.summary}</span></div>)}
              </div>
            )}
            <p className="mt-3 text-[12px] text-faint">To correct a roster, use Roster corrections. Every change requires a reason and notifies the manager.</p>
          </Card>
        </div>
        <div className="space-y-5">
          <Card>
            <SectionTitle>Upcoming deadlines</SectionTitle>
            <ul className="space-y-2 text-[13px]">{data.deadlines.map((d: any) => <li key={d.label} className="flex items-start gap-2"><CalendarClock className="mt-0.5 h-4 w-4 text-accent" /><span><b>{d.label}</b>{d.at ? ` · ${dateTime(d.at)}` : d.week ? ` · week ${d.week}` : ''}</span></li>)}</ul>
          </Card>
          {L.permissions.includes('announce') && (
            <Card>
              <SectionTitle>Announcement</SectionTitle>
              <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); ann.mutate({ leagueId: L.league.id, ...announce }); }}>
                <Input aria-label="Title" placeholder="Title" value={announce.title} maxLength={100} onChange={(e) => setAnnounce({ ...announce, title: e.target.value })} />
                <Textarea aria-label="Message" placeholder="Message to every member" value={announce.body} maxLength={1000} onChange={(e) => setAnnounce({ ...announce, body: e.target.value })} />
                <Button type="submit" className="w-full" icon={<Megaphone className="h-4 w-4" />} disabled={!announce.title.trim()} loading={ann.isPending}>Send to league</Button>
              </form>
            </Card>
          )}
          <Card>
            <SectionTitle>Recent commissioner actions</SectionTitle>
            {data.recent.slice(0, 8).map((a: any) => <div key={a.id} className="border-t border-line py-1.5 text-[12.5px] first:border-t-0"><b>{a.actor_name ?? a.actor_kind}</b> · {a.action}{a.reason ? <span className="text-muted"> — {a.reason}</span> : null}<div className="text-faint">{relative(a.created_at)}</div></div>)}
          </Card>
        </div>
      </div>
      <ConfirmDialog open={Boolean(corr)} onClose={() => setCorr(null)} requireReason title={corr?.apply ? 'Apply stat correction' : 'Dismiss stat correction'} confirmLabel={corr?.apply ? 'Apply and re-score' : 'Dismiss'}
        body={corr?.apply ? 'The finalized week is re-scored with official stats. Standings update automatically.' : 'The original final score stands.'}
        onConfirm={(reason) => decide.mutateAsync({ correctionId: corr!.c.id, apply: corr!.apply, reason })} />
      <span className="hidden">{tm.size}</span>
    </div>
  );
}

function Tile({ icon: Icon, label, value, tone }: { icon: any; label: string; value: number; tone?: 'bad' | 'warn' }) {
  return <Card className="flex items-center gap-3"><Icon className={cx('h-6 w-6', tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-accent')} /><div><div className="num font-display text-3xl font-bold leading-none">{value}</div><div className="text-[12px] text-muted">{label}</div></div></Card>;
}

function RulesTab({ L }: { L: any }) {
  const [s, setS] = useState<LeagueSettings>(() => structuredClone(L.settings));
  const [info, setInfo] = useState({ name: L.league.name, description: L.league.description, visibility: L.league.visibility, maxTeams: L.league.maxTeams });
  const [reason, setReason] = useState('');
  const [section, setSection] = useState<'season' | 'roster' | 'waivers' | 'draft' | 'chat'>('season');
  const save = useAction('leagues.updateSettings', { invalidate: ['league'], success: (r: any) => `Settings saved (version ${r.version}).` });
  const saveInfo = useAction('leagues.updateInfo', { invalidate: ['league', 'dashboard'], success: 'League details saved.' });
  const issues = validateLeagueSettings(s, Math.max(L.teams.length, L.league.maxTeams));
  const started = L.league.status !== 'setup';
  const parsed = leagueSettingsSchema.safeParse(s);
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <Card className="min-w-0">
        <Tabs value={section} onChange={setSection} tabs={[{ value: 'season', label: 'Season' }, { value: 'roster', label: 'Roster' }, { value: 'waivers', label: 'Waivers & trades' }, { value: 'draft', label: 'Draft' }, { value: 'chat', label: 'Chat' }]} />
        {started && <p className="mb-4 rounded-lg bg-sunken px-3 py-2 text-[13px] text-muted">The season is underway, so season length, draft type and roster shape are locked; the server enforces this.</p>}
        {section === 'season' && <SeasonEditor s={s} set={setS} lockedLength={started} />}
        {section === 'roster' && <RosterEditor s={s} set={setS} locked={started} />}
        {section === 'waivers' && <WaiverTradeEditor s={s} set={setS} faabLocked={started && L.settings.waivers.mode === 'faab'} />}
        {section === 'draft' && <DraftEditor s={s} set={setS} />}
        {section === 'chat' && <Toggle label="League chat enabled" checked={s.chat.enabled} onChange={(v) => setS({ ...s, chat: { enabled: v } })} />}
        {issues.length > 0 && <ul className="mt-4 list-disc space-y-0.5 rounded-lg bg-warn/10 p-3 pl-7 text-[13px]">{issues.map((i) => <li key={i.message}>{i.message}</li>)}</ul>}
        <div className="mt-5 flex flex-wrap items-end gap-2 border-t border-line pt-4">
          <div className="min-w-[200px] flex-1"><Field label="Reason (shown in the activity feed)" htmlFor="rs-reason"><Input id="rs-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></Field></div>
          <Button variant="ghost" onClick={() => setS(structuredClone(L.settings))}>Discard</Button>
          <Button variant="primary" disabled={issues.length > 0 || !parsed.success} loading={save.isPending} onClick={() => save.mutate({ leagueId: L.league.id, settings: s, reason: reason || undefined })}>Save settings</Button>
        </div>
      </Card>
      <div className="space-y-5">
        <Card>
          <SectionTitle>League details</SectionTitle>
          <div className="space-y-3">
            <Field label="Name" htmlFor="li-name"><Input id="li-name" value={info.name} maxLength={50} onChange={(e) => setInfo({ ...info, name: e.target.value })} /></Field>
            <Field label="Description" htmlFor="li-desc"><Textarea id="li-desc" value={info.description} maxLength={500} onChange={(e) => setInfo({ ...info, description: e.target.value })} /></Field>
            <Field label="Visibility" htmlFor="li-vis"><Select id="li-vis" value={info.visibility} onChange={(e) => setInfo({ ...info, visibility: e.target.value })}><option value="private">Private</option><option value="public">Public</option></Select></Field>
            <Field label="League size" htmlFor="li-size" hint={started ? 'Locked after the draft.' : undefined}><Select id="li-size" disabled={started} value={info.maxTeams} onChange={(e) => setInfo({ ...info, maxTeams: Number(e.target.value) })}>{Array.from({ length: 10 }, (_, i) => <option key={i} value={i + 1} disabled={i + 1 < L.teams.length}>{i + 1}</option>)}</Select></Field>
            <Button className="w-full" loading={saveInfo.isPending} onClick={() => saveInfo.mutate({ leagueId: L.league.id, ...info, maxTeams: started ? undefined : info.maxTeams })}>Save details</Button>
          </div>
        </Card>
        {L.role === 'commissioner' && <DangerZone L={L} />}
      </div>
    </div>
  );
}

function DangerZone({ L }: { L: any }) {
  const [name, setName] = useState('');
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [err, setErr] = useState<any>(null);
  return (
    <Card className="ring-1 ring-bad/30">
      <SectionTitle>Delete league</SectionTitle>
      <p className="mb-2 text-[13px] text-muted">Permanently deletes rosters, results, chat and history for every member. Type the league name to confirm.</p>
      <Input aria-label="Confirm league name" value={name} onChange={(e) => setName(e.target.value)} placeholder={L.league.name} />
      <Button variant="danger" className="mt-2 w-full" icon={<Trash2 className="h-4 w-4" />} disabled={name !== L.league.name}
        onClick={async () => { try { await api().call('leagues.delete', { leagueId: L.league.id, confirmName: name }); toast('good', 'League deleted.'); await qc.invalidateQueries(); nav('/leagues'); } catch (e) { setErr(e); } }}>Delete league forever</Button>
      {err && <div className="mt-2"><ErrorNote error={err} /></div>}
    </Card>
  );
}

function ScoringTab({ L }: { L: any }) {
  const [rules, setRules] = useState(() => structuredClone(L.scoring));
  const [reason, setReason] = useState('');
  const [recalc, setRecalc] = useState({ from: Math.max(L.settings.season.startWeek, 1), to: Math.max(L.settings.season.startWeek, L.league.currentWeek - 1) });
  const [confirmRecalc, setConfirmRecalc] = useState(false);
  const save = useAction('leagues.updateScoring', { invalidate: ['league', 'matchups', 'roster', 'players'], success: (r: any) => `Scoring updated to version ${r.version}. Finalized weeks are unchanged.` });
  const recalcA = useAction('commish.recalculate', { invalidate: ['matchups', 'standings', 'commish'], success: (r: any) => `Recalculated ${r.results.length} week(s); ${r.results.reduce((a: number, x: any) => a + x.changes.length, 0)} matchup(s) changed.` });
  useEffect(() => setRules(structuredClone(L.scoring)), [L.league.scoringVersion]);
  const finalized = L.league.currentWeek - 1 >= L.settings.season.startWeek;
  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle sub="New rules apply immediately to the current and future weeks. Finalized weeks keep the rules they were scored with unless you recalculate them below.">Scoring rules · version {L.league.scoringVersion}</SectionTitle>
        <ScoringEditor rules={rules} set={setRules} />
        <div className="mt-5 flex flex-wrap items-end gap-2 border-t border-line pt-4">
          <div className="min-w-[220px] flex-1"><Field label="Reason (required, shown to the league)" htmlFor="sc-reason"><Input id="sc-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></Field></div>
          <Button variant="primary" disabled={reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate({ leagueId: L.league.id, rules, reason })}>Save scoring</Button>
        </div>
      </Card>
      <Card>
        <SectionTitle sub="Re-scores finalized weeks with the current rules. Results, standings and the audit log update; the league sees an activity entry.">Transparent recalculation</SectionTitle>
        {!finalized ? <p className="text-[13px] text-muted">No finalized weeks yet.</p> : (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="From week" htmlFor="rc-from"><Input id="rc-from" type="number" className="w-24" min={L.settings.season.startWeek} max={L.league.currentWeek - 1} value={recalc.from} onChange={(e) => setRecalc({ ...recalc, from: Number(e.target.value) })} /></Field>
            <Field label="To week" htmlFor="rc-to"><Input id="rc-to" type="number" className="w-24" min={recalc.from} max={L.league.currentWeek - 1} value={recalc.to} onChange={(e) => setRecalc({ ...recalc, to: Number(e.target.value) })} /></Field>
            <Button onClick={() => setConfirmRecalc(true)} icon={<RefreshCw className="h-4 w-4" />}>Recalculate</Button>
          </div>
        )}
      </Card>
      <ConfirmDialog open={confirmRecalc} onClose={() => setConfirmRecalc(false)} requireReason danger title={`Recalculate weeks ${recalc.from}–${recalc.to}?`} confirmLabel="Recalculate"
        body="Final scores for these weeks will be recomputed with the current scoring rules. Wins and losses may change." onConfirm={(reason) => recalcA.mutateAsync({ leagueId: L.league.id, fromWeek: recalc.from, toWeek: recalc.to, useCurrentScoring: true, reason })} />
    </div>
  );
}

function MembersTab({ L }: { L: any }) {
  const isCommish = L.role === 'commissioner';
  const [obs, setObs] = useState('');
  const [remove, setRemove] = useState<any>(null);
  const [transfer, setTransfer] = useState<any>(null);
  const [mute, setMute] = useState<any>(null);
  const muteA = useAction('chat.mute', { invalidate: ['league'], success: (r: any) => (r.until ? 'Member muted in chat.' : 'Member unmuted.') });
  const role = useAction('leagues.setRole', { invalidate: ['league'], success: 'Role updated.' });
  const addObs = useAction('leagues.addObserver', { invalidate: ['league'], success: 'Observer added.', onSuccess: () => setObs('') });
  const rm = useAction('leagues.removeMember', { invalidate: ['league'], success: 'Member removed.' });
  const tr = useAction('leagues.transfer', { invalidate: ['league'], success: 'Commissioner role transferred.' });
  const regen = useAction('leagues.regenerateInvite', { invalidate: ['league'], success: 'New invite code created; the old one no longer works.' });
  const diff = useAction('leagues.setAiDifficulty', { invalidate: ['league'], success: 'AI difficulty updated.' });
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <Card pad={false}>
        {L.members.map((m: any) => {
          const team = L.teams.find((t: any) => t.owner_user_id === m.user_id);
          return (
            <div key={m.user_id} className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3 first:border-t-0">
              <div className="min-w-0 flex-1"><div className="font-semibold">{m.display_name} <span className="font-normal text-muted">@{m.username}</span></div><div className="text-[12px] text-muted">{team?.name ?? 'No team'}{m.muted_until ? ` · muted until ${dateTime(m.muted_until)}` : ''}</div></div>
              {m.role === 'commissioner' ? <Badge tone="accent">Commissioner</Badge> : (
                <>
                  <Select aria-label="Role" className="h-9 w-auto" value={m.role} onChange={(e) => role.mutate({ leagueId: L.league.id, userId: m.user_id, role: e.target.value })}>
                    <option value="manager">Manager</option>
                    {isCommish && <option value="co_commissioner">Co-commissioner</option>}
                    <option value="observer" disabled={Boolean(team)}>Observer</option>
                  </Select>
                  {isCommish && m.role !== 'observer' && <Button size="sm" variant="ghost" onClick={() => setTransfer(m)}>Make commissioner</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setMute(m)}>{m.muted_until && Date.parse(m.muted_until) > Date.now() ? 'Unmute' : 'Mute'}</Button>
                  <Button size="sm" variant="ghost" className="text-bad" onClick={() => setRemove(m)}>Remove</Button>
                </>
              )}
            </div>
          );
        })}
        {L.teams.filter((t: any) => t.is_ai).map((t: any) => (
          <div key={t.id} className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
            <TeamChip className="flex-1" team={t} sub="AI manager" size={28} />
            <Select aria-label="AI difficulty" className="h-9 w-auto" value={t.ai_difficulty} onChange={(e) => diff.mutate({ teamId: t.id, difficulty: e.target.value })}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></Select>
          </div>
        ))}
      </Card>
      <div className="space-y-5">
        <Card>
          <SectionTitle>Invitations</SectionTitle>
          <div className="mb-2 rounded-lg bg-sunken px-3 py-2 text-center font-mono text-xl font-bold tracking-[.3em]">{L.league.inviteCode}</div>
          <Button size="sm" className="w-full" loading={regen.isPending} onClick={() => regen.mutate({ leagueId: L.league.id })}>Generate a new code</Button>
        </Card>
        <Card>
          <SectionTitle sub="Read-only access: observers can follow the league but cannot vote, chat or manage a team.">Add observer</SectionTitle>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addObs.mutate({ leagueId: L.league.id, username: obs }); }}>
            <Input aria-label="Username" placeholder="username" value={obs} onChange={(e) => setObs(e.target.value)} />
            <Button type="submit" disabled={!obs.trim()}>Add</Button>
          </form>
        </Card>
      </div>
      <ConfirmDialog open={Boolean(remove)} onClose={() => setRemove(null)} requireReason danger title={`Remove ${remove?.display_name}?`} confirmLabel="Remove member"
        body={L.league.status === 'setup' ? 'Their team is deleted.' : 'Their team stays in the league and an AI manager takes it over.'}
        onConfirm={(reason) => rm.mutateAsync({ leagueId: L.league.id, userId: remove.user_id, reason })} />
      <ConfirmDialog open={Boolean(mute)} onClose={() => setMute(null)} requireReason title={mute?.muted_until && Date.parse(mute.muted_until) > Date.now() ? `Unmute ${mute?.display_name}?` : `Mute ${mute?.display_name} for 24 hours?`} confirmLabel="Confirm"
        body="Muted members can read but not post in league chat." onConfirm={(reason) => muteA.mutateAsync({ leagueId: L.league.id, userId: mute.user_id, hours: mute.muted_until && Date.parse(mute.muted_until) > Date.now() ? 0 : 24, reason })} />
      <ConfirmDialog open={Boolean(transfer)} onClose={() => setTransfer(null)} requireReason title={`Transfer commissioner to ${transfer?.display_name}?`} confirmLabel="Transfer"
        body="You will become a co-commissioner. Only the new commissioner can reverse this." onConfirm={(reason) => tr.mutateAsync({ leagueId: L.league.id, userId: transfer.user_id, reason })} />
    </div>
  );
}

function RostersTab({ L }: { L: any }) {
  const [teamId, setTeamId] = useState(L.teams[0]?.id);
  const [q, setQ] = useState('');
  const [action, setAction] = useState<{ add?: any; remove?: any } | null>(null);
  const { data: roster } = useCall<any>(['roster', teamId], 'rosters.get', { teamId }, { enabled: Boolean(teamId) && L.league.status !== 'setup' });
  const { data: search } = useCall<any>(['players', 'commish', q], 'players.search', { leagueId: L.league.id, q: q || undefined, status: 'available', limit: 8 }, { enabled: q.length >= 2 });
  const edit = useAction('rosters.commishEdit', { invalidate: ['roster', 'players', 'commish'], success: (r: any) => r.summary });
  if (L.league.status === 'setup') return <Empty title="Rosters are empty" body="Corrections become available after the draft. To build rosters without a live draft, use Auto-draft in the Draft room." />;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <SectionTitle sub="Emergency corrections and manual roster construction. The manager is notified and the change is audited.">Team roster</SectionTitle>
        <Select aria-label="Team" value={teamId} onChange={(e) => setTeamId(e.target.value)}>{L.teams.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        <div className="mt-3 max-h-[420px] overflow-y-auto">
          {roster && [...roster.starters, ...roster.bench].map((p: any) => (
            <div key={p.playerId} className="flex items-center gap-2 border-b border-line py-1.5 text-[13px] last:border-0">
              <span className="w-10 font-display font-semibold text-muted">{p.slot}</span><span className="flex-1 truncate font-semibold">{p.name}</span><span className="text-muted">{p.position}</span>
              <Button size="sm" variant="ghost" className="text-bad" onClick={() => setAction({ remove: p })}>Remove</Button>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <SectionTitle>Add a player to this team</SectionTitle>
        <Input aria-label="Search available players" placeholder="Search available players" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="mt-2 space-y-1">
          {search?.players?.map((p: any) => (
            <div key={p.id} className="flex items-center gap-2 rounded-lg bg-raised px-3 py-1.5 text-[13px]"><span className="flex-1 font-semibold">{p.name}</span><span className="text-muted">{p.position} · {p.nflTeamId}</span><Button size="sm" onClick={() => setAction({ add: p })}>Add</Button></div>
          ))}
        </div>
      </Card>
      <ConfirmDialog open={Boolean(action)} onClose={() => setAction(null)} requireReason title={action?.add ? `Add ${action.add.name}` : `Remove ${action?.remove?.name}`} confirmLabel="Apply correction"
        body="This bypasses waivers and normal roster rules except roster size. Use it to fix errors or set up teams manually."
        onConfirm={(reason) => edit.mutateAsync({ teamId, addPlayerId: action?.add?.id ?? null, removePlayerId: action?.remove?.playerId ?? null, reason })} />
    </div>
  );
}

function AuditTab({ leagueId }: { leagueId: string }) {
  const { data } = useCall<any[]>(['commish', 'audit', leagueId], 'audit.list', { leagueId, limit: 200 });
  if (!data) return <LoadingBlock />;
  return (
    <div className="scroll-x rounded-card bg-surface hairline">
      <table className="w-full min-w-[640px] text-[13px]">
        <thead className="border-b border-line text-left text-muted"><tr><th className="px-3 py-2.5">When</th><th>Actor</th><th>Action</th><th>Reason</th></tr></thead>
        <tbody>
          {data.map((a) => (
            <tr key={a.id} className="border-b border-line last:border-0 align-top">
              <td className="whitespace-nowrap px-3 py-2 text-muted">{dateTime(a.created_at)}</td>
              <td className="py-2">{a.actor_name ?? <Badge>{a.actor_kind}</Badge>}</td>
              <td className="py-2 font-mono text-[12px]">{a.action}</td>
              <td className="py-2 pr-3 text-muted">{a.reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-3 py-2 text-[12px] text-faint">The audit log is append-only: the database rejects any edit or deletion.</p>
    </div>
  );
}
