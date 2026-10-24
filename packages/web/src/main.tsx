import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { queryClient, setTransport } from './api/client';
import { createHttpTransport } from './api/http';
import { Logo } from './components/Shell';
import { ToastProvider } from './components/ui';
import './styles.css';

declare const __DEMO__: boolean;

// One boot per page load (React StrictMode runs effects twice in development).
let localBoot: Promise<any> | null = null;

if (!__DEMO__) setTransport(createHttpTransport());

function Boot() {
  const [state, setState] = useState<{ ready: boolean; msg: string; pct: number; error?: string; reset?: () => Promise<void> }>({ ready: !__DEMO__, msg: 'Starting', pct: 0 });
  useEffect(() => {
    if (!__DEMO__) return;
    let alive = true;
    (localBoot ??= import('./api/local').then(({ createLocalTransport }) => createLocalTransport((msg, pct) => setState((s) => ({ ...s, msg, pct })))))
      .then(({ transport, reset }) => { setTransport(transport); if (alive) setState({ ready: true, msg: 'Ready', pct: 100, reset }); })
      .catch((e) => { console.error(e); if (alive) setState((s) => ({ ...s, error: String(e?.message ?? e) })); });
    return () => { alive = false; };
  }, []);
  if (!state.ready) {
    return (
      <div className="gutter flex min-h-full flex-col items-center justify-center gap-5 bg-turf text-center text-white">
        <div className="flex items-center gap-2"><Logo size={36} /><span className="font-display text-3xl font-bold uppercase tracking-wide">Gridiron</span></div>
        {state.error ? (
          <div className="max-w-md space-y-2 rounded-xl bg-white/10 p-4 text-[14px]">
            <b>The in-browser demo database could not start.</b>
            <p className="text-white/75">{state.error}</p>
            <p className="text-white/75">This demo needs WebAssembly and IndexedDB. Try a current desktop or mobile browser outside private mode, or run the full app locally (see the README).</p>
          </div>
        ) : (
          <div className="w-full max-w-xs">
            <div className="mb-2 text-[13px] text-white/75">{state.msg}…</div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/15"><div className="h-full bg-[rgb(var(--accent))] transition-all" style={{ width: `${state.pct}%` }} /></div>
            <p className="mt-4 text-[12px] text-white/55">First load replays this season's results into sample leagues in your browser. Later visits open instantly.</p>
          </div>
        )}
      </div>
    );
  }
  return <App resetDemo={state.reset} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider><Boot /></ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
