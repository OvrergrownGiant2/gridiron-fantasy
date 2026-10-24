import { TEMPLATE_INFO, buildTemplate, type LeagueTemplateId } from '@gridiron/core';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Settings2, Swords, Trophy, User, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { Button, Card, ErrorNote, Field, Input, PageHeader, Segmented, Toggle, cx, useToast } from '../components/ui';
import { rememberLeague, useDataStatus } from '../lib/hooks';

const ICONS: Record<LeagueTemplateId, typeof User> = { solo: User, duel: Swords, league: Users };
const TEAM_LABEL: Record<LeagueTemplateId, string> = { solo: '1 player', duel: '2 players', league: '3–10 players' };

/** Quick creation from three templates. The full wizard stays available as "Advanced setup". */
export function QuickCreate() {
  const [params] = useSearchParams();
  const initial = (['solo', 'duel', 'league'] as const).find((t) => t === params.get('template')) ?? null;
  const [tpl, setTpl] = useState<LeagueTemplateId | null>(initial);
  const [name, setName] = useState('');
  const [teamName, setTeamName] = useState('');
  const [scoring, setScoring] = useState<'ppr' | 'half_ppr' | 'standard'>('ppr');
  const [opponent, setOpponent] = useState<'ai' | 'friend'>('ai');
  const [teamCount, setTeamCount] = useState(8);
  const [fillWithAi, setFillWithAi] = useState(false);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [draftMode, setDraftMode] = useState<'live' | 'auto'>('live');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const { data: status } = useDataStatus();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  useEffect(() => { if (tpl) setName(TEMPLATE_INFO[tpl].defaultName); setErr(null); }, [tpl]);
  const result = useMemo(() => tpl ? buildTemplate(tpl, { currentWeek: status?.week ?? 1, scoring, opponent, teamCount, fillWithAi, difficulty }) : null, [tpl, status?.week, scoring, opponent, teamCount, fillWithAi, difficulty]);
  const autoStart = Boolean(result?.canStartImmediately && draftMode === 'auto');
  const liveStart = Boolean(result?.canStartImmediately && draftMode === 'live');

  const create = async () => {
    if (!tpl || !result) return;
    setBusy(true); setErr(null);
    try {
      const r = await api().call<any>('leagues.create', {
        name: name.trim() || TEMPLATE_INFO[tpl].defaultName, teamName: teamName.trim() || 'My Team',
        teamCount: result.teamCount, aiTeams: result.aiTeams, aiDifficulty: difficulty, settings: result.settings, scoringPreset: result.scoringPreset,
        visibility: 'private', description: TEMPLATE_INFO[tpl].tagline,
      });
      rememberLeague(r.id);
      api().sessionChanged();
      if (autoStart) {
        await api().call('drafts.autoAll', { leagueId: r.id });
        await qc.invalidateQueries();
        toast('good', 'Your roster is drafted and the season schedule is set.');
        nav(`/league/${r.id}/team`);
      } else if (liveStart) {
        // Everyone else is an AI: open the draft room straight away. You make every one of your picks.
        await api().call('drafts.configure', { leagueId: r.id });
        await api().call('drafts.start', { leagueId: r.id });
        await qc.invalidateQueries();
        toast('good', tpl === 'solo' ? 'Your draft is open: pick every player on your roster.' : "The draft is live. You're picking against AI managers.");
        nav(`/league/${r.id}/draft`);
      } else {
        await qc.invalidateQueries();
        toast('good', `League created. Invite code: ${r.inviteCode}`);
        nav(`/league/${r.id}/draft`);
      }
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader eyebrow="New league" title="Pick a game mode" sub="Sensible rules are set for you. You can change any of them later as commissioner."
        actions={<Link to="/leagues/new/advanced"><Button variant="ghost" icon={<Settings2 className="h-4 w-4" />}>Advanced setup</Button></Link>} />

      <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Game mode">
        {(['solo', 'duel', 'league'] as const).map((id) => {
          const Icon = ICONS[id];
          const on = tpl === id;
          return (
            <button key={id} role="radio" aria-checked={on} onClick={() => setTpl(id)}
              className={cx('relative flex flex-col items-start gap-2 rounded-card bg-surface p-4 text-left hairline transition hover:-translate-y-0.5 hover:shadow-lg', on && 'ring-2 ring-accent')}>
              {on && <span className="absolute right-3 top-3 rounded-full bg-accent p-1 text-accent-ink"><Check className="h-3.5 w-3.5" /></span>}
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-turf text-white"><Icon className="h-5 w-5" /></span>
              <span className="label">{TEAM_LABEL[id]}</span>
              <span className="font-display text-2xl font-bold uppercase leading-none tracking-wide">{TEMPLATE_INFO[id].title}</span>
              <span className="text-[13px] text-muted">{TEMPLATE_INFO[id].tagline}</span>
            </button>
          );
        })}
      </div>

      {tpl && result && (
        <Card className="animate-slideUp">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="League name" htmlFor="qc-name"><Input id="qc-name" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Your team name" htmlFor="qc-team"><Input id="qc-team" value={teamName} maxLength={40} placeholder="My Team" onChange={(e) => setTeamName(e.target.value)} /></Field>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Scoring"><Segmented value={scoring} onChange={setScoring} options={[{ value: 'ppr', label: 'PPR' }, { value: 'half_ppr', label: 'Half-PPR' }, { value: 'standard', label: 'Standard' }]} /></Field>
            {tpl === 'duel' && <Field label="Opponent"><Segmented value={opponent} onChange={setOpponent} options={[{ value: 'ai', label: 'AI manager' }, { value: 'friend', label: 'Invite a friend' }]} /></Field>}
            {tpl === 'league' && (
              <Field label={`Teams: ${teamCount}`} htmlFor="qc-count">
                <input id="qc-count" type="range" min={3} max={10} value={teamCount} onChange={(e) => setTeamCount(Number(e.target.value))} className="accent-[rgb(var(--accent))]" />
              </Field>
            )}
          </div>
          {tpl === 'league' && <div className="mt-2"><Toggle label="Fill the other seats with AI managers now" checked={fillWithAi} onChange={setFillWithAi} /></div>}
          {(tpl === 'duel' && opponent === 'ai') || (tpl === 'league' && fillWithAi) ? (
            <div className="mt-3"><Field label="AI difficulty"><Segmented value={difficulty} onChange={setDifficulty} options={[{ value: 'easy', label: 'Easy' }, { value: 'medium', label: 'Medium' }, { value: 'hard', label: 'Hard' }]} /></Field></div>
          ) : null}
          {result.canStartImmediately && (
            <div className="mt-4"><Field label="Draft">
              <Segmented value={draftMode} onChange={setDraftMode} options={[{ value: 'live', label: 'I pick every player' }, { value: 'auto', label: 'Auto-draft for me' }]} />
            </Field>
            <p className="mt-1.5 text-[12px] text-muted">{draftMode === 'live' ? (tpl === 'solo' ? `You draft every roster spot yourself, one pick at a time, with photos, ratings and stats for every player.` : 'A live snake draft against the AI managers. You see photos, ratings and stats for every player as you pick.') : 'Your roster is built instantly from rankings and positional needs.'}</p></div>
          )}

          <div className="mt-5 rounded-xl bg-raised p-4">
            <div className="label mb-2 flex items-center gap-1.5"><Trophy className="h-3.5 w-3.5" /> What you get</div>
            <ul className="grid gap-1.5 text-[13px] sm:grid-cols-2">
              {result.summary.map((s) => <li key={s} className="flex items-start gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" />{s}</li>)}
              <li className="flex items-start gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" />{scoring === 'ppr' ? 'Full PPR' : scoring === 'half_ppr' ? 'Half-PPR' : 'Standard'} scoring · QB, 2 RB, 2 WR, TE, FLEX, K, DST + 6 bench</li>
              <li className="flex items-start gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" />{autoStart ? 'Roster drafted for you instantly' : liveStart ? (tpl === 'solo' ? 'Full draft: you pick every player' : 'Live snake draft vs AI, starts now') : 'Live draft once friends join, every manager picks their own team'}</li>
            </ul>
            {status?.provider?.snapshotAsOf && (
              <p className="mt-3 text-[12px] text-muted">This copy uses a data snapshot from {String(status.provider.snapshotAsOf).slice(0, 10)}. New leagues start with the next NFL week, which gets results only after the snapshot is refreshed.</p>
            )}
          </div>

          {err && <div className="mt-4"><ErrorNote error={err} /></div>}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <Link to="/leagues/new/advanced" className="text-[13px] font-semibold text-muted hover:text-ink">Need custom rules? Advanced setup</Link>
            <Button variant="primary" size="lg" loading={busy} onClick={create}>{autoStart ? 'Create and start' : liveStart ? 'Create and draft' : 'Create league'}</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
