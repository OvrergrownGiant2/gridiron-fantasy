import type { Platform } from '../app';

/** Browser platform (demo mode): PBKDF2-SHA256 via WebCrypto. */
const ITER = 210_000;
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: iter }, key, 256));
}

export const webPlatform: Platform = {
  async hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return `pbkdf2$${ITER}$${b64(salt)}$${b64(await derive(password, salt, ITER))}`;
  },
  async verifyPassword(password, stored) {
    const [kind, iter, salt, hash] = stored.split('$');
    if (kind !== 'pbkdf2') return false;
    const a = await derive(password, unb64(salt), Number(iter));
    const b = unb64(hash);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  },
  randomToken(bytes = 32) {
    const a = crypto.getRandomValues(new Uint8Array(bytes));
    return b64(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  async sha256Hex(input) {
    const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
    return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
  },
};
