import { STAT_KEYS, STAT_LABELS, activeRosterSize, playoffRounds, scoringPreset, starterCount, type LeagueSettings, type ScoringRules } from '@gridiron/core';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { Button, Field, Input, Segmented, Select, Toggle, cx } from './ui';

type Upd<T> = (next: T) => void;

function Stepper({ value, onChange, min = 0, max, label, id }: { value: number; onChange: (v: number) => void; min?: number; max: number; label: string; id: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-raised px-3 py-2">
      <label htmlFor={id} className="font-display text-lg font-semibold tracking-wide">{label}</label>
      <div className="flex items-center gap-1">
        <button type="button" aria-label={`Fewer ${label}`} className="rounded-md p-1.5 hover:bg-sunken disabled:opacity-40" disabled={value <= min} onClick={() => onChange(value - 1)}><Minus className="h-4 w-4" /></button>
        <input id={id} className="num w-10 bg-transparent text-center font-display text-xl font-bold" value={value} inputMode="numeric"
          onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, '')); if (!Number.isNaN(n)) onChange(Math.max(min, Math.min(max, n))); }} />
        <button type="button" aria-label={`More ${label}`} className="rounded-md p-1.5 hover:bg-sunken disabled:opacity-40" disabled={value >= max} onClick={() => onChange(value + 1)}><Plus className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

export function RosterEditor({ s, set, locked }: { s: LeagueSettings; set: Upd<LeagueSettings>; locked?: boolean }) {
  const r = s.roster;
  const put = (k: string, v: any) => set({ ...s, roster: { ...r, [k]: v } });
  const slots: [keyof typeof r, string, number][] = [['QB', 'QB', 3], ['RB', 'RB', 5], ['WR', 'WR', 5], ['TE', 'TE', 3], ['FLEX', 'FLEX', 4], ['SUPERFLEX', 'SUPERFLEX', 2], ['K', 'K', 2], ['DST', 'DST', 2], ['BN', 'Bench', 12], ['IR', 'IR', 4]];
  return (
    <fieldset disabled={locked} className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        {slots.map(([k, label, max]) => <Stepper key={k} id={`slot-${k}`} label={label} value={r[k] as number} max={max} onChange={(v) => put(k, v)} />)}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted">
        <span><b className="text-ink">{starterCount(r)}</b> starters</span>
        <span><b className="text-ink">{activeRosterSize(r)}</b> active roster spots (draft rounds)</span>
        <span><b className="text-ink">{r.IR}</b> IR</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="FLEX accepts">
          <div className="flex gap-2">
            {(['RB', 'WR', 'TE'] as const).map((p) => (
              <label key={p} className={cx('flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 hairline', r.flexEligible.includes(p) && 'bg-accent/12')}>
                <input type="checkbox" checked={r.flexEligible.includes(p)} onChange={(e) => {
                  const next = e.target.checked ? [...r.flexEligible, p] : r.flexEligible.filter((x) => x !== p);
                  if (next.length) put('flexEligible', next);
                }} /> {p}
              </label>
            ))}
          </div>
        </Field>
        <Field label="IR eligible designations">
          <div className="flex flex-wrap gap-2">
            {(['out', 'ir', 'pup', 'suspended', 'doubtful'] as const).map((p) => (
              <label key={p} className={cx('flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-2 text-[13px] uppercase hairline', r.irEligible.includes(p) && 'bg-accent/12')}>
                <input type="checkbox" checked={r.irEligible.includes(p)} onChange={(e) => {
                  const next = e.target.checked ? [...r.irEligible, p] : r.irEligible.filter((x) => x !== p);
                  if (next.length) put('irEligible', next);
                }} /> {p}
              </label>
            ))}
          </div>
        </Field>
      </div>
      <Field label="Maximum players per position (0 = no limit)">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {(['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const).map((p) => (
            <label key={p} className="flex flex-col gap-1 text-[12px] font-semibold text-muted">{p}
              <Input id={`limit-${p}`} inputMode="numeric" value={r.positionLimits[p] ?? 0} onChange={(e) => put('positionLimits', { ...r.positionLimits, [p]: Math.min(20, Number(e.target.value.replace(/\D/g, '')) || 0) })} />
            </label>
          ))}
        </div>
      </Field>
    </fieldset>
  );
}

const GROUPS: { title: string; keys: (typeof STAT_KEYS)[number][] }[] = [
  { title: 'Passing', keys: ['pass_yd', 'pass_td', 'pass_int', 'pass_2pt'] },
  { title: 'Rushing', keys: ['rush_yd', 'rush_td', 'rush_2pt'] },
  { title: 'Receiving', keys: ['rec', 'rec_yd', 'rec_td', 'rec_2pt'] },
  { title: 'Miscellaneous', keys: ['fum_lost', 'ret_td', 'off_fum_rec_td'] },
  { title: 'Kicking', keys: ['fgm_0_39', 'fgm_40_49', 'fgm_50p', 'fg_miss', 'xpm', 'xp_miss'] },
  { title: 'Defense & special teams', keys: ['def_sack', 'def_int', 'def_fum_rec', 'def_td', 'st_td', 'def_safety', 'def_blk_kick'] },
];

function NumberCell({ value, onChange, id, step = 'any' }: { value: number; onChange: (n: number) => void; id: string; step?: string }) {
  return <Input id={id} type="number" step={step} className="num h-9 w-24 text-right" value={Number.isFinite(value) ? value : 0} onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />;
}

export function ScoringEditor({ rules, set }: { rules: ScoringRules; set: Upd<ScoringRules> }) {
  const per = (k: string, v: number) => set({ ...rules, preset: 'custom', perStat: { ...rules.perStat, [k]: v } });
  return (
    <div className="space-y-5">
      <Segmented value={rules.preset} onChange={(p) => p === 'custom' ? set({ ...rules, preset: 'custom' }) : set(scoringPreset(p))}
        options={[{ value: 'standard', label: 'Standard' }, { value: 'half_ppr', label: 'Half-PPR' }, { value: 'ppr', label: 'Full PPR' }, { value: 'custom', label: 'Custom' }]} />
      <div className="grid gap-4 md:grid-cols-2">
        {GROUPS.map((g) => (
          <div key={g.title} className="rounded-xl bg-raised p-3">
            <div className="label mb-2">{g.title}</div>
            <div className="divide-y divide-line">
              {g.keys.map((k) => (
                <div key={k} className="flex items-center justify-between gap-3 py-1.5">
                  <label htmlFor={`sc-${k}`} className="text-[13px]">{STAT_LABELS[k]}{k.endsWith('_yd') ? <span className="text-faint"> · per yard</span> : ''}</label>
                  <NumberCell id={`sc-${k}`} value={rules.perStat[k] ?? 0} onChange={(v) => per(k, v)} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <TierEditor title="Defense: points allowed" tiers={rules.pointsAllowedTiers} unit="points" onChange={(t) => set({ ...rules, preset: 'custom', pointsAllowedTiers: t })} />
      <TierEditor title="Defense: yards allowed (optional)" tiers={rules.yardsAllowedTiers} unit="yards" onChange={(t) => set({ ...rules, preset: 'custom', yardsAllowedTiers: t })} />
      <div className="rounded-xl bg-raised p-3">
        <div className="mb-2 flex items-center justify-between"><span className="label">Custom bonuses and penalties</span>
          <Button size="sm" type="button" onClick={() => set({ ...rules, preset: 'custom', bonuses: [...rules.bonuses, { id: `b${Date.now().toString(36)}`, label: '100+ rushing yards', stat: 'rush_yd', threshold: 100, comparator: 'gte', points: 3 }] })} icon={<Plus className="h-4 w-4" />}>Add</Button>
        </div>
        {rules.bonuses.length === 0 && <p className="text-[13px] text-muted">No bonuses. Example: +3 for 100+ rushing yards, −2 for under 5 passing yards.</p>}
        <div className="space-y-2">
          {rules.bonuses.map((b, i) => {
            const upd = (patch: Partial<typeof b>) => set({ ...rules, preset: 'custom', bonuses: rules.bonuses.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={b.id} className="grid grid-cols-2 gap-2 rounded-lg bg-surface p-2 hairline sm:grid-cols-[1.4fr_1.2fr_.7fr_.8fr_.8fr_auto] sm:items-center">
                <Input aria-label="Bonus label" value={b.label} onChange={(e) => upd({ label: e.target.value.slice(0, 60) })} />
                <Select aria-label="Statistic" value={b.stat} onChange={(e) => upd({ stat: e.target.value as any })}>{STAT_KEYS.map((k) => <option key={k} value={k}>{STAT_LABELS[k]}</option>)}</Select>
                <Select aria-label="Comparison" value={b.comparator} onChange={(e) => upd({ comparator: e.target.value as any })}><option value="gte">≥</option><option value="lte">≤</option></Select>
                <Input aria-label="Threshold" type="number" value={b.threshold} onChange={(e) => upd({ threshold: Number(e.target.value) })} />
                <Input aria-label="Points" type="number" step="any" value={b.points} onChange={(e) => upd({ points: Number(e.target.value) })} />
                <Button size="sm" variant="ghost" type="button" aria-label="Remove bonus" onClick={() => set({ ...rules, bonuses: rules.bonuses.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TierEditor({ title, tiers, onChange, unit }: { title: string; tiers: { max: number | null; points: number }[]; onChange: (t: { max: number | null; points: number }[]) => void; unit: string }) {
  return (
    <div className="rounded-xl bg-raised p-3">
      <div className="mb-2 flex items-center justify-between"><span className="label">{title}</span>
        <Button size="sm" type="button" icon={<Plus className="h-4 w-4" />} onClick={() => {
          const finite = tiers.filter((t) => t.max !== null);
          const last = finite.length ? finite[finite.length - 1].max! : -1;
          const next = [...finite, { max: last + 7, points: 0 }, ...(tiers.some((t) => t.max === null) ? tiers.filter((t) => t.max === null) : [{ max: null, points: 0 }])];
          onChange(next);
        }}>Tier</Button>
      </div>
      {tiers.length === 0 ? <p className="text-[13px] text-muted">Not scored.</p> : (
        <div className="scroll-x">
          <table className="w-full text-[13px]">
            <thead><tr className="text-left text-muted"><th className="py-1 font-medium">Up to ({unit})</th><th className="font-medium">Points</th><th /></tr></thead>
            <tbody>
              {tiers.map((t, i) => (
                <tr key={i}>
                  <td className="py-1 pr-2">{t.max === null ? <span className="text-muted">Any more</span> : <NumberCell id={`${title}-max-${i}`} step="1" value={t.max} onChange={(v) => onChange(tiers.map((x, j) => (j === i ? { ...x, max: Math.round(v) } : x)))} />}</td>
                  <td className="py-1 pr-2"><NumberCell id={`${title}-pts-${i}`} value={t.points} onChange={(v) => onChange(tiers.map((x, j) => (j === i ? { ...x, points: v } : x)))} /></td>
                  <td>{t.max !== null && <Button size="sm" variant="ghost" type="button" aria-label="Remove tier" onClick={() => onChange(tiers.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function SeasonEditor({ s, set, lockedLength }: { s: LeagueSettings; set: Upd<LeagueSettings>; lockedLength?: boolean }) {
  const se = s.season;
  const put = (patch: Partial<typeof se>) => set({ ...s, season: { ...se, ...patch } });
  const lastWeek = se.startWeek + se.regularSeasonWeeks - 1;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Starts in NFL week" htmlFor="se-start"><Input id="se-start" disabled={lockedLength} type="number" min={1} max={18} value={se.startWeek} onChange={(e) => put({ startWeek: Number(e.target.value) || 1 })} /></Field>
        <Field label="Regular-season weeks" htmlFor="se-weeks" hint={`Ends after NFL week ${lastWeek}.`}><Input id="se-weeks" disabled={lockedLength} type="number" min={1} max={17} value={se.regularSeasonWeeks} onChange={(e) => put({ regularSeasonWeeks: Number(e.target.value) || 1 })} /></Field>
        <Field label="Playoff teams" htmlFor="se-po" hint={se.playoffTeams >= 2 ? `${playoffRounds(se.playoffTeams)} round(s), weeks ${lastWeek + 1}–${lastWeek + playoffRounds(se.playoffTeams)}. Top seeds get byes.` : 'No playoffs.'}>
          <Select id="se-po" value={se.playoffTeams} onChange={(e) => put({ playoffTeams: Number(e.target.value) })}>{[0, 2, 3, 4, 5, 6, 7, 8, 10].map((n) => <option key={n} value={n}>{n === 0 ? 'None' : n}</option>)}</Select>
        </Field>
      </div>
      <Field label="Standings">
        <Segmented value={se.standingsMode} onChange={(v) => put({ standingsMode: v })} options={[{ value: 'head_to_head', label: 'Head-to-head record' }, { value: 'total_points', label: 'Total points' }]} />
      </Field>
      <Field label="Tie-breakers, in order" hint="Applied when records (or points) are equal.">
        <div className="flex flex-wrap gap-2">
          {se.tieBreakers.map((t, i) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-lg bg-raised px-2.5 py-1.5 text-[13px] hairline">{i + 1}. {t.replace(/_/g, ' ')}
              {se.tieBreakers.length > 1 && <button type="button" aria-label={`Remove ${t}`} className="text-muted hover:text-bad" onClick={() => put({ tieBreakers: se.tieBreakers.filter((x) => x !== t) })}>×</button>}
            </span>
          ))}
          <Select aria-label="Add tie-breaker" className="h-9 w-auto" value="" onChange={(e) => e.target.value && put({ tieBreakers: [...se.tieBreakers, e.target.value as any] })}>
            <option value="">Add…</option>
            {(['points_for', 'head_to_head', 'points_against_low', 'coin_flip'] as const).filter((t) => !se.tieBreakers.includes(t)).map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </Select>
        </div>
      </Field>
      <div className="grid gap-1 sm:grid-cols-2 sm:gap-x-8">
        <Toggle label="Double headers (two opponents per week)" checked={se.doubleHeaders} disabled={lockedLength} onChange={(v) => put({ doubleHeaders: v })} />
        <Toggle label="Consolation bracket for non-playoff teams" checked={se.consolationBracket} onChange={(v) => put({ consolationBracket: v })} />
        <Toggle label="Lock all players at the week's first kickoff" checked={se.lineupLock === 'first_game_of_week'} onChange={(v) => put({ lineupLock: v ? 'first_game_of_week' : 'game_time' })} />
        <Toggle label="Commissioner reviews stat corrections to final weeks" checked={se.statCorrections === 'review'} onChange={(v) => put({ statCorrections: v ? 'review' : 'auto' })} />
      </div>
    </div>
  );
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function WaiverTradeEditor({ s, set, faabLocked }: { s: LeagueSettings; set: Upd<LeagueSettings>; faabLocked?: boolean }) {
  const w = s.waivers, t = s.trades;
  const pw = (patch: Partial<typeof w>) => set({ ...s, waivers: { ...w, ...patch } });
  const pt = (patch: Partial<typeof t>) => set({ ...s, trades: { ...t, ...patch } });
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="label">Waivers</div>
        <Segmented value={w.mode} onChange={(v) => !faabLocked && pw({ mode: v })} options={[{ value: 'faab', label: 'FAAB bidding' }, { value: 'rolling', label: 'Rolling priority' }, { value: 'reverse_standings', label: 'Reverse standings' }]} />
        <div className="grid gap-4 sm:grid-cols-4">
          {w.mode === 'faab' && <Field label="FAAB budget ($)" htmlFor="w-budget"><Input id="w-budget" type="number" min={0} max={10000} value={w.faabBudget} onChange={(e) => pw({ faabBudget: Number(e.target.value) || 0 })} /></Field>}
          <Field label="Waiver period (hours)" htmlFor="w-period" hint="After a drop."><Input id="w-period" type="number" min={0} max={168} value={w.waiverPeriodHours} onChange={(e) => pw({ waiverPeriodHours: Number(e.target.value) || 0 })} /></Field>
          <Field label="Process on" htmlFor="w-day"><Select id="w-day" value={w.processDay} onChange={(e) => pw({ processDay: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select></Field>
          <Field label="At (UTC hour)" htmlFor="w-hour"><Select id="w-hour" value={w.processHourUtc} onChange={(e) => pw({ processHourUtc: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00 UTC</option>)}</Select></Field>
        </div>
        <div className="grid gap-1 sm:grid-cols-2 sm:gap-x-8">
          <Toggle label="Continuous waivers (no free agents)" checked={w.continuous} onChange={(v) => pw({ continuous: v })} />
          {w.mode === 'faab' && <Toggle label="Allow $0 bids" checked={w.allowZeroBids} onChange={(v) => pw({ allowZeroBids: v })} />}
        </div>
      </div>
      <div className="space-y-4">
        <div className="label">Trades</div>
        <Field label="Review process">
          <Segmented value={t.review} onChange={(v) => pt({ review: v })} options={[{ value: 'auto', label: 'Automatic' }, { value: 'commissioner', label: 'Commissioner' }, { value: 'league_vote', label: 'League vote' }, { value: 'hybrid', label: 'Hybrid' }]} />
        </Field>
        <p className="text-[13px] text-muted">{({
          auto: 'Trades process as soon as both managers accept. Rule violations are still blocked.',
          commissioner: 'Every accepted trade waits for a commissioner decision, which must include a reason.',
          league_vote: 'Other managers vote during the review window; enough vetoes block the trade.',
          hybrid: 'Small, balanced trades process automatically; large or flagged trades go to the commissioner.',
        } as any)[t.review]}</p>
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Trade deadline" htmlFor="t-dead" hint="Last week trades are allowed."><Select id="t-dead" value={t.tradeDeadlineWeek} onChange={(e) => pt({ tradeDeadlineWeek: Number(e.target.value) })}><option value={0}>No deadline</option>{Array.from({ length: 17 }, (_, i) => <option key={i + 1} value={i + 1}>After week {i + 1}</option>)}</Select></Field>
          <Field label="Offers expire after (h)" htmlFor="t-exp"><Input id="t-exp" type="number" min={1} max={168} value={t.offerExpiryHours} onChange={(e) => pt({ offerExpiryHours: Number(e.target.value) || 1 })} /></Field>
          <Field label="Review window (h)" htmlFor="t-rev"><Input id="t-rev" type="number" min={1} max={96} value={t.reviewHours} onChange={(e) => pt({ reviewHours: Number(e.target.value) || 1 })} /></Field>
          <Field label="Trade analysis" htmlFor="t-an"><Select id="t-an" value={t.analysisMode} onChange={(e) => pt({ analysisMode: e.target.value as any })}><option value="off">Off</option><option value="advisory">Advisory</option><option value="required">Part of approval</option></Select></Field>
        </div>
        {t.review === 'league_vote' && (
          <div className="grid gap-4 rounded-xl bg-raised p-3 sm:grid-cols-3">
            <Field label="Veto threshold" htmlFor="t-veto" hint={`${Math.round(t.vetoThreshold * 100)}% of eligible voters.`}><Input id="t-veto" type="range" min={0.1} max={1} step={0.05} value={t.vetoThreshold} onChange={(e) => pt({ vetoThreshold: Number(e.target.value) })} /></Field>
            <Field label="Show vote counts" htmlFor="t-show"><Select id="t-show" value={t.showVoteCounts} onChange={(e) => pt({ showVoteCounts: e.target.value as any })}><option value="live">While voting</option><option value="after_close">After voting closes</option><option value="never">Never</option></Select></Field>
            <div className="self-end"><Toggle label="Involved managers can vote" checked={t.involvedManagersCanVote} onChange={(v) => pt({ involvedManagersCanVote: v })} /></div>
          </div>
        )}
        {t.review === 'hybrid' && (
          <div className="grid gap-4 rounded-xl bg-raised p-3 sm:grid-cols-2">
            <Field label="Send to commissioner above value gap" htmlFor="t-gap" hint={`${Math.round(t.hybridValueGap * 100)}% estimated value difference.`}><Input id="t-gap" type="range" min={0.05} max={1} step={0.05} value={t.hybridValueGap} onChange={(e) => pt({ hybridValueGap: Number(e.target.value) })} /></Field>
            <Field label="Auto-approve up to (players)" htmlFor="t-max"><Input id="t-max" type="number" min={1} max={10} value={t.hybridMaxAutoPlayers} onChange={(e) => pt({ hybridMaxAutoPlayers: Number(e.target.value) || 1 })} /></Field>
          </div>
        )}
        <div className="grid gap-1 sm:grid-cols-2 sm:gap-x-8">
          <Toggle label="Draft picks can be traded" checked={t.allowDraftPicks} onChange={(v) => pt({ allowDraftPicks: v })} />
          <Toggle label="FAAB can be traded" checked={t.allowFaab} onChange={(v) => pt({ allowFaab: v })} />
        </div>
      </div>
    </div>
  );
}

export function DraftEditor({ s, set }: { s: LeagueSettings; set: Upd<LeagueSettings> }) {
  const d = s.draft;
  const pd = (patch: Partial<typeof d>) => set({ ...s, draft: { ...d, ...patch } });
  return (
    <div className="space-y-4">
      <Segmented value={d.type} onChange={(v) => pd({ type: v })} options={[{ value: 'snake', label: 'Snake' }, { value: 'linear', label: 'Linear' }, { value: 'auction', label: 'Auction' }, { value: 'manual', label: 'Commissioner entry' }]} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Pick timer" htmlFor="d-timer"><Select id="d-timer" value={d.pickSeconds} onChange={(e) => pd({ pickSeconds: Number(e.target.value) })}>{[30, 60, 90, 120, 300, 3600, 28800, 86400].map((n) => <option key={n} value={n}>{n < 60 ? `${n} seconds` : n < 3600 ? `${n / 60} minutes` : `${n / 3600} hours`}</option>)}</Select></Field>
        {d.type === 'auction' && <Field label="Auction budget ($)" htmlFor="d-budget"><Input id="d-budget" type="number" min={10} max={1000} value={d.auctionBudget} onChange={(e) => pd({ auctionBudget: Number(e.target.value) || 10 })} /></Field>}
        <Field label="Draft order" htmlFor="d-order"><Select id="d-order" value={d.orderMode} onChange={(e) => pd({ orderMode: e.target.value as any })}><option value="random">Randomize when configured</option><option value="manual">Commissioner sets order</option></Select></Field>
      </div>
    </div>
  );
}
