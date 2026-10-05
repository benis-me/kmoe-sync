import { afterAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage } from '../../server/storage';
import { StorageError } from '../../server/storage/types';
import { createWebdavTarget, timeouts } from '../../server/storage/webdav';
import { entry, startFakeDav, xml } from './fake-webdav';

const dav = startFakeDav({ auth: { username: '测试', password: 'test-only' } });
const scratch = mkdtempSync(join(tmpdir(), 'kmoesync-webdav-'));
afterAll(() => { dav.stop(); rmSync(scratch, { recursive: true, force: true }); });
beforeEach(() => dav.reset());

const target = (basePath = '/Comics', password = 'test-only') => createWebdavTarget({ url: dav.url, username: '测试', password, basePath });
const source = (name: string, bytes: Uint8Array) => { const path = join(scratch, name); writeFileSync(path, bytes); return { path, size: bytes.length }; };
const signal = () => ({ signal: new AbortController().signal });
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected a rejection');
}
const closedPort = () => { const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') }); const { port } = server; server.stop(true); return port; };

describe('list', () => {
  for (const dialect of ['d', 'apache', 'default'] as const) {
    it(`reads the ${dialect} dialect: decoded names, no self entry, directories first in zh order`, async () => {
      dav.state.dialect = dialect;
      dav.seed({ '/dav/Comics/卷 10.epub': 10, '/dav/Comics/卷 02.epub': 2, '/dav/Comics/中文 空格 & 100%.epub': 3, '/dav/Comics/中/深/x.epub': 1 }, ['/dav/Comics/啊']);
      expect(await target().list('/')).toEqual([
        { name: '啊', path: '/啊', directory: true, size: 0 },
        { name: '中', path: '/中', directory: true, size: 0 },
        { name: '卷 02.epub', path: '/卷 02.epub', directory: false, size: 2 },
        { name: '卷 10.epub', path: '/卷 10.epub', directory: false, size: 10 },
        { name: '中文 空格 & 100%.epub', path: '/中文 空格 & 100%.epub', directory: false, size: 3 },
      ]);
      expect(await target().list('/中/')).toEqual([{ name: '深', path: '/中/深', directory: true, size: 0 }]);
      expect(dav.requests.every(r => r.method === 'PROPFIND' && r.depth === '1')).toBe(true);
    });
  }

  it('ignores entries outside the target, on other origins, deeper down or with undecodable hrefs', async () => {
    dav.seed({ '/dav/Comics/a.epub': 1 });
    dav.state.extra = [
      '/elsewhere/x.epub', '/dav/x.epub', 'http://evil.example/dav/Comics/y.epub', '/dav/Comics/sub/nested.epub',
      '/dav/Comics/bad%E0%A4%A.epub', '/dav/Comics/%2e%2e/z.epub', '',
    ].map(href => entry(href)).join('');
    expect((await target().list('/')).map(e => e.path)).toEqual(['/a.epub']);
  });

  it('strict mode refuses unreadable entries and incomplete answers; non-WebDAV answers are refused', async () => {
    dav.seed({}, ['/dav/Comics/书']);
    dav.state.extra = '<d:response><d:href>/dav/Comics/书/hidden.epub</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>';
    expect(await target().list('/书')).toEqual([]);
    await expect(target().list('/书', { strict: true })).rejects.toThrow('无法读取');
    dav.state.extra = '<d:response><d:href>/dav/Comics/书/untyped.epub</d:href><d:propstat><d:prop><d:getcontentlength>4</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
    expect(await target().list('/书')).toEqual([{ name: 'untyped.epub', path: '/书/untyped.epub', directory: false, size: 4 }]);
    await expect(target().list('/书', { strict: true })).rejects.toThrow('无法读取');

    dav.state.override = () => new Response(xml(''), { status: 207 });
    expect(await target().list('/书')).toEqual([]);
    await expect(target().list('/书', { strict: true })).rejects.toThrow('不完整');
    for (const body of ['<html>Login</html>', xml(entry('/dav/Comics/', true)).slice(0, -12), 'not xml']) {
      dav.state.override = () => new Response(body, { status: 207 });
      expect(await failure(target().list('/'))).toMatchObject({ code: 'invalid', message: expect.stringContaining('WebDAV') });
    }
  });

  it('maps HTTP and network failures to StorageError codes', async () => {
    expect(await failure(target().list('/missing'))).toMatchObject({ code: 'not_found', status: 404, retryable: false });
    expect(await failure(target('/', 'wrong').list('/'))).toMatchObject({ code: 'auth', status: 401, retryable: false });
    const cases = [[403, 'auth', false], [408, 'network', true], [429, 'network', true], [503, 'network', true], [507, 'no_space', false], [200, 'io', false]] as const;
    for (const [status, code, retryable] of cases) {
      dav.state.override = () => new Response('', { status });
      const error = await failure(target().list('/'));
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({ code, status, retryable });
    }
    dav.state.override = () => new Response(null, { status: 301, headers: { Location: 'https://elsewhere.example/dav/' } });
    expect(await failure(target().list('/'))).toMatchObject({ code: 'invalid', message: expect.stringContaining('重定向') });
    expect(await failure(createWebdavTarget({ url: `http://127.0.0.1:${closedPort()}/dav` }).list('/'))).toMatchObject({ code: 'network', retryable: true });

    const saved = timeouts.request;
    timeouts.request = 100;
    dav.state.override = () => new Promise<Response>(() => {});
    try { expect(await failure(target().list('/'))).toMatchObject({ code: 'network', retryable: true, name: 'TimeoutError' }); }
    finally { timeouts.request = saved; }
  });

  it('refuses redirects, omits cookies and sends UTF-8 Basic auth', async () => {
    const spy = spyOn(globalThis, 'fetch');
    try {
      await target('/').list('/');
      expect(spy.mock.calls[0]?.[1]).toMatchObject({
        method: 'PROPFIND', redirect: 'error', credentials: 'omit',
        headers: { Depth: '1', Authorization: `Basic ${Buffer.from('测试:test-only').toString('base64')}` },
      });
    } finally { spy.mockRestore(); }
  });
});

it('stat reports files, directories and missing paths', async () => {
  dav.seed({ '/dav/Comics/书/a.epub': 7 });
  expect(await target().stat('/书/a.epub')).toEqual({ size: 7, directory: false });
  expect(await target().stat('/书')).toEqual({ size: 0, directory: true });
  expect(await target().stat('/')).toEqual({ size: 0, directory: true });
  expect(await target().stat('/书/none.epub')).toBeNull();
  expect(await failure(target().stat('/../x'))).toMatchObject({ code: 'invalid' });
});

it('ensureDir probes every segment from the base URL and creates only what is missing, every time', async () => {
  await target().ensureDir('/书/卷 01');
  expect(dav.requests.map(r => `${r.method} ${r.path}${r.depth ? ` ${r.depth}` : ''}`)).toEqual([
    'PROPFIND /dav/Comics 0', 'MKCOL /dav/Comics', 'PROPFIND /dav/Comics/书 0', 'MKCOL /dav/Comics/书', 'PROPFIND /dav/Comics/书/卷 01 0', 'MKCOL /dav/Comics/书/卷 01',
  ]);
  dav.requests.length = 0;
  await target().ensureDir('书/卷 01');
  expect(dav.requests.map(r => r.method)).toEqual(['PROPFIND', 'PROPFIND', 'PROPFIND']);
  dav.state.override = request => request.method === 'MKCOL' ? new Response('', { status: 405 }) : request.method === 'PROPFIND' ? new Response('', { status: 404 }) : undefined;
  await target().ensureDir('/raced'); // 405: created meanwhile
  dav.state.override = request => request.method === 'MKCOL' ? new Response('', { status: 403 }) : request.method === 'PROPFIND' ? new Response('', { status: 404 }) : undefined;
  expect(await failure(target().ensureDir('/denied'))).toMatchObject({ code: 'auth', status: 403 });
});

describe('put', () => {
  const bytes = new Uint8Array(3 * 1024 * 1024 + 7).map((_, i) => (i * 31 + 7) & 255);
  const remote = '/dav/Comics/渣女沒渣報/[Kmoe][渣女沒渣報]卷01.epub';

  it('streams the file with If-None-Match, reports progress, verifies the size and never overwrites', async () => {
    const progress: [number, number][] = [];
    const first = source('a.part', bytes);
    expect(await target().put('渣女沒渣報/[Kmoe][渣女沒渣報]卷01.epub', first, { ...signal(), onProgress: (sent, total) => progress.push([sent, total]) })).toBe('stored');
    const stored = dav.tree.get(remote);
    expect(stored?.dir === false && Buffer.from(stored.bytes!).equals(Buffer.from(bytes))).toBe(true);
    const put = dav.requests.find(r => r.method === 'PUT')!;
    expect(put.headers.get('if-none-match')).toBe('*');
    expect(put.headers.get('content-length')).toBe(String(bytes.length));
    expect(put.headers.get('transfer-encoding')).toBeNull();
    expect(put.headers.get('connection')).toBe('close');
    const download = await fetch(`${dav.url}/Comics/${encodeURIComponent('渣女沒渣報')}/${encodeURIComponent('[Kmoe][渣女沒渣報]卷01.epub')}`, { headers: { Authorization: put.headers.get('authorization')! } });
    expect(Buffer.from(await download.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(progress.at(-1)).toEqual([bytes.length, bytes.length]);
    expect(progress.every(([sent], i) => i === 0 || sent > progress[i - 1]![0])).toBe(true);

    dav.requests.length = 0;
    const same = source('b.part', bytes.map(byte => byte ^ 1));
    expect(await target().put('/渣女沒渣報/[Kmoe][渣女沒渣報]卷01.epub', same, signal())).toBe('exists');
    expect(dav.requests.some(r => r.method === 'PUT')).toBe(false);
    expect(await failure(target().put('/渣女沒渣報/[Kmoe][渣女沒渣報]卷01.epub', source('c.part', new Uint8Array(5)), signal()))).toMatchObject({ code: 'conflict' });
    expect(dav.tree.get(remote)?.dir === false && Buffer.from((dav.tree.get(remote) as { bytes: Uint8Array }).bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it('settles a 412 (file appeared after the check) by comparing sizes', async () => {
    dav.seed({ '/dav/Comics/书/a.epub': 4 });
    let hide = true;
    dav.state.override = (request, path) => {
      if (request.method === 'PROPFIND' && path === '/dav/Comics/书/a.epub' && hide) { hide = false; return new Response('', { status: 404 }); }
    };
    expect(await target().put('/书/a.epub', source('d.part', new Uint8Array(4)), signal())).toBe('exists');
    expect(dav.requests.filter(r => r.method === 'PUT')).toHaveLength(1);
    hide = true;
    expect(await failure(target().put('/书/a.epub', source('e.part', new Uint8Array(5)), signal()))).toMatchObject({ code: 'conflict' });
  });

  it('fails when the stored size does not match', async () => {
    dav.state.override = async (request, path) => {
      if (request.method !== 'PUT') return;
      await request.arrayBuffer();
      dav.tree.set(path, { dir: false, size: 1 });
      return new Response('', { status: 201 });
    };
    expect(await failure(target().put('/x.epub', source('f.part', new Uint8Array(10)), signal()))).toMatchObject({ code: 'io', message: expect.stringContaining('核验') });
  });

  it('gives up only after silence, and stops when cancelled', async () => {
    const saved = { ...timeouts };
    Object.assign(timeouts, { idle: 200, finalise: 200 });
    dav.state.override = request => request.method === 'PUT' ? new Promise<Response>(() => {}) : undefined;
    try {
      expect(await failure(target().put('/stall.epub', source('g.part', new Uint8Array(1000)), signal())))
        .toMatchObject({ code: 'network', retryable: true, message: expect.stringContaining('长时间无响应') });
    } finally { Object.assign(timeouts, saved); }

    const controller = new AbortController();
    dav.state.override = request => { if (request.method === 'PUT') { controller.abort(); return new Promise<Response>(() => {}); } };
    expect(await failure(target().put('/cancel.epub', source('h.part', new Uint8Array(10)), { signal: controller.signal }))).toMatchObject({ name: 'AbortError' });
    expect(await failure(target().put('/early.epub', source('i.part', new Uint8Array(10)), { signal: AbortSignal.abort() }))).toMatchObject({ name: 'AbortError' });
  });
});

describe('move', () => {
  it('renames with MOVE and Overwrite: F, and never onto an existing file', async () => {
    dav.seed({ '/dav/Comics/鏈鋸人/[Kmoe][鏈鋸人]卷01.epub': 3, '/dav/Comics/鏈鋸人/鏈鋸人 - 卷 02.epub': 4 });
    await target().move('/鏈鋸人/[Kmoe][鏈鋸人]卷01.epub', '/鏈鋸人/鏈鋸人 - 卷 01.epub');
    expect([...dav.tree.keys()].filter(path => path.startsWith('/dav/Comics/鏈鋸人/')).sort()).toEqual(['/dav/Comics/鏈鋸人/鏈鋸人 - 卷 01.epub', '/dav/Comics/鏈鋸人/鏈鋸人 - 卷 02.epub']);
    const moved = dav.requests.find(request => request.method === 'MOVE')!;
    expect(moved.headers.get('overwrite')).toBe('F');
    expect(decodeURIComponent(moved.headers.get('destination')!)).toBe(`${dav.url}/Comics/鏈鋸人/鏈鋸人 - 卷 01.epub`);
    expect(await failure(target().move('/鏈鋸人/鏈鋸人 - 卷 01.epub', '/鏈鋸人/鏈鋸人 - 卷 02.epub'))).toMatchObject({ code: 'conflict' });
    expect(dav.tree.get('/dav/Comics/鏈鋸人/鏈鋸人 - 卷 02.epub')).toMatchObject({ size: 4 });
    expect(await failure(target().move('/鏈鋸人/nope.epub', '/鏈鋸人/x.epub'))).toMatchObject({ code: 'not_found' });
  });
  it('a server that ignores Overwrite still never replaces a file', async () => {
    dav.seed({ '/dav/Comics/a.epub': 1, '/dav/Comics/b.epub': 2 });
    dav.state.override = request => request.method === 'MOVE' ? new Response('', { status: 204 }) : undefined;
    expect(await failure(target().move('/a.epub', '/b.epub'))).toMatchObject({ code: 'conflict' });
    expect(dav.requests.some(request => request.method === 'MOVE')).toBe(false);
  });
});

describe('test()', () => {
  it('reports success and explains the usual failures', async () => {
    dav.seed({ '/dav/file.epub': 3 }, ['/dav/Comics']);
    expect(await target().test()).toEqual({ ok: true, message: `连接成功：${dav.origin}/dav/Comics` });
    expect(await target('/missing').test()).toMatchObject({ ok: true, message: expect.stringContaining('自动创建') });
    dav.state.override = () => new Response('', { status: 404 });
    expect(await target('/missing').test()).toMatchObject({ ok: false, message: expect.stringContaining('不存在') });
    dav.state.override = undefined;
    expect(await target('/file.epub').test()).toMatchObject({ ok: false, message: expect.stringContaining('不是目录') });
    expect(await target('/Comics', 'wrong').test()).toMatchObject({ ok: false, message: expect.stringContaining('账号和密码') });
    expect(await createWebdavTarget({ url: `http://127.0.0.1:${closedPort()}` }).test()).toMatchObject({ ok: false, message: expect.stringContaining('无法连接') });
    const answers = [[403, '目录权限'], [405, '不支持 WebDAV'], [500, 'HTTP 500']] as const;
    for (const [status, text] of answers) {
      dav.state.override = () => new Response('', { status });
      expect(await target().test()).toMatchObject({ ok: false, message: expect.stringContaining(text) });
    }
    dav.state.override = () => new Response('<html>NAS login</html>', { status: 207 });
    expect(await target().test()).toMatchObject({ ok: false, message: expect.stringContaining('WebDAV') });
  });

  const openssl = Bun.which('openssl');
  it.skipIf(!openssl)('explains an untrusted HTTPS certificate', async () => {
    const key = join(scratch, 'key.pem'), cert = join(scratch, 'cert.pem');
    Bun.spawnSync([openssl!, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1']);
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', tls: { key: Bun.file(key), cert: Bun.file(cert) }, fetch: () => new Response('', { status: 207 }) });
    try {
      const result = await createWebdavTarget({ url: `https://127.0.0.1:${server.port}/dav` }).test();
      expect(result).toMatchObject({ ok: false, message: expect.stringContaining('证书') });
    } finally { server.stop(true); }
  });
});

it('accepts only plain http(s) base URLs and safe paths', () => {
  for (const url of ['', 'ftp://nas/dav', 'https://user:pw@nas/dav', 'https://nas/dav?x=1', 'https://nas/dav#top', 'https://nas/%E0%A4%A']) {
    expect(() => createWebdavTarget({ url })).toThrow(StorageError);
  }
  expect(() => createWebdavTarget({ url: 'https://nas/dav', basePath: '/a/../b' })).toThrow(StorageError);
  expect(createWebdavTarget({ url: 'nas.local:5005/dav/', basePath: '漫画/' }).label).toBe('http://nas.local:5005/dav/漫画');
  expect(createStorage({ kind: 'webdav', path: '/Comics', url: 'https://nas.example.test/dav', username: 'u', password: 'p' }, { libraryRoot: scratch }))
    .toMatchObject({ kind: 'webdav', label: 'https://nas.example.test/dav/Comics' });
  expect(createStorage({ kind: 'local', path: '/', url: null, username: null, password: null }, { libraryRoot: scratch })).toMatchObject({ kind: 'local', label: scratch });
  expect(() => createStorage({ kind: 'webdav', path: '/', url: null, username: null, password: null }, { libraryRoot: scratch })).toThrow('WebDAV');
});
