import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Platform } from '../app';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Node platform: scrypt password hashing (salted, memory-hard), CSPRNG tokens, SHA-256. */
export const nodePlatform: Platform = {
  async hashPassword(password) {
    const salt = randomBytes(16);
    const key = await scrypt(password.normalize('NFKC'), salt, 32, PARAMS);
    return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
  },
  async verifyPassword(password, stored) {
    const parts = stored.split('$');
    if (parts[0] === 'pbkdf2') {
      const { webPlatform } = await import('./web');
      return webPlatform.verifyPassword(password, stored);
    }
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, salt, hash] = parts;
    const expected = Buffer.from(hash, 'base64');
    const key = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
    return key.length === expected.length && timingSafeEqual(key, expected);
  },
  randomToken(bytes = 32) { return randomBytes(bytes).toString('base64url'); },
  async sha256Hex(input) { return createHash('sha256').update(input).digest('hex'); },
};
