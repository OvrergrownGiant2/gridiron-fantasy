import { hexToHsl, hslToHex, isHex, type Hsl } from '@gridiron/core';
import { useEffect, useRef, useState } from 'react';
import { cx } from './ui';

/**
 * A color wheel: angle picks the hue, distance from the center picks saturation, and the
 * slider underneath sets brightness. Works with mouse, touch and keyboard (arrow keys move
 * hue and saturation; the slider and the hex field are ordinary inputs).
 */
export function ColorWheel({ label, value, onChange, size = 184, className }: { label: string; value: string; onChange: (hex: string) => void; size?: number; className?: string }) {
  const [hsl, setHsl] = useState<Hsl>(() => hexToHsl(value));
  const [text, setText] = useState(value.toUpperCase());
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // Follow outside changes (presets, reset) without losing the hue of greys while dragging.
  useEffect(() => {
    if (hslToHex(hsl).toLowerCase() !== value.toLowerCase()) setHsl(hexToHsl(value));
    setText(value.toUpperCase());
  }, [value]);

  const commit = (next: Hsl) => { setHsl(next); const hx = hslToHex(next); setText(hx.toUpperCase()); onChange(hx); };
  const fromPointer = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const h = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    const s = Math.min(100, (Math.hypot(dx, dy) / (r.width / 2)) * 100);
    commit({ h, s, l: hsl.l <= 2 || hsl.l >= 98 ? 50 : hsl.l });
  };
  const rad = (hsl.h * Math.PI) / 180, dist = (hsl.s / 100) * (size / 2 - 8);
  const mx = size / 2 + Math.sin(rad) * dist, my = size / 2 - Math.cos(rad) * dist;
  const pure = hslToHex({ h: hsl.h, s: hsl.s, l: 50 });

  return (
    <div className={cx('flex flex-col items-center gap-3', className)}>
      <div className="label self-start">{label}</div>
      <div ref={ref} role="slider" tabIndex={0} aria-label={`${label}: hue and saturation`} aria-valuetext={`${value.toUpperCase()}, hue ${Math.round(hsl.h)}°, saturation ${Math.round(hsl.s)}%`}
        className="relative touch-none select-none rounded-full shadow-inner outline-offset-4"
        style={{ width: size, height: size, background: 'radial-gradient(circle closest-side, #fff, rgba(255,255,255,0)), conic-gradient(hsl(0 100% 50%), hsl(60 100% 50%), hsl(120 100% 50%), hsl(180 100% 50%), hsl(240 100% 50%), hsl(300 100% 50%), hsl(360 100% 50%))' }}
        onPointerDown={(e) => { dragging.current = true; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); fromPointer(e); }}
        onPointerMove={(e) => { if (dragging.current) fromPointer(e); }}
        onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 15 : 4;
          const k: Record<string, () => Hsl> = {
            ArrowLeft: () => ({ ...hsl, h: (hsl.h - step + 360) % 360 }), ArrowRight: () => ({ ...hsl, h: (hsl.h + step) % 360 }),
            ArrowUp: () => ({ ...hsl, s: Math.min(100, hsl.s + step) }), ArrowDown: () => ({ ...hsl, s: Math.max(0, hsl.s - step) }),
          };
          if (k[e.key]) { e.preventDefault(); commit(k[e.key]()); }
        }}>
        {/* brightness shade over the wheel, so the wheel shows the colors you'd actually get */}
        <div className="pointer-events-none absolute inset-0 rounded-full" style={{ background: hsl.l < 50 ? `rgba(0,0,0,${(50 - hsl.l) / 55})` : `rgba(255,255,255,${(hsl.l - 50) / 55})` }} />
        <span className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_0_0_1px_rgba(0,0,0,.35),0_2px_6px_rgba(0,0,0,.35)]"
          style={{ left: mx, top: my, background: value }} />
      </div>
      <input type="range" min={4} max={96} value={Math.round(hsl.l)} aria-label={`${label}: brightness`}
        onChange={(e) => commit({ ...hsl, l: Number(e.target.value) })}
        className="h-3 w-full cursor-pointer appearance-none rounded-full"
        style={{ width: size, background: `linear-gradient(90deg, #000, ${pure}, #fff)` }} />
      <div className="flex items-center gap-2">
        <span className="h-8 w-8 rounded-lg hairline" style={{ background: value }} aria-hidden />
        <input aria-label={`${label}: hex code`} value={text} maxLength={7} spellCheck={false}
          onChange={(e) => { const t = e.target.value.toUpperCase().replace(/[^#0-9A-F]/g, ''); setText(t); const hx = t.startsWith('#') ? t : `#${t}`; if (isHex(hx)) { setHsl(hexToHsl(hx)); onChange(hx); } }}
          className="num h-8 w-24 rounded-lg bg-sunken px-2 font-mono text-[13px] uppercase outline-none hairline focus:ring-2 focus:ring-accent" />
      </div>
    </div>
  );
}
