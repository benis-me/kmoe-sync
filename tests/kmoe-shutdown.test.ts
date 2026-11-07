import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { KmoeClient, resetKmoeThrottle, type ThrottleState } from '../server/kmoe/client';

it('persists a cooldown discovered while in-flight work is stopping', async () => {
  resetKmoeThrottle();
  const root = mkdtempSync(join(tmpdir(), 'kmoesync-shutdown-'));
  const app = createApp({
    host: '127.0.0.1', port: 0, dataDir: join(root, 'data'), libraryRoot: join(root, 'library'), staticDir: join(root, 'web'),
    mirrors: ['http://127.0.0.1:1'], secureCookies: false, secret: Buffer.alloc(32, 1), fakeKmoe: true,
  }, { scheduler: false });
  let respond!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const client = new KmoeClient({ origin: 'http://127.0.0.1:1', interval: 0, fetch: (async (_input: string | URL | Request, _init?: RequestInit) => {
    entered();
    return new Promise<Response>(resolve => {
      respond = () => resolve(new Response(null, { status: 302, headers: { Location: 'https://www.google.com/' } }));
    });
  }) as typeof fetch });
  const pending = client.get('/list.php').catch(error => error);
  await started;
  let saved: ThrottleState | null = null;
  // A worker can still be waiting for its Kmoe response when shutdown starts.
  app.worker.stop = async () => { respond(); await pending; saved = app.settings.kmoeThrottle(); };
  try {
    await app.stop();
    expect(await pending).toMatchObject({ code: 'rate_limited' });
    expect(saved).toMatchObject({ strikes: 1, host: 'www.google.com' });
  } finally {
    resetKmoeThrottle();
    rmSync(root, { recursive: true, force: true });
  }
});
