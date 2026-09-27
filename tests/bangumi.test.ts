import { expect, test } from 'bun:test';
import { fetchCollections } from '../server/services/sources';

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
