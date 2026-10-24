import { ApiError, type AppEventMsg, type Transport } from './transport';

export function createHttpTransport(base = ''): Transport {
  const listeners = new Set<(e: AppEventMsg) => void>();
  let es: EventSource | null = null;
  const connect = () => {
    es?.close();
    es = new EventSource(`${base}/api/events`, { withCredentials: true });
    es.onmessage = (m) => { try { const ev = JSON.parse(m.data); listeners.forEach((l) => l(ev)); } catch { /* ignore */ } };
    es.onerror = () => { /* the browser reconnects automatically using the server's retry hint */ };
  };
  return {
    mode: 'http',
    async call(method, input) {
      let res: Response;
      try {
        res = await fetch(`${base}/api/${method}`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Gridiron-Client': 'web' },
          body: JSON.stringify({ input: input ?? {} }),
        });
      } catch {
        throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and try again.');
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'http', body?.error?.message ?? `Request failed (HTTP ${res.status}).`, body?.error?.details);
      return body?.data;
    },
    subscribe(cb) {
      listeners.add(cb);
      if (!es) connect();
      return () => listeners.delete(cb);
    },
    async mediaUrl(id) { return `${base}/media/${id}`; },
    sessionChanged() { if (listeners.size) connect(); },
  };
}
