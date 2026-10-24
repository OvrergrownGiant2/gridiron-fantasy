import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createHttpServer } from '../src/http';
import { setupApp, type TestCtx } from './helpers';

let ctx: TestCtx; let server: Server; let base = '';
beforeAll(async () => {
  ctx = await setupApp();
  server = createHttpServer(ctx.app, { webDist: null, trustProxy: false }).listen(0);
  base = `http://127.0.0.1:${(server.address() as any).port}`;
}, 120_000);
afterAll(async () => { server.close(); await ctx.app.db.close?.(); });

const post = (method: string, input: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gridiron-client': 'web', ...headers }, body: JSON.stringify({ input }) });

describe('HTTP API security', () => {
  it('sets an httpOnly session cookie and never returns the password hash', async () => {
    const r = await post('auth.register', { username: 'httpuser', email: 'h@example.com', password: 'password123' });
    expect(r.status).toBe(200);
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toMatch(/gridiron_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(await r.text()).not.toMatch(/scrypt|password_hash/);
    const me = await post('auth.me', {}, { cookie: cookie.split(';')[0] });
    expect((await me.json()).data.user.username).toBe('httpuser');
  });
  it('rejects requests without the client header (CSRF defense)', async () => {
    const r = await fetch(`${base}/api/leagues.mine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(403);
  });
  it('returns 401 without a session and safe error bodies for bad input', async () => {
    expect((await post('leagues.mine', {})).status).toBe(401);
    const bad = await post('auth.register', { username: 'x', email: 'nope', password: '1' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toMatch(/Username/);
  });
  it('rate limits authentication attempts', async () => {
    let last = 200;
    for (let i = 0; i < 25; i++) last = (await post('auth.login', { identifier: 'httpuser', password: 'wrong-pass1' })).status;
    expect(last).toBe(429);
  });
  it('sends security headers', async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
  });
});
