import { z } from 'zod';
import { AppError, badRequest, conflict, unauthorized, type App } from '../app';
import { isUniqueViolation } from '../db/db';
import { NOTIFICATION_KINDS } from './common';

export const usernameSchema = z.string().trim().min(3, 'Username must be at least 3 characters.').max(20, 'Username must be 20 characters or fewer.')
  .regex(/^[a-zA-Z0-9_]+$/, 'Use letters, numbers and underscores only.');
export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters.').max(200)
  .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), 'Password must include a letter and a number.');
export const emailSchema = z.string().trim().email('Enter a valid email address.').max(200);

export interface PublicUser {
  id: string; username: string; displayName: string; email: string; avatarMediaId: string | null;
  timezone: string | null; theme: 'system' | 'light' | 'dark'; notificationPrefs: Record<string, boolean>; createdAt: string;
}

function toPublic(r: any): PublicUser {
  return {
    id: r.id, username: r.username, displayName: r.display_name, email: r.email, avatarMediaId: r.avatar_media_id,
    timezone: r.timezone, theme: r.theme, notificationPrefs: { ...Object.fromEntries(Object.keys(NOTIFICATION_KINDS).map((k) => [k, true])), ...(r.notification_prefs ?? {}) },
    createdAt: r.created_at,
  };
}

export async function register(app: App, input: { username: string; email: string; password: string; displayName?: string }, userAgent?: string) {
  const username = usernameSchema.parse(input.username);
  const email = emailSchema.parse(input.email).toLowerCase();
  const password = passwordSchema.parse(input.password);
  const displayName = (input.displayName ?? '').trim().slice(0, 40) || username;
  const hash = await app.platform.hashPassword(password);
  try {
    const row = await app.db.one('INSERT INTO users (username, email, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING *', [username, email, displayName, hash]);
    const session = await createSession(app, row!.id, userAgent);
    return { user: toPublic(row), token: session.token, expiresAt: session.expiresAt };
  } catch (e) {
    if (isUniqueViolation(e, 'users_username_ci')) throw conflict('That username is taken.');
    if (isUniqueViolation(e, 'users_email_ci')) throw conflict('An account with that email already exists.');
    throw e;
  }
}

export async function createSession(app: App, userId: string, userAgent?: string) {
  const token = app.platform.randomToken(32);
  const tokenHash = await app.platform.sha256Hex(token);
  const expiresAt = new Date(app.clock.now().getTime() + app.config.sessionDays * 86_400_000).toISOString();
  await app.db.query('INSERT INTO sessions (user_id, token_hash, user_agent, expires_at) VALUES ($1,$2,$3,$4)', [userId, tokenHash, (userAgent ?? '').slice(0, 200), expiresAt]);
  return { token, expiresAt };
}

/** Constant-ish time login: a dummy hash is verified when the user does not exist. */
const DUMMY_HASH_PROMISE = new Map<App, Promise<string>>();
export async function login(app: App, input: { identifier: string; password: string }, userAgent?: string) {
  const id = String(input.identifier ?? '').trim().toLowerCase();
  const pw = String(input.password ?? '');
  if (!id || !pw) throw badRequest('Enter your username or email and password.');
  const row = await app.db.one('SELECT * FROM users WHERE lower(username) = $1 OR lower(email) = $1', [id]);
  if (!DUMMY_HASH_PROMISE.has(app)) DUMMY_HASH_PROMISE.set(app, app.platform.hashPassword('not-a-real-password-1'));
  const ok = row ? await app.platform.verifyPassword(pw, row.password_hash) : (await app.platform.verifyPassword(pw, await DUMMY_HASH_PROMISE.get(app)!), false);
  if (!row || !ok) throw new AppError(401, 'invalid_credentials', 'Incorrect username/email or password.');
  const session = await createSession(app, row.id, userAgent);
  return { user: toPublic(row), token: session.token, expiresAt: session.expiresAt };
}

export async function resolveSession(app: App, token: string | null | undefined): Promise<PublicUser | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const tokenHash = await app.platform.sha256Hex(token);
  const row = await app.db.one(
    `SELECT u.*, s.id AS session_id, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > $2`, [tokenHash, app.clock.now().toISOString()]);
  if (!row) return null;
  // Rolling sessions: refresh last_seen at most every 10 minutes.
  if (app.clock.now().getTime() - Date.parse(row.last_seen_at) > 600_000) {
    const exp = new Date(app.clock.now().getTime() + app.config.sessionDays * 86_400_000).toISOString();
    await app.db.query('UPDATE sessions SET last_seen_at = $2, expires_at = $3 WHERE id = $1', [row.session_id, app.clock.now().toISOString(), exp]);
  }
  return toPublic(row);
}

export async function logout(app: App, token: string | null | undefined) {
  if (!token) return { ok: true };
  await app.db.query('DELETE FROM sessions WHERE token_hash = $1', [await app.platform.sha256Hex(token)]);
  return { ok: true };
}

export async function getUser(app: App, userId: string): Promise<PublicUser> {
  const row = await app.db.one('SELECT * FROM users WHERE id = $1', [userId]);
  if (!row) throw unauthorized();
  return toPublic(row);
}

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  timezone: z.string().max(60).nullable().optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  avatarMediaId: z.string().uuid().nullable().optional(),
  notificationPrefs: z.record(z.enum(Object.keys(NOTIFICATION_KINDS) as [string, ...string[]]), z.boolean()).optional(),
});

export async function updateProfile(app: App, userId: string, input: unknown) {
  const p = profileSchema.parse(input);
  if (p.timezone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: p.timezone }); } catch { throw badRequest('Unknown time zone.'); }
  }
  if (p.avatarMediaId) {
    const m = await app.db.one('SELECT id FROM media WHERE id = $1 AND owner_user_id = $2', [p.avatarMediaId, userId]);
    if (!m) throw badRequest('Image not found.');
  }
  const sets: string[] = [];
  const vals: unknown[] = [userId];
  const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (p.displayName !== undefined) add('display_name', p.displayName);
  if (p.timezone !== undefined) add('timezone', p.timezone);
  if (p.theme !== undefined) add('theme', p.theme);
  if (p.avatarMediaId !== undefined) add('avatar_media_id', p.avatarMediaId);
  if (p.notificationPrefs !== undefined) add('notification_prefs', JSON.stringify(p.notificationPrefs));
  if (sets.length) await app.db.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
  return getUser(app, userId);
}

export async function changePassword(app: App, userId: string, input: { currentPassword: string; newPassword: string }) {
  const row = await app.db.one('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!row || !(await app.platform.verifyPassword(input.currentPassword ?? '', row.password_hash))) throw badRequest('Current password is incorrect.');
  const pw = passwordSchema.parse(input.newPassword);
  await app.db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, await app.platform.hashPassword(pw)]);
  return { ok: true };
}

/** Always responds the same way so the endpoint cannot be used to discover accounts. */
export async function requestPasswordReset(app: App, input: { email: string }) {
  const email = String(input.email ?? '').trim().toLowerCase();
  const generic = { ok: true, message: 'If an account exists for that email, a reset link has been sent.' } as { ok: true; message: string; devLink?: string };
  const row = email ? await app.db.one<{ id: string; email: string }>('SELECT id, email FROM users WHERE lower(email) = $1', [email]) : null;
  if (!row) return generic;
  const token = app.platform.randomToken(32);
  await app.db.query('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [row.id, await app.platform.sha256Hex(token), new Date(app.clock.now().getTime() + 3_600_000).toISOString()]);
  const link = `${app.config.publicUrl}/#/reset-password?token=${token}`;
  const res = await app.mailer.sendPasswordReset(row.email, link);
  if (res.devLink && app.config.mode !== 'production') generic.devLink = res.devLink;
  return generic;
}

export async function resetPassword(app: App, input: { token: string; newPassword: string }) {
  const pw = passwordSchema.parse(input.newPassword);
  const hash = await app.platform.sha256Hex(String(input.token ?? ''));
  return app.db.tx(async (db) => {
    const r = await db.one<{ id: string; user_id: string }>('SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 FOR UPDATE', [hash, app.clock.now().toISOString()]);
    if (!r) throw badRequest('This reset link is invalid or has expired.');
    await db.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [r.id]);
    await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [r.user_id, await app.platform.hashPassword(pw)]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [r.user_id]); // sign out everywhere
    return { ok: true };
  });
}
