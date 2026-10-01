// Sealing secrets at rest (Kmoe session cookies, WebDAV passwords) with AES-256-GCM.
// The key is derived from the instance secret (data/secret.key or KMOESYNC_SECRET); changing it invalidates sealed data.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 1;

export interface Sealer {
  seal(plain: string): Uint8Array;
  open(sealed: Uint8Array | null | undefined): string | null;
}

export function createSealer(secret: Buffer): Sealer {
  const key = Buffer.from(hkdfSync('sha256', secret, 'kmoesync', 'sealed-values-v1', 32));
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
    },
    open(sealed) {
      if (!sealed || sealed.length < 29 || sealed[0] !== VERSION) return null;
      const data = Buffer.from(sealed);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(1, 13));
        decipher.setAuthTag(data.subarray(13, 29));
        return Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Same server (scheme, host and port): a saved secret is only ever sent back to the server it was entered for. */
export function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}
