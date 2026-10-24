import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { Logo } from '../components/Shell';
import { Button, ErrorNote, Field, Input } from '../components/ui';

function AuthFrame({ title, sub, children, footer }: { title: string; sub: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-turf text-white lg:block">
        <FieldArt />
        <div className="relative flex h-full flex-col justify-between p-12">
          <div className="flex items-center gap-2"><Logo size={34} /><span className="font-display text-3xl font-bold uppercase tracking-wide">Gridiron</span></div>
          <div className="max-w-md">
            <div className="font-display text-6xl font-bold uppercase leading-[.92]">Run every league<br />from one sideline.</div>
            <p className="mt-4 text-white/70">Drafts, waivers, trades and live scoring for leagues of 1 to 10 managers, with a digital commissioner that enforces your rules and explains every call.</p>
          </div>
          <div className="text-[12px] text-white/50">Fantasy scoring is computed on the server from official stat feeds. Projections are estimates.</div>
        </div>
      </div>
      <div className="gutter flex items-center justify-center py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 lg:hidden"><Logo size={30} /><span className="font-display text-2xl font-bold uppercase tracking-wide">Gridiron</span></div>
          <h1 className="font-display text-4xl font-bold uppercase tracking-wide">{title}</h1>
          <p className="mb-6 mt-1 text-muted">{sub}</p>
          {children}
          {footer && <div className="mt-6 text-[13px] text-muted">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

/** Yard lines and hash marks, drawn rather than imaged. */
function FieldArt() {
  return (
    <svg className="absolute inset-0 h-full w-full opacity-[.13]" preserveAspectRatio="none" viewBox="0 0 100 100" aria-hidden>
      {Array.from({ length: 11 }, (_, i) => <line key={i} x1={i * 10} y1="0" x2={i * 10} y2="100" stroke="white" strokeWidth=".35" />)}
      {Array.from({ length: 50 }, (_, i) => <g key={`h${i}`}><line x1={i * 2} y1="38" x2={i * 2} y2="40" stroke="white" strokeWidth=".25" /><line x1={i * 2} y1="60" x2={i * 2} y2="62" stroke="white" strokeWidth=".25" /></g>)}
      <line x1="63" y1="0" x2="63" y2="100" stroke="rgb(242 194 48)" strokeWidth=".9" />
    </svg>
  );
}

function useAuthSubmit(method: string) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const submit = async (input: any, to = '/') => {
    setBusy(true); setErr(null);
    try {
      await api().call(method, input);
      api().sessionChanged();
      qc.clear();
      nav(to, { replace: true });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return { busy, err, submit };
}

export function Login() {
  const [identifier, setId] = useState('');
  const [password, setPw] = useState('');
  const { busy, err, submit } = useAuthSubmit('auth.login');
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/';
  const isDemo = api().mode === 'demo';
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void submit({ identifier, password }, next); };
  return (
    <AuthFrame title="Sign in" sub="Welcome back to the booth." footer={<>New here? <Link className="font-semibold text-accent" to="/register">Create an account</Link></>}>
      {isDemo && (
        <div className="mb-5 rounded-lg bg-accent/12 px-3 py-2.5 text-[13px]">
          <b>Demo accounts:</b> <code className="font-mono">demo</code> / <code className="font-mono">demo1234</code> or <code className="font-mono">alex</code> / <code className="font-mono">alex1234</code>.
          <button type="button" className="ml-1 font-semibold text-accent underline" onClick={() => submit({ identifier: 'demo', password: 'demo1234' }, next)}>Sign in as demo</button>
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Username or email" htmlFor="login-id"><Input id="login-id" autoComplete="username" value={identifier} onChange={(e) => setId(e.target.value)} required /></Field>
        <Field label="Password" htmlFor="login-pw"><Input id="login-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPw(e.target.value)} required /></Field>
        <ErrorNote error={err} />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Sign in</Button>
        <div className="text-center"><Link to="/forgot" className="text-[13px] text-muted hover:text-ink">Forgot your password?</Link></div>
      </form>
    </AuthFrame>
  );
}

export function Register() {
  const [f, setF] = useState({ username: '', displayName: '', email: '', password: '' });
  const { busy, err, submit } = useAuthSubmit('auth.register');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <AuthFrame title="Create account" sub="One account, every league you play in." footer={<>Already have an account? <Link className="font-semibold text-accent" to="/login">Sign in</Link></>}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(f, '/leagues'); }} className="space-y-4">
        <Field label="Username" hint="3–20 letters, numbers or underscores. Shown to your leagues." htmlFor="r-user"><Input id="r-user" autoComplete="username" value={f.username} onChange={set('username')} required /></Field>
        <Field label="Display name" htmlFor="r-name"><Input id="r-name" value={f.displayName} onChange={set('displayName')} placeholder="Optional" /></Field>
        <Field label="Email" hint="Used for account recovery only. Never shown to other managers." htmlFor="r-email"><Input id="r-email" type="email" autoComplete="email" value={f.email} onChange={set('email')} required /></Field>
        <Field label="Password" hint="At least 8 characters with a letter and a number." htmlFor="r-pw"><Input id="r-pw" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required /></Field>
        <ErrorNote error={err} />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Create account</Button>
      </form>
    </AuthFrame>
  );
}

export function Forgot() {
  const [email, setEmail] = useState('');
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  return (
    <AuthFrame title="Reset password" sub="We'll send a link that works for one hour." footer={<Link className="font-semibold text-accent" to="/login">Back to sign in</Link>}>
      {res ? (
        <div className="space-y-3 rounded-lg bg-sunken p-4 text-[14px]">
          <p>{res.message}</p>
          {res.devLink && <p className="text-[13px] text-muted">No email service is configured in this {api().mode === 'demo' ? 'demo' : 'development'} environment, so here is the link directly: <Link className="break-all font-semibold text-accent" to={res.devLink.split('#')[1] ?? '/'}>open reset link</Link></p>}
        </div>
      ) : (
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { setRes(await api().call('auth.requestReset', { email })); } catch (x) { setErr(x); } finally { setBusy(false); } }}>
          <Field label="Account email" htmlFor="f-email"><Input id="f-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <ErrorNote error={err} />
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Send reset link</Button>
        </form>
      )}
    </AuthFrame>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const [pw, setPw] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  return (
    <AuthFrame title="New password" sub="Choose a new password. You'll be signed out everywhere else." footer={<Link className="font-semibold text-accent" to="/login">Back to sign in</Link>}>
      {done ? <p className="rounded-lg bg-good/10 p-4 text-good">Password updated. <Link to="/login" className="font-semibold underline">Sign in</Link></p> : (
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { await api().call('auth.resetPassword', { token: params.get('token'), newPassword: pw }); setDone(true); } catch (x) { setErr(x); } finally { setBusy(false); } }}>
          <Field label="New password" hint="At least 8 characters with a letter and a number." htmlFor="np"><Input id="np" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
          <ErrorNote error={err} />
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Update password</Button>
        </form>
      )}
    </AuthFrame>
  );
}
