import { defaultLeagueSettings, scoringPreset, validateLeagueSettings, type LeagueSettings, type ScoringRules } from '@gridiron/core';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, Globe, Lock, PlusCircle, UserPlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { DraftEditor, RosterEditor, ScoringEditor, SeasonEditor, WaiverTradeEditor } from '../components/settingsEditors';
import { TeamChip } from '../components/team';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, LoadingBlock, PageHeader, SectionTitle, Segmented, Select, Textarea, cx, useToast } from '../components/ui';
import { rememberLeague, useAction, useCall, useMyLeagues } from '../lib/hooks';

export function Leagues() {
  const { data: leagues, isLoading } = useMyLeagues();
  const [params] = useSearchParams();
  return (
    <div className="space-y-8">
      <PageHeader title="My Leagues" sub="Every league is independent: its own rosters, rules, waivers, trades and chat."
        actions={<Link to="/leagues/new"><Button variant="primary" icon={<PlusCircle className="h-4 w-4" />}>Create league</Button></Link>} />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <section className="min-w-0">
          {isLoading ? <LoadingBlock /> : !leagues?.length ? (
            <Empty title="No leagues yet" body="Create a league, join with an invite code, or start a solo league against AI managers." action={<Link to="/leagues/new?template=solo"><Button variant="primary">Start a High Score Challenge</Button></Link>} />
          ) : (
            <div className="overflow-hidden rounded-card bg-surface hairline">
              {leagues.map((l: any, i: number) => (
                <Link key={l.id} to={`/league/${l.id}/${l.status === 'setup' || l.status === 'drafting' ? 'draft' : 'team'}`} onClick={() => rememberLeague(l.id)}
                  className={cx('flex flex-wrap items-center gap-3 px-4 py-3.5 transition hover:bg-raised', i > 0 && 'border-t border-line')}>
                  <TeamChip className="min-w-[200px] flex-1" team={{ name: l.name, abbrev: l.abbrev, primary_color: l.primary_color, secondary_color: l.secondary_color, logo_media_id: l.team_logo_media_id, logo_preset: l.logo_preset }} sub={`${l.team_name ?? 'Observer'} · ${l.team_count}/${l.max_teams} teams`} size={38} />
                  <div className="flex flex-wrap items-center gap-2">
                    {l.visibility === 'public' ? <Badge><Globe className="h-3 w-3" /> Public</Badge> : <Badge><Lock className="h-3 w-3" /> Private</Badge>}
                    <Badge tone={l.role === 'commissioner' ? 'accent' : l.role === 'co_commissioner' ? 'info' : 'neutral'}>{l.role.replace('_', '-')}</Badge>
                    <Badge tone={l.status === 'in_season' ? 'good' : 'neutral'}>{l.status.replace('_', ' ')}{l.status === 'in_season' || l.status === 'playoffs' ? ` · wk ${l.current_week}` : ''}</Badge>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
        <aside className="space-y-6">
          <JoinCard initialOpen={params.get('join') === '1'} />
          <PublicLeagues />
        </aside>
      </div>
    </div>
  );
}

function JoinCard({ initialOpen, code: preset }: { initialOpen?: boolean; code?: string }) {
  const [code, setCode] = useState(preset ?? '');
  const [teamName, setTeamName] = useState('');
  const nav = useNavigate();
  const join = useAction('leagues.join', { invalidate: ['league', 'dashboard'], success: 'You joined the league.', onSuccess: (r: any) => { rememberLeague(r.leagueId); api().sessionChanged(); nav(`/league/${r.leagueId}/team`); } });
  return (
    <Card>
      <SectionTitle sub="Enter the 8-character code from your commissioner.">Join a league</SectionTitle>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); join.mutate({ inviteCode: code, teamName }); }}>
        <Field label="Invite code" htmlFor="join-code"><Input id="join-code" autoFocus={initialOpen} value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))} placeholder="e.g. K7MQ2PXA" className="font-mono tracking-widest" required /></Field>
        <Field label="Your team name" htmlFor="join-team" hint="You can change it later."><Input id="join-team" value={teamName} onChange={(e) => setTeamName(e.target.value)} maxLength={40} /></Field>
        <Button type="submit" variant="primary" className="w-full" loading={join.isPending} disabled={code.length < 8} icon={<UserPlus className="h-4 w-4" />}>Join league</Button>
      </form>
      {api().mode === 'demo' && (
        <p className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-[12.5px] text-ink">
          <b>Joining only works on the device where the league was created.</b> This version of Gridiron keeps every league inside the browser that made it, so a code from a friend's phone or computer can't be found here. To play with friends on their own devices, the app needs the online (server) version.
        </p>
      )}
    </Card>
  );
}

function PublicLeagues() {
  const { data } = useCall<any[]>(['league', 'public'], 'leagues.public');
  const nav = useNavigate();
  const join = useAction('leagues.join', { invalidate: ['league', 'dashboard'], success: 'You joined the league.', onSuccess: (r: any) => { rememberLeague(r.leagueId); nav(`/league/${r.leagueId}/team`); } });
  if (!data?.length) return null;
  return (
    <Card>
      <SectionTitle sub="Open leagues anyone can join.">Public leagues</SectionTitle>
      <div className="space-y-2">
        {data.map((l) => (
          <div key={l.id} className="flex items-center justify-between gap-2 rounded-lg bg-raised px-3 py-2">
            <div className="min-w-0"><div className="truncate font-semibold">{l.name}</div><div className="text-[12px] text-muted">{l.humans} managers · {l.teams}/{l.max_teams} teams</div></div>
            <Button size="sm" onClick={() => join.mutate({ inviteCode: '', leagueId: l.id })}>Join</Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function JoinByLink() {
  const { code } = useParams();
  return (
    <div className="mx-auto max-w-md space-y-4">
      <PageHeader title="You're invited" sub="Confirm your team name to join." />
      <JoinCard initialOpen code={code} />
    </div>
  );
}

// ------------------------------------------------------------------ creation wizard

const STEPS = ['Basics', 'Roster', 'Scoring', 'Season', 'Waivers & trades', 'Draft', 'Review'] as const;

export function CreateLeague() {
  const [params] = useSearchParams();
  const solo = params.get('solo') === '1';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: status } = useCall<any>(['nflStatus'], 'nfl.status');
  const [step, setStep] = useState(0);
  const [basics, setBasics] = useState({ name: solo ? 'Solo Practice League' : '', description: '', visibility: 'private' as 'private' | 'public', teamCount: solo ? 8 : 10, aiTeams: solo ? 7 : 0, aiDifficulty: 'medium' as 'easy' | 'medium' | 'hard', teamName: '' });
  const [settings, setSettings] = useState<LeagueSettings>(() => defaultLeagueSettings());
  const [rules, setRules] = useState<ScoringRules>(() => scoringPreset('ppr'));
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  // Fit the default season to the NFL calendar once the current week is known.
  useEffect(() => {
    const w = status?.week;
    if (!w) return;
    setSettings((s) => {
      if (s.season.startWeek >= w) return s;
      const start = Math.min(17, w + 1);
      const rounds = s.season.playoffTeams >= 2 ? Math.ceil(Math.log2(s.season.playoffTeams)) : 0;
      const weeks = Math.max(1, Math.min(s.season.regularSeasonWeeks, 18 - start + 1 - rounds));
      return { ...s, season: { ...s.season, startWeek: start, regularSeasonWeeks: weeks }, trades: { ...s.trades, tradeDeadlineWeek: Math.min(start + weeks - 1, start + Math.floor(weeks * 0.7)) } };
    });
  }, [status?.week]);

  const issues = useMemo(() => validateLeagueSettings(settings, basics.teamCount), [settings, basics.teamCount]);
  const basicsOk = basics.name.trim().length >= 3 && basics.teamName.trim().length >= 2 && basics.aiTeams <= basics.teamCount - 1;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api().call<any>('leagues.create', { ...basics, settings, scoring: rules });
      rememberLeague(r.id);
      api().sessionChanged();
      await qc.invalidateQueries();
      toast('good', 'League created. Set up your draft next.');
      nav(`/league/${r.id}/draft`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader eyebrow="New league" title={solo ? 'Solo league' : 'Create a league'} sub={solo ? 'Play a full season against AI managers who follow the same rules you do.' : 'Every setting can be changed later by the commissioner, within the rules of a running season.'} />
      <ol className="scroll-x mb-6 flex gap-1.5">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button onClick={() => (i === 0 || basicsOk) && setStep(i)} className={cx('flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition',
              i === step ? 'bg-ink text-bg' : i < step ? 'bg-accent/15 text-accent' : 'bg-sunken text-muted')}>
              {i < step ? <Check className="h-3.5 w-3.5" /> : <span className="num">{i + 1}</span>} {s}
            </button>
          </li>
        ))}
      </ol>
      <Card>
        {step === 0 && <BasicsStep b={basics} set={setBasics} />}
        {step === 1 && <RosterEditor s={settings} set={setSettings} />}
        {step === 2 && <ScoringEditor rules={rules} set={setRules} />}
        {step === 3 && <SeasonEditor s={settings} set={setSettings} />}
        {step === 4 && <WaiverTradeEditor s={settings} set={setSettings} />}
        {step === 5 && <DraftEditor s={settings} set={setSettings} />}
        {step === 6 && <ReviewStep basics={basics} s={settings} rules={rules} />}
        {issues.length > 0 && step > 0 && (
          <div className="mt-5 rounded-lg bg-warn/12 p-3 text-[13px]">
            <div className="mb-1 font-semibold text-warn">Fix before creating:</div>
            <ul className="list-disc space-y-0.5 pl-5">{issues.map((i) => <li key={i.path + i.message}>{i.message}</li>)}</ul>
          </div>
        )}
        {err && <div className="mt-4"><ErrorNote error={err} />{err.details && Array.isArray(err.details) && <ul className="mt-2 list-disc pl-5 text-[13px] text-bad">{err.details.map((d: any, i: number) => <li key={i}>{d.message}</li>)}</ul>}</div>}
        <div className="mt-6 flex items-center justify-between gap-2 border-t border-line pt-4">
          <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)} icon={<ChevronLeft className="h-4 w-4" />}>Back</Button>
          {step < STEPS.length - 1
            ? <Button variant="primary" disabled={step === 0 && !basicsOk} onClick={() => setStep(step + 1)}>Next <ChevronRight className="h-4 w-4" /></Button>
            : <Button variant="primary" loading={busy} disabled={issues.length > 0 || !basicsOk} onClick={submit}>Create league</Button>}
        </div>
      </Card>
    </div>
  );
}

function BasicsStep({ b, set }: { b: any; set: (b: any) => void }) {
  const humans = b.teamCount - b.aiTeams;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="League name" htmlFor="lg-name"><Input id="lg-name" value={b.name} onChange={(e) => set({ ...b, name: e.target.value })} maxLength={50} placeholder="Sunday Funday League" /></Field>
        <Field label="Your team name" htmlFor="lg-team"><Input id="lg-team" value={b.teamName} onChange={(e) => set({ ...b, teamName: e.target.value })} maxLength={40} placeholder="Gridiron Gang" /></Field>
      </div>
      <Field label="Description" htmlFor="lg-desc"><Textarea id="lg-desc" value={b.description} onChange={(e) => set({ ...b, description: e.target.value })} maxLength={500} placeholder="House rules, buy-in, trash talk policy…" /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Visibility"><Segmented value={b.visibility} onChange={(v) => set({ ...b, visibility: v })} options={[{ value: 'private', label: 'Private (invite only)' }, { value: 'public', label: 'Public' }]} /></Field>
        <Field label="Teams in the league" htmlFor="lg-size" hint="1 to 10. Empty seats can be filled by friends or AI managers later.">
          <Select id="lg-size" value={b.teamCount} onChange={(e) => { const n = Number(e.target.value); set({ ...b, teamCount: n, aiTeams: Math.min(b.aiTeams, n - 1) }); }}>
            {Array.from({ length: 10 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} team{i ? 's' : ''}</option>)}
          </Select>
        </Field>
      </div>
      <div className="rounded-xl bg-raised p-4">
        <div className="label mb-2">AI managers</div>
        <p className="mb-3 text-[13px] text-muted">AI managers draft, set lineups, file waiver claims and answer trade offers using the same validated actions as people. A new human who joins later can take over an AI seat.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Number of AI managers" htmlFor="lg-ai" hint={`${humans} seat${humans === 1 ? '' : 's'} for people (including you).`}>
            <Select id="lg-ai" value={b.aiTeams} onChange={(e) => set({ ...b, aiTeams: Number(e.target.value) })}>{Array.from({ length: b.teamCount }, (_, i) => <option key={i} value={i}>{i}</option>)}</Select>
          </Field>
          <Field label="Difficulty"><Segmented value={b.aiDifficulty} onChange={(v) => set({ ...b, aiDifficulty: v })} options={[{ value: 'easy', label: 'Easy' }, { value: 'medium', label: 'Medium' }, { value: 'hard', label: 'Hard' }]} /></Field>
        </div>
      </div>
      {b.teamCount === 1 && <p className="rounded-lg bg-info/10 p-3 text-[13px] text-info">A one-team league is a personal points challenge. Use total-points standings in the Season step.</p>}
    </div>
  );
}

function ReviewStep({ basics, s, rules }: { basics: any; s: LeagueSettings; rules: ScoringRules }) {
  const r = s.roster;
  const rows: [string, string][] = [
    ['League', `${basics.name} · ${basics.visibility}`],
    ['Teams', `${basics.teamCount} (${basics.aiTeams} AI, ${basics.aiDifficulty})`],
    ['Roster', `QB ${r.QB} · RB ${r.RB} · WR ${r.WR} · TE ${r.TE} · FLEX ${r.FLEX}${r.SUPERFLEX ? ` · SF ${r.SUPERFLEX}` : ''} · K ${r.K} · DST ${r.DST} · BN ${r.BN} · IR ${r.IR}`],
    ['Scoring', `${rules.preset.replace('_', '-').toUpperCase()} · ${rules.perStat.rec ?? 0} per reception · ${rules.perStat.pass_td ?? 0} per passing TD${rules.bonuses.length ? ` · ${rules.bonuses.length} bonuses` : ''}`],
    ['Season', `Weeks ${s.season.startWeek}–${s.season.startWeek + s.season.regularSeasonWeeks - 1} · ${s.season.playoffTeams || 'no'} playoff teams · ${s.season.standingsMode.replace('_', ' ')}`],
    ['Waivers', s.waivers.mode === 'faab' ? `FAAB $${s.waivers.faabBudget}` : s.waivers.mode.replace('_', ' ')],
    ['Trades', `${s.trades.review.replace('_', ' ')} review · deadline ${s.trades.tradeDeadlineWeek ? `after week ${s.trades.tradeDeadlineWeek}` : 'none'}`],
    ['Draft', `${s.draft.type} · ${s.draft.pickSeconds}s per pick`],
  ];
  return (
    <dl className="divide-y divide-line">
      {rows.map(([k, v]) => <div key={k} className="grid gap-1 py-2.5 sm:grid-cols-[140px_1fr]"><dt className="label">{k}</dt><dd className="text-[14px]">{v}</dd></div>)}
    </dl>
  );
}
