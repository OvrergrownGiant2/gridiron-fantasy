import {
  APPEARANCE_PRESETS, BODY_FONTS, DEFAULT_APPEARANCE, DEFAULT_PALETTES, DISPLAY_FONTS, THEME_TOKENS, TOKEN_INFO,
  buildPalettes, paletteWarnings, type Appearance, type BodyFont, type DisplayFont, type ThemeToken,
} from '@gridiron/core';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ChevronDown, Palette as PaletteIcon, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { applyAppearance, currentMode } from '../theme';
import { ColorWheel } from './ColorWheel';
import { Badge, Button, Card, Field, SectionTitle, Segmented, Select, cx, useToast } from './ui';

/**
 * "Personalize": two color wheels restyle the whole app; everything else (every single color,
 * fonts, corners, size) can be fine-tuned. Changes show instantly and save automatically.
 */
export function Personalize({ saved }: { saved: Appearance | null }) {
  const [a, setA] = useState<Appearance>(() => saved ?? {});
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'light' | 'dark'>(() => currentMode());
  const timer = useRef<number>();
  const qc = useQueryClient();
  const toast = useToast();

  // Keep the editing palette in step with the theme being shown.
  useEffect(() => {
    const obs = new MutationObserver(() => setMode(currentMode()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  const update = (patch: Partial<Appearance> | ((x: Appearance) => Appearance)) => {
    setA((prev) => {
      const next = clean(typeof patch === 'function' ? patch(prev) : { ...prev, ...patch });
      applyAppearance(next);
      window.clearTimeout(timer.current);
      setStatus('saving');
      timer.current = window.setTimeout(async () => {
        try { await api().call('profile.update', { appearance: Object.keys(next).length ? next : null }); setStatus('saved'); qc.invalidateQueries({ queryKey: ['me'] }); }
        catch (e: any) { setStatus('error'); toast('bad', e.message); }
      }, 600);
      return next;
    });
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const palettes = useMemo(() => buildPalettes(a), [a]);
  const p = palettes[mode];
  const warnings = paletteWarnings(p);
  const primary = a.primary ?? DEFAULT_PALETTES.dark.turf;
  const accent = a.accent ?? DEFAULT_PALETTES.dark.accent;
  const overridden = (k: ThemeToken) => Boolean(a.overrides?.[mode]?.[k]);
  const setToken = (k: ThemeToken, v: string | null) => update((x) => {
    const o = { ...(x.overrides?.[mode] ?? {}) };
    if (v) o[k] = v; else delete o[k];
    return { ...x, overrides: { ...x.overrides, [mode]: o } };
  });

  return (
    <Card>
      <SectionTitle sub="Pick two colors and the whole app follows. Changes appear instantly and save to your account."
        action={<span className="text-[12px] text-muted">{status === 'saving' ? 'Saving…' : status === 'saved' ? <span className="inline-flex items-center gap-1 text-good"><Check className="h-3.5 w-3.5" />Saved</span> : status === 'error' ? <span className="text-bad">Not saved</span> : null}</span>}>
        <span className="inline-flex items-center gap-2"><PaletteIcon className="h-5 w-5 text-accent" />Personalize</span>
      </SectionTitle>

      <div className="label mb-2">Quick looks</div>
      <div className="mb-5 flex flex-wrap gap-2">
        {APPEARANCE_PRESETS.map((x) => {
          const on = a.primary?.toLowerCase() === x.primary.toLowerCase() && a.accent?.toLowerCase() === x.accent.toLowerCase();
          return (
            <button key={x.name} type="button" onClick={() => update({ primary: x.primary, accent: x.accent, tint: x.tint ?? DEFAULT_APPEARANCE.tint })} aria-pressed={on}
              className={cx('flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-[12.5px] font-semibold hairline transition hover:bg-raised', on && 'ring-2 ring-accent')}>
              <span className="relative h-6 w-6 overflow-hidden rounded-full" style={{ background: x.primary }}><span className="absolute bottom-0 right-0 h-3 w-3 rounded-tl-full" style={{ background: x.accent }} /></span>{x.name}
            </button>
          );
        })}
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <div className="rounded-xl bg-raised p-4">
          <ColorWheel label="Main color" value={primary} onChange={(v) => update({ primary: v })} />
          <p className="mt-2 text-center text-[12px] text-muted">Sidebar, banners and headers. Backgrounds take on a hint of it.</p>
        </div>
        <div className="rounded-xl bg-raised p-4">
          <ColorWheel label="Accent color" value={accent} onChange={(v) => update({ accent: v })} />
          <p className="mt-2 text-center text-[12px] text-muted">Buttons, links, highlights and selections.</p>
        </div>
      </div>

      <Preview />

      <div className="mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <Slider label="Background tint" value={Math.round((a.tint ?? DEFAULT_APPEARANCE.tint) * 100)} min={0} max={100} unit="%" disabled={!a.primary}
          hint={a.primary ? 'How much of the main color shows in backgrounds.' : 'Pick a main color first.'} onChange={(v) => update({ tint: v / 100 })} />
        <Slider label="Corner roundness" value={a.radius ?? DEFAULT_APPEARANCE.radius} min={0} max={28} unit="px" hint="Square to very round." onChange={(v) => update({ radius: v })} />
        <Field label="Text font" htmlFor="pz-font">
          <Select id="pz-font" value={a.font ?? DEFAULT_APPEARANCE.font} onChange={(e) => update({ font: e.target.value as BodyFont })}>
            {Object.entries(BODY_FONTS).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
          </Select>
        </Field>
        <Field label="Heading font" htmlFor="pz-display">
          <Select id="pz-display" value={a.displayFont ?? DEFAULT_APPEARANCE.displayFont} onChange={(e) => update({ displayFont: e.target.value as DisplayFont })}>
            {Object.entries(DISPLAY_FONTS).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
          </Select>
        </Field>
        <Slider label="Interface size" value={Math.round((a.scale ?? 1) * 100)} min={85} max={125} step={5} unit="%" hint="Makes everything larger or smaller." onChange={(v) => update({ scale: v / 100 })} />
      </div>

      <div className="mt-5 rounded-xl hairline">
        <button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span><span className="font-semibold">Fine-tune every color</span><span className="block text-[12px] text-muted">Change any single color of the {mode} theme. Overrides win over the wheels.</span></span>
          <ChevronDown className={cx('h-5 w-5 shrink-0 transition', open && 'rotate-180')} />
        </button>
        {open && (
          <div className="border-t border-line px-4 pb-4 pt-3">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'light', label: 'Light theme colors' }, { value: 'dark', label: 'Dark theme colors' }]} />
              {mode !== currentMode() && <span className="text-[12px] text-muted">You're viewing the {currentMode()} theme, so these changes show when you switch.</span>}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {THEME_TOKENS.map((k) => (
                <label key={k} className="flex items-center gap-3 rounded-lg bg-raised px-3 py-2">
                  <input type="color" value={p[k].toLowerCase()} onChange={(e) => setToken(k, e.target.value.toUpperCase())} aria-label={TOKEN_INFO[k].label}
                    className="h-9 w-9 shrink-0 cursor-pointer rounded-md border-0 bg-transparent p-0" />
                  <span className="min-w-0 flex-1"><span className="block text-[13px] font-semibold">{TOKEN_INFO[k].label}</span><span className="block truncate text-[11.5px] text-muted">{TOKEN_INFO[k].hint}</span></span>
                  {overridden(k) && <button type="button" className="rounded p-1 text-faint hover:text-ink" aria-label={`Reset ${TOKEN_INFO[k].label}`} onClick={(e) => { e.preventDefault(); setToken(k, null); }}><RotateCcw className="h-3.5 w-3.5" /></button>}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="mt-4 flex gap-2 rounded-lg bg-warn/10 px-3 py-2 text-[13px]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <div>{warnings.map((w) => <div key={w}>{w}</div>)}</div>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12px] text-muted">Your look follows your account to any device. Team colors stay as each team chose.</span>
        <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} disabled={Object.keys(a).length === 0} onClick={() => update(() => ({}))}>Reset to Gridiron default</Button>
      </div>
    </Card>
  );
}

/** Drops empty override groups so "nothing customised" really is an empty object. */
function clean(a: Appearance): Appearance {
  const out: Appearance = { ...a };
  if (out.overrides) {
    const o: NonNullable<Appearance['overrides']> = {};
    if (out.overrides.light && Object.keys(out.overrides.light).length) o.light = out.overrides.light;
    if (out.overrides.dark && Object.keys(out.overrides.dark).length) o.dark = out.overrides.dark;
    if (Object.keys(o).length) out.overrides = o; else delete out.overrides;
  }
  for (const k of Object.keys(out) as (keyof Appearance)[]) if (out[k] === undefined || out[k] === null) delete out[k];
  return out;
}

function Slider({ label, value, min, max, step = 1, unit, hint, onChange, disabled }: { label: string; value: number; min: number; max: number; step?: number; unit: string; hint?: string; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <label className={cx('block', disabled && 'opacity-50')}>
      <span className="flex items-baseline justify-between"><span className="label">{label}</span><span className="num text-[13px] font-semibold">{value}{unit}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="mt-1.5 w-full accent-[rgb(var(--accent))]" />
      {hint && <span className="block text-[12px] text-muted">{hint}</span>}
    </label>
  );
}

/** A small sample of the app's surfaces so changes are visible even without the sidebar on screen. */
function Preview() {
  return (
    <div className="mt-5 overflow-hidden rounded-card hairline" aria-label="Preview">
      <div className="flex items-center justify-between bg-turf px-4 py-2.5 text-white">
        <span className="font-display text-lg font-bold uppercase tracking-wide">Preview</span>
        <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-semibold">Week 8</span>
      </div>
      <div className="grid gap-3 bg-bg p-3 sm:grid-cols-[1fr_auto]">
        <div className="rounded-card bg-surface p-3 hairline">
          <div className="label">Your matchup</div>
          <div className="mt-1 flex items-baseline gap-3"><span className="num font-display text-3xl font-bold">104.6</span><span className="text-muted">vs</span><span className="num font-display text-3xl font-bold text-muted">97.2</span></div>
          <div className="mt-2 flex flex-wrap gap-1.5"><Badge tone="good">Win</Badge><Badge tone="live">Live</Badge><Badge tone="warn">Q</Badge><Badge tone="bad">Out</Badge><Badge tone="info">Info</Badge></div>
          <p className="mt-2 text-[12px] text-faint">Faint text for hints.</p>
        </div>
        <div className="flex flex-col justify-center gap-2 rounded-card bg-raised p-3">
          <Button variant="primary" size="sm">Accent button</Button>
          <Button size="sm">Normal button</Button>
          <span className="rounded-lg bg-sunken px-2 py-1 text-center text-[12px] text-muted">Sunken area</span>
        </div>
      </div>
    </div>
  );
}
