import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { resetKmoeThrottle } from '../server/kmoe/client';
import { FAKE_PASSWORD, startFakeKmoe } from './fake-kmoe';

let fake: ReturnType<typeof startFakeKmoe>;
let app: ReturnType<typeof createApp>;
let root: string;
let blocked: boolean, profileOffline: boolean, profileChecks: number;
let downloads: string[];

beforeEach(async () => {
  resetKmoeThrottle();
  fake = startFakeKmoe({ port: 0 });
  root = mkdtempSync(join(tmpdir(), 'kmoesync-content-worker-'));
  blocked = true;
  profileOffline = false;
  profileChecks = 0;
  downloads = [];
  const net = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== fake.origin) throw new Error(`Unexpected origin: ${url.origin}`);
    if (url.pathname === '/getdownurl.php') {
      const volume = url.searchParams.get('v')!;
      downloads.push(volume);
      if (url.searchParams.get('b') === '50076' && volume === '2001' && blocked) {
        return new Response(null, { status: 302, headers: { Location: '/login.php' } });
      }
    }
    if (url.pathname === '/my.php') {
      profileChecks++;
      if (profileOffline) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    }
    return fetch(input, init);
  }) as typeof fetch;
  app = createApp({
    host: '127.0.0.1', port: 0, dataDir: join(root, 'data'), libraryRoot: join(root, 'library'), staticDir: join(root, 'web'),
    mirrors: [fake.origin], secureCookies: false, secret: Buffer.alloc(32, 1), fakeKmoe: true,
  }, { fetch: net, scheduler: false });
  // One worker slot proves the next task runs after the refused task has settled.
  app.settings.patch({ concurrency: 1, autoRetry: true, maxRetries: 1 });
  await app.kmoe.login('reader@example.com', FAKE_PASSWORD);
  profileChecks = 0;
  app.start();
});

afterEach(async () => {
  await app.stop();
  fake.stop();
  rmSync(root, { recursive: true, force: true });
  resetKmoeThrottle();
});

const taskOf = (itemId: string) => app.tasks.list({ comicKey: 'f7e2c9' }).tasks.find(task => task.itemId === itemId)!;
const enqueue = (itemIds: string[]) => app.tasks.create({
  comicKey: 'f7e2c9', itemIds, targetId: app.targets.list()[0]!.id, format: 'epub', line: 0,
}, 'manual');

async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Tasks did not settle: ${JSON.stringify(app.tasks.list({}).tasks)}`);
    await Bun.sleep(20);
  }
}

const firstAttemptFinished = () => taskOf('2001').startedAt !== null && taskOf('2001').status !== 'running';

test('a download login redirect with a valid session fails only that task; the next download completes', async () => {
  expect(await enqueue(['2001', '2002'])).toMatchObject({ created: 2, skipped: 0 });
  await until(firstAttemptFinished);

  expect(taskOf('2001')).toMatchObject({ status: 'failed', errorCode: 'kmoe_content_blocked', attempt: 1, retryAt: null });
  expect(app.status()).toMatchObject({ kmoe: { state: 'active', error: null }, queue: { paused: false, reason: null } });
  expect(app.worker.pauseReason).toBeNull();

  await until(() => taskOf('2002').status === 'completed');
  const completed = taskOf('2002');
  expect(completed).toMatchObject({ status: 'completed', attempt: 0, errorCode: null });
  expect(await Bun.file(join(app.config.libraryRoot, completed.path!)).exists()).toBe(true);
  expect(app.status().queue).toMatchObject({ paused: false, reason: null, counts: { failed: 1, completed: 1, queued: 0, running: 0 } });
  expect(profileChecks).toBe(1);
  expect(downloads).toEqual(['2001', '2002']);
});

test('a failed profile recheck keeps the session active and lets the worker retry the download', async () => {
  profileOffline = true;
  expect(await enqueue(['2001'])).toMatchObject({ created: 1, skipped: 0 });
  await until(firstAttemptFinished);

  const waiting = taskOf('2001');
  expect(waiting).toMatchObject({ status: 'queued', phase: 'waiting', errorCode: 'kmoe_network', attempt: 1 });
  expect(Date.parse(waiting.retryAt!)).toBeGreaterThan(Date.parse(waiting.startedAt!));
  expect(app.status()).toMatchObject({ kmoe: { state: 'active', error: null }, queue: { paused: false, reason: null } });
  expect(app.worker.pauseReason).toBeNull();
  expect(profileChecks).toBe(1);
  expect(downloads).toEqual(['2001']);

  // Recover the site; only the worker's existing retry timer may restart the task.
  profileOffline = false;
  blocked = false;
  await until(() => taskOf('2001').status === 'completed');

  const completed = taskOf('2001');
  expect(completed).toMatchObject({ status: 'completed', attempt: 1, retryAt: null, errorCode: null });
  expect(await Bun.file(join(app.config.libraryRoot, completed.path!)).exists()).toBe(true);
  expect(app.status()).toMatchObject({ kmoe: { state: 'active', error: null }, queue: { paused: false, reason: null } });
  expect(downloads).toEqual(['2001', '2001']);
  expect(profileChecks).toBe(1);
});
