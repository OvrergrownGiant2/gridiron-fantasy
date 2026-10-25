import express, { type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { leagueChannel, userChannel, type App } from './app';
import { RATE_CLASS, call, toErrorBody } from './api/router';
import { resolveSession } from './services/auth';
import { getMedia } from './services/social';

const COOKIE = 'gridiron_session';

function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Fixed-window limiter per IP and route class. Keeps memory bounded. */
function rateLimiter() {
  const limits = { auth: 20, write: 180, read: 900 };
  const hits = new Map<string, { n: number; reset: number }>();
  return (ip: string, cls: keyof typeof limits): number | null => {
    const now = Date.now();
    const k = `${cls}:${ip}`;
    const h = hits.get(k);
    if (!h || h.reset < now) { hits.set(k, { n: 1, reset: now + 60_000 }); if (hits.size > 50_000) hits.clear(); return null; }
    h.n++;
    return h.n > limits[cls] ? Math.ceil((h.reset - now) / 1000) : null;
  };
}

export function createHttpServer(app: App, opts: { webDist: string | null; trustProxy: boolean }) {
  const server = express();
  server.disable('x-powered-by');
  if (opts.trustProxy) server.set('trust proxy', 1);
  const secure = app.config.mode === 'production';
  const limit = rateLimiter();

  server.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https://static.www.nfl.com https://a.espncdn.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  server.get('/healthz', async (_req, res) => {
    try {
      await app.db.query('SELECT 1');
      res.json({ ok: true, provider: app.provider.id });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  server.get('/media/:id', async (req, res) => {
    const m = await getMedia(app, req.params.id).catch(() => null);
    if (!m) { res.status(404).end(); return; }
    res.setHeader('Content-Type', m.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    res.end(Buffer.from(m.bytes));
  });

  server.post('/api/:method', express.json({ limit: '3.5mb' }), async (req: Request, res: Response) => {
    // CSRF defense: a custom header (forces CORS preflight cross-origin) + SameSite=Lax cookie + origin check.
    if (req.get('x-gridiron-client') !== 'web') { res.status(403).json({ error: { code: 'csrf', message: 'Missing client header.' } }); return; }
    const origin = req.get('origin');
    if (origin && new URL(app.config.publicUrl).host !== new URL(origin).host && app.config.mode === 'production') {
      res.status(403).json({ error: { code: 'csrf', message: 'Cross-origin request rejected.' } }); return;
    }
    const method = String(req.params.method);
    const ip = req.ip ?? 'unknown';
    const retry = limit(ip, RATE_CLASS(method));
    if (retry) { res.setHeader('Retry-After', String(retry)); res.status(429).json({ error: { code: 'rate_limited', message: `Too many requests. Try again in ${retry} seconds.` } }); return; }
    const token = parseCookies(req.headers.cookie)[COOKIE] ?? null;
    try {
      const user = await resolveSession(app, token);
      const out = await call(app, method, req.body?.input ?? {}, { user, token, userAgent: req.get('user-agent'), ip });
      if (out.setToken) {
        res.cookie(COOKIE, out.setToken.token, { httpOnly: true, secure, sameSite: 'lax', path: '/', expires: new Date(out.setToken.expiresAt) });
      }
      if (out.clearToken) res.clearCookie(COOKIE, { path: '/' });
      res.json({ data: out.data });
    } catch (e) {
      const { status, body } = toErrorBody(e);
      if (status >= 500) app.log(`API ${method} failed: ${(e as Error)?.stack ?? e}`);
      res.status(status).json(body);
    }
  });

  // Server-Sent Events: per-user stream of league/user events. Clients refetch affected queries.
  server.get('/api/events', async (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE] ?? null;
    const user = await resolveSession(app, token).catch(() => null);
    if (!user) { res.status(401).end(); return; }
    const leagues = await app.db.query<{ league_id: string }>('SELECT league_id FROM league_members WHERE user_id = $1', [user.id]);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 5000\n\n`);
    const unsub = app.bus.subscribe([userChannel(user.id), ...leagues.map((l) => leagueChannel(l.league_id))], (_ch, ev) => {
      res.write(`event: message\ndata: ${JSON.stringify(ev)}\n\n`);
    });
    const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
    req.on('close', () => { clearInterval(ping); unsub(); });
  });

  if (opts.webDist && existsSync(opts.webDist)) {
    server.use(express.static(opts.webDist, { index: false, maxAge: '1h', setHeaders: (res, p) => { if (p.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); } }));
    server.get(/^(?!\/api\/|\/media\/).*/, (_req, res) => res.sendFile(path.join(opts.webDist!, 'index.html')));
  }
  return server;
}
