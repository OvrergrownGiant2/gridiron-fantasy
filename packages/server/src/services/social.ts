import { z } from 'zod';
import { badRequest, forbidden, notFound, type Actor, type App } from '../app';
import { activity, audit, notify, publishLeague, requirePermission, requireUser, roleIn, withTx } from './common';

// ---------------------------------------------------------------- chat

const chatRate = new Map<string, number[]>();

export async function postMessage(app: App, actor: Actor, input: { leagueId: string; body: string }) {
  const userId = requireUser(actor);
  await requirePermission(app.db, actor, input.leagueId, 'chat.post');
  const body = String(input.body ?? '').trim();
  if (!body) throw badRequest('Message is empty.');
  if (body.length > 1000) throw badRequest('Messages are limited to 1000 characters.');
  const m = await app.db.one<{ muted_until: string | null }>('SELECT muted_until FROM league_members WHERE league_id = $1 AND user_id = $2', [input.leagueId, userId]);
  if (m?.muted_until && Date.parse(m.muted_until) > app.clock.now().getTime()) throw forbidden('You are muted in this league chat.');
  const league = await app.db.one<{ settings: any }>('SELECT settings FROM leagues WHERE id = $1', [input.leagueId]);
  if (league?.settings?.chat?.enabled === false) throw badRequest('Chat is disabled in this league.');
  // simple per-user flood control: 8 messages / 10 s
  const now = app.clock.now().getTime();
  const recent = (chatRate.get(userId) ?? []).filter((t) => now - t < 10_000);
  if (recent.length >= 8) throw badRequest('You are sending messages too quickly.');
  chatRate.set(userId, [...recent, now]);
  return withTx(app, async (db) => {
    const row = await db.one('INSERT INTO chat_messages (league_id, user_id, body) VALUES ($1,$2,$3) RETURNING id, created_at', [input.leagueId, userId, body]);
    // @mentions by username → notification (only league members are resolved)
    const mentions = [...new Set([...body.matchAll(/@([A-Za-z0-9_]{3,20})/g)].map((x) => x[1].toLowerCase()))].slice(0, 5);
    if (mentions.length) {
      const users = await db.query<{ id: string }>('SELECT u.id FROM users u JOIN league_members m ON m.user_id = u.id WHERE m.league_id = $1 AND lower(u.username) = ANY($2) AND u.id <> $3', [input.leagueId, mentions, userId]);
      for (const u of users) await notify(app, db, { userId: u.id, leagueId: input.leagueId, kind: 'chat_mention', title: 'You were mentioned in league chat', body: body.slice(0, 120), link: `/league/${input.leagueId}/chat` });
    }
    publishLeague(app, db, input.leagueId, 'chat', { id: row!.id });
    return { id: row!.id, createdAt: row!.created_at };
  });
}

/** Chat history. Only public profile fields (display name, username, team identity) are exposed. */
export async function listMessages(app: App, actor: Actor, input: { leagueId: string; before?: string; limit?: number }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  const rows = await app.db.query(
    `SELECT c.id, c.user_id, CASE WHEN c.deleted_at IS NULL THEN c.body ELSE NULL END AS body, c.deleted_at, c.created_at,
            u.display_name, u.username, u.avatar_media_id, t.id AS team_id, t.name AS team_name, t.abbrev, t.primary_color, t.secondary_color, t.logo_media_id, t.logo_preset
     FROM chat_messages c JOIN users u ON u.id = c.user_id LEFT JOIN teams t ON t.league_id = c.league_id AND t.owner_user_id = c.user_id
     WHERE c.league_id = $1 AND ($2::timestamptz IS NULL OR c.created_at < $2) ORDER BY c.created_at DESC LIMIT $3`,
    [input.leagueId, input.before ?? null, Math.min(100, input.limit ?? 50)]);
  return rows.reverse();
}

export async function deleteMessage(app: App, actor: Actor, input: { messageId: string; reason?: string }) {
  const userId = requireUser(actor);
  const msg = await app.db.one<{ league_id: string; user_id: string }>('SELECT league_id, user_id FROM chat_messages WHERE id = $1', [input.messageId]);
  if (!msg) throw notFound('Message');
  const role = await roleIn(app.db, msg.league_id, userId);
  if (!role) throw notFound('Message');
  const own = msg.user_id === userId;
  if (!own) await requirePermission(app.db, actor, msg.league_id, 'chat.moderate');
  await app.db.query('UPDATE chat_messages SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [input.messageId, userId]);
  if (!own) await audit(app.db, { leagueId: msg.league_id, actor, action: 'chat.delete', target: input.messageId, reason: input.reason ?? null });
  app.bus.publish(`league:${msg.league_id}`, { type: 'chat' });
  return { ok: true };
}

export async function muteMember(app: App, actor: Actor, input: { leagueId: string; userId: string; hours: number; reason: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'chat.moderate');
  if (!input.reason?.trim()) throw badRequest('A reason is required.');
  const target = await roleIn(app.db, input.leagueId, input.userId);
  if (!target) throw notFound('Member');
  if (target === 'commissioner') throw forbidden('The commissioner cannot be muted.');
  const until = input.hours > 0 ? new Date(app.clock.now().getTime() + Math.min(720, input.hours) * 3_600_000).toISOString() : null;
  await app.db.query('UPDATE league_members SET muted_until = $3 WHERE league_id = $1 AND user_id = $2', [input.leagueId, input.userId, until]);
  await audit(app.db, { leagueId: input.leagueId, actor, action: until ? 'chat.mute' : 'chat.unmute', target: input.userId, reason: input.reason, payload: { until } });
  return { ok: true, until };
}

export async function announce(app: App, actor: Actor, input: { leagueId: string; title: string; body: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'announce');
  const title = String(input.title ?? '').trim().slice(0, 100);
  if (!title) throw badRequest('Title is required.');
  return withTx(app, async (db) => {
    const members = await db.query<{ user_id: string }>('SELECT user_id FROM league_members WHERE league_id = $1', [input.leagueId]);
    for (const m of members) await notify(app, db, { userId: m.user_id, leagueId: input.leagueId, kind: 'announcement', title, body: String(input.body ?? '').slice(0, 1000), link: `/league/${input.leagueId}/hub` });
    await activity(app, db, input.leagueId, 'announcement', `📣 ${title}`, { body: input.body });
    await audit(db, { leagueId: input.leagueId, actor, action: 'announce', payload: { title } });
    return { sent: members.length };
  });
}

// ---------------------------------------------------------------- notifications & activity

export async function listNotifications(app: App, actor: Actor, input: { unreadOnly?: boolean; limit?: number }) {
  const userId = requireUser(actor);
  const rows = await app.db.query(`SELECT n.*, l.name AS league_name FROM notifications n LEFT JOIN leagues l ON l.id = n.league_id
    WHERE n.user_id = $1 ${input.unreadOnly ? 'AND n.read_at IS NULL' : ''} ORDER BY n.created_at DESC LIMIT $2`, [userId, Math.min(200, input.limit ?? 50)]);
  const unread = (await app.db.one<{ c: number }>('SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]))!.c;
  return { notifications: rows, unread };
}

export async function markNotificationsRead(app: App, actor: Actor, input: { ids?: string[]; all?: boolean }) {
  const userId = requireUser(actor);
  if (input.all) await app.db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
  else if (input.ids?.length) await app.db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL', [userId, input.ids]);
  return { ok: true };
}

export async function listActivity(app: App, actor: Actor, input: { leagueId: string; before?: number; limit?: number; kind?: string }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  return app.db.query(`SELECT id, kind, summary, payload, created_at FROM activity WHERE league_id = $1 AND ($2::bigint IS NULL OR id < $2) AND ($3::text IS NULL OR kind = $3)
    ORDER BY id DESC LIMIT $4`, [input.leagueId, input.before ?? null, input.kind ?? null, Math.min(100, input.limit ?? 40)]);
}

export async function auditLog(app: App, actor: Actor, input: { leagueId: string; limit?: number }) {
  await requirePermission(app.db, actor, input.leagueId, 'league.view');
  return app.db.query(`SELECT a.id, a.action, a.target, a.reason, a.actor_kind, a.payload, a.created_at, u.display_name AS actor_name
    FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.league_id = $1 ORDER BY a.id DESC LIMIT $2`, [input.leagueId, Math.min(200, input.limit ?? 100)]);
}

// ---------------------------------------------------------------- media

const MAX_BYTES = 2 * 1024 * 1024;

/** Identify type from magic bytes (never trust the declared type or extension) and read dimensions. */
export function sniffImage(b: Uint8Array): { mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number } | null {
  const u32be = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { mime: 'image/png', width: u32be(16), height: u32be(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const marker = b[o + 1];
      const len = (b[o + 2] << 8) | b[o + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', height: (b[o + 5] << 8) | b[o + 6], width: (b[o + 7] << 8) | b[o + 8] };
      }
      o += 2 + len;
    }
    return null;
  }
  if (b.length > 30 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') {
    const chunk = String.fromCharCode(...b.slice(12, 16));
    if (chunk === 'VP8X') return { mime: 'image/webp', width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (chunk === 'VP8 ') return { mime: 'image/webp', width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    if (chunk === 'VP8L') { const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
  }
  return null;
}

const uploadSchema = z.object({ dataBase64: z.string().min(10).max(Math.ceil(MAX_BYTES * 1.37) + 100), purpose: z.enum(['avatar', 'team_logo', 'team_banner', 'league_logo']) });

export function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/^data:[^,]+,/, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function uploadMedia(app: App, actor: Actor, input: unknown) {
  const userId = requireUser(actor);
  const p = uploadSchema.parse(input);
  let bytes: Uint8Array;
  try { bytes = decodeBase64(p.dataBase64); } catch { throw badRequest('The file could not be read.'); }
  if (bytes.length === 0) throw badRequest('The file is empty.');
  if (bytes.length > MAX_BYTES) throw badRequest('Images must be 2 MB or smaller.');
  const info = sniffImage(bytes);
  if (!info) throw badRequest('Only PNG, JPEG and WebP images are supported.');
  if (info.width < 16 || info.height < 16 || info.width > 4096 || info.height > 4096) throw badRequest('Images must be between 16 and 4096 pixels on each side.');
  const count = (await app.db.one<{ c: number }>("SELECT count(*)::int AS c FROM media WHERE owner_user_id = $1 AND created_at > now() - interval '1 day'", [userId]))!.c;
  if (count > 50) throw badRequest('Upload limit reached for today.');
  const sha = await app.platform.sha256Hex(bytes);
  const row = await app.db.one<{ id: string }>('INSERT INTO media (owner_user_id, mime, bytes, byte_size, width, height, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [userId, info.mime, bytes, bytes.length, info.width, info.height, sha]);
  return { id: row!.id, mime: info.mime, width: info.width, height: info.height };
}

export async function deleteMedia(app: App, actor: Actor, input: { id: string }) {
  const userId = requireUser(actor);
  const r = await app.db.query('DELETE FROM media WHERE id = $1 AND owner_user_id = $2 RETURNING id', [input.id, userId]);
  if (!r.length) throw notFound('Image');
  return { ok: true };
}

/** Raw bytes for serving. Media are public-by-id (unguessable UUIDs) so they can be used in <img>. */
export async function getMedia(app: App, id: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await app.db.one<{ mime: string; bytes: Uint8Array }>('SELECT mime, bytes FROM media WHERE id = $1', [id]);
  return r ? { mime: r.mime, bytes: r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes as any) } : null;
}
