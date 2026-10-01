// Library import and folder mapping, end to end against the fake Kmoe mirror with a local library in a temp directory.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LibraryFolder, LibraryOverview, Task } from '@shared/model';
import { createApp } from '../server/app';
import { resetKmoeThrottle } from '../server/kmoe/client';
import { canonicalTitle, folderKeywords, opfIds, similarity, titleHint } from '../server/services/library';
import { FAKE_PASSWORD, startFakeKmoe } from './fake-kmoe';

describe('title helpers', () => {
  test('hints come from the file names the library was written with', () => {
    expect(titleHint(['GRAND BLUE 碧藍之海-卷 01.epub', 'GRAND BLUE 碧藍之海-卷 02.epub'])).toBe('GRAND BLUE 碧藍之海');
    expect(titleHint(['[Kmoe][迷宮飯]卷01.epub', '[Kmoe][迷宮飯]番外.epub'])).toBe('迷宮飯');
    expect(titleHint(['JOJO的奇妙冒險-JOJO Lands-卷 01.epub'])).toBe('JOJO的奇妙冒險-JOJO Lands');
    expect(titleHint(['cover.jpg', 'NANA 01.epub'])).toBeNull();
  });
  test('canonical titles and similarity', () => {
    expect(canonicalTitle('ＧＲＡＮＤ　BLUE 碧藍之海！')).toBe('grandblue碧藍之海');
    expect(similarity('間諜家家', '間諜家家酒')).toBeCloseTo(0.8);
    expect(similarity('IS (完全版)', 'IS（完全版）')).toBe(1);
    expect(folderKeywords('迷宮飯 (完全版)', '迷宮飯')).toEqual(['迷宮飯', '迷宮飯 (完全版)']);
  });
  test('Kmoe ids come from the EPUB metadata', () => {
    const opf = (identifier: string, series = '') => `<metadata><dc:identifier id="KSBN" opf:scheme="KSBN">${identifier}</dc:identifier>${series}</metadata>`;
    expect(opfIds(opf('2003135230814', '<dc:seriesid>KMOE:8a3dbd</dc:seriesid>'))).toEqual({ key: '8a3dbd', bookId: '31352' });
    expect(opfIds(opf('2005190810017-1749327691'))).toEqual({ key: null, bookId: '51908' });
    expect(opfIds('<dc:identifier id="MOXBID">2002591110012</dc:identifier>')).toEqual({ key: null, bookId: '25911' });
    expect(opfIds('<dc:identifier id="ISBN">9784088820019</dc:identifier>')).toEqual({ key: null, bookId: null });
  });
});

const fake = startFakeKmoe({ port: 0 });
const root = mkdtempSync(join(tmpdir(), 'kmoesync-library-'));
const library = join(root, 'library');
const app = createApp({
  host: '127.0.0.1', port: 0, dataDir: join(root, 'data'), libraryRoot: library, staticDir: join(root, 'web'),
  mirrors: [fake.origin], secureCookies: false, secret: Buffer.alloc(32, 9), fakeKmoe: true,
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
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value).slice(0, 400)}`);
    await Bun.sleep(100);
  }
}
const overview = () => api<LibraryOverview>('GET', `/api/library?targetId=${targetId}`).then(r => r.data);
const folderAt = (data: LibraryOverview, path: string) => data.folders.find(folder => folder.path === path)!;
const book = (folder: string, name: string) => { mkdirSync(join(library, folder), { recursive: true }); writeFileSync(join(library, folder, name), 'PK\x03\x04 book'); };
const tasksOf = async (key: string) => (await api<{ tasks: Task[] }>('GET', `/api/tasks?comicKey=${key}&limit=100`)).data.tasks;
const settled = (tasks: Task[]) => tasks.length > 0 && tasks.every(task => task.status !== 'queued' && task.status !== 'running');

beforeAll(async () => {
  base = `http://127.0.0.1:${app.start().port}`;
  csrf = (await api('POST', '/api/auth/setup', { password: 'library-test-pass' })).data.csrf;
  targetId = (await api('GET', '/api/targets')).data[0].id;
  // What an existing NAS library looks like: folders named after the Kmoe titles, some with edition suffixes.
  book('葬送的芙莉蓮', '葬送的芙莉蓮-卷 01.epub');
  book('葬送的芙莉蓮', '葬送的芙莉蓮-卷 02.epub');
  book('迷宮飯 (完全版)', '[Kmoe][迷宮飯]卷01.epub');
  book('GRAND BLUE 碧藍之海', 'GRAND BLUE 碧藍之海-卷 01.epub');
  book('間諜家家', '間諜家家 01.epub');
  book('收藏/渣女沒渣報', '渣女沒渣報-卷 01.epub');
  writeFileSync(join(library, 'readme.txt'), 'not a series');
});
afterAll(async () => { await app.stop(); fake.stop(); rmSync(root, { recursive: true, force: true }); });

describe('library import', () => {
  test('matching needs a Kmoe login', async () => {
    const response = await api('POST', '/api/library/scan', { targetId, match: true });
    expect(response.status).toBe(409);
    expect(response.data.error.code).toBe('kmoe_login_required');
  }, 30_000);

  test('scan finds series folders and links identical titles', async () => {
    await api('POST', '/api/kmoe/login', { email: 'reader@example.com', password: FAKE_PASSWORD });
    expect((await api('POST', '/api/library/scan', { targetId, match: true })).data).toMatchObject({ kind: 'scan', running: true });
    expect((await api('POST', '/api/library/match-kmoe', { targetId })).status).toBe(409);
    const data = await until(overview, value => !value.job.running);
    expect(data.job.error).toBeNull();
    expect(data.folders.map(folder => folder.path).sort()).toEqual(['/GRAND BLUE 碧藍之海', '/收藏/渣女沒渣報', '/葬送的芙莉蓮', '/迷宮飯 (完全版)', '/間諜家家']);
    expect(folderAt(data, '/葬送的芙莉蓮')).toMatchObject({ books: 2, format: 'epub', hint: '葬送的芙莉蓮', kmoe: { state: 'matched', comic: { key: 'f7e2c9' } } });
    expect(folderAt(data, '/迷宮飯 (完全版)').kmoe).toMatchObject({ state: 'matched', comic: { key: 'b1c4a0' } });
    expect(folderAt(data, '/收藏/渣女沒渣報').kmoe).toMatchObject({ state: 'matched', comic: { key: '8a3dbd' } });
    expect(folderAt(data, '/GRAND BLUE 碧藍之海').kmoe.state).toBe('unmatched');
    const suggested = folderAt(data, '/間諜家家').kmoe;
    expect(suggested.state).toBe('suggested');
    expect(suggested.candidates[0]).toMatchObject({ key: 'c9d0e1', title: '間諜家家酒' });
    expect(suggested.candidates[0]!.score).toBeCloseTo(0.8);
    expect(data.counts.kmoe).toMatchObject({ matched: 3, suggested: 1, unmatched: 1 });
  }, 30_000);

  test('imported comics are on the shelf with their existing volumes', async () => {
    const shelf = (await api('GET', '/api/shelf')).data as { comic: { key: string }; counts: { downloaded: number } }[];
    expect(shelf.find(entry => entry.comic.key === 'f7e2c9')?.counts.downloaded).toBe(2);
    expect(shelf.find(entry => entry.comic.key === 'b1c4a0')?.counts.downloaded).toBe(1);
    const { data } = await api('GET', '/api/comics/f7e2c9');
    expect(data.folder).toMatchObject({ path: '/葬送的芙莉蓮', mapped: false });
    expect(data.states['2001'].state).toBe('downloaded');
    expect(data.states['2003'].state).toBe('missing');
  }, 30_000);

  test('new downloads go into the folder the comic already lives in', async () => {
    const detail = (await api('GET', '/api/comics/b1c4a0')).data;
    expect(detail.folder).toMatchObject({ path: '/迷宮飯 (完全版)', mapped: true });
    await api('POST', '/api/tasks', { comicKey: 'b1c4a0', itemIds: ['4002'], format: 'epub', targetId });
    expect((await until(() => tasksOf('b1c4a0'), settled))[0]).toMatchObject({ status: 'completed', path: '/迷宮飯 (完全版)/[Kmoe][迷宮飯]卷02.epub' });
    expect(existsSync(join(library, '迷宮飯 (完全版)', '[Kmoe][迷宮飯]卷02.epub'))).toBe(true);
    expect(existsSync(join(library, '迷宮飯'))).toBe(false);
    expect(folderAt(await overview(), '/迷宮飯 (完全版)').books).toBe(2);
  }, 30_000);

  test('manual link, accept-suggested skips comics linked elsewhere, ignore and reset', async () => {
    const data = await overview();
    const grand = folderAt(data, '/GRAND BLUE 碧藍之海'), spy = folderAt(data, '/間諜家家');
    const linked = await api<LibraryFolder>('POST', `/api/library/folders/${grand.id}/kmoe`, { comic: `${fake.origin}/c/c9d0e1.htm` });
    expect(linked.data.kmoe).toMatchObject({ state: 'matched', comic: { key: 'c9d0e1' } });
    // Files named after another title ("GRAND BLUE 碧藍之海-卷 01") still count in a folder dedicated to the series.
    expect((await api('GET', '/api/comics/c9d0e1')).data.states['5001'].state).toBe('downloaded');
    expect((await api('POST', '/api/library/accept-suggested', { targetId, minScore: 0.7 })).data).toEqual({ linked: 0 });
    expect((await api('POST', `/api/library/folders/${spy.id}/kmoe`, { comic: 'c9d0e1' })).status).toBe(409);
    expect((await api<LibraryFolder>('POST', `/api/library/folders/${grand.id}/ignore`)).data.kmoe).toMatchObject({ state: 'ignored', comic: null });
    expect((await api('POST', '/api/library/accept-suggested', { targetId, minScore: 0.7 })).data).toEqual({ linked: 1 });
    expect((await api<LibraryFolder>('POST', `/api/library/folders/${grand.id}/reset`)).data.kmoe).toMatchObject({ state: 'pending', candidates: [] });
  }, 30_000);

  test('map a comic to an existing folder and back', async () => {
    book('Frieren', '葬送的芙莉蓮-卷 05.epub');
    const mapped = await api('PUT', '/api/comics/f7e2c9/folder', { targetId, path: '/Frieren' });
    expect(mapped.data.folder).toMatchObject({ path: '/Frieren', mapped: true });
    expect(mapped.data.states['2005'].state).toBe('downloaded');
    expect(mapped.data.states['2001'].state).toBe('missing');
    expect(folderAt(await overview(), '/葬送的芙莉蓮').kmoe.state).toBe('pending');
    expect((await api('PUT', '/api/comics/8a3dbd/folder', { targetId, path: '/Frieren' })).status).toBe(409);
    expect((await api('PUT', '/api/comics/f7e2c9/folder', { targetId, path: '/nope' })).status).toBe(404);
    const back = await api('DELETE', `/api/comics/f7e2c9/folder?targetId=${targetId}`);
    expect(back.data.folder).toMatchObject({ path: '/葬送的芙莉蓮', mapped: false });
    expect(back.data.states['2001'].state).toBe('downloaded');
  }, 30_000);
});

describe('following an imported comic', () => {
  test('a MOBI folder is followed in MOBI, and volumes its library check cannot confirm are not downloaded again', async () => {
    // NANA in MOBI on a target of its own: 卷 01 is recognised, the other file is not, so 卷 02 and 03 cannot be confirmed.
    book('MOBI/NANA', 'NANA-卷 01.mobi');
    book('MOBI/NANA', 'NANA 特典.mobi');
    const mobi = (await api('POST', '/api/targets', { kind: 'local', name: 'MOBI', path: '/MOBI', rule: '{title}/{filename}' })).data.id as number;
    await api('POST', '/api/library/scan', { targetId: mobi, match: false });
    const scanned = await until(() => api<LibraryOverview>('GET', `/api/library?targetId=${mobi}`).then(r => r.data), value => !value.job.running);
    await api('POST', `/api/library/folders/${folderAt(scanned, '/NANA').id}/kmoe`, { comic: '10114' });
    const detail = (await api('GET', '/api/comics/10114')).data;
    expect(detail.view).toEqual({ targetId: mobi, format: 'mobi' });
    expect(['6001', '6002', '6003'].map(id => detail.states[id].state)).toEqual(['downloaded', 'unknown', 'unknown']);
    const policy = { enabled: true, types: ['volume'], format: 'mobi', targetId: mobi, strategy: 'backfill', line: 0 };
    expect((await api('POST', '/api/comics/10114/subscription/preview', policy)).data).toMatchObject({ queue: 0, unknown: 2 });
    // MCP (and the assistant) without a target or format work where the folder is, in its format.
    const token = (await api('POST', '/api/token')).data.token as string;
    const tool = async (name: string, args: object) => (await (await fetch(`${base}/mcp`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })).json()).result.structuredContent;
    expect(await tool('download', { key: '10114' })).toMatchObject({ created: 0 });
    expect(await tool('subscribe', { key: '10114' })).toMatchObject({ targetId: mobi, format: 'mobi', strategy: 'backfill' });
    expect(await tasksOf('10114')).toEqual([]);
    await api('DELETE', '/api/comics/10114/subscription?cancelPending=true');
    expect((await api('DELETE', `/api/targets/${mobi}`)).status).toBe(200);
    rmSync(join(library, 'MOBI'), { recursive: true, force: true });
  }, 30_000);
});

describe('following the imported library', () => {
  test('one job follows the ongoing comics that are not subscribed: new items only, in the folder\'s format, nothing downloaded', async () => {
    const subscription = async (key: string) => (await api('GET', `/api/comics/${key}`)).data.subscription;
    // Linked: 葬送的芙莉蓮 (again, after the mapping above) and 間諜家家酒 are coming out; 渣女沒渣報 is followed already
    // (its serial chapters); 迷宮飯 has ended.
    await api('POST', `/api/library/folders/${folderAt(await overview(), '/葬送的芙莉蓮').id}/kmoe`, { comic: 'f7e2c9' });
    await api('PUT', '/api/comics/8a3dbd/subscription', { enabled: true, types: ['serial'], format: 'epub', targetId, strategy: 'future', line: 0 });
    expect((await overview()).follow).toBe(2);
    expect((await api('POST', '/api/library/follow', { targetId })).data).toMatchObject({ kind: 'follow', running: true });
    const done = await until(overview, value => !value.job.running);
    expect(done.job).toMatchObject({ kind: 'follow', error: null, done: 2, total: 2 });
    expect(done.follow).toBe(0);
    for (const key of ['f7e2c9', 'c9d0e1']) {
      expect(await subscription(key)).toMatchObject({ enabled: true, types: ['volume'], format: 'epub', targetId, strategy: 'future' });
      expect(await tasksOf(key)).toEqual([]);
    }
    expect(await subscription('8a3dbd')).toMatchObject({ types: ['serial'] });
    expect(await subscription('b1c4a0')).toBeNull();
    for (const key of ['f7e2c9', 'c9d0e1', '8a3dbd']) await api('DELETE', `/api/comics/${key}/subscription?cancelPending=true`);
  }, 30_000);
});

describe('matching by the Kmoe ids in the files', () => {
  test('EPUBs name their comic, so only folders whose ids settle nothing need a search', async () => {
    mkdirSync(join(library, '第二书库'), { recursive: true });
    const second = (await api('POST', '/api/targets', { kind: 'local', name: '第二书库', path: '/第二书库', rule: '{title}/{filename}' })).data.id as number;
    const epub = (folder: string, name: string, identifier: string, series?: string) => {
      const dir = join(library, '第二书库', folder), opf = join(root, `${crypto.randomUUID()}.opf`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(opf, `<package><metadata><dc:identifier id="KSBN">${identifier}</dc:identifier>${series ? `<dc:seriesid>KMOE:${series}</dc:seriesid>` : ''}</metadata></package>`);
      expect(Bun.spawnSync(['zip', '-q', '-j', join(dir, name), opf]).exitCode).toBe(0);
    };
    epub('NANA', 'NANA-卷01.epub', '2001011410015-1748432680'); // numeric key = book id
    epub('渣女', '渣女-話081-085.epub', '2003135230814', '8a3dbd'); // series id (files from 2026 on)
    epub('迷宮飯', '迷宮飯-卷01.epub', '2001848810017'); // hex key, but the comic is already known here
    epub('間諜家家酒', '間諜家家酒-卷01.epub', '2004099910012'); // unknown book: the title search finds another comic
    const searches = async () => ((await fetch(`${fake.origin}/__fake/state`).then(r => r.json())) as { searches: number }).searches;
    const before = await searches();
    await api('POST', '/api/library/scan', { targetId: second, match: true });
    const data = await until(() => api<LibraryOverview>('GET', `/api/library?targetId=${second}`).then(r => r.data), value => !value.job.running);
    expect(data.job.error).toBeNull();
    expect(folderAt(data, '/NANA').kmoe).toMatchObject({ state: 'matched', comic: { key: '10114' }, error: null });
    expect(folderAt(data, '/渣女').kmoe).toMatchObject({ state: 'matched', comic: { key: '8a3dbd' } });
    expect(folderAt(data, '/迷宮飯').kmoe).toMatchObject({ state: 'matched', comic: { key: 'b1c4a0' } });
    expect(folderAt(data, '/間諜家家酒').kmoe).toMatchObject({ state: 'suggested', comic: null, candidates: [{ key: 'c9d0e1' }] });
    expect(await searches() - before).toBe(1);
    expect((await api('GET', `/api/comics/10114?targetId=${second}`)).data.states['6001'].state).toBe('downloaded');
  }, 30_000);
});

describe('Kmoe throttling during an import', () => {
  test('the job waits out the cooldown and finishes every folder', async () => {
    resetKmoeThrottle(0.0005); // 30 min → 0.9 s
    try {
      for (const name of ['間諜家家酒', '渣女沒渣報']) book(`再掃描/${name}`, `${name}-卷 02.epub`);
      await fetch(`${fake.origin}/__fake/control`, { method: 'POST', body: JSON.stringify({ deflect: 1 }) });
      expect((await api('POST', '/api/library/scan', { targetId, match: true })).status).toBe(200);
      const messages = new Set<string>();
      const data = await until(overview, value => { if (value.job.current) messages.add(value.job.current); return !value.job.running; });
      expect(data.job).toMatchObject({ error: null, cancelled: false });
      expect([...messages].some(message => message.includes('Kmoe 暂时限制了访问频率'))).toBe(true);
      // Nothing failed: the throttled search was retried after the cooldown.
      expect(data.folders.filter(folder => folder.kmoe.error)).toEqual([]);
      expect(folderAt(data, '/再掃描/渣女沒渣報').kmoe.state).not.toBe('pending');
    } finally { resetKmoeThrottle(); }
  }, 30_000);
});

describe('upgrade from before folders were tracked', () => {
  test('backfill links downloaded comics to the folder their files are in', () => {
    const comicId = app.comics.find('b1c4a0')!.id;
    app.db.run('DELETE FROM library_folders WHERE comic_id = ?', [comicId]);
    expect(app.library.folderFor(comicId, targetId)).toBeNull();
    app.library.backfill();
    expect(app.library.folderFor(comicId, targetId)?.path).toBe('/迷宮飯 (完全版)');
    app.library.backfill();
    expect(app.db.query('SELECT COUNT(*) AS n FROM library_folders WHERE comic_id = ?').get(comicId)).toEqual({ n: 1 });
  });
});

describe('network outage', () => {
  test('a lost connection pauses the queue instead of failing the task', async () => {
    await api('PATCH', '/api/settings', { autoRetry: false });
    fake.stop();
    await api('POST', '/api/tasks', { comicKey: 'c9d0e1', itemIds: ['5002'], format: 'epub', targetId });
    const status = await until(() => api('GET', '/api/status').then(r => r.data), s => s.queue.paused);
    expect(status.queue.reason).toBe('network');
    const task = (await tasksOf('c9d0e1')).find(item => item.itemId === '5002')!;
    expect(task).toMatchObject({ status: 'queued', errorCode: 'kmoe_network' });
  }, 30_000);
});
