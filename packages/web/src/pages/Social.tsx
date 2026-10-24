import { useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, Send, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TeamLogo } from '../components/team';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorNote, LoadingBlock, PageHeader, Segmented, Textarea, cx } from '../components/ui';
import { dateTime, relative, timeOnly } from '../lib/format';
import { useAction, useCall, useLeague, useMe } from '../lib/hooks';

export function Chat() {
  const { leagueId } = useParams();
  const { data: L } = useLeague(leagueId);
  const { data: me } = useMe();
  const { data, isLoading, error } = useCall<any[]>(['chat', leagueId], 'chat.list', { leagueId, limit: 100 }, { refetchInterval: 15_000 });
  const [body, setBody] = useState('');
  const [del, setDel] = useState<any>(null);
  const qc = useQueryClient();
  const post = useAction('chat.post', { invalidate: ['chat'], onSuccess: () => setBody('') });
  const remove = useAction('chat.delete', { invalidate: ['chat'], success: 'Message removed.' });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [data?.length]);
  if (isLoading || !L) return <LoadingBlock />;
  const canPost = L.permissions.includes('chat.post') && L.settings.chat.enabled;
  const canModerate = L.permissions.includes('chat.moderate');
  const send = () => { if (body.trim()) post.mutate({ leagueId, body }); };
  let lastDay = '';
  return (
    <div className="flex h-[calc(100vh-220px)] min-h-[420px] flex-col lg:h-[calc(100vh-160px)]">
      <PageHeader title="League Chat" sub="Only display names and team identities are shown. Use @username to mention someone." />
      <Card pad={false} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error && <ErrorNote error={error} />}
          {data && data.length === 0 && <Empty title="No messages yet" body="Say hello to the league." />}
          {data?.map((m) => {
            const day = new Date(m.created_at).toDateString();
            const sep = day !== lastDay; lastDay = day;
            const mine = m.user_id === me?.user?.id;
            const team = m.team_id ? { name: m.team_name, abbrev: m.abbrev, primary_color: m.primary_color, secondary_color: m.secondary_color, logo_media_id: m.logo_media_id, logo_preset: m.logo_preset } : { name: m.display_name };
            return (
              <div key={m.id}>
                {sep && <div className="my-3 text-center text-[11px] font-semibold uppercase tracking-wider text-faint">{dateTime(m.created_at).split(',')[0]}</div>}
                <div className={cx('group flex gap-2.5 py-1.5', mine && 'flex-row-reverse')}>
                  <TeamLogo team={team} size={32} />
                  <div className={cx('min-w-0 max-w-[78%]', mine && 'items-end text-right')}>
                    <div className="text-[12px] text-muted"><b className="text-ink">{m.display_name}</b>{m.team_name ? ` · ${m.team_name}` : ''} · {timeOnly(m.created_at)}</div>
                    <div className={cx('mt-0.5 inline-block whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-left text-[14px]', m.body === null ? 'italic text-faint' : mine ? 'bg-turf text-white' : 'bg-raised')}>
                      {m.body === null ? 'Message removed' : m.body.split(/(@[A-Za-z0-9_]{3,20})/g).map((part: string, i: number) => part.startsWith('@') ? <b key={i} className={mine ? 'text-accent' : 'text-accent'}>{part}</b> : part)}
                    </div>
                  </div>
                  {m.body !== null && (mine || canModerate) && <button aria-label="Delete message" className="self-center rounded p-1 text-faint opacity-0 transition hover:text-bad group-hover:opacity-100 focus:opacity-100" onClick={() => setDel(m)}><Trash2 className="h-3.5 w-3.5" /></button>}
                </div>
              </div>
            );
          })}
          <div ref={end} />
        </div>
        <form className="flex items-end gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <Textarea aria-label="Message" className="min-h-[44px] flex-1 resize-none" rows={1} disabled={!canPost} placeholder={canPost ? 'Message the league' : 'You cannot post in this chat.'}
            value={body} maxLength={1000} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <Button type="submit" variant="primary" aria-label="Send" disabled={!canPost || !body.trim()} loading={post.isPending}><Send className="h-4 w-4" /></Button>
        </form>
      </Card>
      <ConfirmDialog open={Boolean(del)} onClose={() => setDel(null)} title="Remove message?" confirmLabel="Remove" danger
        body={del && del.user_id !== me?.user?.id ? 'Moderator removals are recorded in the audit log.' : 'This removes your message for everyone.'}
        onConfirm={() => remove.mutateAsync({ messageId: del.id }).then(() => qc.invalidateQueries({ queryKey: ['chat'] }))} />
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  trade_proposal: 'Trade offer', trade_counter: 'Counteroffer', trade_decision: 'Trade', trade_vote: 'Vote', waiver_result: 'Waivers',
  draft_turn: 'Draft', player_injury: 'Injury', lineup_lock: 'Lineup', matchup_result: 'Result', announcement: 'Announcement', commissioner_queue: 'Commissioner', chat_mention: 'Chat',
};

export function Notifications() {
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const { data, isLoading } = useCall<any>(['notifications', filter], 'notifications.list', { unreadOnly: filter === 'unread', limit: 100 });
  const read = useAction('notifications.read', { invalidate: ['notifications', 'dashboard', 'league'] });
  return (
    <div className="space-y-4">
      <PageHeader title="Notifications" sub={data ? `${data.unread} unread` : undefined}
        actions={<><Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }]} />
          <Button icon={<CheckCheck className="h-4 w-4" />} disabled={!data?.unread} onClick={() => read.mutate({ all: true })}>Mark all read</Button></>} />
      {isLoading ? <LoadingBlock /> : data.notifications.length === 0 ? <Empty icon={<Bell className="h-8 w-8" />} title="You're all caught up" body="Choose which events notify you in Profile & Settings." /> : (
        <Card pad={false}>
          {data.notifications.map((n: any) => {
            const content = (
              <div className={cx('flex gap-3 border-t border-line px-4 py-3 first:border-t-0', !n.read_at && 'bg-accent/[.06]')}>
                <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-accent')} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><Badge>{KIND_LABEL[n.kind] ?? n.kind}</Badge>{n.league_name && <span className="text-[12px] text-muted">{n.league_name}</span>}</div>
                  <div className="mt-0.5 font-semibold">{n.title}</div>
                  {n.body && <div className="text-[13px] text-muted">{n.body}</div>}
                </div>
                <span className="shrink-0 text-[12px] text-faint">{relative(n.created_at)}</span>
              </div>
            );
            return n.link
              ? <Link key={n.id} to={n.link.split('?')[0]} onClick={() => !n.read_at && read.mutate({ ids: [n.id] })} className="block hover:bg-raised">{content}</Link>
              : <button key={n.id} className="block w-full text-left hover:bg-raised" onClick={() => !n.read_at && read.mutate({ ids: [n.id] })}>{content}</button>;
          })}
        </Card>
      )}
    </div>
  );
}
