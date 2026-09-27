// Test doubles: Bangumi API answered from recorded fixtures (a fetch to inject), a Komga server (Bun.serve) that keeps
// series/books in memory and records every write, and a Bangumi Archive dump with a GitHub that serves it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import fixtures from './bangumi-fixtures.json';

type Fixtures = Record<string, unknown>;

/** Bangumi v0 + lain.bgm.tv images from fixtures; anything else goes to the real network stack (the fake Komga). */
/** A number as fixture value answers with that HTTP status. */
export function fakeBangumi(extra: Fixtures = {}) {
  const data: Fixtures = { ...fixtures, ...extra };
  const calls: string[] = [];
  const headers: Headers[] = [];
  /** The proxy each Bangumi request (API or image) was asked to go through. */
  const proxies: (string | undefined)[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: BunFetchRequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (/(^|\.)bgm\.tv$/.test(url.hostname)) proxies.push(typeof init?.proxy === 'string' ? init.proxy : undefined);
    if (url.hostname === 'api.bgm.tv') {
      if (url.pathname === '/v0/subjects/1') return Response.json({ title: 'Not Found' }, { status: 404 }); // reachability probe
      headers.push(new Headers(init?.headers));
      const match = /^\/v0\/subjects\/(\d+)(?:\/(persons|subjects))?$/.exec(url.pathname);
      const key = url.pathname === '/v0/search/subjects' ? `search:${(JSON.parse(String(init?.body)) as { keyword: string }).keyword}`
        : match ? `${match[2] === 'persons' ? 'persons' : match[2] === 'subjects' ? 'related' : 'subject'}:${match[1]}` : url.pathname;
      calls.push(key);
      if (typeof data[key] === 'number') return Response.json({ title: 'Error' }, { status: data[key] });
      if (key.startsWith('search:')) return Response.json({ data: data[key] ?? [], total: 0, limit: 10, offset: 0 });
      if (key in data) return Response.json(data[key]);
      return key.startsWith('subject:') ? Response.json({ title: 'Not Found' }, { status: 404 }) : Response.json([]);
    }
    if (url.hostname === 'lain.bgm.tv') {
      calls.push(`image:${url.pathname}`);
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
    }
    return fetch(input, init);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, headers, proxies, data };
}

export interface FakeSeries { id: string; libraryId: string; name: string; url: string; metadata: Record<string, unknown> }
export interface FakeBook { id: string; seriesId: string; name: string; url: string; metadata: Record<string, unknown> }

export const seriesMetadata = (title: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'ONGOING', statusLock: false, title, titleLock: false, titleSort: title, titleSortLock: false, summary: '', summaryLock: false,
  readingDirection: '', readingDirectionLock: false, publisher: '', publisherLock: false, ageRatingLock: false, language: '', languageLock: false,
  genres: [], genresLock: false, tags: [], tagsLock: false, totalBookCountLock: false, sharingLabels: [], sharingLabelsLock: false,
  links: [], linksLock: false, alternateTitles: [], alternateTitlesLock: false, ...extra,
});
export const bookMetadata = (title: string, number: number): Record<string, unknown> => ({
  title, titleLock: false, summary: '', summaryLock: false, number: String(number), numberLock: false, numberSort: number, numberSortLock: false,
  releaseDateLock: false, authors: [], authorsLock: false, tags: [], tagsLock: false, isbn: '', isbnLock: false, links: [], linksLock: false,
});

export function startFakeKomga(options: { apiKey?: string; roles?: string[] } = {}) {
  const apiKey = options.apiKey ?? 'komga-key';
  const state = {
    roles: options.roles ?? ['ADMIN', 'USER'],
    libraries: [{ id: 'lib1', name: '漫画', root: '/data' }, { id: 'lib2', name: '小说', root: '/novels' }],
    series: [] as FakeSeries[],
    books: [] as FakeBook[],
    thumbnails: new Map<string, { id: string; type: string; selected: boolean }[]>(),
    patches: [] as { kind: 'series' | 'books'; id: string; body: Record<string, unknown> }[],
    uploads: [] as { kind: string; id: string; size: number; selected: string | null }[],
    scans: [] as string[],
    requests: [] as string[],
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      state.requests.push(`${req.method} ${url.pathname}`);
      if (req.headers.get('x-api-key') !== apiKey) return new Response('Unauthorized', { status: 401 });
      const path = url.pathname;
      if (req.method === 'GET' && path === '/actuator/info') return Response.json({ build: { version: '1.27.1', name: 'komga' } });
      if (req.method === 'GET' && path === '/api/v2/users/me') return Response.json({ id: 'u1', email: 'admin@example.com', roles: state.roles });
      if (req.method === 'GET' && path === '/api/v1/libraries') return Response.json(state.libraries.map(library => ({ ...library, scanInterval: 'DISABLED' })));
      if (req.method === 'POST' && path === '/api/v1/series/list') {
        const body = await req.json() as { condition: { allOf: { libraryId?: { value: string } }[] } };
        const libraryId = body.condition.allOf.find(entry => entry.libraryId)?.libraryId?.value;
        return Response.json({ content: state.series.filter(series => series.libraryId === libraryId), totalElements: state.series.length });
      }
      if (req.method === 'POST' && path === '/api/v1/books/list') {
        const body = await req.json() as { condition: { allOf: { seriesId?: { value: string } }[] } };
        const seriesId = body.condition.allOf.find(entry => entry.seriesId)?.seriesId?.value;
        return Response.json({ content: state.books.filter(book => book.seriesId === seriesId) });
      }
      let match = /^\/api\/v1\/libraries\/([^/]+)\/scan$/.exec(path);
      if (match && req.method === 'POST') { state.scans.push(match[1]!); return new Response(null, { status: 202 }); }
      match = /^\/api\/v1\/series\/([^/]+)$/.exec(path);
      if (match && req.method === 'GET') {
        const series = state.series.find(entry => entry.id === match![1]);
        return series ? Response.json(series) : new Response('Not found', { status: 404 });
      }
      match = /^\/api\/v1\/(series|books)\/([^/]+)\/metadata$/.exec(path);
      if (match && req.method === 'PATCH') {
        const kind = match[1] as 'series' | 'books', id = match[2]!;
        const body = await req.json() as Record<string, unknown>;
        const target = kind === 'series' ? state.series.find(entry => entry.id === id) : state.books.find(entry => entry.id === id);
        if (!target) return new Response('Not found', { status: 404 });
        state.patches.push({ kind, id, body });
        // Komga stores genres and tags lower-cased.
        const stored = { ...body };
        for (const key of ['genres', 'tags']) if (Array.isArray(stored[key])) stored[key] = (stored[key] as string[]).map(value => value.toLowerCase());
        Object.assign(target.metadata, stored);
        return new Response(null, { status: 204 });
      }
      match = /^\/api\/v1\/(series|books)\/([^/]+)\/thumbnails$/.exec(path);
      if (match) {
        const key = `${match[1]}/${match[2]}`;
        if (req.method === 'GET') return Response.json(state.thumbnails.get(key) ?? [{ id: 't0', type: 'GENERATED', selected: true }]);
        const form = await req.formData();
        const file = form.get('file');
        if (!(file instanceof Blob)) return new Response('no file', { status: 400 });
        state.uploads.push({ kind: match[1]!, id: match[2]!, size: file.size, selected: url.searchParams.get('selected') });
        state.thumbnails.set(key, [{ id: `t${state.uploads.length}`, type: 'USER_UPLOADED', selected: true }]);
        return Response.json({ id: `t${state.uploads.length}`, type: 'USER_UPLOADED', selected: true });
      }
      return new Response(`no route ${req.method} ${path}`, { status: 404 });
    },
  });
  return {
    state, apiKey, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true),
    reset() {
      state.roles = options.roles ?? ['ADMIN', 'USER'];
      for (const list of [state.series, state.books, state.patches, state.uploads, state.scans, state.requests]) list.length = 0;
      state.thumbnails.clear();
    },
    addSeries(id: string, folder: string, metadata: Record<string, unknown> = {}, libraryId = 'lib1'): FakeSeries {
      const series = { id, libraryId, name: folder.split('/').at(-1)!, url: `/data${folder}`, metadata: seriesMetadata(folder.split('/').at(-1)!, metadata) };
      state.series.push(series);
      return series;
    },
    addBook(id: string, seriesId: string, file: string, number: number): FakeBook {
      const series = state.series.find(entry => entry.id === seriesId)!;
      const name = file.replace(/\.[^.]+$/, '');
      const book = { id, seriesId, name, url: `${series.url}/${file}`, metadata: bookMetadata(name, number) };
      state.books.push(book);
      return book;
    },
  };
}

// ---------- Bangumi Archive (offline data) ----------
type Infobox = { key: string; value: string | { k?: string; v?: string }[] }[];
/** The raw wiki Bangumi stores (CRLF, "|key= value", lists in braces) for an infobox as the API returns it. */
export function toWiki(infobox: Infobox, type = 'animanga/Manga'): string {
  const lines = [`{{Infobox ${type}`];
  for (const { key, value } of infobox) {
    if (typeof value === 'string') lines.push(`|${key}= ${value}`);
    else lines.push(`|${key}={`, ...value.map(item => item.k !== undefined ? `[${item.k}|${item.v ?? ''}]` : `[${item.v ?? ''}]`), '}');
  }
  return [...lines, '}}'].join('\r\n');
}

const PLATFORM_CODES: Record<string, number> = { 漫画: 1001, 小说: 1002, 画集: 1003, 公式书: 1006 };
interface FixtureSubject { id: number; name: string; name_cn?: string; platform?: string | null; series?: boolean; date?: string | null; summary?: string; nsfw?: boolean; infobox?: Infobox | null; tags?: { name: string; count: number }[]; meta_tags?: string[] }
/** One subject.jsonlines line built from an API-shaped fixture (type 1 = book). */
export function dumpSubject(subject: FixtureSubject, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: subject.id, type: 1, name: subject.name, name_cn: subject.name_cn ?? '', infobox: toWiki(subject.infobox ?? []),
    platform: PLATFORM_CODES[subject.platform ?? ''] ?? 0, summary: subject.summary ?? '', nsfw: subject.nsfw ?? false, date: subject.date ?? null,
    favorite: { wish: 1, done: 1, doing: 0, on_hold: 0, dropped: 0 }, series: subject.series ?? false, tags: subject.tags ?? [], meta_tags: subject.meta_tags ?? [],
    score: 7.1, rank: 1000, ...extra,
  });
}

/** Writes the given .jsonlines files and zips them (the zip CLI); returns the zip path, bytes and sha256. */
export function buildDump(dir: string, files: Record<string, string[]>, name = 'dump-2026-09-22.210341Z.zip') {
  const source = `${dir}/source`;
  mkdirSync(source, { recursive: true });
  for (const [file, lines] of Object.entries(files)) writeFileSync(`${source}/${file}`, `${lines.join('\n')}\n`);
  const zip = `${dir}/${name}`;
  const result = Bun.spawnSync(['zip', '-q', '-j', zip, ...Object.keys(files).map(file => `${source}/${file}`)]);
  if (result.exitCode !== 0) throw new Error(`zip failed: ${result.stderr.toString()}`);
  const bytes = new Uint8Array(readFileSync(zip));
  return { zip, name, bytes, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') };
}

/** GitHub for the Bangumi Archive: latest.json, the release URL (302 to an asset URL), Range requests, dropped connections. */
export function startFakeGithub(initial: { name: string; bytes: Uint8Array; sha256: string }) {
  let dump = initial;
  const state = { requests: [] as string[], proxies: [] as (string | undefined)[], cutAfter: 0, ignoreRange: false, latestStatus: 200, digest: dump.sha256 };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      state.requests.push(`${url.pathname}${req.headers.get('range') ? ` ${req.headers.get('range')}` : ''}`);
      if (url.pathname === '/bangumi/Archive/master/aux/latest.json') {
        if (state.latestStatus !== 200) return new Response('error', { status: state.latestStatus });
        return Response.json({
          name: dump.name, browser_download_url: `https://github.com/bangumi/Archive/releases/download/archive/${dump.name}`, size: dump.bytes.length,
          digest: `sha256:${state.digest}`, created_at: '2026-09-22T21:03:41Z', content_type: 'application/zip',
        });
      }
      if (url.pathname === `/bangumi/Archive/releases/download/archive/${dump.name}`) return new Response(null, { status: 302, headers: { Location: `/assets/${dump.name}` } });
      if (url.pathname === `/assets/${dump.name}`) {
        const range = state.ignoreRange ? null : /bytes=(\d+)-/.exec(req.headers.get('range') ?? '');
        const start = range ? Number(range[1]) : 0;
        const headers: Record<string, string> = start ? { 'Content-Range': `bytes ${start}-${dump.bytes.length - 1}/${dump.bytes.length}` } : {};
        return new Response(new Blob([new Uint8Array(dump.bytes.subarray(start))]), { status: start ? 206 : 200, headers });
      }
      return new Response('not found', { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  /** fetch that sends github.com / raw.githubusercontent.com to this server (and records the proxy asked for). */
  const route = (next: typeof fetch) => ((input: string | URL | Request, init?: BunFetchRequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'github.com' || url.hostname === 'raw.githubusercontent.com') {
      state.proxies.push(typeof init?.proxy === 'string' ? init.proxy : undefined);
      const { proxy: _proxy, ...rest } = init ?? {};
      const cut = url.hostname === 'github.com' ? state.cutAfter : 0;
      if (cut) state.cutAfter = 0;
      return fetch(`${origin}${url.pathname}`, rest).then(response => {
        if (!cut || !response.body) return response;
        // The connection drops after `cut` bytes, as seen by the client.
        const reader = response.body.getReader();
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (sent >= cut) {
              await reader.cancel();
              controller.error(Object.assign(new Error('The socket connection was closed unexpectedly.'), { code: 'ECONNRESET' }));
              return;
            }
            const { done, value } = await reader.read();
            if (done) { controller.close(); return; }
            const part = value.subarray(0, cut - sent);
            sent += part.byteLength;
            controller.enqueue(part);
          },
        });
        return new Response(body, { status: response.status, headers: response.headers });
      });
    }
    return next(input, init);
  }) as typeof fetch;
  /** Publish another dump (a newer weekly one). */
  const serve = (next: typeof initial) => { dump = next; state.digest = next.sha256; };
  return { state, origin, route, serve, stop: () => server.stop(true) };
}

/** A network that blocks these hosts: every connection fails, with Bun's own error. */
export const blocked = (hosts: RegExp, next: typeof fetch = fetch) => ((input: string | URL | Request, init?: BunFetchRequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (hosts.test(url.hostname)) return Promise.reject(Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' }));
  return next(input, init);
}) as typeof fetch;
export const BANGUMI_HOSTS = /(^|\.)(bgm\.tv|bangumi\.tv|chii\.in)$/;
export const GITHUB_HOSTS = /(^|\.)(github\.com|githubusercontent\.com)$/;

const POSITION_CODES: Record<string, number> = { 作者: 2001, 作画: 2002, 出版社: 2004, 连载杂志: 2005, 译者: 2006, 原作: 2007 };
/** Chinese names the sample persons carry in their wiki (简体中文名). */
const PERSON_CN: Record<number, string> = { 1647: '矢泽爱', 3815: '井上坚二', 15044: '吉冈公威' };

/**
 * A small but realistic dump: GRAND BLUE (series + 2 volumes), NANA (series + 2 volumes) and the unrelated NaNa,
 * 葬送的芙莉蓮 and its artbook, from recorded API data; plus what the import must drop or survive: an anime subject,
 * relations/credits to it, a guest credit, unreferenced persons, episodes, and a book with messy wiki.
 */
export function sampleDump(dir: string, name?: string) {
  const data = fakeBangumi().data;
  const subject = (key: string) => data[key] as FixtureSubject;
  const hit = (key: string, id: number) => (data[key] as FixtureSubject[]).find(entry => entry.id === id)!;
  const messy = [
    '{{Infobox animanga/Novel', '|中文名= 怪异之书', '|别名={', '[别名一]', '[英文名|Odd Book]', '|册数= 全3卷', 'continued value line', '|作者= 某作者 ', '}}',
  ].join('\r\n');
  const subjects = [
    dumpSubject(subject('subject:118165'), { favorite: { wish: 900, done: 1200, doing: 300, on_hold: 10, dropped: 5 } }),
    dumpSubject(subject('subject:118167')), dumpSubject(subject('subject:118166')),
    dumpSubject(subject('subject:5297'), { favorite: { wish: 500, done: 3000, doing: 100, on_hold: 50, dropped: 20 } }),
    dumpSubject(hit('search:NANA', 606428)), dumpSubject(hit('search:NANA', 5237)), dumpSubject(hit('search:NANA', 5274)),
    dumpSubject(hit('search:葬送的芙莉蓮', 305429), { favorite: { wish: 2000, done: 4000, doing: 800, on_hold: 0, dropped: 1 } }),
    dumpSubject(hit('search:葬送的芙莉蓮', 463534)),
    JSON.stringify({ id: 900001, type: 1, name: 'Odd Book', name_cn: '', infobox: messy, platform: 1002, summary: '', nsfw: true, date: '2020-01-01', series: true, tags: [], favorite: {} }),
    JSON.stringify({ id: 235130, type: 2, name: 'ぐらんぶる', name_cn: '碧蓝之海', infobox: '{{Infobox animanga/TVAnime\r\n|中文名= 碧蓝之海\r\n}}', platform: 1, summary: '', nsfw: false, date: '2018-07-14', series: false }),
  ];
  const relation = (from: number, to: number, type: number, order = 0) => JSON.stringify({ subject_id: from, relation_type: type, related_subject_id: to, order });
  const relations = [
    relation(118165, 118167, 1003, 1), relation(118165, 118166, 1003, 2), relation(118167, 118165, 1002), relation(118166, 118165, 1002),
    relation(118165, 235130, 1), relation(235130, 118165, 1), relation(5297, 5274, 1003, 1), relation(5297, 5237, 1003, 11),
    relation(5274, 5297, 1002), relation(5237, 5297, 1002), relation(305429, 463534, 1004),
  ];
  const credit = (person: number, subjectId: number, position: number) => JSON.stringify({ person_id: person, subject_id: subjectId, position, appear_eps: '' });
  const people = [...data['persons:118165'] as { id: number; name: string; relation: string; type: number }[], ...data['persons:5297'] as { id: number; name: string; relation: string; type: number }[]];
  const credits = [
    ...(data['persons:118165'] as { id: number; relation: string }[]).map(person => credit(person.id, 118165, POSITION_CODES[person.relation]!)),
    ...(data['persons:5297'] as { id: number; relation: string }[]).map(person => credit(person.id, 5297, POSITION_CODES[person.relation]!)),
    credit(777, 118165, 2008), credit(778, 235130, 2),
  ];
  const personLine = (id: number, personName: string, type: number) => JSON.stringify({
    id, name: personName, type, career: [], summary: '', comments: 0, collects: 0,
    infobox: toWiki([...(PERSON_CN[id] ? [{ key: '简体中文名', value: PERSON_CN[id]! }] : []), { key: '性别', value: '女' }], 'Crt'),
  });
  const persons = [...people.map(person => personLine(person.id, person.name, person.type)), personLine(777, 'Guest', 1), personLine(778, 'Anime Staff', 1), personLine(999, 'Nobody', 1)];
  return buildDump(dir, {
    'subject.jsonlines': subjects, 'subject-relations.jsonlines': relations, 'subject-persons.jsonlines': credits, 'person.jsonlines': persons,
    'episode.jsonlines': [JSON.stringify({ id: 1, name: 'ep', subject_id: 235130, sort: 1, type: 0 })],
  }, name);
}
