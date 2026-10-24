import { DEFAULT_COLORS, PRESET_PALETTES, checkPair, contrastRatio, ensureContrast, hexToRgb, isHex, readableTextOn } from '@gridiron/core';
import { ImagePlus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { HexColorPicker } from 'react-colorful';
import { PRESET_IDS, PresetLogo, TeamLogo } from '../components/team';
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, SectionTitle, Textarea, cx, useToast } from '../components/ui';
import { api } from '../api/client';
import { useAction } from '../lib/hooks';

const MAX_BYTES = 2 * 1024 * 1024;

function ColorControl({ label, value, onChange, id }: { label: string; value: string; onChange: (v: string) => void; id: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const rgb = hexToRgb(value);
  return (
    <div className="space-y-2">
      <div className="label">{label}</div>
      <div className="color-wheel"><HexColorPicker color={value} onChange={(c) => onChange(c.toUpperCase())} style={{ width: '100%', height: 170 }} /></div>
      <div className="flex items-center gap-2">
        <span className="h-9 w-9 shrink-0 rounded-lg hairline" style={{ background: value }} aria-hidden />
        <Input id={id} aria-label={`${label} hex`} className="font-mono uppercase" value={text}
          onChange={(e) => { const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`; setText(v); if (isHex(v)) onChange(v.toUpperCase()); }} maxLength={7} />
      </div>
      <div className="num font-mono text-[12px] text-muted">RGB {rgb.r}, {rgb.g}, {rgb.b}</div>
    </div>
  );
}

/** Square crop with zoom and pan, re-encoded on a canvas (strips metadata, bounds size). */
function Cropper({ file, onDone, onCancel }: { file: File; onDone: (b64: string) => void; onCancel: () => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragging = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    const ctx = c.getContext('2d')!;
    const S = c.width;
    const base = Math.max(S / img.width, S / img.height) * zoom;
    const w = img.width * base, h = img.height * base;
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(img, (S - w) / 2 + off.x, (S - h) / 2 + off.y, w, h);
  }, [img, zoom, off]);
  const finish = () => {
    const c = canvas.current!;
    const out = c.toDataURL('image/webp', 0.9);
    onDone(out.startsWith('data:image/webp') ? out : c.toDataURL('image/png'));
  };
  return (
    <Modal open onClose={onCancel} title="Position your image" footer={<><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button variant="primary" onClick={finish} disabled={!img}>Use image</Button></>}>
      <div className="space-y-3">
        <canvas ref={canvas} width={320} height={320} className="mx-auto aspect-square w-full max-w-[320px] cursor-move touch-none rounded-full bg-sunken"
          onPointerDown={(e) => { dragging.current = { x: e.clientX - off.x, y: e.clientY - off.y }; (e.target as HTMLElement).setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => { if (dragging.current) setOff({ x: e.clientX - dragging.current.x, y: e.clientY - dragging.current.y }); }}
          onPointerUp={() => { dragging.current = null; }} />
        <Field label="Zoom" htmlFor="crop-zoom"><input id="crop-zoom" type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></Field>
        <p className="text-[12px] text-muted">Drag to reposition. The image is saved as a 320×320 square.</p>
      </div>
    </Modal>
  );
}

export function TeamCustomizer({ team, leagueId }: { team: any; leagueId: string }) {
  const [f, setF] = useState({ name: team.name, abbrev: team.abbrev, description: team.description ?? '', primaryColor: team.primary_color, secondaryColor: team.secondary_color, logoMediaId: team.logo_media_id as string | null, logoPreset: team.logo_preset as string | null, bannerMediaId: team.banner_media_id as string | null });
  const [file, setFile] = useState<File | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const toast = useToast();
  const save = useAction('teams.update', { invalidate: ['league', 'roster', 'matchups', 'dashboard', 'standings'], success: 'Team identity saved.' });
  const check = checkPair(f.primaryColor, f.secondaryColor);
  const preview = { ...team, name: f.name || team.name, abbrev: f.abbrev, primary_color: f.primaryColor, secondary_color: f.secondaryColor, logo_media_id: f.logoMediaId, logo_preset: f.logoPreset };
  const onFile = (fl: File | undefined) => {
    setUploadErr(null);
    if (!fl) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(fl.type)) { setUploadErr('Use a PNG, JPEG or WebP image.'); return; }
    if (fl.size > 8 * MAX_BYTES) { setUploadErr('That image is too large (max 16 MB before cropping).'); return; }
    setFile(fl);
  };
  const upload = async (b64: string) => {
    setFile(null); setUploading(true);
    try {
      const r = await api().call<any>('media.upload', { dataBase64: b64, purpose: 'team_logo' });
      setF((x) => ({ ...x, logoMediaId: r.id, logoPreset: null }));
      toast('info', 'Image uploaded. Save to apply it.');
    } catch (e: any) { setUploadErr(e.message); } finally { setUploading(false); }
  };
  const dirty = JSON.stringify(f) !== JSON.stringify({ name: team.name, abbrev: team.abbrev, description: team.description ?? '', primaryColor: team.primary_color, secondaryColor: team.secondary_color, logoMediaId: team.logo_media_id, logoPreset: team.logo_preset, bannerMediaId: team.banner_media_id });
  const textOnPrimary = readableTextOn(f.primaryColor);
  const accentOnLight = ensureContrast(f.primaryColor, '#FFFFFF', 3);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-5">
        <Card>
          <SectionTitle>Identity</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
            <Field label="Team name" htmlFor="tc-name"><Input id="tc-name" value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Abbreviation" htmlFor="tc-ab"><Input id="tc-ab" value={f.abbrev} maxLength={4} className="font-display text-lg uppercase tracking-wider" onChange={(e) => setF({ ...f, abbrev: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} /></Field>
          </div>
          <div className="mt-4"><Field label="Description" htmlFor="tc-desc"><Textarea id="tc-desc" value={f.description} maxLength={300} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
        </Card>
        <Card>
          <SectionTitle sub="Exactly two colors. They brand your logo, matchup headers, standings and lineup cards; app text adapts automatically to stay readable."
            action={<Button size="sm" variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setF({ ...f, primaryColor: DEFAULT_COLORS.primary, secondaryColor: DEFAULT_COLORS.secondary })}>Reset</Button>}>Team colors</SectionTitle>
          <div className="grid gap-5 sm:grid-cols-2">
            <ColorControl id="tc-primary" label="Primary" value={f.primaryColor} onChange={(v) => setF({ ...f, primaryColor: v })} />
            <ColorControl id="tc-secondary" label="Secondary" value={f.secondaryColor} onChange={(v) => setF({ ...f, secondaryColor: v })} />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-muted">Contrast between your colors:</span>
            <Badge tone={check.level === 'fail' ? 'bad' : check.level === 'AA large' ? 'warn' : 'good'}>{check.ratio}:1 · {check.level === 'fail' ? 'low' : check.level}</Badge>
            {check.level === 'fail' && <span className="text-muted">Secondary details may be hard to see on the primary. Readable text is still guaranteed.</span>}
            <span className="text-muted">· Text on primary: {textOnPrimary === '#FFFFFF' ? 'white' : 'dark'} ({contrastRatio(f.primaryColor, textOnPrimary).toFixed(1)}:1)</span>
          </div>
          <div className="mt-4">
            <div className="label mb-2">Preset palettes</div>
            <div className="flex flex-wrap gap-2">
              {PRESET_PALETTES.map((p) => (
                <button key={p.name} onClick={() => setF({ ...f, primaryColor: p.primary, secondaryColor: p.secondary })} title={p.name}
                  className={cx('flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-semibold hairline hover:bg-raised', f.primaryColor === p.primary && f.secondaryColor === p.secondary && 'ring-2 ring-accent')}>
                  <span className="flex"><span className="h-4 w-4 rounded-l" style={{ background: p.primary }} /><span className="h-4 w-4 rounded-r" style={{ background: p.secondary }} /></span>{p.name}
                </button>
              ))}
            </div>
          </div>
        </Card>
        <Card>
          <SectionTitle sub="Upload a PNG, JPEG or WebP, or choose an original emblem drawn in your colors.">Logo</SectionTitle>
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-surface px-4 text-sm font-semibold hairline hover:bg-raised">
              <ImagePlus className="h-4 w-4" /> {uploading ? 'Uploading…' : 'Upload image'}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {(f.logoMediaId || f.logoPreset) && <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setF({ ...f, logoMediaId: null, logoPreset: null })}>Use default monogram</Button>}
          </div>
          {uploadErr && <div className="mt-3"><ErrorNote error={{ message: uploadErr }} /></div>}
          <div className="mt-4 grid grid-cols-6 gap-2 sm:grid-cols-12">
            {PRESET_IDS.map((id) => (
              <button key={id} aria-label={`Emblem ${id.replace('preset-', '')}`} onClick={() => setF({ ...f, logoPreset: id, logoMediaId: null })}
                className={cx('flex aspect-square items-center justify-center rounded-lg bg-raised hover:bg-sunken', f.logoPreset === id && !f.logoMediaId && 'ring-2 ring-accent')}>
                <PresetLogo preset={id} primary={f.primaryColor} secondary={f.secondaryColor} size={34} />
              </button>
            ))}
          </div>
        </Card>
        <Card>
          <SectionTitle sub="Optional wide image shown behind your team header. PNG, JPEG or WebP up to 2 MB.">Banner</SectionTitle>
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-surface px-4 text-sm font-semibold hairline hover:bg-raised">
              <ImagePlus className="h-4 w-4" /> Upload banner
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={async (e) => {
                const fl = e.target.files?.[0]; e.target.value = '';
                if (!fl) return;
                if (!['image/png', 'image/jpeg', 'image/webp'].includes(fl.type) || fl.size > MAX_BYTES) { setUploadErr('Banners must be PNG, JPEG or WebP and 2 MB or smaller.'); return; }
                const b64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(fl); });
                try { const m = await api().call<any>('media.upload', { dataBase64: b64, purpose: 'team_banner' }); setF((x) => ({ ...x, bannerMediaId: m.id })); toast('info', 'Banner uploaded. Save to apply it.'); } catch (er: any) { setUploadErr(er.message); }
              }} />
            </label>
            {f.bannerMediaId && <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setF({ ...f, bannerMediaId: null })}>Remove banner</Button>}
          </div>
        </Card>
      </div>
      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <Card>
          <div className="label mb-3">Live preview</div>
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: f.primaryColor, color: textOnPrimary }}>
              <TeamLogo team={preview} size={46} />
              <div className="min-w-0 flex-1"><div className="truncate font-display text-xl font-bold uppercase">{preview.name}</div><div className="text-[12px] opacity-75">Matchup header</div></div>
              <div className="num font-display text-3xl font-bold">104.2</div>
            </div>
            <div className="flex items-center gap-3 rounded-lg bg-raised px-3 py-2">
              <span className="num w-5 font-display text-lg font-bold text-muted">1</span>
              <span className="w-1 self-stretch rounded-full" style={{ background: `linear-gradient(${f.primaryColor} 0 70%, ${f.secondaryColor} 70%)` }} />
              <TeamLogo team={preview} size={26} />
              <span className="flex-1 truncate font-semibold">{preview.name}</span><span className="num text-[13px]">7-2</span>
            </div>
            <div className="rounded-lg bg-surface p-3 hairline">
              <div className="mb-1 text-[11px] font-bold uppercase tracking-wider" style={{ color: accentOnLight }}>{preview.abbrev || 'ABBR'} · Lineup card</div>
              <div className="h-1 rounded-full" style={{ background: `linear-gradient(90deg, ${f.primaryColor} 0 70%, ${f.secondaryColor} 70%)` }} />
            </div>
          </div>
        </Card>
        <Button variant="primary" size="lg" className="w-full" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate({ teamId: team.id, ...f })}>Save team identity</Button>
        <p className="text-[12px] text-faint">League: changes appear for every manager immediately.</p>
      </aside>
      {file && <Cropper file={file} onCancel={() => setFile(null)} onDone={upload} />}
      <span className="hidden">{leagueId}</span>
    </div>
  );
}
