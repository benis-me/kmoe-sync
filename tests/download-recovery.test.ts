import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionInput } from '../shared/model';
import { createApp } from '../server/app';
import { resetKmoePacing, resetKmoeThrottle } from '../server/kmoe/client';
import { createSealer } from '../server/lib/crypto';
import { startFakeDav } from './storage/fake-webdav';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  resetKmoeThrottle(); resetKmoePacing();
});
async function until(done: () => boolean) {
  const end = Date.now() + 3000;
  while (!done()) {
    if (Date.now() > end) throw new Error('等待任务状态超时');
    await Bun.sleep(5);
  }
}
const payload = new Uint8Array(1024 * 1024);
payload.set([80, 75, 3, 4]); payload.set([80, 75, 5, 6], payload.length - 22);

function setup(count = 2, totalMB = 3, reserveMB = 1.5) {
  resetKmoeThrottle(); resetKmoePacing();
  const root = mkdtempSync(join(tmpdir(), 'kmoesync-recovery-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const routes = new Map<string, (url: URL, init?: RequestInit) => Response | Promise<Response>>();
  const net = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url.pathname);
    const override = routes.get(url.pathname);
    if (override) return override(url, init);
    if (url.pathname === '/getdownurl.php') return link(url);
    if (url.pathname.startsWith('/file/')) return new Response(payload, { headers: { 'Content-Length': String(payload.length) } });
    throw new Error(`未预期的假 Kmoe 请求：${url.pathname}`);
  }) as typeof fetch;
  const app = createApp({
    host: '127.0.0.1', port: 0, dataDir: join(root, 'data'), libraryRoot: join(root, 'library'), staticDir: join(root, 'web'),
    mirrors: ['http://fake.invalid'], secureCookies: false, secret: Buffer.alloc(32, 7), fakeKmoe: true,
  }, { database: ':memory:', scheduler: false, fetch: net });
  cleanup.push(() => app.stop());
  app.settings.patch({ quotaReserveMB: reserveMB, autoRetry: false });
  app.db.run("UPDATE kmoe_account SET state = 'active', mirror = ?, cookies = ?, free_quota = ? WHERE id = 1", [
    'http://fake.invalid', createSealer(Buffer.alloc(32, 7)).seal(JSON.stringify({ fake: 'session' })), JSON.stringify({ totalMB, usedMB: 0, resetDay: 1 }),
  ]);
  const now = new Date().toISOString(), seen = new Date(Date.now() - 1000).toISOString();
  const comicId = Number(app.db.run('INSERT INTO comics (key, book_id, title, authors, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['abc123', '100', '恢复测试', '[]', now, now, now]).lastInsertRowid);
  for (let i = 1; i <= count; i++) app.db.run('INSERT INTO items (comic_id, remote_id, type, name, sort_order, epub_mb, mobi_mb, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [comicId, String(i), 'volume', `卷 ${i}`, i, 1, 1, seen, seen]);
  const targetId = app.targets.list()[0]!.id;
  const policy = SubscriptionInput.parse({ enabled: true, types: ['volume'], format: 'epub', targetId, strategy: 'backfill' });
  const queue = (itemIds = Array.from({ length: count }, (_, i) => String(i + 1)), target = targetId) => app.tasks.create({ comicKey: 'abc123', itemIds, targetId: target, format: 'epub', line: 0 }, 'manual');
  const tasks = () => app.tasks.list({ comicKey: 'abc123', limit: 200 }).tasks;
  return { app, root, routes, calls, comicId, targetId, policy, queue, tasks };
}
function link(url: URL) { return Response.json({ code: '200', url: `http://fake.invalid/file/${url.searchParams.get('v')}`, name: `卷${url.searchParams.get('v')}.epub` }); }

test.each(['pause', 'types', 'format', 'target', 'strategy'] as const)('subscription %s restores policy cancellations while preserving user exclusions', async change => {
  const { app, comicId, policy, queue, tasks } = setup(4);
  app.db.run("UPDATE items SET type = 'serial' WHERE comic_id = ? AND remote_id = '4'", [comicId]);
  await app.subscriptions.save('abc123', policy);
  const initial = tasks(), manual = initial.find(task => task.itemId === '1')!, legacy = initial.find(task => task.itemId === '2')!;
  app.tasks.cancel(manual.id);
  // Historical queued cancellations had neither cancel_requested nor an error code.
  app.db.run("UPDATE tasks SET status = 'cancelled', cancel_requested = 0, error_code = NULL WHERE id = ?", [legacy.id]);
  await queue(['4']);
  const userQueued = tasks().find(task => task.itemId === '4')!;
  const changed = { ...policy };
  if (change === 'pause') changed.enabled = false;
  if (change === 'types') changed.types = ['serial'];
  if (change === 'format') changed.format = 'mobi';
  if (change === 'target') changed.targetId = app.targets.create({ kind: 'local', name: '另一书库', path: '/other', rule: '{title}/{filename}' }).id;
  if (change === 'strategy') changed.strategy = 'future';
  await app.subscriptions.save('abc123', changed);
  const stopped = initial.find(task => task.itemId === '3')!;
  expect(app.tasks.get(stopped.id)).toMatchObject({ status: 'cancelled', errorCode: 'policy_cancelled' });
  expect(app.tasks.get(userQueued.id).status).toBe('queued');
  expect(await app.subscriptions.preview('abc123', policy)).toMatchObject({ queue: 1 });
  await app.subscriptions.save('abc123', policy);
  expect(tasks().filter(task => task.itemId === '3' && task.status === 'queued')).toHaveLength(1);
  expect(tasks().filter(task => task.itemId === '1' && task.format === 'epub' && task.targetId === policy.targetId)).toMatchObject([{ status: 'cancelled', id: manual.id }]);
  expect(app.tasks.row(legacy.id)).toMatchObject({ status: 'cancelled', error_code: null, cancel_requested: 0 });
  app.tasks.clearFinished();
  expect(await app.subscriptions.preview('abc123', policy)).toMatchObject({ queue: 0 });
});

test('unsubscribe keeps running tasks and resubscribe recovers only policy cancellations', async () => {
  const { app, policy, tasks } = setup(3);
  await app.subscriptions.save('abc123', policy);
  const running = tasks()[0]!;
  app.db.run("UPDATE tasks SET status = 'running' WHERE id = ?", [running.id]);
  app.subscriptions.remove('abc123', true);
  expect(app.tasks.get(running.id).status).toBe('running');
  await app.subscriptions.save('abc123', policy);
  expect(app.tasks.counts()).toMatchObject({ queued: 2, running: 1, cancelled: 2 });
  app.tasks.cancelAllQueued();
  expect(await app.subscriptions.preview('abc123', policy)).toMatchObject({ queue: 0 });
});

test('default concurrency reserves each unresolved link before another task can spend it', async () => {
  const { app, queue, routes, calls } = setup();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  routes.set('/getdownurl.php', async url => { entered.resolve(); await release.promise; return link(url); });
  expect(app.settings.get().concurrency).toBe(2);
  await queue(); app.worker.start();
  try {
    await entered.promise;
    await until(() => app.worker.pauseReason === 'quota');
    expect(calls.filter(path => path === '/getdownurl.php')).toHaveLength(1);
    expect(app.tasks.counts()).toMatchObject({ running: 1, queued: 1 });
    release.resolve();
    await until(() => app.tasks.counts().completed === 1);
    expect(app.kmoe.account().remainingMB).toBe(2);
    app.worker.resume();
    await until(() => app.worker.pauseReason === 'quota');
    expect(calls.filter(path => path === '/getdownurl.php')).toHaveLength(1);
    app.settings.patch({ quotaReserveMB: 1 }); app.worker.resume();
    await until(() => app.tasks.counts().completed === 2);
    expect(app.kmoe.account().remainingMB).toBe(1);
  } finally { release.resolve(); }
});

test('a rejected link releases its reservation without charging or blocking the next task', async () => {
  const { app, queue, routes, calls } = setup();
  const release = Promise.withResolvers<void>();
  let first = true;
  routes.set('/getdownurl.php', async url => {
    if (first) { first = false; await release.promise; return new Response('', { status: 503 }); }
    return link(url);
  });
  await queue(); app.worker.start();
  try {
    await until(() => app.worker.pauseReason === 'quota');
    release.resolve();
    await until(() => app.tasks.counts().failed === 1);
    expect(app.kmoe.account().remainingMB).toBe(3);
    app.worker.resume();
    await until(() => app.tasks.counts().completed === 1);
    expect(app.kmoe.account().remainingMB).toBe(2);
    expect(calls.filter(path => path === '/getdownurl.php')).toHaveLength(2);
  } finally { release.resolve(); }
});

test('a cached paid link can retry below the reserve without another charge', async () => {
  const { app, queue, routes, calls, tasks } = setup(1);
  app.settings.patch({ autoRetry: true, maxRetries: 1 });
  let first = true;
  routes.set('/file/1', () => {
    if (first) { first = false; return new Response('', { status: 503 }); }
    return new Response(payload, { headers: { 'Content-Length': String(payload.length) } });
  });
  await queue(); app.worker.start();
  await until(() => tasks()[0]?.phase === 'waiting');
  expect(app.kmoe.account().remainingMB).toBe(2);
  app.db.run('UPDATE tasks SET retry_at = NULL'); app.worker.wake();
  await until(() => app.tasks.counts().completed === 1);
  expect(tasks()[0]).toMatchObject({ status: 'completed', attempt: 1 });
  expect(calls.filter(path => path === '/getdownurl.php')).toHaveLength(1);
  expect(calls.filter(path => path === '/file/1')).toHaveLength(2);
  expect(app.kmoe.account().remainingMB).toBe(2);
});

test('a cancelled task still pays for its issued link and releases the in-flight reservation', async () => {
  const { app, queue, routes, tasks, calls } = setup(1);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  routes.set('/getdownurl.php', async url => { entered.resolve(); await release.promise; return link(url); });
  await queue(); app.worker.start();
  try {
    await entered.promise;
    app.tasks.cancel(tasks()[0]!.id);
    release.resolve();
    await until(() => app.tasks.counts().cancelled === 1);
    expect(app.kmoe.account().remainingMB).toBe(2);
    expect(calls.filter(path => path.startsWith('/file/'))).toHaveLength(0);
    app.settings.patch({ quotaReserveMB: 1 });
    app.tasks.retry(tasks()[0]!.id);
    await until(() => app.tasks.counts().completed === 1);
    expect(app.kmoe.account().remainingMB).toBe(1);
    expect(calls.filter(path => path === '/getdownurl.php')).toHaveLength(2);
  } finally { release.resolve(); }
});

test('a partial DAV upload retries the staged file without another download or charge', async () => {
  const dav = startFakeDav(); cleanup.push(() => dav.stop());
  const { app, queue, calls, root, tasks } = setup(1, 3, 2);
  const target = app.targets.create({ kind: 'webdav', name: '恢复 DAV', url: dav.url, path: '/Comics', rule: '{title}/{filename}' });
  let first = true;
  dav.state.override = async (request, path) => {
    if (request.method === 'PUT' && first) {
      first = false;
      await request.arrayBuffer();
      dav.tree.set(path, { dir: false, size: 3 });
      return new Response('', { status: 500 });
    }
  };
  await queue(['1'], target.id); app.worker.start();
  await until(() => app.worker.pauseReason === 'network');
  const task = tasks()[0]!, part = join(root, 'data', 'tmp', `task-${task.id}.part`);
  expect(existsSync(part)).toBe(true);
  expect(app.kmoe.account().remainingMB).toBe(2);
  expect([...dav.tree.keys()].some(path => path.endsWith('.epub'))).toBe(false);
  app.worker.resume();
  await until(() => app.tasks.counts().completed === 1);
  expect(calls.filter(path => path === '/getdownurl.php')).toHaveLength(1);
  expect(calls.filter(path => path === '/file/1')).toHaveLength(1);
  expect(app.kmoe.account().remainingMB).toBe(2);
  expect(existsSync(part)).toBe(false);
  expect(dav.tree.get('/dav/Comics/恢复测试/卷1.epub')).toMatchObject({ size: payload.length });
  expect([...dav.tree.keys()].some(path => path.includes('/.kmoesync-'))).toBe(false);
});

test.each(['cancel', 'shutdown'] as const)('%s during DAV upload cleans only the temporary object and preserves the right local state', async action => {
  const dav = startFakeDav(); cleanup.push(() => dav.stop());
  const { app, queue, root, tasks } = setup(1);
  const target = app.targets.create({ kind: 'webdav', name: '中断 DAV', url: dav.url, path: '/Comics', rule: '{title}/{filename}' });
  const entered = Promise.withResolvers<void>();
  dav.state.override = async (request, path) => {
    if (request.method === 'PUT') {
      await request.arrayBuffer();
      dav.tree.set(path, { dir: false, size: 3 });
      entered.resolve();
      return new Promise<Response>(() => {});
    }
    // Cleanup must not outlive the worker's five-second shutdown grace period.
    if (action === 'shutdown' && request.method === 'DELETE') return new Promise<Response>(() => {});
  };
  await queue(['1'], target.id); app.worker.start();
  await entered.promise;
  const task = tasks()[0]!, part = join(root, 'data', 'tmp', `task-${task.id}.part`);
  if (action === 'cancel') {
    app.tasks.cancel(task.id);
    await until(() => app.tasks.get(task.id).status === 'cancelled');
    expect(existsSync(part)).toBe(false);
  } else {
    await app.worker.stop();
    expect(app.tasks.get(task.id).status).toBe('queued');
    expect(existsSync(part)).toBe(true);
  }
  expect(app.kmoe.account().remainingMB).toBe(2);
  expect([...dav.tree.keys()].some(path => path.endsWith('.epub'))).toBe(false);
  const temporary = dav.requests.find(request => request.method === 'PUT')!.path;
  expect(dav.requests.filter(request => request.method === 'DELETE').map(request => request.path)).toEqual([temporary]);
  if (action === 'cancel') expect(dav.tree.has(temporary)).toBe(false);
});

test('restart honours pending cancellation and uploads a complete staged file without spending quota', async () => {
  const { app, queue, calls, root, tasks } = setup(2, 0, 2);
  await queue();
  const staged = tasks().find(task => task.itemId === '2')!, cancelled = tasks().find(task => task.itemId === '1')!;
  const scratch = join(root, 'data', 'tmp'); mkdirSync(scratch, { recursive: true });
  for (const task of [staged, cancelled]) {
    writeFileSync(join(scratch, `task-${task.id}.part`), payload);
    app.db.run("UPDATE tasks SET status = 'running', phase = 'uploading', total = ?, path = ? WHERE id = ?", [payload.length, `/卷${task.itemId}.epub`, task.id]);
  }
  app.db.run('UPDATE tasks SET cancel_requested = 1 WHERE id = ?', [cancelled.id]);
  app.worker.start();
  await until(() => app.tasks.counts().completed === 1);
  expect(app.tasks.get(cancelled.id).status).toBe('cancelled');
  expect(app.tasks.get(staged.id).status).toBe('completed');
  expect(calls).toEqual([]);
  expect(app.kmoe.account().remainingMB).toBe(0);
  expect(existsSync(join(scratch, `task-${cancelled.id}.part`))).toBe(false);
  expect(existsSync(join(root, 'library', '卷2.epub'))).toBe(true);
});
