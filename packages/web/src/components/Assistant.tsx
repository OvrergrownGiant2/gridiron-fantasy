import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { useCall } from '../lib/hooks';
import { Badge, Button, Card, ErrorNote, Input, LoadingBlock, SectionTitle } from './ui';

const KIND: Record<string, { label: string; tone: any }> = {
  verified: { label: 'Verified data', tone: 'good' }, projection: { label: 'Projection', tone: 'info' },
  opinion: { label: 'Recommendation', tone: 'accent' }, missing: { label: 'Missing / caveat', tone: 'warn' },
};

/** Optional assistant. Falls back to rule-based insights when no AI provider is configured. */
export function Assistant({ leagueId }: { leagueId: string }) {
  const { data, isLoading, error } = useCall<any>(['assistant', leagueId], 'assistant.insights', { leagueId });
  const { data: status } = useCall<any>(['assistant', 'status'], 'assistant.status', {});
  const [q, setQ] = useState('');
  const [ans, setAns] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const ask = async () => {
    setBusy(true); setErr(null);
    try { setAns(await api().call('assistant.ask', { leagueId, question: q })); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <Card className="min-w-0">
        <SectionTitle sub="Each item is labeled by what it is: verified data, a model projection, a recommendation, or a known gap.">Team insights</SectionTitle>
        {isLoading ? <LoadingBlock /> : error ? <ErrorNote error={error} /> : (
          <ul className="space-y-2">
            {data.insights.map((i: any, n: number) => (
              <li key={n} className="rounded-lg bg-raised p-3">
                <div className="mb-1 flex items-center gap-2"><Badge tone={KIND[i.kind].tone}>{KIND[i.kind].label}</Badge><b className="text-[14px]">{i.title}</b></div>
                <p className="text-[13px] text-muted">{i.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <SectionTitle sub={status?.message}>Ask the assistant</SectionTitle>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim()) void ask(); }}>
          <Input aria-label="Question" placeholder={status?.aiAvailable ? 'Who should I start at FLEX?' : 'AI not configured'} value={q} onChange={(e) => setQ(e.target.value)} disabled={!status?.aiAvailable} />
          <Button type="submit" variant="primary" icon={<Sparkles className="h-4 w-4" />} loading={busy} disabled={!status?.aiAvailable || !q.trim()}>Ask</Button>
        </form>
        {!status?.aiAvailable && <p className="mt-3 text-[13px] text-muted">An administrator can enable this by setting <code className="font-mono">ANTHROPIC_API_KEY</code> on the server. Everything else in the app works without it.</p>}
        {err && <div className="mt-3"><ErrorNote error={err} /></div>}
        {ans && (
          <div className="mt-3 rounded-lg bg-raised p-3 text-[13px]">
            {ans.notice && <p className="mb-2 text-warn">{ans.notice}</p>}
            {ans.answer ? <p className="whitespace-pre-wrap">{ans.answer}</p> : <p className="text-muted">Showing the rule-based insights instead.</p>}
          </div>
        )}
      </Card>
    </div>
  );
}
