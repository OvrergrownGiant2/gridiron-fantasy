import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ------------------------------------------------------------------ buttons
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'turf';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 shadow-sm',
  secondary: 'bg-surface text-ink hairline hover:bg-raised',
  ghost: 'text-ink hover:bg-sunken',
  danger: 'bg-bad text-white hover:brightness-110',
  turf: 'bg-turf text-white hover:brightness-125',
};
export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx('inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition active:scale-[.98] disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : size === 'lg' ? 'h-12 px-5 text-[15px]' : 'h-10 px-4 text-sm', VARIANTS[variant], className)}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button {...rest} aria-label={label} title={label} className={cx('inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink transition', className)}>
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ surfaces
export function Card({ children, className, pad = true, ...rest }: { children: ReactNode; className?: string; pad?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('rounded-card bg-surface hairline', pad && 'p-4 sm:p-5', className)}>{children}</div>;
}

export function SectionTitle({ children, action, sub }: { children: ReactNode; action?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <h2 className="font-display text-xl font-semibold uppercase tracking-wide">{children}</h2>
        {sub && <p className="text-[13px] text-muted">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, sub, actions, eyebrow }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <div className="label mb-1">{eyebrow}</div>}
        <h1 className="font-display text-3xl font-bold uppercase leading-none tracking-wide sm:text-4xl">{title}</h1>
        {sub && <p className="mt-1.5 text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ badges & status
export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'good' | 'warn' | 'bad' | 'info' | 'live'; className?: string }) {
  const t = {
    neutral: 'bg-sunken text-muted', accent: 'bg-accent/15 text-accent', good: 'bg-good/15 text-good', warn: 'bg-warn/15 text-warn',
    bad: 'bg-bad/15 text-bad', info: 'bg-info/15 text-info', live: 'bg-live/15 text-live',
  }[tone];
  return <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide', t, className)}>{children}</span>;
}

export type DisplayStatus = 'LIVE' | 'UPCOMING' | 'FINAL' | 'DELAYED' | 'POSTPONED' | 'CANCELED' | 'DATA UNAVAILABLE';
export function StatusPill({ status, detail }: { status: DisplayStatus; detail?: string | null }) {
  const tone = { LIVE: 'live', UPCOMING: 'info', FINAL: 'neutral', DELAYED: 'warn', POSTPONED: 'warn', CANCELED: 'bad', 'DATA UNAVAILABLE': 'bad' }[status] as any;
  return (
    <Badge tone={tone}>
      {status === 'LIVE' && <span className="h-1.5 w-1.5 rounded-full bg-live animate-pulseDot" aria-hidden />}
      {status}{detail ? <span className="font-medium normal-case tracking-normal opacity-80"> · {detail}</span> : null}
    </Badge>
  );
}

const INJ: Record<string, { label: string; tone: any }> = {
  questionable: { label: 'Q', tone: 'warn' }, doubtful: { label: 'D', tone: 'bad' }, out: { label: 'O', tone: 'bad' },
  ir: { label: 'IR', tone: 'bad' }, suspended: { label: 'SUS', tone: 'bad' }, pup: { label: 'PUP', tone: 'bad' },
};
export function InjuryTag({ status }: { status: string }) {
  const i = INJ[status];
  if (!i) return null;
  return <span title={status} className={cx('rounded px-1 text-[10px] font-bold', i.tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-bad/15 text-bad')}>{i.label}</span>;
}

export function Spinner({ className }: { className?: string }) { return <Loader2 className={cx('h-5 w-5 animate-spin text-muted', className)} aria-label="Loading" />; }
export function Skeleton({ className }: { className?: string }) { return <div className={cx('animate-pulse rounded-md bg-sunken', className)} aria-hidden />; }
export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return <div className="space-y-2" aria-busy="true">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;
}

export function Empty({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line px-6 py-10 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <div className="font-display text-lg font-semibold uppercase tracking-wide">{title}</div>
      {body && <div className="max-w-md text-[13px] text-muted">{body}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: any; retry?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg bg-bad/10 px-3 py-2.5 text-[13px] text-bad">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">{error.message ?? String(error)}</div>
      {retry && <button className="font-semibold underline" onClick={retry}>Retry</button>}
    </div>
  );
}

// ------------------------------------------------------------------ form controls
export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-semibold">{label}</label>
      {children}
      {error ? <span className="text-[12px] text-bad">{error}</span> : hint ? <span className="text-[12px] text-muted">{hint}</span> : null}
    </div>
  );
}
const ctl = 'h-10 w-full rounded-lg bg-surface px-3 hairline focus:outline-none focus:ring-2 focus:ring-accent/60 disabled:opacity-60';
export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className={cx(ctl, props.className)} />; }
export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) { return <select {...props} className={cx(ctl, 'pr-8', props.className)}>{children}</select>; }
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...props} className={cx(ctl, 'h-auto min-h-[84px] py-2', props.className)} />; }

export function Toggle({ checked, onChange, label, id, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; id?: string; disabled?: boolean }) {
  const auto = useId();
  const i = id ?? auto;
  return (
    <label htmlFor={i} className={cx('flex cursor-pointer items-center justify-between gap-3 py-1.5', disabled && 'opacity-60')}>
      <span className="text-[13px]">{label}</span>
      <span className="relative inline-flex">
        <input id={i} type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-6 w-10 rounded-full bg-sunken hairline transition peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent" />
        <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
      </span>
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-sunken p-0.5">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cx('rounded-md font-semibold transition', size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3 py-1.5 text-[13px]', value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number }[] }) {
  return (
    <div role="tablist" className="scroll-x mb-4 flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
          className={cx('-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-semibold transition', value === t.value ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink')}>
          {t.label}{t.count ? <span className="rounded-full bg-accent px-1.5 text-[10px] text-accent-ink">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ dialogs
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not([aria-label="Close"])')?.focus(), 30);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" className={cx('flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-surface shadow-2xl animate-slideUp sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 className="font-display text-xl font-semibold uppercase tracking-wide">{title}</h2>
          <IconButton label="Close" onClick={onClose}><X className="h-5 w-5" /></IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** In-page confirmation for consequential actions, with an optional required reason. */
export function ConfirmDialog({ open, onClose, onConfirm, title, body, confirmLabel = 'Confirm', danger, requireReason, reasonLabel = 'Reason (shown in the audit log)' }: {
  open: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<unknown> | void; title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; requireReason?: boolean; reasonLabel?: string;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  useEffect(() => { if (open) { setReason(''); setErr(null); } }, [open]);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await onConfirm(reason.trim()); onClose(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={requireReason && reason.trim().length < 3} onClick={go}>{confirmLabel}</Button>
    </>}>
      <div className="space-y-3">
        {body && <div className="text-[14px] text-muted">{body}</div>}
        {requireReason && <Field label={reasonLabel} htmlFor="confirm-reason"><Textarea id="confirm-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="At least 3 characters" /></Field>}
        <ErrorNote error={err} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ toasts
interface Toast { id: number; tone: 'good' | 'bad' | 'info'; text: string }
const ToastCtx = createContext<(tone: Toast['tone'], text: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { id, tone, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'bad' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6">
        {items.map((t) => (
          <div key={t.id} className="pointer-events-auto flex max-w-md items-start gap-2 rounded-xl bg-ink px-4 py-3 text-[13px] text-bg shadow-xl animate-slideUp">
            {t.tone === 'good' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-good" /> : t.tone === 'bad' ? <AlertTriangle className="h-4 w-4 shrink-0 text-bad" /> : <Info className="h-4 w-4 shrink-0" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export const slotLabel = (s: string) => (s === 'SUPERFLEX' ? 'SFLX' : s);
