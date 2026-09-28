// Writing Bangumi metadata to one Komga series and its books. A field Bangumi lacks is left out (never blanked), written
// fields are locked when asked, and fields that already hold the value are not sent again (re-syncs are quiet).
import type { MetadataOptions, MetadataText } from '@shared/model';
import { AppError } from '../http/errors';
import { errorMessage } from '../lib/retry';
import type { ItemRow } from '../services/comics';
import {
  creators, infobox, subjectUrl, traditionalEdition, type BangumiApi, type BgmPerson, type BgmRelated, type BgmSubject,
} from './bangumi';
import { below, type KomgaClient, type KomgaLink } from './komga';
import { bookNumber, fold, surname, type BookNumber } from './text';

export type Language = 'zh-Hant' | 'zh-Hans';
/** Kmoe sells Taiwan (繁體) editions; its "語言" is 繁體 or missing for them. Japanese/English editions get no language. */
export function languageOf(comic: { language: string | null } | null): Language | null {
  if (!comic) return null;
  if (!comic.language || /繁/.test(comic.language)) return 'zh-Hant';
  return /[简簡]/.test(comic.language) ? 'zh-Hans' : null;
}

export interface ComicFacts { title: string; status: string | null; language: string | null; volumes: number }

// ---------- Series ----------
const NOT_GENRES = new Set(['日本', '中国', '中国大陆', '中国台湾', '中国香港', '台湾', '香港', '韩国', '美国', '欧美', '法国', '漫画', '小说', '轻小说',
  '画集', '绘本', '系列', '单行本', '条漫', '连载中', '已完结', '完结', '休刊', '原创']);
const NOT_TAGS = /^(?:\d{4}(?:\D.*)?|.*系列|.*单行本|.*單行本|[日国韩美]漫|[少青]年漫画?|少女漫画?|女性漫画?|日本漫画|月刊|[周週]刊|漫画?|漫畫|manga|comics?|コミックス?|マンガ|其他|全\d+[卷巻]|已购|待买)$/i;
const OUR_LINKS = /^(?:bangumi|cbl|kmoe)$/i;
const OUR_TITLES = new Set(['日文', '中文', '别名', 'Kmoe']);

export function seriesStatus(subject: BgmSubject, comic: ComicFacts | null): 'ENDED' | 'ONGOING' | null {
  if (comic?.status && /完結|完结/.test(comic.status)) return 'ENDED';
  if (comic?.status && /連載|连载/.test(comic.status)) return 'ONGOING';
  const meta = subject.meta_tags ?? [];
  if (meta.includes('已完结') || meta.includes('完结') || infobox(subject, '结束').length) return 'ENDED';
  return meta.includes('连载中') ? 'ONGOING' : null;
}

function seriesTags(subject: BgmSubject, persons: BgmPerson[], genres: string[], limit: number): string[] {
  const people = [...creators(subject), ...persons.filter(person => person.type === 1).map(person => person.name)].map(fold);
  const excluded = [subject.name, subject.name_cn ?? '', ...infobox(subject, '别名'), ...people, ...persons.map(person => person.name),
    ...infobox(subject, '出版社'), ...infobox(subject, '连载杂志'), ...genres].map(fold).filter(Boolean);
  // "矢泽爱" is how tags spell 矢沢あい: a tag with an author's two-character surname is that author.
  const surnames = new Set(people.map(surname).filter((value): value is string => value !== null));
  const tags: string[] = [];
  for (const tag of [...subject.tags ?? []].sort((a, b) => b.count - a.count)) {
    if (tags.length >= limit) break;
    const name = tag.name.trim(), key = fold(name);
    if (!key || tag.count < 2 || NOT_GENRES.has(name) || NOT_TAGS.test(name)) continue;
    if (excluded.some(other => other === key || (key.length >= 2 && other.includes(key))) || surnames.has(surname(key) ?? '')) continue;
    if (!tags.some(other => fold(other) === key)) tags.push(name);
  }
  return tags;
}

/** Summary, genres and tags as syncing writes them from Bangumi (an accepted AI version replaces all three). */
export function seriesText(subject: BgmSubject, persons: BgmPerson[], tagLimit: number): MetadataText {
  const genres = [...new Set((subject.meta_tags ?? []).map(tag => tag.trim()).filter(tag => tag && !NOT_GENRES.has(tag)))];
  return { summary: subject.summary?.trim() ?? '', genres, tags: seriesTags(subject, persons, genres, tagLimit) };
}

function withLocks(body: Record<string, unknown>, lock: boolean): Record<string, unknown> {
  if (lock) for (const key of Object.keys(body)) body[`${key}Lock`] = true;
  return body;
}

export interface SeriesInput {
  subject: BgmSubject; persons: BgmPerson[]; related: BgmRelated[]; comic: ComicFacts | null; kmoeUrl: string | null;
  /** The series' current Komga metadata (links and alternate titles are merged into). */
  current: Record<string, unknown>;
  options: MetadataOptions;
  /** The AI-tidied summary and tags the user accepted for this subject. */
  polish?: MetadataText | null;
}

/** The full series update (before `changes()` drops what Komga already has). */
export function seriesPatch({ subject, persons, related, comic, kmoeUrl, current, options, polish }: SeriesInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const title = (options.titleLanguage === 'cn' ? subject.name_cn || subject.name : subject.name).trim();
  body.title = title;
  body.titleSort = title;
  const text = polish ?? seriesText(subject, persons, options.tagLimit);
  if (text.summary) body.summary = text.summary;
  const status = seriesStatus(subject, comic);
  if (status) body.status = status;
  const language = languageOf(comic);
  const publisher = ((language === 'zh-Hant' ? traditionalEdition(subject)?.['出版社'] : undefined) ?? infobox(subject, '出版社')[0])?.split(/[、,，/]/)[0]?.trim();
  if (publisher) body.publisher = publisher;
  // auto: Japanese manga (a 漫画 not tagged Chinese, Korean or Western) reads right to left; anything else keeps Komga's.
  const japanese = subject.platform === '漫画' && !(subject.meta_tags ?? []).some(tag => ['中国', '韩国', '美国', '欧美'].includes(tag));
  const direction = options.readingDirection === 'auto' ? (japanese ? 'RIGHT_TO_LEFT' : null) : options.readingDirection === 'keep' ? null : options.readingDirection;
  if (direction) body.readingDirection = direction;
  if (subject.nsfw) body.ageRating = 18;
  if (language) body.language = language;
  if (text.genres.length) body.genres = text.genres;
  if (text.tags.length) body.tags = text.tags;
  const released = related.filter(entry => entry.relation === '单行本').length;
  const total = subject.volumes && subject.volumes > 0 ? subject.volumes
    : comic?.status && /完結|完结/.test(comic.status) && comic.volumes > 0 ? comic.volumes
    : status === 'ENDED' && released > 0 ? released : null;
  if (total) body.totalBookCount = total;
  const links = ((current.links ?? []) as KomgaLink[]).filter(link => !OUR_LINKS.test(link.label.trim()));
  body.links = [...links, { label: 'Bangumi', url: subjectUrl(subject.id) }, ...(kmoeUrl ? [{ label: 'Kmoe', url: kmoeUrl }] : [])];
  const alternates = [
    ...((current.alternateTitles ?? []) as { label: string; title: string }[]).filter(entry => !OUR_TITLES.has(entry.label)),
    { label: '日文', title: subject.name }, { label: '中文', title: subject.name_cn ?? '' },
    ...infobox(subject, '别名').map(alias => ({ label: '别名', title: alias })),
    ...(comic ? [{ label: 'Kmoe', title: comic.title }] : []),
  ];
  const seen = new Set([title.toLowerCase()]);
  const alternateTitles = alternates.map(entry => ({ label: entry.label, title: entry.title.trim() })).filter(entry => {
    const key = entry.title.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (alternateTitles.length) body.alternateTitles = alternateTitles;
  return withLocks(body, options.lock);
}

// ---------- Books ----------
const SPECIAL_EDITION = /限定|特装|特別|特别|豪華|豪华|付き|付属|同梱|セット|box/i;

/** Volume number → Bangumi volume ("单行本" relations; numbers from "ぐらんぶる (3)" / 第3巻, else their order). */
export function volumeMap(related: BgmRelated[]): Map<number, BgmRelated> {
  const volumes = related.filter(entry => entry.relation === '单行本');
  const numbered = volumes.map(entry => ({
    entry, number: [entry.name, entry.name_cn ?? ''].map(name => bookNumber(name)).find(parsed => parsed.kind === 'volume' && !parsed.range)?.number ?? null,
  }));
  const map = new Map<number, BgmRelated>();
  if (!numbered.some(volume => volume.number !== null)) {
    volumes.forEach((entry, index) => map.set(index + 1, entry));
    return map;
  }
  for (const { entry, number } of numbered) {
    if (number === null) continue;
    const previous = map.get(number);
    if (!previous || (SPECIAL_EDITION.test(previous.name) && !SPECIAL_EDITION.test(entry.name))) map.set(number, entry);
  }
  return map;
}

/** What a Kmoe item is: 卷 NN volumes (else their order), 話 chapter packs, 番外 extras. */
export function itemNumber(item: Pick<ItemRow, 'type' | 'name' | 'sort_order'>): BookNumber {
  if (item.type !== 'volume') return { kind: item.type === 'serial' ? 'chapter' : 'extra', number: null, label: null, range: false };
  const parsed = bookNumber(item.name);
  if (parsed.kind === 'volume' || item.sort_order === null) return parsed;
  return { kind: 'volume', number: item.sort_order, label: String(item.sort_order), range: false };
}

const ROLES: Record<string, string> = { 作者: 'writer', 原作: 'writer', 作画: 'penciller' };
/** Book authors from the series credits (persons endpoint, else the infobox). */
export function bookAuthors(persons: BgmPerson[], subject: BgmSubject): { name: string; role: string }[] {
  let authors = persons.filter(person => ROLES[person.relation]).map(person => ({ name: person.name.trim(), role: ROLES[person.relation]! }));
  if (!authors.length) {
    authors = Object.entries(ROLES).flatMap(([key, role]) => infobox(subject, key).flatMap(value => value.split(/[、,，/／]/))
      .map(name => ({ name: name.trim(), role })));
  }
  const seen = new Set<string>();
  return authors.filter(author => author.name && !seen.has(`${author.name}\n${author.role}`) && seen.add(`${author.name}\n${author.role}`));
}

export function isoDate(raw: string | null | undefined): string | null {
  const match = /(\d{4})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})/.exec(raw ?? '');
  if (!match) return null;
  const date = `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`;
  return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ? null : date;
}

/** A valid ISBN-13 (ISBN-10 converted), or null. */
export function isbn13(raw: string | null | undefined): string | null {
  const text = (raw ?? '').replace(/[^\dXx]/g, '').toUpperCase();
  const check = (digits: string) => (10 - [...digits].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 ? 3 : 1), 0) % 10) % 10;
  if (/^97[89]\d{10}$/.test(text)) return check(text.slice(0, 12)) === Number(text[12]) ? text : null;
  if (/^\d{9}[\dX]$/.test(text)) {
    const sum = [...text].reduce((total, char, index) => total + (char === 'X' ? 10 : Number(char)) * (10 - index), 0);
    if (sum % 11) return null;
    const base = `978${text.slice(0, 9)}`;
    return `${base}${check(base)}`;
  }
  return null;
}

export interface BookInput {
  number: BookNumber;
  /** Kmoe item name ("卷 01") when the file is a known Kmoe download. */
  itemName: string | null;
  /** The matching Bangumi volume (full subject). */
  volume: BgmSubject | null;
  language: Language | null;
  authors: { name: string; role: string }[];
  current: Record<string, unknown>;
  options: MetadataOptions;
}

export function bookPatch({ number, itemName, volume, language, authors, current, options }: BookInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (number.kind === 'volume' && number.number !== null) { body.number = number.label; body.numberSort = number.number; }
  if (itemName) body.title = itemName;
  if (volume) {
    // Kmoe files are Taiwan editions: prefer that edition's date and ISBN when Bangumi lists it.
    const edition = language === 'zh-Hant' ? traditionalEdition(volume) : null;
    const date = isoDate(edition?.['发售日']) ?? isoDate(volume.date) ?? isoDate(infobox(volume, '发售日')[0]);
    if (date) body.releaseDate = date;
    const isbn = isbn13(edition?.['ISBN']) ?? isbn13(infobox(volume, 'ISBN')[0]);
    if (isbn) body.isbn = isbn;
    if (volume.summary?.trim()) body.summary = volume.summary.trim();
    const links = ((current.links ?? []) as KomgaLink[]).filter(link => !OUR_LINKS.test(link.label.trim()));
    body.links = [...links, { label: 'Bangumi', url: subjectUrl(volume.id) }];
  }
  if (authors.length) body.authors = authors;
  return withLocks(body, options.lock);
}

// ---------- Diff ----------
const SETS = new Set(['genres', 'tags', 'sharingLabels']);
function comparable(key: string, value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) {
    const items = value.map(item => item && typeof item === 'object'
      ? JSON.stringify(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => [name, typeof entry === 'string' ? entry.trim() : entry]))
      : String(item).trim().toLowerCase());
    return JSON.stringify(SETS.has(key) ? items.sort() : items);
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(key === 'language' ? value.trim().toLowerCase() : value.trim());
  return JSON.stringify(value);
}

/** The part of `body` that differs from `current` (a field is resent when its lock differs too); null when nothing does. */
export function changes(body: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key.endsWith('Lock')) continue;
    const lock = body[`${key}Lock`];
    if (comparable(key, value) === comparable(key, current[key]) && (lock === undefined || current[`${key}Lock`] === lock)) continue;
    out[key] = value;
    if (lock !== undefined) out[`${key}Lock`] = lock;
  }
  return Object.keys(out).length ? out : null;
}

// ---------- Writing to Komga ----------
export interface SyncTools { komga: KomgaClient; bangumi: BangumiApi; fetch: typeof fetch; options: MetadataOptions; signal?: AbortSignal }
export interface SeriesJob {
  seriesId: string; subjectId: number; comic: ComicFacts | null; kmoeUrl: string | null;
  /** Komga library root, to turn book URLs into folder-relative paths. */
  root: string;
  /** Kmoe items by file path relative to the target (NFC). */
  files: Map<string, Pick<ItemRow, 'type' | 'name' | 'sort_order'>>;
  /** Title the files are named after (hint or Kmoe title). */
  fileTitle: string | null;
  /** Accepted AI summary and tags (see SeriesInput). */
  polish?: MetadataText | null;
}

const IMAGE_HOST = /(?:^|\.)bgm\.tv$/i;
async function image(url: string | undefined, tools: SyncTools): Promise<Blob | null> {
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !IMAGE_HOST.test(parsed.hostname)) return null;
  const timeout = AbortSignal.timeout(30_000);
  const response = await tools.fetch(parsed.href, { signal: tools.signal ? AbortSignal.any([tools.signal, timeout]) : timeout });
  if (!response.ok || !(response.headers.get('content-type') ?? '').startsWith('image/')) return null;
  const blob = await response.blob();
  return blob.size > 0 && blob.size <= 20 * 1024 * 1024 ? blob : null;
}

/** Bangumi cover as the selected poster, unless someone already uploaded one (ours included). Failures are only logged. */
async function poster(kind: 'series' | 'books', id: string, subject: BgmSubject, tools: SyncTools): Promise<void> {
  try {
    if ((await tools.komga.thumbnails(kind, id, tools.signal)).some(thumbnail => thumbnail.type === 'USER_UPLOADED')) return;
    for (const size of ['large', 'medium', 'common'] as const) {
      const bytes = await image(subject.images?.[size], tools);
      if (!bytes) continue;
      try {
        await tools.komga.upload(kind, id, { bytes, name: `bangumi-${subject.id}.jpg` }, tools.signal);
        return;
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'komga_too_large')) throw error;
      }
    }
  } catch (error) {
    if (tools.signal?.aborted) throw error;
    console.warn(`[metadata] ${kind} ${id} poster: ${errorMessage(error)}`);
  }
}

/**
 * Writes one series (and its books when enabled). Returns the subject, how many volumes Bangumi lists, and the book files
 * Komga lists (relative to the target; null when books are not written).
 */
export async function syncSeries(job: SeriesJob, tools: SyncTools): Promise<{ subject: BgmSubject; volumes: number; books: Set<string> | null }> {
  const { komga, bangumi, options, signal } = tools;
  const subject = await bangumi.subject(job.subjectId, signal);
  if (!subject) throw new AppError(404, 'bangumi_missing', `无法读取 Bangumi 条目 ${job.subjectId}（条目已删除，或是 R18 条目而未设置 Access Token）`);
  const persons = await bangumi.persons(subject.id, signal);
  const related = await bangumi.related(subject.id, signal);
  const series = await komga.series(job.seriesId, signal);
  const body = changes(seriesPatch({ subject, persons, related, comic: job.comic, kmoeUrl: job.kmoeUrl, current: series.metadata, options, polish: job.polish }), series.metadata);
  if (body) await komga.patch('series', series.id, body, signal);
  if (options.posters !== 'off') await poster('series', series.id, subject, tools);
  const volumes = volumeMap(related);
  let books: Set<string> | null = null;
  if (options.books) {
    books = new Set();
    const language = languageOf(job.comic), authors = bookAuthors(persons, subject);
    for (const book of await komga.books(series.id, signal)) {
      signal?.throwIfAborted();
      const path = below(job.root, book.url);
      if (path) books.add(path);
      const item = path ? job.files.get(path) : undefined;
      const number = item ? itemNumber(item) : bookNumber(book.name, job.fileTitle);
      const entry = number.kind === 'volume' && !number.range && number.number !== null ? volumes.get(number.number) : undefined;
      const volume = entry ? await bangumi.subject(entry.id, signal) : null;
      const update = changes(bookPatch({ number, itemName: item?.name ?? null, volume, language, authors, current: book.metadata, options }), book.metadata);
      if (update) await komga.patch('books', book.id, update, signal);
      if (options.posters === 'all' && volume) await poster('books', book.id, volume, tools);
    }
  }
  return { subject, volumes: volumes.size, books };
}
