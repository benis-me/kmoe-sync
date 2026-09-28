// End-to-end: the real server against the fake Kmoe mirror, with a local library in a temp directory.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import type { Task } from '@shared/model';
import { createApp } from '../server/app';
import { KmoeClient } from '../server/kmoe/client';
import { FAKE_PASSWORD, startFakeKmoe } from './fake-kmoe';
import { startFakeDav } from './storage/fake-webdav';

const fake = startFakeKmoe({ port: 0 });
const dav = startFakeDav({ auth: { username: 'nas', password: 'dav-secret' } });
const root = mkdtempSync(join(tmpdir(), 'kmoesync-'));
const library = join(root, 'library');
/** Bun error codes the next requests to the fake Kmoe fail with, one per request. */
const drops: string[] = [];
/** Two more mirrors: mirror-b is the same fake Kmoe (a login carries over), mirror-c another one (it does not). */
const other = startFakeKmoe({ port: 0 });
const MIRRORS: Record<string, string> = { 'http://mirror-b.test': fake.origin, 'http://mirror-c.test': other.origin };
/** Hosts the app sent requests to, for the tests that check where they went. */
const hosts: string[] = [];
const flaky = ((input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  hosts.push(new URL(url).host);
  const code = url.startsWith(fake.origin) ? drops.shift() : undefined;
  if (code) return Promise.reject(Object.assign(new Error(`connection failed (${code})`), { code }));
  const mirror = Object.keys(MIRRORS).find(from => url.startsWith(from));
  return fetch(mirror ? MIRRORS[mirror] + url.slice(mirror.length) : input, init);
}) as typeof fetch;
const app = createApp({
  host: '127.0.0.1', port: 0, dataDir: join(root, 'data'), libraryRoot: library, staticDir: join(root, 'web'),
  mirrors: [fake.origin, ...Object.keys(MIRRORS)], secureCookies: false, secret: Buffer.alloc(32, 7), fakeKmoe: true,
}, { fetch: flaky, scheduler: false });
let base = '';
let cookie = '', csrf = '';

async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  const response = await fetch(`${base}${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}), ...headers },
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}
const control = (patch: object) => fetch(`${fake.origin}/__fake/control`, { method: 'POST', body: JSON.stringify(patch) });

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value).slice(0, 500)}`);
    await Bun.sleep(100);
  }
}
const tasksOf = async (comicKey: string) => (await api<{ tasks: Task[] }>('GET', `/api/tasks?comicKey=${comicKey}&limit=200`)).data.tasks;
const settled = (tasks: Task[]) => tasks.length > 0 && tasks.every(task => task.status !== 'queued' && task.status !== 'running');

beforeAll(() => { base = `http://127.0.0.1:${app.start().port}`; });
afterAll(async () => { await app.stop(); fake.stop(); other.stop(); dav.stop(); rmSync(root, { recursive: true, force: true }); });

describe('admin auth', () => {
  test('setup, session and CSRF', async () => {
    expect((await api('GET', '/api/auth/state')).data).toMatchObject({ setupRequired: true, authenticated: false });
    expect((await api('GET', '/api/status')).status).toBe(401);
    expect((await api('POST', '/api/auth/setup', { password: 'short' })).status).toBe(400);
    const setup = await api('POST', '/api/auth/setup', { password: 'correct horse' });
    expect(setup.data).toMatchObject({ setupRequired: false, authenticated: true });
    csrf = setup.data.csrf;
    expect((await api('POST', '/api/auth/setup', { password: 'another one' })).status).toBe(409);
    expect((await api('POST', '/api/queue/pause', undefined, { 'X-CSRF-Token': 'wrong' })).status).toBe(403);
    expect((await api('GET', '/api/status')).data.targets).toBe(1);
  });
});

describe('kmoe + downloads', () => {
  let targetId = 0;

  test('login to the Kmoe mirror', async () => {
    expect((await api('POST', '/api/kmoe/login', { email: 'reader@example.com', password: 'wrong' })).data.error.code).toBe('kmoe_invalid_credentials');
    const login = await api('POST', '/api/kmoe/login', { email: 'reader@example.com', password: FAKE_PASSWORD });
    expect(login.data).toMatchObject({ state: 'active', vip: true, level: 2 });
    expect(login.data.remainingMB).toBeGreaterThan(40_000);
    targetId = (await api('GET', '/api/targets')).data[0].id;
  });

  test('search and resolve', async () => {
    const search = await api('GET', `/api/search?q=${encodeURIComponent('芙莉蓮')}`);
    expect(search.data.results.map((comic: { key: string }) => comic.key)).toEqual(['f7e2c9']);
    expect((await api('POST', '/api/resolve', { input: `${fake.origin.replace('127.0.0.1', 'localhost')}/c/f7e2c9.htm` })).status).toBe(400);
    expect((await api('POST', '/api/resolve', { input: `${fake.origin}/m/c/f7e2c9.htm` })).data.key).toBe('f7e2c9');
  });

  test('network proxy: validated and normalized; LAN hosts (here the Kmoe mirror) never go through it', async () => {
    expect((await api('PATCH', '/api/settings', { proxy: 'socks5://192.168.1.2:1080' })).data.error.message).toContain('SOCKS');
    expect((await api('PATCH', '/api/settings', { proxy: ' 192.0.2.1:9/ ', proxyKmoe: true })).data).toMatchObject({ proxy: 'http://192.0.2.1:9', proxyKmoe: true });
    expect((await api('GET', `/api/search?q=${encodeURIComponent('芙莉蓮')}`)).data.results).toHaveLength(1);
    expect((await api('PATCH', '/api/settings', { proxy: '', proxyKmoe: false })).data).toMatchObject({ proxy: '', proxyKmoe: false });
  });

  test('the mirror setting takes the Kmoe login along, but only to a mirror that accepts it', async () => {
    const account = async () => (await api('GET', '/api/status')).data.kmoe;
    const home = new URL(fake.origin).host;
    expect(await account()).toMatchObject({ state: 'active', mirror: home });
    expect((await api('GET', '/api/settings')).data.preferredMirror).toBe(home);
    // mirror-b knows the session: it moves, and Kmoe requests go there from now on.
    expect((await api('PATCH', '/api/settings', { preferredMirror: 'mirror-b.test' })).status).toBe(200);
    expect(await account()).toMatchObject({ state: 'active', mirror: 'mirror-b.test' });
    hosts.length = 0;
    expect((await api('GET', `/api/search?q=${encodeURIComponent('芙莉蓮')}`)).data.results).toHaveLength(1);
    expect(hosts).toEqual(['mirror-b.test']);
    // mirror-c does not: nothing changes, and the login stays valid where it was.
    const refused = await api('PATCH', '/api/settings', { preferredMirror: 'mirror-c.test' });
    expect(refused).toMatchObject({ status: 409, data: { error: { code: 'mirror_needs_login' } } });
    expect(refused.data.error.message).toContain('mirror-c.test');
    expect(await account()).toMatchObject({ state: 'active', mirror: 'mirror-b.test' });
    expect((await api('GET', '/api/settings')).data.preferredMirror).toBe('mirror-b.test');
    expect((await api('PATCH', '/api/settings', { preferredMirror: home })).status).toBe(200);
    expect((await account()).mirror).toBe(home);
  });

  test('a remembered password logs in again by itself when the session expires; a login Kmoe refuses forgets it', async () => {
    const account = async () => (await api('GET', '/api/status')).data.kmoe;
    const latest = async () => (await api('GET', '/api/activity')).data[0].title;
    expect((await api('POST', '/api/kmoe/login', { email: 'reader@example.com', password: FAKE_PASSWORD, remember: true })).data).toMatchObject({ state: 'active', remember: true });
    // The session dies: the next account check notices, downloads wait, and the scheduler's step logs in again.
    await control({ expired: true });
    expect((await api('POST', '/api/kmoe/refresh')).status).toBe(409);
    expect(await account()).toMatchObject({ state: 'expired', remember: true });
    expect((await api('GET', '/api/status')).data.queue).toMatchObject({ paused: true, reason: 'auth' });
    expect(await latest()).toBe('Kmoe 登录已失效，正在自动重新登录');
    await app.autoLogin();
    expect(await account()).toMatchObject({ state: 'active', remember: true, error: null });
    expect((await api('GET', '/api/status')).data.queue.paused).toBe(false);
    expect(await latest()).toBe('已自动重新登录 Kmoe，下载继续');
    // Kmoe refuses the next automatic login (it wants a person): the password is deleted and never tried again.
    await control({ expired: true, loginCode: 'e401' });
    await api('POST', '/api/kmoe/refresh');
    await app.autoLogin();
    expect(await account()).toMatchObject({ state: 'expired', remember: true, error: expect.stringContaining('自动重新登录失败') });
    expect(await latest()).toBe('Kmoe 自动重新登录失败，下载已暂停');
    expect(await app.kmoe.autoLogin()).toBeNull();
    // Logging in by hand keeps the choice (the password is saved again); turning it off deletes the password.
    await control({ loginCode: '' });
    expect((await api('POST', '/api/kmoe/login', { email: 'reader@example.com', password: FAKE_PASSWORD })).data).toMatchObject({ state: 'active', remember: true });
    expect(app.kmoe.autoLoginReady()).toBe(true);
    expect((await api('DELETE', '/api/kmoe/password')).data).toMatchObject({ state: 'active', remember: false });
    expect(app.kmoe.autoLoginReady()).toBe(false);
  });

  test('an automatic login that does not get through waits and tries again', async () => {
    expect((await api('POST', '/api/kmoe/login', { email: 'reader@example.com', password: FAKE_PASSWORD, remember: true })).data.remember).toBe(true);
    await control({ expired: true });
    await api('POST', '/api/kmoe/refresh');
    drops.push('ConnectionRefused');
    expect(await app.kmoe.autoLogin()).toMatchObject({ outcome: 'retry', first: true, message: expect.stringContaining('连接被拒绝') });
    expect(app.kmoe.autoLoginReady()).toBe(true);
    // Not yet due: nothing is sent.
    expect(await app.kmoe.autoLogin()).toBeNull();
    await api('POST', '/api/kmoe/login', { email: 'reader@example.com', password: FAKE_PASSWORD, remember: false });
    expect((await api('GET', '/api/status')).data.kmoe).toMatchObject({ state: 'active', remember: false });
  });

  test('comic detail with item states and a cached cover', async () => {
    const { data } = await api('GET', '/api/comics/f7e2c9');
    expect(data.comic).toMatchObject({ title: '葬送的芙莉蓮', bookId: '50076', authors: ['山田鐘人', 'アベツカサ'], cover: '/api/covers/f7e2c9' });
    expect(data.items).toHaveLength(13);
    expect(data.view).toEqual({ targetId, format: 'epub' });
    expect(Object.values(data.states).every((state: any) => state.state === 'missing')).toBe(true);
    const cover = await fetch(`${base}/api/covers/f7e2c9`, { headers: { Cookie: cookie } });
    expect(cover.headers.get('content-type')).toBe('image/svg+xml');
    expect(cover.headers.get('content-security-policy')).toContain('sandbox');
  });

  test('download selected volumes into the local library', async () => {
    const created = await api('POST', '/api/tasks', { comicKey: 'f7e2c9', itemIds: ['2001', '2002'], format: 'epub', targetId });
    expect(created.data).toMatchObject({ created: 2, skipped: 0 });
    const tasks = await until(() => tasksOf('f7e2c9'), settled);
    expect(tasks.map(task => task.status)).toEqual(['completed', 'completed']);
    const files = readdirSync(join(library, '葬送的芙莉蓮')).sort();
    expect(files).toEqual(['[Kmoe][葬送的芙莉蓮]卷01.epub', '[Kmoe][葬送的芙莉蓮]卷02.epub']);
    expect(readFileSync(join(library, '葬送的芙莉蓮', files[0]!)).subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
    const { data } = await api('GET', '/api/comics/f7e2c9');
    expect(data.states['2001']).toMatchObject({ state: 'downloaded', paths: ['/葬送的芙莉蓮/[Kmoe][葬送的芙莉蓮]卷01.epub'] });
    expect((await api('POST', '/api/tasks', { comicKey: 'f7e2c9', itemIds: ['2001', '2002'], format: 'epub', targetId })).data).toMatchObject({ created: 0, skipped: 2 });
  });

  test('library check recognises the files', async () => {
    const { data } = await api('POST', '/api/comics/f7e2c9/library-check', { targetId, format: 'epub' });
    expect(data.directoryExists).toBe(true);
    const status = Object.fromEntries(data.chapters.map((chapter: any) => [chapter.id, chapter.status]));
    expect(status['2001']).toBe('downloaded');
    expect(status['2003']).toBe('missing');
  });

  test('a dropped connection is retried and resumed', async () => {
    await control({ dropDownloads: 1 });
    await api('POST', '/api/tasks', { comicKey: 'f7e2c9', itemIds: ['2003'], format: 'epub', targetId });
    const tasks = await until(() => tasksOf('f7e2c9'), settled);
    expect(tasks[0]).toMatchObject({ itemId: '2003', status: 'completed', attempt: 1 });
  });

  test('subscription: future-only keeps the baseline, a check picks up the new volume', async () => {
    const policy = { enabled: true, types: ['volume'], format: 'epub', targetId, strategy: 'future', line: 0 };
    expect((await api('POST', '/api/comics/f7e2c9/subscription/preview', { ...policy, strategy: 'backfill' })).data).toMatchObject({ queue: 10, cancel: 0 });
    expect((await api('POST', '/api/comics/f7e2c9/subscription/preview', policy)).data).toMatchObject({ queue: 0 });
    const saved = await api('PUT', '/api/comics/f7e2c9/subscription', policy);
    expect(saved.data).toMatchObject({ comicKey: 'f7e2c9', strategy: 'future', enabled: true });
    await fetch(`${fake.origin}/__fake/new-volume`, { method: 'POST', body: JSON.stringify({ key: 'f7e2c9' }) });
    expect((await api('POST', '/api/comics/f7e2c9/check')).status).toBe(200);
    const tasks = await until(() => tasksOf('f7e2c9'), list => settled(list) && list.length === 4);
    expect(tasks[0]).toMatchObject({ itemName: '卷 14', status: 'completed', origin: 'subscription' });
    const activity = (await api('GET', '/api/activity')).data;
    expect(activity.some((entry: any) => entry.kind === 'new_items' && entry.title.includes('葬送的芙莉蓮'))).toBe(true);
    const shelf = (await api('GET', '/api/shelf')).data;
    expect(shelf[0]).toMatchObject({ comic: { key: 'f7e2c9' }, counts: { downloaded: 4, new: 1 } });
  });

  test('subscription: a check that cannot reach Kmoe retries within minutes and clears its error once it works', async () => {
    const delays = KmoeClient.retryDelays;
    KmoeClient.retryDelays = [1, 1];
    try {
      const check = () => api('POST', '/api/comics/f7e2c9/check');
      const subscription = async () => (await api('GET', '/api/comics/f7e2c9')).data.subscription;
      const reports = async () => (await api('GET', '/api/activity')).data.filter((entry: any) => entry.kind === 'check_failed');
      const minutesAway = (at: string) => Math.round((Date.parse(at) - Date.now()) / 60_000);
      // A connection that drops is sent again at once: the check just works.
      drops.push('ECONNRESET', 'ECONNRESET');
      expect((await check()).status).toBe(200);
      expect(drops).toEqual([]);
      // Kmoe unreachable: next check in 5, then 10, then 20 minutes; the feed hears of it once, when the first retry fails.
      drops.push(...Array<string>(3).fill('ConnectionRefused'));
      const failed = await check();
      expect(failed).toMatchObject({ status: 502, data: { error: { code: 'kmoe_network', message: `无法连接 ${new URL(fake.origin).host}（连接被拒绝）` } } });
      expect(await subscription()).toMatchObject({ error: failed.data.error.message });
      expect(minutesAway((await subscription()).nextCheckAt)).toBe(5);
      expect(await reports()).toHaveLength(0);
      await check();
      expect(minutesAway((await subscription()).nextCheckAt)).toBe(10);
      expect(await reports()).toMatchObject([{ title: '《葬送的芙莉蓮》检查更新失败', detail: expect.stringContaining('会自动重试') }]);
      await check();
      expect(minutesAway((await subscription()).nextCheckAt)).toBe(20);
      expect(await reports()).toHaveLength(1);
      // A batch ends at the first check that cannot reach Kmoe: the next subscription is not tried until a later tick.
      await api('PUT', '/api/comics/c9d0e1/subscription', { enabled: true, types: ['volume'], format: 'epub', targetId, strategy: 'future', line: 0 });
      drops.push('ConnectionRefused', 'ConnectionRefused');
      await app.subscriptions.checkDue(true);
      expect(drops).toHaveLength(1);
      expect((await api('GET', '/api/comics/c9d0e1')).data.subscription).toMatchObject({ lastCheckAt: null, error: null });
      drops.length = 0;
      await api('DELETE', '/api/comics/c9d0e1/subscription?cancelPending=true');
      // Reachable again: the error is gone and the normal interval (6 h ± 10 %) is back.
      expect((await check()).status).toBe(200);
      const recovered = await subscription();
      expect(recovered.error).toBeNull();
      expect(minutesAway(recovered.nextCheckAt)).toBeGreaterThan(5 * 60);
    } finally { drops.length = 0; KmoeClient.retryDelays = delays; }
  });

  test('quota exhaustion pauses the queue instead of failing', async () => {
    await control({ quotaExhausted: true });
    await api('POST', '/api/tasks', { comicKey: 'b1c4a0', itemIds: ['4001'], format: 'epub', targetId });
    const status = await until(() => api('GET', '/api/status').then(r => r.data), s => s.queue.paused);
    expect(status.queue.reason).toBe('quota');
    expect((await tasksOf('b1c4a0'))[0]!.status).toBe('queued');
    await control({ quotaExhausted: false });
    expect((await api('POST', '/api/queue/resume')).data.paused).toBe(false);
    expect((await until(() => tasksOf('b1c4a0'), settled))[0]!.status).toBe('completed');
  });

  test('an expired Kmoe login pauses for auth and resumes after logging in again', async () => {
    await control({ expired: true });
    await api('POST', '/api/tasks', { comicKey: 'b1c4a0', itemIds: ['4002'], format: 'epub', targetId });
    const status = await until(() => api('GET', '/api/status').then(r => r.data), s => s.kmoe.state === 'expired' && s.queue.paused);
    expect(status.queue.reason).toBe('auth');
    await api('POST', '/api/kmoe/login', { email: 'reader@example.com', password: FAKE_PASSWORD });
    const tasks = await until(() => tasksOf('b1c4a0'), settled);
    expect(tasks.map(task => task.status)).toEqual(['completed', 'completed']);
    expect((await api('GET', '/api/status')).data.queue.paused).toBe(false);
  });
});

describe('unwritable library', () => {
  test('a permission error fails the task with a readable message and the server keeps running', async () => {
    const folder = join(library, '迷宮飯');
    chmodSync(folder, 0o555);
    try {
      const targetId = (await api('GET', '/api/targets')).data[0].id;
      await api('POST', '/api/tasks', { comicKey: 'b1c4a0', itemIds: ['4003'], format: 'epub', targetId });
      const task = (await until(() => tasksOf('b1c4a0'), settled)).find(item => item.itemId === '4003')!;
      expect(task).toMatchObject({ status: 'failed', errorCode: 'storage_auth' });
      expect(task.error).toContain('权限');
      expect((await fetch(`${base}/api/health`)).ok).toBe(true);
      expect(readdirSync(folder).some(name => name.includes('.kmoesync'))).toBe(false);
    } finally { chmodSync(folder, 0o755); }
  });
});

describe('WebDAV target', () => {
  test('test, browse and download to WebDAV; the password never leaves the server', async () => {
    const draft = { kind: 'webdav', name: 'NAS WebDAV', url: dav.url, username: 'nas', password: 'wrong', path: '/Comics', rule: '{title}/{filename}' };
    expect((await api('POST', '/api/targets/test', { draft })).data.ok).toBe(false);
    const created = await api('POST', '/api/targets', { ...draft, password: 'dav-secret' });
    expect(created.data).toMatchObject({ kind: 'webdav', hasPassword: true, isDefault: false });
    expect(JSON.stringify(created.data)).not.toContain('dav-secret');
    const targetId = created.data.id;
    expect((await api('POST', '/api/targets/test', { targetId })).data).toMatchObject({ ok: true, message: expect.stringContaining('自动创建') });
    // Editing without a password keeps the stored one.
    expect((await api('PATCH', `/api/targets/${targetId}`, { name: 'WebDAV 书库' })).data.hasPassword).toBe(true);
    await api('POST', '/api/tasks', { comicKey: 'c9d0e1', itemIds: ['5001'], format: 'epub', targetId });
    expect((await until(() => tasksOf('c9d0e1'), settled))[0]).toMatchObject({ status: 'completed', targetName: 'WebDAV 书库' });
    const stored = dav.tree.get('/dav/Comics/間諜家家酒/[Kmoe][間諜家家酒]卷01.epub');
    expect(stored && !stored.dir && stored.size).toBeGreaterThan(1000);
    // Browsing starts at the WebDAV server root, so the target's own folder can be picked too.
    expect((await api('POST', '/api/targets/browse', { ref: { targetId }, path: '/' })).data.entries.map((entry: { name: string }) => entry.name)).toContain('Comics');
    const browse = await api('POST', '/api/targets/browse', { ref: { targetId }, path: '/Comics' });
    expect(browse.data.entries.map((entry: { name: string }) => entry.name)).toEqual(['間諜家家酒']);
    // Subscribed targets cannot be deleted; unused ones can.
    expect((await api('DELETE', `/api/targets/${targetId}`)).status).toBe(200);
  });
});

describe('external API and MCP', () => {
  let token = '';
  const mcp = (body: object) => fetch(`${base}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', ...body }), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

  test('token-protected /api/v1', async () => {
    token = (await api('POST', '/api/token')).data.token;
    expect((await fetch(`${base}/api/v1/status`)).status).toBe(401);
    const status = await fetch(`${base}/api/v1/status`, { headers: { Authorization: `Bearer ${token}` } });
    expect(status.status).toBe(200);
    // Admin-only endpoints are not exposed to the token.
    expect((await fetch(`${base}/api/v1/settings`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(404);
  });

  test('MCP initialize, tools/list and tools/call', async () => {
    const init = await (await mcp({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).json();
    expect(init.result.serverInfo.name).toBe('kmoesync');
    expect((await mcp({ method: 'notifications/initialized' })).status).toBe(202);
    const list = await (await mcp({ id: 2, method: 'tools/list' })).json();
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toContain('download');
    const call = await (await mcp({ id: 3, method: 'tools/call', params: { name: 'get_comic', arguments: { key: 'f7e2c9' } } })).json();
    expect(call.result.isError).toBeUndefined();
    expect(call.result.structuredContent.items.find((item: any) => item.id === '2001').state).toBe('downloaded');
    const bad = await (await mcp({ id: 4, method: 'tools/call', params: { name: 'get_comic', arguments: { key: 'zzzzzz' } } })).json();
    expect(bad.result.isError).toBe(true);
    // A new subscription also fills in what is missing (queued only: the queue is paused, and the tasks go with the
    // subscription); changing one keeps what was not given (f7e2c9 follows new volumes only).
    const tool = async (name: string, args: object) => (await (await mcp({ id: 5, method: 'tools/call', params: { name, arguments: args } })).json()).result.structuredContent;
    await api('POST', '/api/queue/pause');
    expect(await tool('subscribe', { key: 'b1c4a0' })).toMatchObject({ comicKey: 'b1c4a0', strategy: 'backfill', types: ['volume'] });
    const backfill = async () => (await tasksOf('b1c4a0')).filter(task => task.origin === 'subscription');
    expect((await backfill()).length).toBeGreaterThan(0);
    expect((await backfill()).every(task => task.status === 'queued')).toBe(true);
    await tool('unsubscribe', { key: 'b1c4a0', cancelPending: true });
    expect((await backfill()).every(task => task.status === 'cancelled')).toBe(true);
    await api('POST', '/api/queue/resume');
    expect(await tool('subscribe', { key: 'f7e2c9' })).toMatchObject({ comicKey: 'f7e2c9', strategy: 'future' });
  });
});

describe('web UI', () => {
  test('hashed assets are cached for good and sent precompressed when the browser accepts it', async () => {
    const assets = join(root, 'web', 'assets'), code = 'console.log("kmoesync");\n'.repeat(100);
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, 'app.js'), code);
    writeFileSync(join(assets, 'app.js.br'), brotliCompressSync(code));
    writeFileSync(join(assets, 'app.js.gz'), gzipSync(code));
    const get = (encoding: string) => fetch(`${base}/assets/app.js`, { headers: { 'Accept-Encoding': encoding } });
    for (const [accepted, sent] of [['gzip, deflate, br', 'br'], ['gzip', 'gzip'], ['identity', null]] as const) {
      const response = await get(accepted);
      expect(response.headers.get('content-encoding')).toBe(sent);
      expect(response.headers.get('content-type')).toContain('javascript');
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(await response.text()).toBe(code);
    }
  });
});
