// 整理文件名: recognising book files as Kmoe items and planning their new names (shared/books.ts), and renaming them through
// the API against the fake Kmoe mirror with a local library in a temp directory.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chapterRange, planRename, type RenameInput, type RenameItem } from '@shared/books';
import type { LibraryCheck, LibraryJob, RenamePreview, Task } from '@shared/model';
import { createApp } from '../server/app';
import { FAKE_PASSWORD, startFakeKmoe } from './fake-kmoe';
import { startFakeKomga } from './metadata/fakes';

const volume = (n: number): RenameItem => ({ id: String(1000 + n), type: 'volume', name: `卷 ${String(n).padStart(2, '0')}`, sort_order: n });
const ITEMS: RenameItem[] = [
  ...[1, 2, 3, 4, 5].map(volume),
  { id: '3005', type: 'serial', name: '話 005-015', sort_order: 5 },
  { id: '4101', type: 'extra', name: '番外 冒險者指南', sort_order: 1 },
];
const plan = (names: string[], extra: Partial<RenameInput> = {}) => planRename({
  title: '渣女沒渣報', authors: ['岸川瑞樹'], rule: '{title} - {bookname}', items: ITEMS,
  entries: names.map(name => ({ name: name.replace(/\/$/, ''), directory: name.endsWith('/') })), ...extra,
});
const renames = (result: ReturnType<typeof planRename>) => Object.fromEntries(result.files.map(file => [file.name, file.to ?? file.note]));

describe('planRename', () => {
  test('old names of every kind become the rule name; named files and other files stay', () => {
    const result = plan([
      '[Kmoe][渣女沒渣報]卷01.epub', '渣女沒渣報-卷 02.epub', '渣女沒渣報 - 卷 03.epub', 'Vol.04.epub', '[Kmoe][渣女沒渣報]話005-015.epub',
      '番外冒險者指南.mobi', 'scan_0012.epub', 'cover.jpg',
    ]);
    expect(result.named).toBe(1);
    expect(renames(result)).toEqual({
      '[Kmoe][渣女沒渣報]卷01.epub': '渣女沒渣報 - 卷 01.epub',
      '渣女沒渣報-卷 02.epub': '渣女沒渣報 - 卷 02.epub',
      'Vol.04.epub': '渣女沒渣報 - 卷 04.epub',
      '[Kmoe][渣女沒渣報]話005-015.epub': '渣女沒渣報 - 話 005-015.epub',
      '番外冒險者指南.mobi': '渣女沒渣報 - 番外 冒險者指南.mobi',
      'scan_0012.epub': '认不出是哪一卷或哪一话',
    });
    expect(result.files.find(file => file.name === 'Vol.04.epub')).toMatchObject({ item: '卷 04', source: 'name', confidence: null });
  });

  test('download records and the AI name files whose names say nothing; the record wins over the name', () => {
    const result = plan(['第一本.epub', 'scan_0012.epub', '渣女沒渣報 - 卷 01.mobi'], {
      records: new Map([['第一本.epub', '1001'], ['渣女沒渣報 - 卷 01.mobi', '1002']]),
      ai: new Map([['scan_0012.epub', { item: '1005', confidence: 0.92 }]]),
    });
    expect(renames(result)).toEqual({ '第一本.epub': '渣女沒渣報 - 卷 01.epub', 'scan_0012.epub': '渣女沒渣報 - 卷 05.epub', '渣女沒渣報 - 卷 01.mobi': '渣女沒渣報 - 卷 02.mobi' });
    expect(result.files.find(file => file.name === 'scan_0012.epub')).toMatchObject({ source: 'ai', confidence: 0.92, item: '卷 05' });
  });

  test('chapter packs in any notation, and volumes or packs Kmoe no longer lists, named the way Kmoe names them', () => {
    expect(renames(plan(['第5-15話.epub', 'Ch.005~015.mobi']))).toEqual({ '第5-15話.epub': '渣女沒渣報 - 話 005-015.epub', 'Ch.005~015.mobi': '渣女沒渣報 - 話 005-015.mobi' });
    // The chapter is the number by 第…话, not one in the subtitle after it.
    expect(chapterRange('第105话 5x6')).toEqual({ first: 105, last: 105 });
    expect(chapterRange('鏈鋸人2 話076-080')).toEqual({ first: 76, last: 80 });
    expect(chapterRange('話 076-080')).toEqual({ first: 76, last: 80 });
    expect(chapterRange('076話')).toEqual({ first: 76, last: 76 });
    expect(chapterRange('話 035-037 [話132-134]')).toEqual({ first: 35, last: 37 });
    expect(chapterRange('最終回紀念+番外特別')).toBeNull();
    expect(chapterRange('Ch.12')).toEqual({ first: 12, last: 12 });
    // 庫洛魔法使 透明牌篇 on Kmoe has volumes only now; the files were named after the title without its space.
    const clear = planRename({
      title: '庫洛魔法使 透明牌篇', hint: '庫洛魔法使透明牌篇', authors: [], rule: '{title}-{bookname}', items: [1, 2, 16].map(volume),
      entries: ['庫洛魔法使透明牌篇-卷 16.epub', '庫洛魔法使透明牌篇-話076-080.epub', '庫洛魔法使透明牌篇-話081.epub', '庫洛魔法使透明牌篇-卷 17.epub', '庫洛魔法使透明牌篇 18.epub']
        .map(name => ({ name, directory: false })),
    });
    expect(renames(clear)).toEqual({
      '庫洛魔法使透明牌篇-卷 16.epub': '庫洛魔法使 透明牌篇-卷 16.epub',
      '庫洛魔法使透明牌篇-話076-080.epub': '庫洛魔法使 透明牌篇-話 076-080.epub',
      '庫洛魔法使透明牌篇-話081.epub': '庫洛魔法使 透明牌篇-話 081.epub',
      '庫洛魔法使透明牌篇-卷 17.epub': '庫洛魔法使 透明牌篇-卷 17.epub',
      // A bare number is too weak to name a file after when Kmoe has no such volume.
      '庫洛魔法使透明牌篇 18.epub': '认不出是哪一卷或哪一话',
    });
    expect(clear.files.find(file => file.name === '庫洛魔法使透明牌篇-話076-080.epub')).toMatchObject({ item: '話 076-080', source: 'name', note: 'Kmoe 上已经没有「話 076-080」这一项，按文件名命名' });
    expect(clear.files.find(file => file.name === '庫洛魔法使透明牌篇-卷 16.epub')).toMatchObject({ item: '卷 16', note: null });
    // Already named by the rule, or by Kmoe's own name with a {filename} rule.
    expect(planRename({ title: 'X', authors: [], rule: '{title}-{bookname}', items: [], entries: [{ name: 'X-話 076-080.epub', directory: false }] })).toEqual({ named: 1, files: [] });
    expect(planRename({ title: 'X', authors: [], rule: '{filename}', items: [], entries: [{ name: '[Mox.moe][X]話 076-080.epub', directory: false }] })).toEqual({ named: 1, files: [] });
  });

  test('the title the files were named after, digits in titles, and a change of case only', () => {
    const grand = planRename({ title: '碧藍之海', hint: 'GRAND BLUE 碧藍之海', authors: [], rule: '{title} - {bookname}', items: ITEMS, entries: [{ name: 'GRAND BLUE 碧藍之海-卷 01.epub', directory: false }] });
    expect(renames(grand)).toEqual({ 'GRAND BLUE 碧藍之海-卷 01.epub': '碧藍之海 - 卷 01.epub' });
    const century = planRename({ title: '20世紀少年', authors: [], rule: '{title} {bookname}', items: ITEMS, entries: [{ name: '20世紀少年 03.epub', directory: false }] });
    expect(renames(century)).toEqual({ '20世紀少年 03.epub': '20世紀少年 卷 03.epub' });
    const nana = planRename({ title: 'NANA', authors: [], rule: '{title} {bookname}', items: ITEMS, entries: [{ name: 'nana 卷 01.epub', directory: false }] });
    expect(renames(nana)).toEqual({ 'nana 卷 01.epub': 'NANA 卷 01.epub' });
  });

  test('two files of one item, a name taken by a file that stays, and names that would have to be swapped', () => {
    expect(renames(plan(['[Kmoe][渣女沒渣報]卷01.epub', '渣女沒渣報-卷 01.epub']))).toEqual({
      '[Kmoe][渣女沒渣報]卷01.epub': '有 2 个文件都是「卷 01」，请先处理重复的文件', '渣女沒渣報-卷 01.epub': '有 2 个文件都是「卷 01」，请先处理重复的文件',
    });
    expect(renames(plan(['渣女沒渣報 - 卷 01.epub', '渣女沒渣報-卷 01.epub']))).toEqual({ '渣女沒渣報-卷 01.epub': '和「渣女沒渣報 - 卷 01.epub」是同一项，可能是重复的文件' });
    // The record says "渣女沒渣報 - 卷 02.epub" holds volume 3, which already has its file: it stays, so volume 2 cannot take its name.
    const blocked = plan(['渣女沒渣報 - 卷 02.epub', '渣女沒渣報 - 卷 03.epub', '渣女沒渣報-卷 02.epub'], { records: new Map([['渣女沒渣報 - 卷 02.epub', '1003']]) });
    expect(renames(blocked)).toEqual({
      '渣女沒渣報 - 卷 02.epub': '和「渣女沒渣報 - 卷 03.epub」是同一项，可能是重复的文件', '渣女沒渣報-卷 02.epub': '已有同名的「渣女沒渣報 - 卷 02.epub」',
    });
    // A file that moves away first frees its name.
    const chain = plan(['渣女沒渣報 - 卷 02.epub', '渣女沒渣報-卷 02.epub'], { records: new Map([['渣女沒渣報 - 卷 02.epub', '1003']]) });
    expect(renames(chain)).toEqual({ '渣女沒渣報 - 卷 02.epub': '渣女沒渣報 - 卷 03.epub', '渣女沒渣報-卷 02.epub': '渣女沒渣報 - 卷 02.epub' });
    const swap = plan(['渣女沒渣報 - 卷 01.epub', '渣女沒渣報 - 卷 02.epub'], { records: new Map([['渣女沒渣報 - 卷 01.epub', '1002'], ['渣女沒渣報 - 卷 02.epub', '1001']]) });
    expect(renames(swap)).toEqual({ '渣女沒渣報 - 卷 01.epub': '几个文件要互换名字，请手动改名', '渣女沒渣報 - 卷 02.epub': '几个文件要互换名字，请手动改名' });
    // A rule that names different items alike renames none of them.
    expect(renames(plan(['渣女沒渣報-卷 01.epub', '渣女沒渣報-卷 02.epub'], { rule: '{title}' }))).toEqual({
      '渣女沒渣報-卷 01.epub': '命名规则会给 2 个文件同一个名字', '渣女沒渣報-卷 02.epub': '命名规则会给 2 个文件同一个名字',
    });
    // Never onto a folder either.
    expect(renames(plan(['渣女沒渣報-卷 01.epub', '渣女沒渣報 - 卷 01.epub/']))).toEqual({ '渣女沒渣報-卷 01.epub': '已有同名的「渣女沒渣報 - 卷 01.epub」' });
  });

  test('{filename} is Kmoe\'s name for the file: kept from any mirror, given to files named otherwise', () => {
    const result = plan(['[Kmoe][渣女沒渣報]卷01.epub', '[Mox.moe][渣女沒渣報]卷 02.epub', '渣女沒渣報 - 卷 03.epub', '渣女沒渣報-卷 02.epub'], { rule: '{filename}' });
    expect(result.named).toBe(2);
    expect(renames(result)).toEqual({
      '渣女沒渣報 - 卷 03.epub': '[Kmoe][渣女沒渣報]卷03.epub',
      // Another file of volume 2, which already has its Kmoe-named file.
      '渣女沒渣報-卷 02.epub': '和「[Mox.moe][渣女沒渣報]卷 02.epub」是同一项，可能是重复的文件',
    });
    // Dates in the rule match any date.
    expect(plan(['渣女沒渣報 卷 01 2024.epub'], { rule: '{title} {bookname} {year}' }).named).toBe(1);
  });
});

describe('整理文件名 through the API', () => {
  const fake = startFakeKmoe({ port: 0 }), komga = startFakeKomga();
  const root = mkdtempSync(join(tmpdir(), 'kmoesync-rename-'));
  const library = join(root, 'library'), folder = join(library, '渣女沒渣報');
  const app = createApp({
    host: '127.0.0.1', port: 0, dataDir: join(root, 'data'), libraryRoot: library, staticDir: join(root, 'web'),
    mirrors: [fake.origin], secureCookies: false, secret: Buffer.alloc(32, 7), fakeKmoe: true,
  }, { fetch, scheduler: false, bulkPaceMs: 20 });
  let base = '', cookie = '', csrf = '', targetId = 0;
  async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const response = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) },
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0]!;
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  }
  async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    for (const deadline = Date.now() + 20_000; ;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value).slice(0, 400)}`);
      await Bun.sleep(50);
    }
  }
  const job = () => api<{ job: LibraryJob }>('GET', `/api/library?targetId=${targetId}`).then(r => r.data.job);

  beforeAll(async () => {
    base = `http://127.0.0.1:${app.start().port}`;
    csrf = (await api('POST', '/api/auth/setup', { password: 'rename-test-pass' })).data.csrf;
    targetId = (await api('GET', '/api/targets')).data[0].id;
    await api('POST', '/api/kmoe/login', { email: 'reader@example.com', password: FAKE_PASSWORD });
    mkdirSync(folder, { recursive: true });
    for (const name of ['渣女沒渣報-卷 02.epub', '話005-015.mobi', 'notes.epub', 'cover.jpg']) writeFileSync(join(folder, name), 'PK\x03\x04 book');
  });
  afterAll(async () => { await app.stop(); fake.stop(); komga.stop(); rmSync(root, { recursive: true, force: true }); });

  test('a download named by the old rule and older files get the new rule; records, checks and folders follow', async () => {
    expect((await api('PUT', '/api/comics/8a3dbd/folder', { targetId, path: '/渣女沒渣報' })).status).toBe(200);
    await api('POST', '/api/tasks', { comicKey: '8a3dbd', itemIds: ['1001'], format: 'epub', targetId });
    await until(() => api<{ tasks: Task[] }>('GET', '/api/tasks?comicKey=8a3dbd').then(r => r.data.tasks), tasks => tasks.every(task => task.status === 'completed'));
    expect(existsSync(join(folder, '[Kmoe][渣女沒渣報]卷01.epub'))).toBe(true);
    expect((await api('PATCH', `/api/targets/${targetId}`, { rule: '{title}/{title} - {bookname}' })).status).toBe(200);

    // Komga reads this library: the preview says whether it keeps read progress through renames, and the job asks it to scan.
    expect((await api('PATCH', '/api/metadata/settings', { enabled: true, komga: { url: komga.url, auth: 'apiKey', secret: komga.apiKey, libraries: [{ targetId, libraryId: 'lib1' }] } })).status).toBe(200);

    const preview = (await api<RenamePreview>('POST', '/api/library/rename/preview', { targetId })).data;
    expect(preview).toMatchObject({ rule: '{title} - {bookname}', named: 0, komga: { name: '漫画', hashFiles: true } });
    expect(preview.folders.map(f => [f.path, f.files.map(file => [file.name, file.to ?? file.note, file.source])])).toEqual([['/渣女沒渣報', [
      ['[Kmoe][渣女沒渣報]卷01.epub', '渣女沒渣報 - 卷 01.epub', 'record'],
      ['話005-015.mobi', '渣女沒渣報 - 話 005-015.mobi', 'name'],
      ['渣女沒渣報-卷 02.epub', '渣女沒渣報 - 卷 02.epub', 'name'],
      ['notes.epub', '认不出是哪一卷或哪一话', null],
    ]]]);
    // Only plain file names that are books, in a folder of this target.
    const folderId = preview.folders[0]!.folderId;
    expect((await api('POST', '/api/library/rename', { targetId, renames: [{ folderId, name: 'notes.epub', to: '../x.epub' }] })).status).toBe(400);
    expect((await api('POST', '/api/library/rename', { targetId, renames: [{ folderId, name: 'cover.jpg', to: 'a.epub' }] })).status).toBe(400);
    // The AI needs setting up first.
    expect((await api('POST', '/api/library/rename/ai', { folderId })).status).toBe(409);

    const renames = preview.folders[0]!.files.flatMap(file => file.to ? [{ folderId, name: file.name, to: file.to }] : []);
    expect((await api<LibraryJob>('POST', '/api/library/rename', { targetId, renames })).data).toMatchObject({ kind: 'rename', running: true, total: 3 });
    expect(await until(job, current => !current.running)).toMatchObject({ kind: 'rename', done: 3, error: null });
    expect(readdirSync(folder).sort()).toEqual(['cover.jpg', 'notes.epub', '渣女沒渣報 - 卷 01.epub', '渣女沒渣報 - 卷 02.epub', '渣女沒渣報 - 話 005-015.mobi']);
    expect(app.db.query<{ path: string }, []>('SELECT path FROM deliveries').all()).toEqual([{ path: '/渣女沒渣報/渣女沒渣報 - 卷 01.epub' }]);
    const check = (await api<LibraryCheck>('POST', '/api/comics/8a3dbd/library-check', { targetId, format: 'epub' })).data;
    expect(check.chapters.filter(chapter => chapter.status === 'downloaded').map(chapter => chapter.id)).toEqual(['1001', '1002']);
    const overview = (await api('GET', `/api/library?targetId=${targetId}`)).data;
    expect(overview.folders.find((f: { path: string }) => f.path === '/渣女沒渣報')).toMatchObject({ books: 4, sample: '渣女沒渣報 - 話 005-015.mobi', hint: '渣女沒渣報' });
    expect(komga.state.scans).toEqual(['lib1']);
    expect((await api('GET', '/api/activity?limit=1')).data[0]).toMatchObject({ level: 'success', title: '整理文件名：改名了 1 部的 3 个文件', detail: '已请求 Komga 扫描书库' });

    const again = (await api<RenamePreview>('POST', '/api/library/rename/preview', { targetId })).data;
    expect(again.named).toBe(3);
    expect(again.folders.map(f => f.files.map(file => file.name))).toEqual([['notes.epub']]);
    // A file that took a name meanwhile is never overwritten: that rename fails and says why.
    writeFileSync(join(folder, '渣女沒渣報 - 卷 99.epub'), 'other');
    await api('POST', '/api/library/rename', { targetId, renames: [{ folderId, name: 'notes.epub', to: '渣女沒渣報 - 卷 99.epub' }] });
    const failed = await until(job, current => !current.running);
    expect(failed.error).toContain('notes.epub');
    expect(readdirSync(folder)).toContain('notes.epub');
    // The API token reaches 整理文件名 too (/api/v1), like the other library jobs.
    const token = (await api<{ token: string }>('POST', '/api/token')).data.token;
    const viaToken = await fetch(`${base}/api/v1/library/rename/preview`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId }) });
    expect(viaToken.status).toBe(200);
    expect((await viaToken.json() as RenamePreview).named).toBe(4);
  }, 60_000);
});
