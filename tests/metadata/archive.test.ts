// Offline Bangumi data: wiki parsing, importing a (synthetic) Bangumi Archive dump, API-shaped queries and search,
// matching against it, and the resumable, verified download from a fake GitHub.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveReader, importDump } from '../../server/metadata/archive';
import type { BgmSubject } from '../../server/metadata/bangumi';
import { downloadDump, downloadTiming, latestDump } from '../../server/metadata/dump';
import { findSubject } from '../../server/metadata/match';
import { parseWiki } from '../../server/metadata/wiki';
import { fakeBangumi, sampleDump, startFakeGithub, toWiki } from './fakes';

const root = mkdtempSync(join(tmpdir(), 'kmoesync-archive-'));
const dump = sampleDump(root);
const reader = new ArchiveReader(join(root, 'archive.db'));
const fx = fakeBangumi().data;
let subjects = 0;
const phases: number[] = [];

beforeAll(async () => {
  downloadTiming.retryDelays = [10, 10, 10];
  subjects = await importDump(dump.zip, join(root, 'archive.db'), { dump: dump.name, dumpDate: '2026-09-22T21:03:41Z', digest: `sha256:${dump.sha256}` },
    (done, total) => { phases.push(done / total); });
});
afterAll(() => { reader.close(); rmSync(root, { recursive: true, force: true }); });

describe('wiki parser', () => {
  test('fields, lists, named items, spacing and CRLF', () => {
    const wiki = '{{Infobox animanga/Manga\r\n|中文名= 葬送的芙莉莲\r\n| 别名 ={\r\n\r\n[葬送者芙莉莲]\r\n[ FRIEREN ]\r\n}\r\n|出版社=小学館\r\n|版本:东立版={\r\n[版本名|葬送的芙莉蓮]\r\n[出版社| 東立出版社 ]\r\n[]\r\n}\r\n|空=\r\n}}';
    expect(parseWiki(wiki)).toEqual([
      { key: '中文名', value: '葬送的芙莉莲' },
      { key: '别名', value: [{ v: '葬送者芙莉莲' }, { v: 'FRIEREN' }] },
      { key: '出版社', value: '小学館' },
      { key: '版本:东立版', value: [{ k: '版本名', v: '葬送的芙莉蓮' }, { k: '出版社', v: '東立出版社' }, { v: '' }] },
      { key: '空', value: '' },
    ]);
  });
  test('only the first "=" and "|" split; brackets inside values survive', () => {
    expect(parseWiki('{{Infobox\n|A= b = c\n|L={\n[k| v | w ]\n[x]]\n[a[b]\n}\n}}')).toEqual([
      { key: 'A', value: 'b = c' }, { key: 'L', value: [{ k: 'k', v: 'v | w' }, { v: 'x]' }, { v: 'a[b' }] },
    ]);
  });
  test('lenient with broken wiki: unclosed list, stray line, missing end, no infobox', () => {
    expect(parseWiki('{{Infobox\n|L={\n[a]\n|B= b\nmore b\n|C= c')).toEqual([{ key: 'L', value: [{ v: 'a' }] }, { key: 'B', value: 'b\nmore b' }, { key: 'C', value: 'c' }]);
    expect(parseWiki('')).toEqual([]);
    expect(parseWiki(null)).toEqual([]);
    expect(parseWiki('just text')).toEqual([]);
  });
  test('round trip on real Bangumi infoboxes (as the API parses them)', () => {
    for (const key of ['subject:118165', 'subject:5297', 'subject:118167']) {
      const infobox = (fx[key] as BgmSubject).infobox!;
      expect(parseWiki(toWiki(infobox))).toEqual(infobox.map(entry => typeof entry.value === 'string' ? entry
        : { key: entry.key, value: entry.value.map(item => item.k === undefined ? { v: item.v } : { k: item.k, v: item.v }) }));
    }
  });
});

describe('import', () => {
  test('keeps book subjects only, with metadata, and reports progress', () => {
    expect(subjects).toBe(10);
    expect(reader.info()).toMatchObject({ dump: dump.name, subjects: 10, digest: `sha256:${dump.sha256}`, dumpDate: '2026-09-22T21:03:41Z' });
    expect(phases.at(-1)).toBe(1);
    expect(phases.every((value, index) => index === 0 || value >= phases[index - 1]!)).toBe(true);
  });

  test('subjects answer like the online API (infobox parsed from raw wiki, trimmed to what is used)', async () => {
    const api = fx['subject:118165'] as BgmSubject;
    const offline = (await reader.subject(118165))!;
    expect(offline).toMatchObject({ id: 118165, type: 1, name: 'ぐらんぶる', name_cn: 'GRANDBLUE 碧蓝之海', platform: '漫画', series: true, nsfw: false, date: '2014-11-07', images: null });
    // Only what metadata reads is stored: names, credits, publisher, magazine, dates and the Taiwan edition.
    const keys = offline.infobox!.map(entry => entry.key);
    expect(keys).toEqual(['中文名', '别名', '作画', '原作', '出版社', '连载杂志', '发售日', '开始', '版本:东立版']);
    expect(offline.infobox).toEqual(api.infobox!.filter(entry => keys.includes(entry.key)));
    expect((await reader.search('Grand Blue Dreaming'))[0]?.id).toBe(118165);
    expect((await reader.subject(118167))!.tags).toEqual([]);
    expect(offline.tags).toEqual(api.tags!);
    expect(offline.meta_tags).toEqual(api.meta_tags!);
    expect(offline.summary).toBe(api.summary!);
    expect((await reader.subject(5297))!).toMatchObject({ volumes: 21, credits_cn: ['矢泽爱'] });
    expect(await reader.subject(235130)).toBeNull();
    expect(await reader.subject(424242)).toBeNull();
    const odd = (await reader.subject(900001))!;
    expect(odd).toMatchObject({ platform: '小说', nsfw: true, volumes: 3 });
    expect(odd.infobox).toEqual([
      { key: '中文名', value: '怪异之书' }, { key: '别名', value: [{ v: '别名一' }, { k: '英文名', v: 'Odd Book' }] },
      { key: '册数', value: '全3卷\ncontinued value line' }, { key: '作者', value: '某作者' },
    ]);
  });

  test('relations between books (单行本 / 系列), credits and persons', async () => {
    expect(await reader.related(118165)).toEqual([
      { id: 118167, type: 1, name: 'ぐらんぶる (1)', name_cn: '', relation: '单行本' },
      { id: 118166, type: 1, name: 'ぐらんぶる (2)', name_cn: '', relation: '单行本' },
    ]);
    expect(await reader.related(5274)).toEqual([{ id: 5297, type: 1, name: 'NANA -ナナ-', name_cn: 'NANA ～世上的另一个我～', relation: '系列' }]);
    const persons = await reader.persons(118165);
    expect(persons.map(person => `${person.relation}:${person.name}`)).toEqual([
      '作画:吉岡公威', '出版社:講談社', '出版社:東立出版社', '出版社:대원씨아이', '出版社:Studio JG', '连载杂志:good!アフタヌーン', '译者:江昱霖', '原作:井上堅二',
    ]);
    expect(persons.some(person => person.name === 'Guest')).toBe(false);
  });
});

describe('search', () => {
  const ids = async (keyword: string) => (await reader.search(keyword)).map(subject => subject.id);
  test('Traditional input finds Simplified names; series before their volumes', async () => {
    expect(await ids('碧藍之海')).toEqual([118165, expect.any(Number), expect.any(Number)]);
    expect((await ids('碧藍之海')).slice(1).sort()).toEqual([118166, 118167]);
    expect((await ids('葬送的芙莉蓮')).slice(0, 2)).toEqual([305429, 463534]);
    expect(await ids('GRANDBLUE 碧藍之海')).toContain(118165);
  });
  test('exact names first, then prefixes, series before volumes', async () => {
    const nana = await ids('NANA');
    expect(nana.slice(0, 2)).toEqual([606428, 5297]);
    expect(nana.slice(2).sort()).toEqual([5237, 5274]);
    expect(await ids('娜娜')).toEqual([5297]);
    expect(await ids('odd book')).toEqual([900001]);
  });
  test('short queries (under 3 characters) and nothing', async () => {
    expect(await ids('之海')).toEqual([118165, expect.any(Number), expect.any(Number)]);
    expect(await ids('海')).toContain(118165);
    expect(await ids('"%_')).toEqual([]);
    expect(await ids('完全不存在的书')).toEqual([]);
  });
  test('the matcher works on the archive (NANA by 矢澤愛; GRAND BLUE)', async () => {
    const nana = await findSubject(reader, { keywords: ['NANA'], authors: ['矢澤愛'], localVolumes: 21 });
    expect(nana).toMatchObject({ state: 'matched', subject: { id: 5297 } });
    expect(nana.candidates[0]).toMatchObject({ id: 5297, cover: null, authors: ['矢沢あい'] });
    expect((await findSubject(reader, { keywords: ['GRAND BLUE 碧藍之海'], authors: ['井上堅二'], localVolumes: 25 })).subject?.id).toBe(118165);
    expect((await findSubject(reader, { keywords: ['NANA'], authors: [], localVolumes: 21 })).state).toBe('suggested');
  });
});

describe('download from GitHub', () => {
  const github = startFakeGithub(dump);
  afterAll(() => github.stop());

  test('latest.json is read and checked', async () => {
    const latest = await latestDump(github.route(fetch));
    expect(latest).toEqual({ name: dump.name, url: `https://github.com/bangumi/Archive/releases/download/archive/${dump.name}`, size: dump.bytes.length, sha256: dump.sha256, createdAt: '2026-09-22T21:03:41Z' });
    github.state.latestStatus = 503;
    await expect(latestDump(github.route(fetch))).rejects.toThrow('HTTP 503');
    github.state.latestStatus = 200;
    const offline = (async () => { throw Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' }); }) as unknown as typeof fetch;
    const error = await latestDump(offline).then(() => new Error('no error'), (reason: Error) => reason);
    expect(error.message).toContain('无法访问 GitHub（连接被拒绝）');
    expect(error.message).not.toContain('Unable to connect');
  });

  test('a dropped connection is resumed with Range, and the file is verified', async () => {
    const dir = mkdtempSync(join(root, 'dl-'));
    const latest = await latestDump(github.route(fetch));
    github.state.requests.length = 0;
    github.state.cutAfter = 1000;
    const progress: number[] = [];
    const file = await downloadDump(latest, dir, github.route(fetch), done => { progress.push(done); });
    expect(file).toBe(join(dir, dump.name));
    expect(new Bun.CryptoHasher('sha256').update(await Bun.file(file).bytes()).digest('hex')).toBe(dump.sha256);
    expect(github.state.requests).toEqual([`/bangumi/Archive/releases/download/archive/${dump.name}`, `/assets/${dump.name}`,
      `/bangumi/Archive/releases/download/archive/${dump.name} bytes=1000-`, `/assets/${dump.name} bytes=1000-`]);
    expect(progress.at(-1)).toBe(dump.bytes.length);
    expect(existsSync(`${file}.part`)).toBe(false);
  });

  test('a partial file left by a restart is continued; a server ignoring Range restarts from zero', async () => {
    const dir = mkdtempSync(join(root, 'dl-'));
    const latest = await latestDump(github.route(fetch));
    writeFileSync(join(dir, `${dump.name}.part`), dump.bytes.subarray(0, 500));
    writeFileSync(join(dir, 'dump-2026-09-15.210336Z.zip.part'), 'stale');
    github.state.requests.length = 0;
    await downloadDump(latest, dir, github.route(fetch), () => {});
    expect(github.state.requests.at(-1)).toBe(`/assets/${dump.name} bytes=500-`);
    expect(existsSync(join(dir, 'dump-2026-09-15.210336Z.zip.part'))).toBe(false);

    const again = mkdtempSync(join(root, 'dl-'));
    writeFileSync(join(again, `${dump.name}.part`), 'garbage that is not the start of the zip');
    github.state.ignoreRange = true;
    const file = await downloadDump(latest, again, github.route(fetch), () => {});
    github.state.ignoreRange = false;
    expect(new Bun.CryptoHasher('sha256').update(await Bun.file(file).bytes()).digest('hex')).toBe(dump.sha256);
  });

  test('a digest mismatch deletes the download', async () => {
    const dir = mkdtempSync(join(root, 'dl-'));
    const latest = { ...await latestDump(github.route(fetch)), sha256: '0'.repeat(64) };
    await expect(downloadDump(latest, dir, github.route(fetch), () => {})).rejects.toThrow('校验失败');
    expect(existsSync(join(dir, `${dump.name}.part`))).toBe(false);
    expect(existsSync(join(dir, dump.name))).toBe(false);
  });
});
