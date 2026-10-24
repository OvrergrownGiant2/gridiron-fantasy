export interface AppEventMsg { type: string; leagueId?: string; userId?: string; payload?: any }

export interface Transport {
  mode: 'http' | 'demo';
  call<T = any>(method: string, input?: unknown): Promise<T>;
  subscribe(cb: (ev: AppEventMsg) => void): () => void;
  mediaUrl(id: string): Promise<string>;
  /** Called after login/logout so realtime streams can re-scope to the new session. */
  sessionChanged(): void;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}
