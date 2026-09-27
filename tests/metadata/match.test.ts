// Matcher decisions against recorded Bangumi search results (GRAND BLUE, 芙莉蓮, and the NANA / NaNa trap).
import { beforeAll, describe, expect, test } from 'bun:test';
import { openDatabase } from '../../server/db';
import { BangumiClient, bangumiLimiter, type BgmSubject } from '../../server/metadata/bangumi';
import { authorEvidence, findSubject, scoreSubject } from '../../server/metadata/match';
import { fakeBangumi } from './fakes';

beforeAll(() => { bangumiLimiter.max = 10_000; BangumiClient.retryDelays = [1, 1]; });

function client() {
  const bgm = fakeBangumi();
  return { bgm, client: new BangumiClient({ db: openDatabase('', ':memory:'), fetch: bgm.fetch }) };
}
const nanaHits = () => fakeBangumi().data['search:NANA'] as BgmSubject[];

describe('automatic matching', () => {
  test('GRAND BLUE with Kmoe authors: one search, matched', async () => {
    const { bgm, client: bangumi } = client();
    const outcome = await findSubject(bangumi, { keywords: ['GRAND BLUE 碧藍之海'], authors: ['井上堅二', '吉岡公威'], localVolumes: 25 });
    expect(outcome.state).toBe('matched');
    expect(outcome.subject?.id).toBe(118165);
    expect(outcome.candidates[0]).toMatchObject({ id: 118165, score: 1, series: true, platform: '漫画', url: 'https://bgm.tv/subject/118165' });
    expect(bgm.calls).toEqual(['search:GRAND BLUE 碧藍之海']);
  });

  test('GRAND BLUE from the folder name alone: matched by a clear margin', async () => {
    const outcome = await findSubject(client().client, { keywords: ['GRAND BLUE 碧藍之海'], authors: [], localVolumes: 25 });
    expect(outcome.state).toBe('matched');
    expect(outcome.subject?.id).toBe(118165);
  });

  test('the Chinese half of a Latin + Chinese title is enough: 碧藍之海 → GRANDBLUE 碧蓝之海', async () => {
    const outcome = await findSubject(client().client, { keywords: ['碧藍之海'], authors: [], localVolumes: 25 });
    expect(outcome.state).toBe('matched');
    expect(outcome.subject?.id).toBe(118165);
  });

  test('a fragment of a title only suggests', async () => {
    const bgm = fakeBangumi({ 'search:碧藍': fakeBangumi().data['search:碧藍之海'] });
    const outcome = await findSubject(new BangumiClient({ db: openDatabase('', ':memory:'), fetch: bgm.fetch }), { keywords: ['碧藍'], authors: [], localVolumes: 25 });
    expect(outcome.state).toBe('suggested');
    expect(outcome.candidates.map(candidate => candidate.id)).toContain(118165);
  });

  test('葬送的芙莉蓮: series wins over the artbook and fan book', async () => {
    const outcome = await findSubject(client().client, { keywords: ['葬送的芙莉蓮'], authors: ['山田鐘人', 'アベツカサ'], localVolumes: 14 });
    expect(outcome.state).toBe('matched');
    expect(outcome.subject?.id).toBe(305429);
    const ids = outcome.candidates.map(candidate => candidate.id);
    for (const id of [463534, 468458]) if (ids.includes(id)) expect(ids.indexOf(id)).toBeGreaterThan(0);
  });

  test('NANA by 矢澤愛: volume hits resolve to the series, the unrelated NaNa is not taken', async () => {
    const { bgm, client: bangumi } = client();
    const outcome = await findSubject(bangumi, { keywords: ['NANA'], authors: ['矢澤愛'], localVolumes: 21 });
    expect(outcome.state).toBe('matched');
    expect(outcome.subject?.id).toBe(5297);
    expect(bgm.calls).toEqual(['search:NANA', 'related:5237', 'subject:5297']);
    const nana = outcome.candidates.find(candidate => candidate.id === 5297)!, other = outcome.candidates.find(candidate => candidate.id === 606428)!;
    expect(nana.score).toBeGreaterThan(other.score + 0.1);
    expect(nana).toMatchObject({ series: true, volumes: 21, authors: ['矢沢あい'] });
  });

  test('NANA without a Kmoe link: two plausible works, so only a suggestion', async () => {
    const outcome = await findSubject(client().client, { keywords: ['NANA'], authors: [], localVolumes: 21 });
    expect(outcome.state).toBe('suggested');
    expect(outcome.subject).toBeNull();
    expect(outcome.candidates.map(candidate => candidate.id).slice(0, 2).sort()).toEqual([5297, 606428]);
  });

  test('a single volume without a series entry is kept as a suggestion, never auto-matched', async () => {
    const bgm = fakeBangumi({ 'search:ORPHAN': [{ id: 9001, name: 'ORPHAN (1)', name_cn: '', series: false, platform: '漫画', infobox: [{ key: '作者', value: '某作者' }] }] });
    const bangumi = new BangumiClient({ db: openDatabase('', ':memory:'), fetch: bgm.fetch });
    const outcome = await findSubject(bangumi, { keywords: ['ORPHAN'], authors: ['某作者'], localVolumes: 1 });
    expect(outcome.state).toBe('suggested');
    expect(outcome.candidates[0]?.id).toBe(9001);
    expect(bgm.calls).toEqual(['search:ORPHAN', 'related:9001']);
  });

  test('nothing found', async () => {
    const outcome = await findSubject(client().client, { keywords: ['完全不存在的漫画'], authors: [], localVolumes: null });
    expect(outcome).toEqual({ state: 'unmatched', subject: null, candidates: [] });
  });

  test('searches and lookups are cached', async () => {
    const { bgm, client: bangumi } = client();
    await findSubject(bangumi, { keywords: ['NANA'], authors: ['矢澤愛'], localVolumes: 21 });
    await findSubject(bangumi, { keywords: ['NANA'], authors: ['矢澤愛'], localVolumes: 21 });
    expect(bgm.calls).toHaveLength(3);
  });
});

test('author evidence: tags carry Chinese names, surnames count, other authors do not', () => {
  const fx = fakeBangumi().data;
  const series = fx['subject:5297'] as BgmSubject;
  expect(authorEvidence(['矢澤愛'], series)).toBe('match');
  expect(authorEvidence(['矢澤愛'], { ...series, tags: [] })).toBe('partial');
  expect(authorEvidence(['矢澤愛'], nanaHits().find(hit => hit.id === 606428)!)).toBe('mismatch');
  expect(authorEvidence([], series)).toBe('unknown');
  expect(authorEvidence(['井上堅二,吉岡公威'], fx['subject:118165'] as BgmSubject)).toBe('match');
});

test('Bangumi client: User-Agent, token, retries on 503', async () => {
  let attempts = 0;
  const seen: Headers[] = [];
  const flaky = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return ++attempts < 2 ? new Response('busy', { status: 503 }) : Response.json({ id: 1, name: 'X' });
  }) as typeof fetch;
  const bangumi = new BangumiClient({ db: openDatabase('', ':memory:'), fetch: flaky, token: () => 'secret-token' });
  expect(await bangumi.subject(1)).toMatchObject({ id: 1 });
  expect(attempts).toBe(2);
  expect(seen[0]!.get('user-agent')).toMatch(/^kmoesync\/\d+\.\d+\.\d+ \(self-hosted; https:\/\/github\.com\/\)$/);
  expect(seen[0]!.get('authorization')).toBe('Bearer secret-token');
  const failing = new BangumiClient({ db: openDatabase('', ':memory:'), fetch: (async () => new Response('x', { status: 500 })) as unknown as typeof fetch });
  await expect(failing.subject(2)).rejects.toThrow('HTTP 500');
});

test('Taiwan titles pairing a Latin and a Chinese name match either half', () => {
  const subject = (name: string, nameCn: string, author: string): BgmSubject => ({ id: 1, name, name_cn: nameCn, platform: '漫画', series: true, infobox: [{ key: '作者', value: author }] });
  const onePiece = scoreSubject(subject('ONE PIECE', '航海王', '尾田栄一郎'), { keywords: ['ONE PIECE 航海王'], authors: ['尾田榮一郎'], localVolumes: 100 });
  expect(onePiece).toMatchObject({ author: 'match', title: 0.9, score: 1 });
  const blueLock = scoreSubject(subject('ブルーロック', '蓝色监狱', '金城宗幸'), { keywords: ['BLUE LOCK 藍色監獄'], authors: [], localVolumes: 30 });
  expect(blueLock).toMatchObject({ author: 'unknown', title: 0.9, score: 0.9 });
});
