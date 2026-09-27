// Ported from the browser extension's tests/library.test.ts. There the server was https://nas.example.test/dav with target
// path /comic; here the storage is rooted at /comic, so result paths are relative to it. Every case runs on WebDAV and local.
import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectLibrary, type Delivered, type LibraryRequest } from '../../server/storage/library';
import { createLocalTarget } from '../../server/storage/local';
import type { StorageTarget } from '../../server/storage/types';
import { createWebdavTarget } from '../../server/storage/webdav';
import { entry, startFakeDav, xml } from './fake-webdav';

const request: LibraryRequest = {
  title: '渣女沒渣報', authors: ['岸川瑞樹'], format: 'epub', rule: '{title}/{filename}',
  chapters: [{ id: '1001', label: '卷 01' }, { id: '1010', label: '卷 10' }, { id: '3005', label: '話 005-015' }],
};
const dir = '/渣女沒渣報';

const dav = startFakeDav({ auth: { username: 'reader', password: 'test-only' } });
const roots: string[] = [];
afterAll(() => { dav.stop(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

type Remote = (files: Record<string, number>, base?: string) => { storage: StorageTarget; reads: () => number };
const backends: Record<'webdav' | 'local', Remote> = {
  webdav(files, base = '/comic') {
    dav.reset();
    dav.seed(Object.fromEntries(Object.entries(files).map(([path, size]) => [`/dav${base}${path}`, size])), [`/dav/comic${dir}`]);
    const storage = createWebdavTarget({ url: dav.url, username: 'reader', password: 'test-only', basePath: base });
    return { storage, reads: () => { expect(dav.requests.every(r => r.method === 'PROPFIND' && r.depth === '1')).toBe(true); return dav.requests.length; } };
  },
  local(files, base = '/comic') {
    const root = mkdtempSync(join(tmpdir(), 'kmoesync-library-'));
    roots.push(root);
    mkdirSync(join(root, 'comic', dir), { recursive: true });
    for (const [path, size] of Object.entries(files)) {
      const file = join(root, base, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '');
      truncateSync(file, size);
    }
    const storage = createLocalTarget({ libraryRoot: root, path: base });
    const list = spyOn(storage, 'list');
    return { storage, reads: () => list.mock.calls.length };
  },
};

for (const [kind, remote] of Object.entries(backends)) describe(kind, () => {
  it('matches complete site names, zero-padding, volume/range boundaries and only the requested format', async () => {
    const { storage, reads } = remote({ [`${dir}/[Kmoe][渣女沒渣報]卷01.epub`]: 34924626, [`${dir}/[Kmoe][渣女沒渣報][岸川瑞樹]話005-015.epub`]: 55852035, [`${dir}/[Kmoe][渣女沒渣報]卷10.mobi`]: 12 });
    const result = await inspectLibrary(storage, request);
    expect(result.chapters.map(c => c.status)).toEqual(['downloaded', 'missing', 'downloaded']);
    expect(result).toMatchObject({ directory: dir, directoryExists: true, unmatched: [] });
    expect(reads()).toBe(1);
    const mobi = await inspectLibrary(storage, { ...request, format: 'mobi' });
    expect(mobi.chapters.map(c => c.status)).toEqual(['missing', 'downloaded', 'missing']);
  });

  it('leaves renamed, zero-byte and ambiguous files unconfirmed instead of marking them new', async () => {
    const result = await inspectLibrary(remote({ [`${dir}/卷01.epub`]: 0, [`${dir}/custom-name.epub`]: 10 }).storage, request);
    expect(result.chapters.every(c => c.status === 'unknown')).toBe(true);
    expect(result.unmatched).toEqual([`${dir}/custom-name.epub`]);
    const collision = await inspectLibrary(remote({ [`${dir}/卷 01.epub`]: 10 }).storage,
      { ...request, rule: '{title}/{bookname}', chapters: [{ id: '1001', label: '卷 01' }, { id: '2001', label: '卷 01' }] });
    expect(collision.chapters.every(c => c.status === 'unknown')).toBe(true);
  });

  it('reads custom chapter and historical date directories without scanning unrelated series', async () => {
    const path = '/岸川瑞樹/渣女沒渣報/卷 01/2024/[Kmoe][渣女沒渣報]卷01.epub';
    const { storage, reads } = remote({ [path]: 10, '/other-book/2024/volume.epub': 10 });
    const result = await inspectLibrary(storage, { ...request, rule: '{author$0}/{title}/{bookname}/{year}/{filename}' });
    expect(result.chapters.map(c => c.status)).toEqual(['downloaded', 'missing', 'missing']);
    expect(result.chapters[0]?.paths).toEqual([path]);
    expect(reads()).toBe(3);
    expect((await inspectLibrary(remote({ [`${dir}/卷 01.epub`]: 10 }).storage, { ...request, rule: '{title}/{bookname}' })).chapters[0]?.status).toBe('downloaded');
  });

  it('uses history only with an existing file of the correct size, and cannot confuse another comic in a shared directory', async () => {
    const history: Delivered[] = [{ itemId: '1001', path: `${dir}/renamed.epub`, size: 10, ok: true }];
    expect((await inspectLibrary(remote({ [`${dir}/renamed.epub`]: 9 }).storage, request, history)).chapters[0]?.status).toBe('unknown');
    expect((await inspectLibrary(remote({ [`${dir}/renamed.epub`]: 10 }).storage, request, history)).chapters[0])
      .toMatchObject({ status: 'downloaded', reason: '已核对同步记录与书库文件', paths: [`${dir}/renamed.epub`] });
    expect((await inspectLibrary(remote({ [`${dir}/renamed.epub`]: 10 }).storage, request, [{ ...history[0]!, ok: false }])).chapters[0]?.status).toBe('unknown');
    expect((await inspectLibrary(remote({ '/[Kmoe][另一本]卷01.epub': 10 }).storage, { ...request, rule: '{filename}' })).chapters.every(c => c.status === 'missing')).toBe(true);
  });

  it('reports a missing directory without failing', async () => {
    const result = await inspectLibrary(remote({}).storage, { ...request, rule: '{author$0}/{title}/{filename}' });
    expect(result).toMatchObject({ directory: '/岸川瑞樹/渣女沒渣報', directoryExists: false });
    expect(result.chapters.every(c => c.status === 'missing')).toBe(true);
  });

  it('treats a title folder in the target path itself as a title directory, like the extension', async () => {
    const base = `/comic${dir}`, files = { '/卷01.epub': 10 };
    const plain = await inspectLibrary(remote(files, base).storage, { ...request, rule: '{filename}' });
    expect(plain.chapters[0]?.status).toBe('missing');
    const titled = await inspectLibrary(remote(files, base).storage, { ...request, rule: '{filename}', basePath: base });
    expect(titled.chapters.map(c => c.status)).toEqual(['downloaded', 'missing', 'missing']);
  });
});

describe('webdav only', () => {
  it('distinguishes a missing directory from access errors and rejects incomplete multistatus listings', async () => {
    const { storage } = backends.webdav({});
    dav.state.override = () => new Response('', { status: 404 });
    expect(await inspectLibrary(storage, request)).toMatchObject({ directoryExists: false, chapters: expect.arrayContaining([expect.objectContaining({ status: 'missing' })]) });
    dav.state.override = () => new Response('', { status: 403 });
    await expect(inspectLibrary(storage, request)).rejects.toMatchObject({ code: 'auth', message: expect.stringContaining('验证失败') });
    const partial = xml(entry(`/dav/comic${dir}`, true) + `<d:response><d:href>/dav/comic${dir}/hidden.epub</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>`);
    dav.state.override = () => new Response(partial, { status: 207 });
    await expect(storage.list(dir, { strict: true })).rejects.toThrow('无法读取');
    await expect(inspectLibrary(storage, request)).rejects.toThrow('无法读取');
    dav.state.override = () => new Response(xml(''), { status: 207 });
    await expect(storage.list(dir, { strict: true })).rejects.toThrow('不完整');
  });

  it('keeps the extension limits: 100 directories and 10 000 entries', async () => {
    const years = Array.from({ length: 101 }, (_, i) => `/dav/comic${dir}/${2000 + i}`);
    const { storage } = backends.webdav({});
    dav.seed({}, years);
    await expect(inspectLibrary(storage, { ...request, rule: '{title}/{year}/{filename}' })).rejects.toThrow('100 个目录');
    dav.seed(Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [`/dav/comic${dir}/f${i}.txt`, 1])));
    await expect(inspectLibrary(storage, request)).rejects.toThrow('10000 个条目');
  });
});
