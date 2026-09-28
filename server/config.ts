// Runtime configuration from the environment. Everything has a NAS-friendly default; the secret is generated on first start.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { version } from '../package.json';

/** package.json is the one place a release changes the version. */
export const VERSION = version;

/** Official Kmoe mirrors, most reliable first. The user picks the preferred one in settings. */
export const DEFAULT_MIRRORS = ['kzo.moe', 'mox.moe', 'kxo.moe', 'kxx.moe', 'koz.moe', 'kzz.moe'] as const;
export const FAKE_KMOE_ORIGIN = 'http://127.0.0.1:18080';

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  libraryRoot: string;
  staticDir: string;
  /** Mirror origins, e.g. "https://kzo.moe". */
  mirrors: string[];
  secureCookies: boolean;
  secret: Buffer;
  fakeKmoe: boolean;
}

/** Accepts "kzo.moe" (https) or a full origin (http only for local development). */
export function mirrorOrigin(value: string): string {
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error(`Mirror must use HTTPS: ${value}`);
  return url.origin;
}

function loadSecret(dataDir: string): Buffer {
  const fromEnv = env('KMOESYNC_SECRET');
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error('KMOESYNC_SECRET must be at least 32 characters');
    return Buffer.from(fromEnv);
  }
  const file = join(dataDir, 'secret.key');
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  const secret = randomBytes(32);
  writeFileSync(file, secret.toString('base64'), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort on exotic filesystems */ }
  return secret;
}

export function loadConfig(): Config {
  const dataDir = resolve(env('DATA_DIR') ?? './data');
  const libraryRoot = resolve(env('LIBRARY_ROOT') ?? './library');
  for (const dir of [dataDir, libraryRoot, join(dataDir, 'tmp'), join(dataDir, 'covers')]) mkdirSync(dir, { recursive: true });
  const fakeKmoe = env('KMOESYNC_FAKE_KMOE') === '1';
  const mirrors = (env('KMOESYNC_MIRRORS')?.split(',').map(value => value.trim()).filter(Boolean) ?? (fakeKmoe ? [FAKE_KMOE_ORIGIN] : [...DEFAULT_MIRRORS])).map(mirrorOrigin);
  return {
    host: env('HOST') ?? '0.0.0.0',
    port: Number(env('PORT') ?? 8080),
    dataDir,
    libraryRoot,
    staticDir: resolve(env('STATIC_DIR') ?? './dist'),
    mirrors: [...new Set(mirrors)],
    secureCookies: env('KMOESYNC_SECURE_COOKIES') === '1',
    secret: loadSecret(dataDir),
    fakeKmoe,
  };
}
