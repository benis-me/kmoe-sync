import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalTarget } from '../../server/storage/local';
import { StorageError } from '../../server/storage/types';

let root = '', outside = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'kmoesync-local-')); outside = mkdtempSync(join(tmpdir(), 'kmoesync-outside-')); });
afterEach(() => { for (const dir of [root, outside]) rmSync(dir, { recursive: true, force: true }); });

const signal = () => ({ signal: new AbortController().signal });
function source(name: string, text: string) {
  const dir = join(root, '.kmoesync-tmp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
  return { path: join(dir, name), size: Buffer.byteLength(text) };
}

it('lists directories first in zh order and hides only our own entries and NAS system folders', async () => {
  const library = join(root, '漫画');
  for (const dir of ['中', '啊', '.kmoesync-tmp', '@eaDir', '#recycle']) mkdirSync(join(library, dir), { recursive: true });
  const files = { '卷 10.epub': '0123456789', '卷 02.epub': '01', '.kmoesync-test-1': '', '.DS_Store': '', 'a\\b.epub': '', 'trailing.epub ': '' };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(library, name), text);
  const storage = createLocalTarget({ libraryRoot: root, path: '/漫画' });
  expect(storage).toMatchObject({ kind: 'local', label: library, scratchDir: join(library, '.kmoesync-tmp') });
  const entries = await storage.list('/');
  expect(entries.map(e => e.name)).toContain('.DS_Store');
  expect(entries.filter(e => e.name !== '.DS_Store')).toEqual([
    { name: '啊', path: '/啊', directory: true, size: 0 },
    { name: '中', path: '/中', directory: true, size: 0 },
    { name: '卷 02.epub', path: '/卷 02.epub', directory: false, size: 2 },
    { name: '卷 10.epub', path: '/卷 10.epub', directory: false, size: 10 },
  ]);
  expect(await storage.list('中')).toEqual([]);
});

it('hard-links a download into place, never clobbers, and verifies the size', async () => {
  const storage = createLocalTarget({ libraryRoot: root, path: '/' });
  const book = join(root, '书', '卷 01.epub');
  const first = source('a.part', 'hello');
  const progress: [number, number][] = [];
  expect(await storage.put('书/卷 01.epub', first, { ...signal(), onProgress: (sent, total) => progress.push([sent, total]) })).toBe('stored');
  expect(readFileSync(book, 'utf8')).toBe('hello');
  expect(existsSync(first.path)).toBe(false);
  expect(progress).toEqual([[5, 5]]);

  const same = source('b.part', 'HELLO');
  expect(await storage.put('/书/卷 01.epub', same, signal())).toBe('exists');
  expect(existsSync(same.path)).toBe(true);
  expect(await storage.put('/书/卷 01.epub', source('c.part', 'much longer'), signal()).catch(error => error)).toMatchObject({ code: 'conflict' });
  expect(readFileSync(book, 'utf8')).toBe('hello');

  const wrong = { ...source('d.part', 'abc'), size: 4 };
  expect(await storage.put('/书/卷 02.epub', wrong, signal()).catch(error => error)).toMatchObject({ code: 'io' });
  expect(existsSync(join(root, '书', '卷 02.epub'))).toBe(false);
  expect(existsSync(wrong.path)).toBe(true);
  expect(await storage.put('/', source('e.part', 'x'), signal()).catch(error => error)).toMatchObject({ code: 'invalid' });
});

it('copies exclusively when a hard link is impossible (EXDEV) and cleans up after ENOSPC', async () => {
  const storage = createLocalTarget({ libraryRoot: root, path: '/' });
  const link = spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));
  try {
    const first = source('a.part', 'data');
    expect(await storage.put('/x.epub', first, signal())).toBe('stored');
    expect(readFileSync(join(root, 'x.epub'), 'utf8')).toBe('data');
    expect(existsSync(first.path)).toBe(false);
    expect(await storage.put('/x.epub', source('b.part', 'DATA'), signal())).toBe('exists');
    expect(await storage.put('/x.epub', source('c.part', 'other'), signal()).catch(error => error)).toMatchObject({ code: 'conflict' });
    expect(readFileSync(join(root, 'x.epub'), 'utf8')).toBe('data');

    const copy = spyOn(fs, 'copyFile').mockImplementationOnce(async (_from, to) => {
      writeFileSync(String(to), 'part');
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });
    try {
      expect(await storage.put('/y.epub', source('d.part', 'data'), signal()).catch(error => error)).toMatchObject({ code: 'no_space' });
      expect(existsSync(join(root, 'y.epub'))).toBe(false);
    } finally { copy.mockRestore(); }
  } finally { link.mockRestore(); }
});

it('rejects traversal and symlinks that lead outside the library root', async () => {
  expect(() => createLocalTarget({ libraryRoot: root, path: '/../etc' })).toThrow(StorageError);
  const storage = createLocalTarget({ libraryRoot: root, path: '/' });
  for (const path of ['/a/../../x', '%2e%2e', '/a%2Fb']) expect(await storage.list(path).catch(error => error)).toMatchObject({ code: 'invalid' });

  writeFileSync(join(outside, 'secret.epub'), 'secret');
  symlinkSync(outside, join(root, 'escape'));
  expect(await storage.list('/escape').catch(error => error)).toMatchObject({ code: 'invalid' });
  expect(await storage.stat('/escape/secret.epub').catch(error => error)).toMatchObject({ code: 'invalid' });
  expect(await storage.ensureDir('/escape/new').catch(error => error)).toMatchObject({ code: 'invalid' });
  expect(await storage.put('/escape/new/book.epub', source('a.part', 'x'), signal()).catch(error => error)).toMatchObject({ code: 'invalid' });
  expect(readdirSync(outside)).toEqual(['secret.epub']);
  const escaped = createLocalTarget({ libraryRoot: root, path: '/escape' });
  expect(await escaped.list('/').catch(error => error)).toMatchObject({ code: 'invalid' });
  expect(await escaped.test()).toMatchObject({ ok: false });

  mkdirSync(join(root, 'real'));
  symlinkSync(join(root, 'real'), join(root, 'alias'));
  expect(await storage.stat('/alias')).toEqual({ size: 0, directory: true });
  expect(await storage.put('/alias/book.epub', source('b.part', 'ok'), signal())).toBe('stored');
  expect(readFileSync(join(root, 'real', 'book.epub'), 'utf8')).toBe('ok');
});

it('skips unreadable entries, or refuses them in strict mode', async () => {
  const storage = createLocalTarget({ libraryRoot: root, path: '/' });
  writeFileSync(join(root, 'ok.epub'), 'x');
  symlinkSync(join(root, 'nowhere'), join(root, 'dangling.epub'));
  expect((await storage.list('/')).map(e => e.name)).toEqual(['ok.epub']);
  expect(await storage.list('/', { strict: true }).catch(error => error)).toMatchObject({ code: 'io', message: expect.stringContaining('无法读取') });
});

it('stat, ensureDir and missing paths', async () => {
  const storage = createLocalTarget({ libraryRoot: root, path: '/' });
  expect(await storage.list('/missing').catch(error => error)).toMatchObject({ code: 'not_found' });
  expect(await storage.stat('/missing/x.epub')).toBeNull();
  await storage.ensureDir('/a/b');
  await storage.ensureDir('/a/b');
  expect(await storage.stat('a/b')).toEqual({ size: 0, directory: true });
  writeFileSync(join(root, 'file.epub'), '123');
  expect(await storage.stat('/file.epub')).toEqual({ size: 3, directory: false });
  expect(await storage.list('/file.epub').catch(error => error)).toMatchObject({ code: 'not_found' });
  expect(await storage.ensureDir('/file.epub/sub').catch(error => error)).toBeInstanceOf(StorageError);
  expect(await storage.list('/', { signal: AbortSignal.abort() }).catch(error => error)).toMatchObject({ name: 'AbortError' });
});

it('test() checks that the directory exists, is a directory and is writable', async () => {
  expect(await createLocalTarget({ libraryRoot: root, path: '/' }).test()).toEqual({ ok: true, message: `可以写入：${root}` });
  expect(readdirSync(root)).toEqual([]);
  expect(await createLocalTarget({ libraryRoot: root, path: '/nope' }).test()).toMatchObject({ ok: false, message: expect.stringContaining('不存在') });
  writeFileSync(join(root, 'file'), '');
  expect(await createLocalTarget({ libraryRoot: root, path: '/file' }).test()).toMatchObject({ ok: false, message: expect.stringContaining('不是目录') });
  expect(await createLocalTarget({ libraryRoot: join(root, 'no-root'), path: '/' }).test()).toMatchObject({ ok: false });
  if (process.getuid?.() !== 0) {
    mkdirSync(join(root, 'ro'));
    chmodSync(join(root, 'ro'), 0o555);
    try { expect(await createLocalTarget({ libraryRoot: root, path: '/ro' }).test()).toMatchObject({ ok: false, message: expect.stringContaining('不可写') }); }
    finally { chmodSync(join(root, 'ro'), 0o755); }
  }
});
