import { expect, test } from 'bun:test';
import { now, openDatabase } from '../server/db';
import { EventHub } from '../server/events';
import { Notifier } from '../server/notify';
import { ActivityLog } from '../server/services/activity';
import { fetchCollections, SourceService } from '../server/services/sources';

test('Bangumi collections: paging, type codes and title fallback', async () => {
  const calls: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}?type=${url.searchParams.get('type')}&offset=${url.searchParams.get('offset')}`);
    if (url.pathname.includes('nobody')) return new Response('{}', { status: 404 });
    const offset = Number(url.searchParams.get('offset'));
    const data = Array.from({ length: offset === 0 ? 50 : 3 }, (_, i) => ({
      subject_id: offset + i, type: Number(url.searchParams.get('type')),
      subject: { id: offset + i, name: `Original ${offset + i}`, name_cn: i === 0 ? '' : `中文 ${offset + i}`, images: { common: `https://lain.bgm.tv/${offset + i}.jpg` } },
    }));
    return Response.json({ data, total: 53, limit: 50, offset });
  }) as typeof fetch;

  const entries = await fetchCollections('reader', ['wish'], fake);
  expect(calls).toEqual(['/v0/users/reader/collections?type=1&offset=0', '/v0/users/reader/collections?type=1&offset=50']);
  expect(entries).toHaveLength(53);
  expect(entries[0]).toMatchObject({ externalId: '0', title: 'Original 0', originalTitle: null, status: 'wish', url: 'https://bgm.tv/subject/0' });
  expect(entries[1]).toMatchObject({ title: '中文 1', originalTitle: 'Original 1', cover: 'https://lain.bgm.tv/1.jpg' });
  expect(fetchCollections('nobody', ['doing'], fake)).rejects.toThrow('找不到用户');
});

test('a reading list: a sync keeps matched entries that left the list, and due syncs never overlap', async () => {
  let ids = [1, 2, 3];
  let calls = 0;
  let release = () => {};
  let gate: Promise<void> | null = null;
  const fake = (async (input: string | URL | Request) => {
    calls++;
    await gate;
    if (String(input).includes('/users/gone/')) return new Response('{}', { status: 404 });
    return Response.json({ data: ids.map(id => ({ subject_id: id, type: 1, subject: { id, name: `Manga ${id}`, name_cn: `漫画 ${id}` } })), total: ids.length });
  }) as typeof fetch;
  const db = openDatabase('', ':memory:');
  const hub = new EventHub();
  const sources = new SourceService(db, hub, new ActivityLog(db, hub, new Notifier(() => [])), fake);
  const byId = (sourceId: number) => Object.fromEntries(sources.items(sourceId).map(item => [item.externalId, item]));

  const source = await sources.create({ name: '想读', username: 'reader', types: ['wish'], enabled: true, intervalHours: 24 });
  expect(source).toMatchObject({ itemCount: 3, pendingCount: 3, error: null });
  db.run("INSERT INTO comics (key, title, created_at, updated_at) VALUES ('k1', '漫画一', ?, ?)", [now(), now()]);
  expect(sources.setMatch(byId(source.id)['1']!.id, 'matched', 'k1').match).toEqual({ state: 'matched', comicKey: 'k1', comicTitle: '漫画一' });
  sources.setMatch(byId(source.id)['2']!.id, 'dismissed');
  expect(() => sources.setMatch(9999, 'dismissed')).toThrow('找不到该书单条目');

  // 1 (matched) and 2 (dismissed) left the list on Bangumi, 4 joined it.
  ids = [3, 4];
  expect(await sources.sync(source.id)).toMatchObject({ itemCount: 3, pendingCount: 2 });
  expect(Object.keys(byId(source.id)).sort()).toEqual(['1', '3', '4']);
  expect(db.query('SELECT title FROM activity').all()).toEqual([{ title: '书单「想读」新增 1 部' }]);

  // Not due again for 24 hours; once due, a second call while the first waits on Bangumi joins it.
  calls = 0;
  await sources.syncDue();
  expect(calls).toBe(0);
  db.run('UPDATE sources SET last_sync_at = NULL');
  gate = new Promise(resolve => { release = resolve; });
  const first = sources.syncDue();
  expect(sources.syncDue()).toBe(first);
  release();
  await first;
  expect(calls).toBe(1);

  sources.update(source.id, { username: 'gone' });
  await expect(sources.sync(source.id)).rejects.toThrow('找不到用户「gone」');
  expect(sources.get(source.id).error).toContain('找不到用户');
});
