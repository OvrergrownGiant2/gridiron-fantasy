let userTz: string | undefined;
export function setUserTimeZone(tz: string | null | undefined) { userTz = tz || undefined; }
export function browserTimeZone(): string { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } }
export function activeTimeZone(): string { return userTz ?? browserTimeZone(); }

function fmt(iso: string | Date, opts: Intl.DateTimeFormatOptions) {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  try { return new Intl.DateTimeFormat(undefined, { timeZone: activeTimeZone(), ...opts }).format(d); }
  catch { return new Intl.DateTimeFormat(undefined, opts).format(d); }
}

export const kickoff = (iso: string) => fmt(iso, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
export const dateTime = (iso: string) => fmt(iso, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const dateOnly = (iso: string) => fmt(iso, { month: 'short', day: 'numeric', year: 'numeric' });
export const timeOnly = (iso: string) => fmt(iso, { hour: 'numeric', minute: '2-digit' });

export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  const abs = Math.abs(s);
  const r = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'}`;
  const v = abs < 45 ? 'just now' : abs < 3600 ? r(Math.round(abs / 60), 'min') : abs < 86400 ? r(Math.round(abs / 3600), 'hour') : r(Math.round(abs / 86400), 'day');
  if (v === 'just now') return v;
  return s >= 0 ? `${v} ago` : `in ${v}`;
}

export const pts = (n: number | null | undefined, d = 2) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(d));
export const pct = (n: number) => `${Math.round(n * 100)}%`;
export const ordinal = (n: number) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const newRequestId = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
