// MetadataService end to end: settings, Komga test, matching (Komga links, manual), syncing to a fake Komga, backoff, tick, jobs.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent } from '@shared/model';
import { now, openDatabase } from '../../server/db';
import { EventHub } from '../../server/events';
import { createSealer } from '../../server/lib/crypto';
import { BangumiClient, bangumiLimiter } from '../../server/metadata/bangumi';
import { DISABLED_METADATA, MetadataService } from '../../server/metadata/service';
import { Notifier } from '../../server/notify';
import { ActivityLog } from '../../server/services/activity';
import { ComicService } from '../../server/services/comics';
import { JobRunner } from '../../server/services/jobs';
import { KmoeService } from '../../server/services/kmoe';
import { SettingsStore } from '../../server/services/settings';
import { TargetService } from '../../server/services/targets';
import { downloadTiming } from '../../server/metadata/dump';
import { isLocalHost, proxyUrl } from '../../server/lib/proxy';
import { AiService } from '../../server/ai/service';
import { startFakeAi } from '../fake-ai';
import { BANGUMI_HOSTS, blocked, fakeBangumi, GITHUB_HOSTS, sampleDump, startFakeGithub, startFakeKomga } from './fakes';

const komga = startFakeKomga();
const root = mkdtempSync(join(tmpdir(), 'kmoesync-metadata-'));
const services: MetadataService[] = [];
beforeAll(() => { bangumiLimiter.max = 10_000; BangumiClient.retryDelays = [1, 1]; downloadTiming.retryDelays = [10, 10]; });
beforeEach(() => komga.reset());
afterAll(async () => {
  await Promise.all(services.map(service => service.dispose()));
  komga.stop();
  rmSync(root, { recursive: true, force: true });
});

interface MetaRow { dirty: number; attempts: number; next_attempt_at: string | null; bangumi_id: number | null }
type ItemSpec = [type: 'volume' | 'serial' | 'extra', name: string, order: number];

async function until(check: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await Bun.sleep(10);
  }
}

/** net: wraps the fake Bangumi fetch, e.g. to block bgm.tv or to route GitHub to a fake. */
function setup(fixtures: Record<string, unknown> = {}, net: (next: typeof fetch) => typeof fetch = next => next) {
  const db = openDatabase(root, ':memory:');
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  hub.subscribe(event => events.push(event));
  const sealer = createSealer(Buffer.alloc(32, 5));
  const settings = new SettingsStore(db);
  const activity = new ActivityLog(db, hub, new Notifier(() => []));
  const kmoe = new KmoeService(db, sealer, ['https://kzo.moe'], () => '');
  const targets = new TargetService(db, sealer, settings, join(root, 'library'));
  targets.ensureDefault();
  const comics = new ComicService(db, kmoe, hub, settings);
  const jobs = new JobRunner(hub);
  const bgm = fakeBangumi(fixtures);
  const dataDir = mkdtempSync(join(root, 'data-'));
  const open = () => {
    const service = new MetadataService({ db, hub, sealer, settings, activity, comics, targets, kmoe, jobs, fetch: net(bgm.fetch), dataDir });
    services.push(service);
    return service;
  };
  const metadata = open();
  const targetId = targets.list()[0]!.id;
  return {
    db, events, metadata, jobs, activity, targetId, bgm, dataDir, settings,
    /** The service as it starts up again on the same database (e.g. after an upgrade). */
    reopen: open,
    folder(path: string, extra: { books?: number; hint?: string; comicId?: number } = {}): number {
      const time = now();
      return Number(db.run('INSERT INTO library_folders (target_id, path, name, books, hint, comic_id, kmoe_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [targetId, path, path.split('/').at(-1)!, extra.books ?? 3, extra.hint ?? null, extra.comicId ?? null, extra.comicId ? 'matched' : 'pending', time, time]).lastInsertRowid);
    },
    comic(key: string, title: string, authors: string[], items: ItemSpec[], status = '連載'): number {
      const time = now();
      const id = Number(db.run('INSERT INTO comics (key, book_id, title, authors, language, status, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [key, '1', title, JSON.stringify(authors), '繁體', status, time, time, time]).lastInsertRowid);
      for (const [index, [type, name, order]] of items.entries()) {
        db.run('INSERT INTO items (comic_id, remote_id, type, name, sort_order, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, String(1000 + index), type, name, order, time, time]);
      }
      return id;
    },
    deliver(comicId: number, remoteId: string, path: string) {
      db.run(`INSERT INTO deliveries (item_id, target_id, format, path, size, delivered_at)
        SELECT id, ?, 'epub', ?, 100, ? FROM items WHERE comic_id = ? AND remote_id = ?`, [targetId, path, now(), comicId, remoteId]);
    },
    configure(patch: Parameters<MetadataService['patchSettings']>[0] = {}) {
      return metadata.patchSettings({ enabled: true, komga: { url: komga.url, auth: 'apiKey', secret: komga.apiKey, libraries: [{ targetId, libraryId: 'lib1' }] }, ...patch });
    },
    state: (folderId: number) => metadata.forFolders([folderId]).get(folderId)!,
    row: (folderId: number) => db.query<MetaRow, [number]>('SELECT * FROM folder_metadata WHERE folder_id = ?').get(folderId)!,
  };
}

describe('settings', () => {
  test('defaults, patch semantics; secrets are sealed and never returned', () => {
    const { metadata, db, targetId } = setup();
    expect(metadata.settings()).toEqual({
      enabled: false, komga: { url: '', auth: 'apiKey', username: '', hasSecret: false, libraries: [] },
      bangumi: {
        hasToken: false, source: 'auto', online: { reachable: null, checkedAt: null, error: null },
        archive: { state: 'none', dump: null, dumpDate: null, importedAt: null, subjects: 0, progress: null, error: null, checkedAt: null },
      },
      options: { titleLanguage: 'cn', books: true, posters: 'off', lock: true, autoSync: true, tagLimit: 10, readingDirection: 'auto' },
    });
    const saved = metadata.patchSettings({
      enabled: true, komga: { url: '192.168.1.10:25600/', secret: 'key-123', libraries: [{ targetId, libraryId: 'lib1' }] },
      bangumi: { token: 'bgm-token-456' }, options: { tagLimit: 5 },
    });
    expect(saved).toMatchObject({
      enabled: true, komga: { url: 'http://192.168.1.10:25600', hasSecret: true, libraries: [{ targetId, libraryId: 'lib1' }] },
      bangumi: { hasToken: true }, options: { tagLimit: 5, lock: true, posters: 'off' },
    });
    const stored = db.query<{ value: string }, []>('SELECT value FROM settings').all().map(row => row.value).join('\n');
    expect(stored).not.toContain('key-123');
    expect(stored).not.toContain('bgm-token-456');
    expect(JSON.stringify(saved)).not.toContain('key-123');
    expect(metadata.patchSettings({ komga: { username: 'admin' } }).komga).toMatchObject({ hasSecret: true, username: 'admin' });
    expect(metadata.patchSettings({ komga: { secret: '' }, bangumi: { token: '' } })).toMatchObject({ komga: { hasSecret: false }, bangumi: { hasToken: false } });
    expect(() => metadata.patchSettings({ komga: { url: 'http://admin:pw@nas:7799' } })).toThrow('账号密码');
    expect(() => metadata.patchSettings({ komga: { libraries: [{ targetId: 999, libraryId: 'lib1' }] } })).toThrow('不存在');
    expect(metadata.settings().komga.url).toBe('http://192.168.1.10:25600');
  });

  test('testKomga: draft merged with saved settings, clear errors', async () => {
    const { metadata } = setup();
    const ok = await metadata.testKomga({ url: komga.url, auth: 'apiKey', secret: komga.apiKey });
    expect(ok).toMatchObject({ ok: true, version: '1.27.1', libraries: [{ id: 'lib1', name: '漫画', root: '/data' }, { id: 'lib2', name: '小说', root: '/novels' }] });
    expect(ok.message).toContain('1.27.1');
    expect(await metadata.testKomga({ url: komga.url, secret: 'wrong' })).toMatchObject({ ok: false, message: expect.stringContaining('凭据') });
    expect((await metadata.testKomga({ url: komga.url })).message).toContain('API Key');
    metadata.patchSettings({ komga: { url: komga.url, secret: komga.apiKey } });
    expect((await metadata.testKomga({})).ok).toBe(true);
    expect((await metadata.testKomga({ url: 'http://127.0.0.1:1' })).message).toContain('无法连接');
    komga.state.roles = ['USER'];
    expect(await metadata.testKomga({})).toMatchObject({ ok: false, message: expect.stringContaining('ADMIN') });
  });

  test('forFolders: Komga state is disabled until enabled, configured and mapped', () => {
    const s = setup();
    const id = s.folder('/X');
    expect(s.state(id)).toEqual(DISABLED_METADATA);
    s.metadata.markDirty(id);
    expect(s.state(id).komga.state).toBe('disabled');
    s.configure();
    expect(s.state(id).komga).toMatchObject({ state: 'pending', dirty: true });
    s.metadata.patchSettings({ komga: { libraries: [] } });
    expect(s.state(id).komga.state).toBe('disabled');
    expect(s.metadata.forFolders([id, 12345]).get(12345)).toEqual(DISABLED_METADATA);
  });
});

describe('matching', () => {
  test('a Bangumi link already on the Komga series is reused without searching; an unlinked one is not', async () => {
    const s = setup();
    s.configure();
    komga.addSeries('s-link', '/GRAND BLUE 碧藍之海', { links: [{ label: 'cbl', url: 'https://bgm.tv/subject/118165' }] });
    const id = s.folder('/GRAND BLUE 碧藍之海', { books: 25 });
    await s.metadata.matchFolder(id, { auto: true });
    expect(s.state(id).bangumi).toMatchObject({ state: 'matched', source: 'komga', subject: { id: 118165, nameCn: 'GRANDBLUE 碧蓝之海' } });
    expect(s.bgm.calls).toEqual(['subject:118165']);
    s.metadata.unmatchFolder(id);
    expect(s.state(id).bangumi).toMatchObject({ state: 'none', subject: null, candidates: [], source: null });
    await s.metadata.matchFolder(id, { auto: true });
    expect(s.bgm.calls).toContain('search:GRAND BLUE 碧藍之海');
    expect(s.state(id).bangumi).toMatchObject({ state: 'matched', source: 'auto', subject: { id: 118165 } });
  });

  test('manual subject from an id or link; clear errors', async () => {
    const s = setup();
    const id = s.folder('/NANA', { books: 21 });
    await s.metadata.matchFolder(id, { subject: 'https://bangumi.tv/subject/5297/' });
    expect(s.state(id).bangumi).toMatchObject({ state: 'matched', source: 'manual', subject: { id: 5297, volumes: 21 } });
    expect(s.row(id).dirty).toBe(1);
    expect(s.events).toContainEqual({ type: 'folders', targetId: s.targetId });
    await expect(s.metadata.matchFolder(id, { subject: 'NANA' })).rejects.toThrow('无法识别');
    await expect(s.metadata.matchFolder(id, { subject: '424242' })).rejects.toThrow('找不到条目');
    await expect(s.metadata.matchFolder(id, {})).rejects.toThrow('自动匹配');
    await expect(s.metadata.matchFolder(999, { auto: true })).rejects.toThrow('找不到该文件夹');
    expect((await s.metadata.searchBangumi('NANA'))[0]).toMatchObject({ id: 606428, name: 'NaNa', series: true, url: 'https://bgm.tv/subject/606428' });
  });
});

/** A GRAND BLUE folder with three delivered items, and its Komga series with four books. */
function grandBlue(s: ReturnType<typeof setup>) {
  const comicId = s.comic('gb1234', 'GRAND BLUE 碧藍之海', ['井上堅二', '吉岡公威'], [['volume', '卷 01', 1], ['volume', '卷 02', 2], ['serial', '話 100-105', 100]]);
  const folderId = s.folder('/GRAND BLUE 碧藍之海', { books: 4, hint: 'GRAND BLUE 碧藍之海', comicId });
  s.deliver(comicId, '1000', '/GRAND BLUE 碧藍之海/GRAND BLUE 碧藍之海-卷 01.epub');
  s.deliver(comicId, '1001', '/GRAND BLUE 碧藍之海/GRAND BLUE 碧藍之海-卷 02.epub');
  s.deliver(comicId, '1002', '/GRAND BLUE 碧藍之海/GRAND BLUE 碧藍之海-話 100-105.epub');
  komga.addSeries('s1', '/GRAND BLUE 碧藍之海', { links: [{ label: 'MAL', url: 'https://myanimelist.net/manga/1' }], alternateTitles: [{ label: 'Original', title: 'ぐらんぶる' }] });
  komga.addBook('b1', 's1', 'GRAND BLUE 碧藍之海-卷 01.epub', 1);
  komga.addBook('b2', 's1', 'GRAND BLUE 碧藍之海-卷 02.epub', 2);
  komga.addBook('b3', 's1', 'GRAND BLUE 碧藍之海-話 100-105.epub', 3);
  komga.addBook('b4', 's1', 'GRAND BLUE 碧藍之海-卷 03.epub', 4);
  return folderId;
}

describe('writing to Komga', () => {
  test('series and books: Kmoe items, file names and Bangumi volumes; a re-sync writes nothing', async () => {
    const s = setup();
    s.configure();
    const folderId = grandBlue(s);
    await s.metadata.matchFolder(folderId, { auto: true });
    expect(s.state(folderId).bangumi).toMatchObject({ state: 'matched', source: 'auto', subject: { id: 118165 } });
    await s.metadata.syncFolder(folderId);
    expect(s.state(folderId).komga).toMatchObject({ state: 'synced', seriesId: 's1', seriesUrl: `${komga.url}/series/s1`, dirty: false, error: null });
    expect(s.state(folderId).bangumi.subject?.volumes).toBe(27);
    expect(s.events).toContainEqual({ type: 'comic', key: 'gb1234' });

    const series = komga.state.patches.filter(patch => patch.kind === 'series');
    expect(series).toHaveLength(1);
    expect(series[0]!.body).toMatchObject({
      title: 'GRANDBLUE 碧蓝之海', titleLock: true, status: 'ONGOING', statusLock: true, publisher: '東立出版社', language: 'zh-Hant',
      readingDirection: 'RIGHT_TO_LEFT', genres: ['青年', '搞笑'],
      links: [{ label: 'MAL', url: 'https://myanimelist.net/manga/1' }, { label: 'Bangumi', url: 'https://bgm.tv/subject/118165' }, { label: 'Kmoe', url: 'https://kzo.moe/c/gb1234.htm' }],
      alternateTitles: [{ label: 'Original', title: 'ぐらんぶる' }, { label: '别名', title: 'Grand Blue' }, { label: 'Kmoe', title: 'GRAND BLUE 碧藍之海' }],
    });
    const books = Object.fromEntries(komga.state.patches.filter(patch => patch.kind === 'books').map(patch => [patch.id, patch.body]));
    const authors = [{ name: '吉岡公威', role: 'penciller' }, { name: '井上堅二', role: 'writer' }];
    expect(books.b1).toMatchObject({ title: '卷 01', number: '1', numberSort: 1, releaseDate: '2015-10-14', isbn: '9789864620111', authors, links: [{ label: 'Bangumi', url: 'https://bgm.tv/subject/118167' }] });
    expect(books.b2).toMatchObject({ title: '卷 02', number: '2', numberSort: 2, releaseDate: '2016-01-12', isbn: '9789864622221', links: [{ label: 'Bangumi', url: 'https://bgm.tv/subject/118166' }] });
    // A chapter pack is not a volume; the fourth file is numbered from its name (its Bangumi volume has no details here).
    expect(books.b3).toEqual({ title: '話 100-105', titleLock: true, authors, authorsLock: true });
    expect(books.b4).toMatchObject({ number: '3', numberSort: 3, authors });
    expect(books.b4!.title).toBeUndefined();
    expect(books.b4!.links).toBeUndefined();

    const written = komga.state.patches.length;
    s.metadata.markDirty(folderId);
    await s.metadata.syncFolder(folderId);
    expect(komga.state.patches.length).toBe(written);
    expect(s.state(folderId).komga).toMatchObject({ state: 'synced', dirty: false });
  });

  test('the reading direction is a setting: a change is written at each series\' next sync, synced series are not queued again', async () => {
    const s = setup();
    s.configure();
    const folderId = grandBlue(s);
    await s.metadata.matchFolder(folderId, { auto: true });
    await s.metadata.syncFolder(folderId);
    const direction = () => komga.state.patches.filter(patch => patch.kind === 'series').at(-1)?.body.readingDirection;
    expect(direction()).toBe('RIGHT_TO_LEFT');
    s.metadata.patchSettings({ options: { readingDirection: 'WEBTOON' } });
    expect(s.state(folderId).komga).toMatchObject({ state: 'synced', dirty: false });
    await s.metadata.syncFolder(folderId);
    expect(direction()).toBe('WEBTOON');
  });

  test('posters: the Bangumi cover is uploaded once and never over a user-uploaded one', async () => {
    const s = setup();
    s.settings.patch({ proxy: 'http://127.0.0.1:7890' });
    s.configure({ options: { posters: 'all' } });
    const folderId = grandBlue(s);
    komga.state.thumbnails.set('books/b2', [{ id: 'mine', type: 'USER_UPLOADED', selected: true }]);
    await s.metadata.matchFolder(folderId, { subject: '118165' });
    await s.metadata.syncFolder(folderId);
    expect(komga.state.uploads.map(upload => `${upload.kind}/${upload.id}`)).toEqual(['series/s1', 'books/b1']);
    expect(komga.state.uploads.every(upload => upload.selected === 'true' && upload.size > 0)).toBe(true);
    expect(s.bgm.calls).toContain('image:/pic/cover/l/0f/2f/118165_f0m8c.jpg');
    expect([...new Set(s.bgm.proxies)]).toEqual(['http://127.0.0.1:7890']);
    await s.metadata.syncFolder(folderId);
    expect(komga.state.uploads).toHaveLength(2);
  });

  test('a folder Komga does not show yet: one scan request, retries after 2, 5, 15, 60 minutes, then waits', async () => {
    const s = setup();
    s.configure();
    const id = s.folder('/新漫画');
    await s.metadata.matchFolder(id, { subject: '118165' });
    await s.metadata.syncFolder(id);
    expect(s.state(id).komga).toMatchObject({ state: 'not_found', seriesId: null, dirty: true });
    expect(komga.state.scans).toEqual(['lib1']);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) await s.metadata.syncFolder(id);
      const row = s.row(id);
      expect(row.attempts).toBe(attempt);
      delays.push(row.next_attempt_at ? Math.round((Date.parse(row.next_attempt_at) - Date.now()) / 60_000) : 0);
    }
    expect(delays).toEqual([2, 5, 15, 60, 0]);
    expect(s.row(id).dirty).toBe(0);
    expect(komga.state.scans).toEqual(['lib1']);
    komga.addSeries('s-new', '/新漫画');
    s.metadata.markDirty(id);
    await s.metadata.syncFolder(id);
    expect(s.state(id).komga).toMatchObject({ state: 'synced', seriesId: 's-new', dirty: false });
    expect(s.row(id).attempts).toBe(0);
  });

  test('a volume downloaded before Komga scanned it: the series is written, a scan requested, and its book filled in later', async () => {
    const s = setup();
    s.configure();
    const folderId = grandBlue(s);
    await s.metadata.matchFolder(folderId, { auto: true });
    // 卷 04 has just been downloaded; Komga does not list it yet.
    const { comic_id: comicId } = s.db.query<{ comic_id: number }, [number]>('SELECT comic_id FROM library_folders WHERE id = ?').get(folderId)!;
    s.db.run('INSERT INTO items (comic_id, remote_id, type, name, sort_order, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [comicId, '1003', 'volume', '卷 04', 4, now(), now()]);
    s.deliver(comicId, '1003', '/GRAND BLUE 碧藍之海/GRAND BLUE 碧藍之海-卷 04.epub');
    await s.metadata.syncFolder(folderId);
    expect(s.state(folderId).komga).toMatchObject({ state: 'synced', seriesId: 's1', dirty: true });
    expect(komga.state.patches.some(patch => patch.kind === 'series')).toBe(true);
    expect(komga.state.scans).toEqual(['lib1']);
    const row = s.row(folderId);
    expect(row.attempts).toBe(1);
    expect(Math.round((Date.parse(row.next_attempt_at!) - Date.now()) / 60_000)).toBe(2);
    // Komga has scanned it: the next pass writes the new book and the folder is done.
    komga.addBook('b5', 's1', 'GRAND BLUE 碧藍之海-卷 04.epub', 5);
    await s.metadata.syncFolder(folderId);
    expect(s.state(folderId).komga).toMatchObject({ state: 'synced', dirty: false });
    expect(s.row(folderId).attempts).toBe(0);
    expect(komga.state.patches.find(patch => patch.id === 'b5')?.body).toMatchObject({ title: '卷 04', number: '4' });
  });

  test('sync needs a configured Komga, a library for the target and a Bangumi match', async () => {
    const s = setup();
    const id = s.folder('/GRAND BLUE 碧藍之海');
    await expect(s.metadata.syncFolder(id)).rejects.toThrow('启用');
    expect(() => s.metadata.startSyncJob(s.targetId, true)).toThrow('启用');
    s.configure();
    await expect(s.metadata.syncFolder(id)).rejects.toThrow('匹配');
    s.metadata.patchSettings({ komga: { libraries: [] } });
    expect(() => s.metadata.startSyncJob(s.targetId, true)).toThrow('Komga 书库');
  });
});

describe('scheduler and jobs', () => {
  test('tick: matches new folders and syncs dirty ones, only when enabled, automatic and idle', async () => {
    const s = setup();
    const id = s.folder('/GRAND BLUE 碧藍之海', { books: 25 });
    komga.addSeries('s-tick', '/GRAND BLUE 碧藍之海');
    await s.metadata.tick();
    expect(s.bgm.calls).toEqual([]);
    s.configure();
    await s.metadata.tick();
    expect(s.state(id)).toMatchObject({ bangumi: { state: 'matched', source: 'auto' }, komga: { state: 'synced', dirty: false } });
    const written = komga.state.patches.length;
    expect(written).toBeGreaterThan(0);

    s.metadata.markDirty(id);
    expect(s.state(id).komga.dirty).toBe(true);
    let release = () => {};
    s.jobs.start('scan', s.targetId, () => new Promise<void>(resolve => { release = resolve; }));
    await s.metadata.tick();
    expect(s.state(id).komga.dirty).toBe(true);
    release();
    await until(() => !s.jobs.busy);
    s.metadata.patchSettings({ options: { autoSync: false } });
    await s.metadata.tick();
    expect(s.state(id).komga.dirty).toBe(true);
    s.metadata.patchSettings({ options: { autoSync: true } });
    await s.metadata.tick();
    expect(s.state(id).komga.dirty).toBe(false);
    expect(komga.state.patches.length).toBe(written);
  });

  test('tick: a folder Bangumi rejects is left to the match job; an outage pauses matching', async () => {
    const s = setup({ 'search:BAD': 400, 'search:DOWN': 503 });
    s.configure();
    const bad = s.folder('/BAD'), good = s.folder('/GRAND BLUE 碧藍之海', { books: 25 });
    await s.metadata.tick();
    expect(s.state(bad).bangumi.state).toBe('none');
    expect(s.state(bad).bangumi.checkedAt).not.toBeNull();
    expect(s.state(good).bangumi.state).toBe('matched');
    const down = s.folder('/DOWN'), later = s.folder('/NANA', { books: 21 });
    await s.metadata.tick();
    expect(s.state(down).bangumi.checkedAt).toBeNull();
    expect(s.state(later).bangumi.checkedAt).toBeNull();
  });

  test('match and sync jobs: progress, retry semantics and an activity summary', async () => {
    const s = setup();
    s.configure();
    const grand = s.folder('/GRAND BLUE 碧藍之海', { books: 25 });
    const nana = s.folder('/NANA', { books: 21 });
    komga.addSeries('j1', '/GRAND BLUE 碧藍之海');
    expect(s.metadata.startMatchJob(s.targetId, false)).toMatchObject({ kind: 'bangumi', running: true, targetId: s.targetId });
    expect(() => s.metadata.startMatchJob(s.targetId, false)).toThrow('已有书库任务');
    await until(() => !s.jobs.busy);
    expect(s.jobs.current()).toMatchObject({ kind: 'bangumi', running: false, done: 2, total: 2, error: null });
    expect(s.state(grand).bangumi.state).toBe('matched');
    expect(s.state(nana).bangumi).toMatchObject({ state: 'suggested', subject: null });
    expect(s.state(nana).bangumi.candidates.map(candidate => candidate.id)).toContain(5297);
    expect(s.activity.list(1)[0]).toMatchObject({ kind: 'info', title: 'Bangumi 匹配：自动匹配 1 部，待确认 1 部，未找到 0 部' });

    s.metadata.startSyncJob(s.targetId, false);
    await until(() => !s.jobs.busy);
    expect(s.jobs.current()).toMatchObject({ kind: 'komga', done: 1, total: 1, error: null });
    expect(s.activity.list(1)[0]).toMatchObject({ title: 'Komga 元数据：同步 1 部', level: 'success' });
    expect(s.events.some(event => event.type === 'library' && event.job.kind === 'komga' && event.job.running)).toBe(true);

    // retry: everything but manual choices runs again
    await s.metadata.matchFolder(nana, { subject: '5297' });
    s.metadata.startMatchJob(s.targetId, true);
    await until(() => !s.jobs.busy);
    expect(s.jobs.current()).toMatchObject({ total: 1 });
    expect(s.state(nana).bangumi).toMatchObject({ state: 'matched', source: 'manual' });
    expect(s.state(grand).bangumi).toMatchObject({ state: 'matched', source: 'auto' });
  });
});

describe('Bangumi source: online API, offline archive, proxy', () => {
  const dump = sampleDump(mkdtempSync(join(root, 'dump-')));
  const github = startFakeGithub(dump);
  afterAll(() => github.stop());
  beforeEach(() => { github.state.requests.length = 0; github.state.proxies.length = 0; github.serve(dump); });
  /** Attempts to reach bgm.tv (each one costs a timeout on a network that blocks it). */
  let bangumiAttempts = 0;
  const counted = (next: typeof fetch) => ((input: string | URL | Request, init?: BunFetchRequestInit) => {
    if (BANGUMI_HOSTS.test(new URL(input instanceof Request ? input.url : String(input)).hostname)) bangumiAttempts++;
    return next(input, init);
  }) as typeof fetch;
  /** bgm.tv blocked (poisoned DNS / reset), GitHub reachable: the situation on the NAS. */
  const blockedSetup = () => setup({}, next => github.route(counted(blocked(BANGUMI_HOSTS, next))));
  const archive = (s: ReturnType<typeof setup>) => s.metadata.settings().bangumi.archive;
  const downloads = () => github.state.requests.filter(request => request.startsWith('/assets/')).length;
  const failure = (work: Promise<unknown>) => work.then(() => new Error('no error'), (reason: Error) => reason);

  test('bgm.tv blocked: the offline data is fetched by itself (once), then search and matching use it', async () => {
    const s = blockedSetup();
    s.configure();
    const error = await failure(s.metadata.searchBangumi('NANA'));
    expect(error.message).toMatch(/^Bangumi 在当前网络无法直接访问，正在下载离线数据（Bangumi Archive.*），完成后自动继续$/);
    // (Bun's toMatchObject replaces matched fields with the matcher, so the raw value is checked first.)
    const online = s.metadata.settings().bangumi.online;
    expect(online.error).not.toContain('Unable to connect');
    expect(online).toMatchObject({ reachable: false, error: expect.stringContaining('无法访问 Bangumi（连接被拒绝）') });
    await until(() => archive(s).state === 'ready');
    expect(archive(s)).toMatchObject({ state: 'ready', dump: dump.name, dumpDate: '2026-09-22T21:03:41Z', subjects: 10, progress: null, error: null });
    expect(downloads()).toBe(1);
    expect(existsSync(join(s.dataDir, 'bangumi', dump.name))).toBe(false);
    expect(existsSync(join(s.dataDir, 'bangumi', 'archive.db'))).toBe(true);
    expect(s.activity.list(1)[0]).toMatchObject({ title: 'Bangumi 离线数据已更新：10 部书籍条目', detail: dump.name });
    const states = s.events.flatMap(event => event.type === 'bangumi-archive' ? [event.archive.state] : []);
    expect(states).toContain('importing');
    expect(states.at(-1)).toBe('ready');

    // Known to be blocked: later actions go straight to the archive without trying bgm.tv again.
    const attempts = bangumiAttempts;
    expect((await s.metadata.searchBangumi('NANA')).slice(0, 2)).toMatchObject([{ id: 606428, cover: null }, { id: 5297, volumes: 21, authors: ['矢沢あい'] }]);
    const folder = s.folder('/NANA', { books: 21 });
    await s.metadata.matchFolder(folder, { subject: 'https://bgm.tv/subject/5297' });
    expect(s.state(folder).bangumi).toMatchObject({ state: 'matched', source: 'manual', subject: { id: 5297, cover: null } });
    expect(bangumiAttempts).toBe(attempts);
    expect(s.bgm.calls).toEqual([]);
  });

  test('a match job stopped for lack of data restarts by itself once the offline data is ready', async () => {
    const s = blockedSetup();
    s.configure();
    const comicId = s.comic('nana01', 'NANA', ['矢澤愛'], Array.from({ length: 21 }, (_, index): ItemSpec => ['volume', `卷 ${index + 1}`, index + 1]), '完結');
    const folder = s.folder('/NANA', { books: 21, comicId });
    s.metadata.startMatchJob(s.targetId, false);
    await until(() => s.state(folder).bangumi.state !== 'none');
    await until(() => !s.jobs.busy);
    // The first run's end is read from its event: polling can miss the short gap before the restart.
    const ended = s.events.flatMap(event => event.type === 'library' && !event.job.running ? [event.job] : []);
    expect(ended[0]!.error).toContain('Bangumi 在当前网络无法直接访问');
    expect(s.jobs.current()).toMatchObject({ kind: 'bangumi', error: null, done: 1, total: 1 });
    expect(s.state(folder).bangumi).toMatchObject({ state: 'matched', source: 'auto', subject: { id: 5297 } });
  });

  test('forced sources: "online" explains the blocked network, "archive" never asks bgm.tv', async () => {
    const s = blockedSetup();
    s.configure({ bangumi: { source: 'online' } });
    const error = await failure(s.metadata.searchBangumi('NANA'));
    expect(error.message).toBe('无法访问 Bangumi（连接被拒绝）：当前网络可能屏蔽了 bgm.tv。可以在设置中填写代理，或改用离线数据（Bangumi Archive）');
    expect(archive(s).state).toBe('none');
    expect(downloads()).toBe(0);

    const direct = setup({}, next => github.route(next));
    direct.configure({ bangumi: { source: 'archive' } });
    await until(() => archive(direct).state === 'ready');
    expect((await direct.metadata.searchBangumi('葬送的芙莉蓮'))[0]).toMatchObject({ id: 305429, cover: null });
    expect(direct.bgm.calls).toEqual([]);
  });

  test('a failed download is reported and not retried automatically for a while', async () => {
    const s = setup({}, next => blocked(GITHUB_HOSTS, blocked(BANGUMI_HOSTS, next)));
    s.configure();
    expect((await failure(s.metadata.searchBangumi('NANA'))).message).toContain('正在下载离线数据');
    await until(() => archive(s).state === 'error');
    expect(archive(s).error).toContain('无法访问 GitHub（连接被拒绝）');
    expect(s.activity.list(1)[0]).toMatchObject({ title: 'Bangumi 离线数据更新失败', level: 'warning' });
    expect((await failure(s.metadata.searchBangumi('NANA'))).message).toMatch(/^Bangumi 在当前网络无法直接访问，离线数据下载失败：无法访问 GitHub/);
    expect(archive(s).state).toBe('error');
  });

  test('updateArchive: one run at a time; an imported dump is only fetched again when forced; newer dumps are picked up', async () => {
    const s = setup({}, next => github.route(next));
    expect(s.metadata.updateArchive(false).state).toBe('downloading');
    expect(s.metadata.updateArchive(true).state).toBe('downloading');
    await until(() => archive(s).state === 'ready');
    expect(downloads()).toBe(1);
    const checked = archive(s).checkedAt;
    await Bun.sleep(5);
    s.metadata.updateArchive(false);
    await until(() => archive(s).state === 'ready' && archive(s).checkedAt !== checked);
    expect(downloads()).toBe(1);
    s.metadata.updateArchive(true);
    await until(() => archive(s).state === 'ready' && downloads() === 2);

    // The scheduler looks for a newer weekly dump (at most daily) while the archive is in use.
    const newer = sampleDump(mkdtempSync(join(root, 'dump-')), 'dump-2026-09-29.210341Z.zip');
    github.serve(newer);
    s.configure({ bangumi: { source: 'archive' } });
    await s.metadata.tick();
    expect(downloads()).toBe(2);
    s.db.run("UPDATE settings SET value = json_set(value, '$.checkedAt', '2026-01-01T00:00:00.000Z') WHERE key = 'metadata.archive'");
    await s.metadata.tick();
    await until(() => archive(s).state === 'ready' && archive(s).dump === newer.name);
    expect(existsSync(join(s.dataDir, 'bangumi', dump.name))).toBe(false);
  });

  test('proxy (设置 → 网络代理): validated, used for Bangumi and GitHub but never the LAN; tests check a draft or the saved one', async () => {
    expect(() => proxyUrl('socks5://127.0.0.1:1080')).toThrow('SOCKS');
    expect(() => proxyUrl('http://user:pw@127.0.0.1:7890')).toThrow('账号密码');
    expect(() => proxyUrl('http://127.0.0.1:7890/x')).toThrow('主机和端口');
    expect(proxyUrl(' 192.168.1.2:7890/ ')).toBe('http://192.168.1.2:7890');
    expect(['localhost', 'nas', '192.168.1.10', '10.0.0.8', '172.20.0.2', 'nas.home.arpa', 'komga.local', '[::1]'].filter(host => !isLocalHost(host))).toEqual([]);
    expect(['api.bgm.tv', 'github.com', '8.8.8.8', '172.32.0.1'].filter(isLocalHost)).toEqual([]);
    const s = setup({}, next => github.route(next));
    s.settings.patch({ proxy: 'http://192.168.1.2:7890' });
    expect(await s.metadata.testOnline()).toEqual({ reachable: true, message: '通过代理 http://192.168.1.2:7890 可以访问 Bangumi API' });
    expect(await s.metadata.testOnline('')).toEqual({ reachable: true, message: '可以直接访问 Bangumi API' });
    expect(await s.metadata.testOnline('ftp://x')).toMatchObject({ reachable: false, message: expect.stringContaining('http://') });
    expect(s.metadata.settings().bangumi.online).toMatchObject({ reachable: true, error: null });
    await s.metadata.searchBangumi('NANA');
    s.metadata.updateArchive(false);
    await until(() => archive(s).state === 'ready');
    expect([...new Set(s.bgm.proxies)]).toEqual(['http://192.168.1.2:7890']);
    expect([...new Set(github.state.proxies)]).toEqual(['http://192.168.1.2:7890']);
    const checks = await s.metadata.testNetwork('192.168.1.2:7890', null);
    expect(checks.map(check => [check.name, check.ok])).toEqual([['Bangumi', true], ['GitHub（离线数据）', true]]);
    s.metadata.networkChanged();
    expect(s.metadata.settings().bangumi.online.reachable).toBeNull();

    const cut = blockedSetup();
    expect(await cut.metadata.testOnline()).toMatchObject({ reachable: false, message: expect.stringContaining('当前网络可能屏蔽了 bgm.tv') });
  });

  test('a proxy saved as a Bangumi setting (before 网络代理) becomes the app-wide proxy on upgrade', () => {
    const s = setup();
    s.db.run("INSERT INTO settings (key, value) VALUES ('metadata', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [JSON.stringify({ enabled: true, bangumi: { source: 'archive', proxy: 'http://10.0.0.2:7890' } })]);
    const metadata = s.reopen();
    expect(s.settings.get().proxy).toBe('http://10.0.0.2:7890');
    expect(metadata.settings()).toMatchObject({ enabled: true, bangumi: { source: 'archive' } });
    // Moved, not copied: clearing the app-wide proxy later must stick.
    s.settings.patch({ proxy: '' });
    s.reopen();
    expect(s.settings.get().proxy).toBe('');
  });
});

describe('AI', () => {
  const fakeAi = startFakeAi();
  afterAll(() => fakeAi.stop());
  const aiOf = (s: ReturnType<typeof setup>) => {
    const ai = new AiService({ db: s.db, sealer: createSealer(Buffer.alloc(32, 6)), settings: s.settings });
    ai.patch({ baseUrl: `${fakeAi.origin}/v1`, model: 'fake-chat', apiKey: 'sk-test' });
    return ai;
  };

  test('Bangumi candidates: a confident AI pick is matched, with the reason kept', async () => {
    const s = setup();
    s.configure();
    const nana = s.folder('/NANA', { books: 21 });
    await s.metadata.matchFolder(nana, { auto: true });
    expect(s.state(nana).bangumi.state).toBe('suggested');
    const first = s.state(nana).bangumi.candidates[0]!.id;
    fakeAi.state.reply = () => ({ text: '{"pick": 1, "confidence": 0.92, "reason": "系列条目，卷数对得上"}' });
    expect(s.metadata.startAiMatch(s.targetId, aiOf(s))).toMatchObject({ kind: 'ai', running: true });
    await until(() => !s.jobs.busy);
    expect(s.jobs.current()).toMatchObject({ kind: 'ai', error: null });
    expect(s.state(nana).bangumi).toMatchObject({ state: 'matched', source: 'ai', subject: { id: first }, ai: { pick: String(first), confidence: 0.92, reason: '系列条目，卷数对得上' } });
    expect(s.activity.list(1)[0]).toMatchObject({ title: 'AI 判定 Bangumi：匹配 1 部，仍需确认 0 部' });
  });

  test('polish: tidied versions wait for review, and only accepted ones are written to Komga', async () => {
    const s = setup();
    s.configure({ options: { tagLimit: 5 } });
    const folderId = grandBlue(s);
    await s.metadata.matchFolder(folderId, { subject: '118165' });
    await s.metadata.syncFolder(folderId);
    const polished = { summary: '北原伊织升入大学，寄住在叔叔的潜水店里……\n\n一群大学生的潜水与酒会日常。', genres: ['搞笑', '运动'], tags: ['潜水', '大学', '搞笑', '青春', '友情', '多余的'] };
    fakeAi.state.reply = () => ({ text: JSON.stringify(polished) });
    s.metadata.startAiPolish(s.targetId, false, aiOf(s));
    await until(() => !s.jobs.busy);
    const [item] = s.metadata.polishList(s.targetId);
    expect(item).toMatchObject({ folderId, status: 'pending', polished: { ...polished, tags: polished.tags.slice(0, 5) } });
    expect(item!.original.summary.length).toBeGreaterThan(0);
    expect(s.state(folderId).polish).toBe('pending');
    expect(s.row(folderId).dirty).toBe(0);

    const written = komga.state.patches.length;
    expect(s.metadata.decidePolish([folderId], true)).toEqual({ updated: 1 });
    expect(s.row(folderId).dirty).toBe(1);
    await s.metadata.syncFolder(folderId);
    const series = komga.state.patches.slice(written).find(patch => patch.kind === 'series')!;
    expect(series.body).toMatchObject({ summary: polished.summary, genres: ['搞笑', '运动'], tags: polished.tags.slice(0, 5) });
    // Already tidied for this subject: nothing to do unless asked for all.
    s.metadata.startAiPolish(s.targetId, false, aiOf(s));
    await until(() => !s.jobs.busy);
    expect(s.jobs.current()).toMatchObject({ total: 0 });
    // Dropping an accepted version writes the Bangumi one back.
    s.metadata.decidePolish([folderId], false);
    expect(s.row(folderId).dirty).toBe(1);
  });
});
