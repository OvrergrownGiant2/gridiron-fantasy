import { ZodError } from 'zod';
import { AppError, unauthorized, type Actor, type App } from '../app';
import * as assistant from '../services/assistant';
import * as auth from '../services/auth';
import * as drafts from '../services/drafts';
import * as leagues from '../services/leagues';
import * as players from '../services/players';
import * as rosters from '../services/rosters';
import { refreshLeague } from '../services/refresh';
import * as social from '../services/social';
import * as trades from '../services/trades';
import * as views from '../services/views';
import * as waivers from '../services/waivers';

export interface CallContext {
  user: auth.PublicUser | null;
  token: string | null;
  userAgent?: string;
  ip: string;
}

export interface CallResult { data: unknown; setToken?: { token: string; expiresAt: string } | null; clearToken?: boolean }

type Handler = (app: App, actor: Actor, input: any, ctx: CallContext) => Promise<unknown>;
interface Route { auth: boolean; rate: 'auth' | 'write' | 'read'; handler: Handler }

const r = (handler: Handler, rate: Route['rate'] = 'write'): Route => ({ auth: true, rate, handler });
const read = (handler: Handler): Route => r(handler, 'read');

export const routes: Record<string, Route> = {
  // auth (session-token handling happens in `call`)
  'auth.me': { auth: false, rate: 'read', handler: async (_a, _x, _i, ctx) => ({ user: ctx.user }) },
  'auth.changePassword': r((app, a, i) => auth.changePassword(app, (a as any).userId, i), 'auth'),
  'profile.update': r((app, a, i) => auth.updateProfile(app, (a as any).userId, i)),

  'leagues.mine': read((app, a) => leagues.listMyLeagues(app, a)),
  'leagues.public': read((app, a) => leagues.listPublicLeagues(app, a)),
  'leagues.create': r((app, a, i) => leagues.createLeague(app, a, i)),
  'leagues.join': r((app, a, i) => leagues.joinLeague(app, a, i)),
  'leagues.leave': r((app, a, i) => leagues.leaveLeague(app, a, i)),
  'leagues.get': read((app, a, i) => leagues.leagueDetail(app, a, i)),
  'leagues.updateInfo': r((app, a, i) => leagues.updateLeagueInfo(app, a, i)),
  'leagues.updateSettings': r((app, a, i) => leagues.updateSettings(app, a, i)),
  'leagues.updateScoring': r((app, a, i) => leagues.updateScoring(app, a, i)),
  'leagues.scoringHistory': read((app, a, i) => leagues.scoringHistory(app, a, i)),
  'leagues.addAi': r((app, a, i) => leagues.addAiTeams(app, a, i)),
  'leagues.setAiDifficulty': r((app, a, i) => leagues.setAiDifficulty(app, a, i)),
  'leagues.setRole': r((app, a, i) => leagues.setMemberRole(app, a, i)),
  'leagues.transfer': r((app, a, i) => leagues.transferCommissioner(app, a, i)),
  'leagues.addObserver': r((app, a, i) => leagues.addObserver(app, a, i)),
  'leagues.removeMember': r((app, a, i) => leagues.removeMember(app, a, i)),
  'leagues.regenerateInvite': r((app, a, i) => leagues.regenerateInvite(app, a, i)),
  'leagues.delete': r((app, a, i) => leagues.deleteLeague(app, a, i)),
  'leagues.refresh': r((app, a, i) => refreshLeague(app, a, i)),
  'teams.update': r((app, a, i) => leagues.updateTeam(app, a, i)),

  'rosters.get': read((app, a, i) => rosters.getRoster(app, a, i)),
  'rosters.setLineup': r((app, a, i) => rosters.setLineup(app, a, i)),
  'rosters.suggest': read((app, a, i) => rosters.suggestLineup(app, a, i)),
  'rosters.addFreeAgent': r((app, a, i) => rosters.addFreeAgent(app, a, i)),
  'rosters.drop': r((app, a, i) => rosters.dropPlayer(app, a, i)),
  'rosters.commishEdit': r((app, a, i) => rosters.commissionerRosterEdit(app, a, i)),

  'players.search': read((app, a, i) => players.searchPlayers(app, a, i)),
  'players.profile': read((app, a, i) => players.playerProfile(app, a, i)),
  'players.meta': read((app, a) => players.playerMeta(app, a)),
  'players.card': read((app, a, i) => players.playerCard(app, a, i)),
  'drafts.finishForMe': r((app, a, i) => drafts.finishForMe(app, a, i)),

  'drafts.get': read((app, a, i) => drafts.getDraft(app, a, i)),
  'drafts.available': read((app, a, i) => drafts.draftAvailable(app, a, i)),
  'drafts.configure': r((app, a, i) => drafts.configureDraft(app, a, i)),
  'drafts.start': r((app, a, i) => drafts.startDraft(app, a, i)),
  'drafts.pick': r((app, a, i) => drafts.makePick(app, a, i)),
  'drafts.queue': r((app, a, i) => drafts.setQueue(app, a, i)),
  'drafts.pause': r((app, a, i) => drafts.pauseDraft(app, a, i)),
  'drafts.undo': r((app, a, i) => drafts.undoPick(app, a, i)),
  'drafts.mock': r((app, a, i) => drafts.createMockDraft(app, a, i)),
  'drafts.nominate': r((app, a, i) => drafts.nominate(app, a, i)),
  'drafts.bid': r((app, a, i) => drafts.placeBid(app, a, i)),
  'drafts.autoAll': r((app, a, i) => drafts.autoDraftAll(app, a, i)),

  'waivers.overview': read((app, a, i) => waivers.waiverOverview(app, a, i)),
  'waivers.claim': r((app, a, i) => waivers.submitClaim(app, a, i)),
  'waivers.updateClaim': r((app, a, i) => waivers.updateClaim(app, a, i)),
  'waivers.cancelClaim': r((app, a, i) => waivers.cancelClaim(app, a, i)),
  'waivers.reorder': r((app, a, i) => waivers.reorderClaims(app, a, i)),
  'waivers.processNow': r((app, a, i) => waivers.processWaivers(app, i.leagueId, a)),
  'transactions.list': read((app, a, i) => waivers.transactionHistory(app, a, i)),

  'trades.list': read((app, a, i) => trades.listTrades(app, a, i)),
  'trades.preview': read((app, a, i) => trades.previewTrade(app, a, i)),
  'trades.propose': r((app, a, i) => trades.proposeTrade(app, a, i)),
  'trades.accept': r((app, a, i) => trades.acceptTrade(app, a, i)),
  'trades.reject': r((app, a, i) => trades.rejectTrade(app, a, i)),
  'trades.counter': r((app, a, i) => trades.counterTrade(app, a, i)),
  'trades.cancel': r((app, a, i) => trades.cancelTrade(app, a, i)),
  'trades.vote': r((app, a, i) => trades.voteTrade(app, a, i)),
  'trades.decide': r((app, a, i) => trades.commissionerDecision(app, a, i)),

  'matchups.week': read((app, a, i) => views.weekMatchups(app, a, i)),
  'matchups.get': read((app, a, i) => views.getMatchup(app, a, i)),
  'standings.get': read((app, a, i) => views.standings(app, a, i)),
  'schedule.get': read((app, a, i) => views.schedule(app, a, i)),
  'nfl.scoreboard': read((app, a, i) => views.nflScoreboard(app, a, i)),
  'nfl.status': read((app) => views.nflStatus(app)),
  'dashboard.get': read((app, a) => views.dashboard(app, a)),
  'commish.dashboard': read((app, a, i) => views.commissionerDashboard(app, a, i)),
  'commish.recalculate': r((app, a, i) => views.recalculateWeeks(app, a, i)),
  'commish.decideCorrection': r((app, a, i) => views.decideCorrection(app, a, i)),

  'chat.list': read((app, a, i) => social.listMessages(app, a, i)),
  'chat.post': r((app, a, i) => social.postMessage(app, a, i)),
  'chat.delete': r((app, a, i) => social.deleteMessage(app, a, i)),
  'chat.mute': r((app, a, i) => social.muteMember(app, a, i)),
  'announce': r((app, a, i) => social.announce(app, a, i)),
  'notifications.list': read((app, a, i) => social.listNotifications(app, a, i ?? {})),
  'notifications.read': r((app, a, i) => social.markNotificationsRead(app, a, i)),
  'activity.list': read((app, a, i) => social.listActivity(app, a, i)),
  'audit.list': read((app, a, i) => social.auditLog(app, a, i)),
  'media.upload': r((app, a, i) => social.uploadMedia(app, a, i)),
  'media.delete': r((app, a, i) => social.deleteMedia(app, a, i)),

  'assistant.status': read(async (app) => assistant.assistantStatus(app)),
  'assistant.insights': read((app, a, i) => assistant.insights(app, a, i)),
  'assistant.ask': r((app, a, i) => assistant.ask(app, a, i)),
};

/** Extra routes that only exist in demo/development builds. */
export const devRoutes: Record<string, Route> = {};

export function toErrorBody(e: unknown): { status: number; body: { error: { code: string; message: string; details?: unknown } } } {
  if (e instanceof AppError) return { status: e.status, body: { error: { code: e.code, message: e.message, details: e.details } } };
  if (e instanceof ZodError) {
    const first = e.issues[0];
    return { status: 400, body: { error: { code: 'validation', message: first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input.', details: e.issues } } };
  }
  const msg = (e as Error)?.message ?? String(e);
  return { status: 500, body: { error: { code: 'internal', message: 'Something went wrong on our side. Please try again.', details: (globalThis as any).process?.env?.NODE_ENV === 'production' ? undefined : msg } } };
}

/** Transport-independent entry point used by HTTP and by the in-browser demo. */
export async function call(app: App, method: string, input: unknown, ctx: CallContext): Promise<CallResult> {
  switch (method) {
    case 'auth.register': {
      const r = await auth.register(app, input as any, ctx.userAgent);
      return { data: { user: r.user }, setToken: { token: r.token, expiresAt: r.expiresAt } };
    }
    case 'auth.login': {
      const r = await auth.login(app, input as any, ctx.userAgent);
      return { data: { user: r.user }, setToken: { token: r.token, expiresAt: r.expiresAt } };
    }
    case 'auth.logout':
      await auth.logout(app, ctx.token);
      return { data: { ok: true }, clearToken: true };
    case 'auth.requestReset':
      return { data: await auth.requestPasswordReset(app, input as any) };
    case 'auth.resetPassword':
      return { data: await auth.resetPassword(app, input as any) };
  }
  const route = routes[method] ?? devRoutes[method];
  if (!route) throw new AppError(404, 'unknown_method', `Unknown API method: ${method}`);
  if (route.auth && !ctx.user) throw unauthorized();
  const actor: Actor = ctx.user ? { kind: 'user', userId: ctx.user.id } : { kind: 'system' };
  if (route.auth && actor.kind !== 'user') throw unauthorized();
  return { data: await route.handler(app, actor, input ?? {}, ctx) };
}

export const RATE_CLASS = (method: string): 'auth' | 'write' | 'read' =>
  method.startsWith('auth.') && method !== 'auth.me' ? 'auth' : (routes[method] ?? devRoutes[method])?.rate ?? 'write';
