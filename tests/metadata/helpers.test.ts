import { describe, expect, test } from 'bun:test';
import type { MetadataOptions } from '@shared/model';
import { SlidingWindow, subjectIdOf, traditionalEdition, type BgmPerson, type BgmRelated, type BgmSubject } from '../../server/metadata/bangumi';
import { below, komgaUrl, plainPath } from '../../server/metadata/komga';
import { linkedSubject } from '../../server/metadata/service';
import { bookAuthors, bookPatch, changes, isbn13, isoDate, itemNumber, languageOf, seriesPatch, volumeMap } from '../../server/metadata/sync';
import { bookNumber, fold, isVolumeName, mainTitle, titleParts, titleSimilarity, volumeBase } from '../../server/metadata/text';
import { fakeBangumi } from './fakes';

const fx = fakeBangumi().data;
const grandBlue = fx['subject:118165'] as BgmSubject;
const volumeOne = fx['subject:118167'] as BgmSubject;
const persons = fx['persons:118165'] as BgmPerson[];
const related = fx['related:118165'] as BgmRelated[];
const OPTIONS: MetadataOptions = { titleLanguage: 'cn', books: true, posters: 'off', lock: true, autoSync: true, tagLimit: 10 };

describe('text folding and similarity', () => {
  test('Traditional and Japanese forms fold to the same key', () => {
    expect(fold('碧藍之海')).toBe(fold('碧蓝之海'));
    expect(fold('葬送的芙莉蓮')).toBe('葬送的芙莉莲');
    expect(fold('矢澤愛')).toBe(fold('矢泽爱'));
    expect(fold('矢沢')).toBe(fold('矢澤'));
    expect(fold('ＧＲＡＮＤ　BLUE・碧藍之海')).toBe('grandblue碧蓝之海');
  });
  test('title similarity', () => {
    expect(titleSimilarity('GRAND BLUE 碧藍之海', 'GRANDBLUE 碧蓝之海')).toBe(1);
    expect(titleSimilarity('碧藍之海', 'GRANDBLUE 碧蓝之海')).toBeLessThan(0.8);
    expect(titleSimilarity('葬送的芙莉蓮', '葬送的芙莉莲 画集 Vol.1')).toBeLessThan(0.8);
    expect(mainTitle('NANA -ナナ-')).toBe('NANA');
    expect(mainTitle('NANA ～世上的另一个我～')).toBe('NANA');
    expect(mainTitle('ぐらんぶる')).toBeNull();
    expect(titleParts('GRAND BLUE 碧藍之海')).toEqual(['GRAND BLUE', '碧藍之海']);
    expect(titleParts('SPY×FAMILY 間諜家家酒')).toEqual(['SPY×FAMILY', '間諜家家酒']);
    expect(titleParts('葬送的芙莉蓮')).toEqual([]);
    expect(titleParts('A 中文 B')).toEqual([]);
  });
  test('single-volume subject names', () => {
    expect(isVolumeName('NANA -ナナ- (11)')).toBe(true);
    expect(isVolumeName('GRAND SLAM (1)')).toBe(true);
    expect(isVolumeName('ぐらんぶる')).toBe(false);
    expect(volumeBase('NANA -ナナ- (11)')).toBe('NANA -ナナ-');
  });
});

describe('volume numbers', () => {
  const cases: [string, string | null, ReturnType<typeof bookNumber>['kind'], string | null][] = [
    ['GRAND BLUE 碧藍之海-卷 01.epub', 'GRAND BLUE 碧藍之海', 'volume', '1'],
    ['[Kmoe][葬送的芙莉蓮]卷01.epub', null, 'volume', '1'],
    ['20世紀少年-卷 03', '20世紀少年', 'volume', '3'],
    ['渣女沒渣報-話 005-015', '渣女沒渣報', 'chapter', null],
    ['進擊的巨人 第01-02卷', null, 'volume', '1-2'],
    ['ONE PIECE Vol.12', null, 'volume', '12'],
    ['進撃の巨人 v05', null, 'volume', '5'],
    ['ぐらんぶる (3)', null, 'volume', '3'],
    ['MIX 01', null, 'volume', '1'],
    ['DVD付き 2', null, 'volume', '2'],
    ['卷 10.5', null, 'volume', '10.5'],
    ['葬送的芙莉蓮-番外 冒險者指南', '葬送的芙莉蓮', 'extra', null],
    ['Title (2019)', null, 'unknown', null],
    ['進擊的巨人 Before the fall', null, 'unknown', null],
  ];
  for (const [name, title, kind, label] of cases) {
    test(name, () => {
      const parsed = bookNumber(name, title);
      expect(parsed.kind).toBe(kind);
      expect(parsed.label).toBe(label);
    });
  }
  test('Kmoe items: 卷 NN, else the order; 話 packs are chapters', () => {
    expect(itemNumber({ type: 'volume', name: '卷 07', sort_order: 9 })).toMatchObject({ kind: 'volume', number: 7 });
    expect(itemNumber({ type: 'volume', name: '上卷', sort_order: 1 })).toMatchObject({ kind: 'volume', number: 1 });
    expect(itemNumber({ type: 'serial', name: '話 005-015', sort_order: 5 })).toMatchObject({ kind: 'chapter', number: null });
    expect(itemNumber({ type: 'extra', name: '番外 01', sort_order: 1 })).toMatchObject({ kind: 'extra', number: null });
  });
  test('Bangumi volumes from 单行本 relations', () => {
    const map = volumeMap(related);
    expect(map.size).toBe(27);
    expect(map.get(1)?.id).toBe(118167);
    expect(map.get(2)?.id).toBe(118166);
    expect(map.get(27)?.name).toBe('ぐらんぶる (27)');
    const unnumbered = volumeMap([{ id: 1, name: 'X 上', relation: '单行本' }, { id: 2, name: 'X 下', relation: '单行本' }, { id: 3, name: 'X', relation: '动画' }]);
    expect([...unnumbered].map(([number, entry]) => [number, entry.id])).toEqual([[1, 1], [2, 2]]);
    const special = volumeMap([{ id: 5, name: 'X (3) 特装版', relation: '单行本' }, { id: 6, name: 'X (3)', relation: '单行本' }]);
    expect(special.get(3)?.id).toBe(6);
  });
});

describe('links, paths and values', () => {
  test('subject ids from ids and links', () => {
    expect(subjectIdOf('118165')).toBe(118165);
    expect(subjectIdOf('https://bgm.tv/subject/118165')).toBe(118165);
    expect(subjectIdOf('bangumi.tv/subject/305429/')).toBe(305429);
    expect(subjectIdOf('https://chii.in/subject/5297?foo=1')).toBe(5297);
    expect(subjectIdOf('https://notbgm.tv/subject/1')).toBeNull();
    expect(subjectIdOf('ぐらんぶる')).toBeNull();
  });
  test('Komga series links: cbl first, adaptation links ignored', () => {
    expect(linkedSubject([{ label: 'Bangumi', url: 'https://bgm.tv/subject/1' }, { label: 'cbl', url: 'https://bangumi.tv/subject/2' }])).toBe(2);
    expect(linkedSubject([{ label: '动画：ぐらんぶる', url: 'https://bgm.tv/subject/235130' }, { label: 'MAL', url: 'https://myanimelist.net/manga/1' }])).toBeNull();
    expect(linkedSubject([{ label: 'bgm', url: 'https://bgm.tv/subject/118165' }])).toBe(118165);
  });
  test('Komga paths', () => {
    expect(plainPath('/data/GRAND BLUE 碧藍之海/')).toBe('/data/GRAND BLUE 碧藍之海');
    expect(plainPath('file:///data/GRAND%20BLUE%20%E7%A2%A7')).toBe('/data/GRAND BLUE 碧');
    expect(plainPath('/data/100%AB')).toBe('/data/100%AB');
    expect(plainPath('/data/グ'.normalize('NFD'))).toBe('/data/グ');
    expect(below('/data', '/data/JOJO的奇妙冒險/JOJO Lands')).toBe('/JOJO的奇妙冒險/JOJO Lands');
    expect(below('/data/', '/data')).toBe('/');
    expect(below('/data', '/database/x')).toBeNull();
    expect(komgaUrl(' 192.168.1.10:25600/ ')).toBe('http://192.168.1.10:25600');
    expect(komgaUrl('https://nas.example/komga/')).toBe('https://nas.example/komga');
    expect(() => komgaUrl('http://admin:pw@nas:7799')).toThrow('账号密码');
    expect(() => komgaUrl('ftp://nas')).toThrow('http');
  });
  test('ISBN and dates', () => {
    expect(isbn13('978-986-462-011-1')).toBe('9789864620111');
    expect(isbn13('9789864620112')).toBeNull();
    expect(isbn13('4-06-387990-9')).toBe('9784063879902');
    expect(isoDate('2014年11月7日')).toBe('2014-11-07');
    expect(isoDate('2015-10-14')).toBe('2015-10-14');
    expect(isoDate('2014-02-30')).toBeNull();
    expect(isoDate('1999年')).toBeNull();
  });
  test('Traditional Chinese edition of a volume', () => {
    expect(traditionalEdition(volumeOne)).toMatchObject({ 出版社: '東立出版社', ISBN: '9789864620111', 发售日: '2015-10-14' });
    expect(languageOf({ language: '繁體' })).toBe('zh-Hant');
    expect(languageOf({ language: null })).toBe('zh-Hant');
    expect(languageOf({ language: '日文' })).toBeNull();
    expect(languageOf(null)).toBeNull();
  });
});

test('sliding window queues calls instead of dropping them', async () => {
  const window = new SlidingWindow(2, 150);
  const started: number[] = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => window.take().then(() => started.push(Date.now() - t0))));
  expect(started).toHaveLength(5);
  expect(started[1]!).toBeLessThan(100);
  expect(started[2]!).toBeGreaterThanOrEqual(140);
  expect(started[4]!).toBeGreaterThanOrEqual(290);
});

describe('series PATCH body', () => {
  const comic = { title: 'GRAND BLUE 碧藍之海', status: '連載', language: '繁體', volumes: 25 };
  const current = {
    links: [{ label: 'Bangumi', url: 'https://bgm.tv/subject/1' }, { label: 'cbl', url: 'https://bgm.tv/subject/118165' }, { label: 'MAL', url: 'https://myanimelist.net/manga/1' }],
    alternateTitles: [{ label: 'Original', title: 'ぐらんぶる' }, { label: '别名', title: '旧别名' }],
  };
  const body = seriesPatch({ subject: grandBlue, persons, related, comic, kmoeUrl: 'https://kzo.moe/c/abc123.htm', current, options: OPTIONS });

  test('fields from Bangumi and Kmoe, each locked', () => {
    expect(body).toMatchObject({
      title: 'GRANDBLUE 碧蓝之海', titleSort: 'GRANDBLUE 碧蓝之海', status: 'ONGOING', publisher: '東立出版社', readingDirection: 'RIGHT_TO_LEFT',
      language: 'zh-Hant', genres: ['青年', '搞笑'],
    });
    expect(body.summary).toStartWith('以上大学为契机');
    for (const key of Object.keys(body).filter(key => !key.endsWith('Lock'))) expect(body[`${key}Lock`]).toBe(true);
  });
  test('tags skip genres, years, platform words, the title and people', () => {
    const tags = body.tags as string[];
    expect(tags.length).toBeLessThanOrEqual(10);
    expect(tags).toContain('颜艺');
    expect(tags).toContain('潜水');
    for (const word of ['搞笑', '漫画', '井上堅二', '吉岡公威', '井上坚二', '講談社', '讲谈社', '2014', '日本', 'GRANDBLUE', '连载中', '系列', 'good!アフタヌーン']) {
      expect(tags).not.toContain(word);
    }
  });
  test('links and alternate titles are merged, old Bangumi/cbl links replaced', () => {
    expect(body.links).toEqual([
      { label: 'MAL', url: 'https://myanimelist.net/manga/1' }, { label: 'Bangumi', url: 'https://bgm.tv/subject/118165' }, { label: 'Kmoe', url: 'https://kzo.moe/c/abc123.htm' },
    ]);
    expect(body.alternateTitles).toEqual([
      { label: 'Original', title: 'ぐらんぶる' }, { label: '别名', title: 'Grand Blue' }, { label: 'Kmoe', title: 'GRAND BLUE 碧藍之海' },
    ]);
  });
  test('nothing is blanked when Bangumi lacks it; no locks when locking is off', () => {
    const bare: BgmSubject = { id: 9, name: 'Bare', name_cn: '', platform: '小说', infobox: [], tags: [], meta_tags: [] };
    const plain = seriesPatch({ subject: bare, persons: [], related: [], comic: null, kmoeUrl: null, current: {}, options: { ...OPTIONS, lock: false, titleLanguage: 'original' } });
    expect(plain).toEqual({ title: 'Bare', titleSort: 'Bare', links: [{ label: 'Bangumi', url: 'https://bgm.tv/subject/9' }] });
  });
  test("an author's Chinese-name tag is not a tag", () => {
    const nana = fx['subject:5297'] as BgmSubject;
    const tags = seriesPatch({ subject: nana, persons: fx['persons:5297'] as BgmPerson[], related: [], comic: null, kmoeUrl: null, current: {}, options: OPTIONS }).tags as string[];
    expect(tags.slice(0, 3)).toEqual(['恋爱', '坑', '爱情']);
    for (const word of ['矢泽爱', '矢沢あい', 'nana', '集英社', 'Cookie', '少女漫画', '1999']) expect(tags).not.toContain(word);
  });

  test('ended Kmoe comics give totalBookCount; R18 gives ageRating 18', () => {
    const ended = seriesPatch({ subject: { ...grandBlue, nsfw: true }, persons, related, comic: { ...comic, status: '完結' }, kmoeUrl: null, current: {}, options: OPTIONS });
    expect(ended).toMatchObject({ status: 'ENDED', totalBookCount: 25, ageRating: 18 });
    expect(body.totalBookCount).toBeUndefined();
  });
  test('changes() only sends what differs', () => {
    const stored = { ...body, tags: (body.tags as string[]).map(tag => tag.toLowerCase()) };
    expect(changes(body, stored)).toBeNull();
    expect(changes(body, { ...stored, title: 'Old', titleLock: true })).toEqual({ title: 'GRANDBLUE 碧蓝之海', titleLock: true });
    expect(changes(body, { ...stored, summaryLock: false })).toEqual({ summary: body.summary, summaryLock: true });
  });
});

test('book PATCH body: Taiwan edition date/ISBN, Kmoe title, authors, volume link', () => {
  const authors = bookAuthors(persons, grandBlue);
  expect(authors).toEqual([{ name: '吉岡公威', role: 'penciller' }, { name: '井上堅二', role: 'writer' }]);
  const body = bookPatch({
    number: bookNumber('卷 01'), itemName: '卷 01', volume: volumeOne, language: 'zh-Hant', authors,
    current: { links: [{ label: 'Bangumi', url: 'https://bgm.tv/subject/1' }] }, options: OPTIONS,
  });
  expect(body).toMatchObject({
    number: '1', numberSort: 1, title: '卷 01', releaseDate: '2015-10-14', isbn: '9789864620111', authors,
    links: [{ label: 'Bangumi', url: 'https://bgm.tv/subject/118167' }], numberLock: true, isbnLock: true,
  });
  expect(body.summary).toStartWith('海沿いの街');
  const japanese = bookPatch({ number: bookNumber('卷 01'), itemName: null, volume: volumeOne, language: null, authors: [], current: {}, options: { ...OPTIONS, lock: false } });
  expect(japanese).toMatchObject({ releaseDate: '2014-11-07', isbn: '9784063879902' });
  expect(japanese.title).toBeUndefined();
  expect(japanese.authors).toBeUndefined();
  const chapter = bookPatch({ number: bookNumber('話 005-015'), itemName: '話 005-015', volume: null, language: 'zh-Hant', authors, current: {}, options: OPTIONS });
  expect(chapter).toEqual({ title: '話 005-015', authors, titleLock: true, authorsLock: true });
});
