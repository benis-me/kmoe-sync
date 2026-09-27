// Offline Bangumi data from the weekly Bangumi Archive dump (https://github.com/bangumi/Archive). Only what metadata
// needs is kept: book subjects, the relations between them, and their credited persons. The zip is streamed through
// `unzip -p` (never extracted) into a new SQLite file, which then answers the same BangumiApi as the online client.
import { Database } from 'bun:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { editions, infobox, isTraditionalEdition, type BangumiApi, type BgmInfobox, type BgmPerson, type BgmRelated, type BgmSubject } from './bangumi';
import { fold, isVolumeName } from './text';
import { parseWiki } from './wiki';

// Numeric codes used by the dump, as documented in bangumi/common; the names are the ones the online API returns.
const PLATFORMS: Record<number, string> = { 0: '其他', 1001: '漫画', 1002: '小说', 1003: '画集', 1004: '绘本', 1005: '写真', 1006: '公式书' };
const RELATIONS: Record<number, string> = {
  1: '改编', 1002: '系列', 1003: '单行本', 1004: '画集', 1005: '前传', 1006: '续集', 1007: '番外篇', 1008: '主线故事', 1010: '不同版本',
  1011: '角色出演', 1012: '相同世界观', 1013: '不同世界观', 1014: '联动', 1015: '不同演绎', 1099: '其他',
};
const POSITIONS: Record<number, string> = {
  2001: '作者', 2002: '作画', 2003: '插图', 2004: '出版社', 2005: '连载杂志', 2006: '译者', 2007: '原作', 2009: '人物原案', 2010: '脚本',
};
const CREATORS = [2001, 2002, 2007, 2009, 2010];
/** Infobox fields metadata reads (names, credits, publisher, magazine, dates, ISBN, volume count); the rest is not stored. */
const WIKI_KEYS = new Set(['中文名', '别名', '作者', '原作', '作画', '脚本', '原案', '人物原案', '插图', '出版社', '连载杂志', '发售日', '开始', '结束', 'ISBN', '册数']);
/** What is kept of an infobox: the fields above and the Traditional Chinese edition (other editions only feed search names). */
const kept = (entry: BgmInfobox) => WIKI_KEYS.has(entry.key) || (entry.key.startsWith('版本:') && Array.isArray(entry.value)
  && isTraditionalEdition(entry.key, Object.fromEntries(entry.value.map(item => [item.k ?? '', item.v ?? '']))));
const BOOK = 1;
const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE subjects (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_cn TEXT NOT NULL, platform INTEGER NOT NULL, series INTEGER NOT NULL, nsfw INTEGER NOT NULL,
    date TEXT, volumes INTEGER NOT NULL, summary TEXT NOT NULL, infobox TEXT NOT NULL, tags TEXT NOT NULL, meta_tags TEXT NOT NULL, popularity INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE subject_names USING fts5(names, tokenize = 'trigram');
  CREATE TABLE relations (subject_id INTEGER NOT NULL, related_id INTEGER NOT NULL, relation INTEGER NOT NULL, sort INTEGER NOT NULL,
    PRIMARY KEY (subject_id, related_id, relation)) WITHOUT ROWID;
  CREATE TABLE credits (subject_id INTEGER NOT NULL, person_id INTEGER NOT NULL, position INTEGER NOT NULL,
    PRIMARY KEY (subject_id, person_id, position)) WITHOUT ROWID;
  CREATE TABLE persons (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_cn TEXT, type INTEGER NOT NULL);
`;

export interface ArchiveInfo { dump: string; dumpDate: string | null; digest: string | null; importedAt: string; subjects: number }

// ---------- Import ----------
interface Entry { name: string; size: number }

function unzip(args: string[]): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  try { return Bun.spawn(['unzip', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }); } catch {
    throw new Error('找不到 unzip 命令：请安装 unzip（Docker 镜像已自带）');
  }
}

async function run(args: string[]): Promise<string> {
  const child = unzip(args);
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`unzip 失败（${code}）：${err.trim().slice(0, 300)}`);
  return out;
}

/** Entries of the zip with their uncompressed sizes (`unzip -l`). */
async function entries(zip: string): Promise<Entry[]> {
  return (await run(['-l', zip])).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line);
    return match && !match[2]!.endsWith('/') ? [{ name: match[2]!, size: Number(match[1]) }] : [];
  });
}

/** Calls `onLine` for every line of one zip entry, streamed from `unzip -p`. */
async function eachLine(zip: string, entry: string, onLine: (line: string) => void, onBytes: (bytes: number) => void, signal?: AbortSignal) {
  const child = unzip(['-p', zip, entry]);
  const abort = () => child.kill();
  signal?.addEventListener('abort', abort, { once: true });
  const errors = new Response(child.stderr).text();
  try {
    const decoder = new TextDecoder();
    let rest = '';
    for await (const chunk of child.stdout) {
      signal?.throwIfAborted();
      onBytes(chunk.byteLength);
      const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n');
      rest = lines.pop()!;
      for (const line of lines) if (line.trim()) onLine(line);
    }
    rest += decoder.decode();
    if (rest.trim()) onLine(rest);
    const code = await child.exited;
    signal?.throwIfAborted();
    if (code !== 0) throw new Error(`解压 ${entry} 失败（unzip ${code}）：${(await errors).trim().slice(0, 300)}`);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

interface DumpSubject {
  id: number; type: number; name?: string; name_cn?: string; infobox?: string; platform?: number; summary?: string; nsfw?: boolean; date?: string | null;
  series?: boolean; tags?: { name: string; count: number }[]; meta_tags?: string[]; favorite?: Record<string, number>;
}

/** Names a subject can be searched by: name, Chinese name, aliases and edition titles, folded (Traditional → Simplified). */
function searchNames(subject: BgmSubject): string {
  const names = [subject.name, subject.name_cn ?? '', ...infobox(subject, '中文名'), ...infobox(subject, '别名')];
  for (const { fields } of editions(subject)) names.push(fields['版本名'] ?? '', fields['别名'] ?? '');
  return [...new Set(names.map(fold).filter(Boolean))].join(' ');
}

/**
 * Builds a fresh archive database at `target` from a dump zip. Progress is reported in uncompressed bytes read.
 * Book subjects (type 1) are kept with their parsed infobox; relations only between two kept subjects; credits for the
 * book positions, and the persons they name (with their 简体中文名).
 */
export async function importDump(zip: string, target: string, info: Omit<ArchiveInfo, 'importedAt' | 'subjects'>,
  progress: (done: number, total: number) => void, signal?: AbortSignal): Promise<number> {
  const list = await entries(zip);
  const find = (name: string) => list.find(entry => basename(entry.name) === name);
  const files = { subjects: find('subject.jsonlines'), relations: find('subject-relations.jsonlines'), credits: find('subject-persons.jsonlines'), persons: find('person.jsonlines') };
  if (!files.subjects) throw new Error('离线数据包里没有 subject.jsonlines');
  const total = Object.values(files).reduce((sum, entry) => sum + (entry?.size ?? 0), 0);
  let done = 0, lines = 0, unreadable = 0;
  const bytes = (count: number) => { done += count; progress(done, total); };
  /** One bad line must not cost the whole weekly import; many mean the format changed. */
  const parse = <T>(line: string): T | null => {
    lines++;
    try { return JSON.parse(line) as T; } catch { unreadable++; return null; }
  };

  rmSync(target, { force: true });
  const db = new Database(target, { create: true, strict: true });
  try {
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -16384;');
    db.exec(SCHEMA);
    let pending = 0;
    db.exec('BEGIN');
    const batch = () => { if (++pending >= 5_000) { db.exec('COMMIT; BEGIN'); pending = 0; } };

    const books = new Set<number>();
    const addSubject = db.query(`INSERT OR REPLACE INTO subjects (id, name, name_cn, platform, series, nsfw, date, volumes, summary, infobox, tags, meta_tags, popularity)
      VALUES ($id, $name, $cn, $platform, $series, $nsfw, $date, $volumes, $summary, $infobox, $tags, $meta, $popularity)`);
    const addNames = db.query('INSERT INTO subject_names (rowid, names) VALUES (?, ?)');
    await eachLine(zip, files.subjects.name, line => {
      const row = parse<DumpSubject>(line);
      if (!row || row.type !== BOOK || !Number.isSafeInteger(row.id) || books.has(row.id)) return;
      const parsed = parseWiki(row.infobox);
      const subject: BgmSubject = { id: row.id, name: row.name ?? '', name_cn: row.name_cn ?? '', infobox: parsed };
      const volumes = Number(/\d+/.exec(infobox(subject, '册数')[0] ?? '')?.[0] ?? 0);
      addSubject.run({
        id: row.id, name: subject.name, cn: subject.name_cn ?? '', platform: row.platform ?? 0, series: row.series ? 1 : 0, nsfw: row.nsfw ? 1 : 0,
        date: /^\d{4}-\d{2}-\d{2}$/.test(row.date ?? '') ? row.date! : null, volumes: volumes > 0 && volumes < 10_000 ? volumes : 0, summary: row.summary?.trim() ?? '',
        infobox: JSON.stringify(parsed.filter(kept)),
        // A single volume's tags are never used (its series' are): not stored.
        tags: JSON.stringify(!row.series && isVolumeName(subject.name) ? [] : [...row.tags ?? []].sort((a, b) => b.count - a.count).slice(0, 30)),
        meta: JSON.stringify(row.meta_tags ?? []), popularity: Object.values(row.favorite ?? {}).reduce((sum, value) => sum + (Number(value) || 0), 0),
      });
      addNames.run(row.id, searchNames(subject));
      books.add(row.id);
      batch();
    }, bytes, signal);

    if (files.relations) {
      const addRelation = db.query('INSERT OR IGNORE INTO relations (subject_id, related_id, relation, sort) VALUES (?, ?, ?, ?)');
      await eachLine(zip, files.relations.name, line => {
        const row = parse<{ subject_id: number; related_subject_id: number; relation_type: number; order?: number }>(line);
        if (!row || !books.has(row.subject_id) || !books.has(row.related_subject_id)) return;
        addRelation.run(row.subject_id, row.related_subject_id, row.relation_type, row.order ?? 0);
        batch();
      }, bytes, signal);
    }

    const people = new Set<number>();
    if (files.credits) {
      const addCredit = db.query('INSERT OR IGNORE INTO credits (subject_id, person_id, position) VALUES (?, ?, ?)');
      await eachLine(zip, files.credits.name, line => {
        const row = parse<{ subject_id: number; person_id: number; position: number }>(line);
        if (!row || !books.has(row.subject_id) || !(row.position in POSITIONS)) return;
        addCredit.run(row.subject_id, row.person_id, row.position);
        people.add(row.person_id);
        batch();
      }, bytes, signal);
    }
    if (files.persons) {
      const addPerson = db.query('INSERT OR REPLACE INTO persons (id, name, name_cn, type) VALUES (?, ?, ?, ?)');
      await eachLine(zip, files.persons.name, line => {
        const row = parse<{ id: number; name?: string; type?: number; infobox?: string }>(line);
        if (!row || !people.has(row.id)) return;
        const chinese = infobox({ id: row.id, name: '', infobox: parseWiki(row.infobox) }, '简体中文名')[0] ?? null;
        addPerson.run(row.id, row.name ?? '', chinese, row.type ?? 1);
        batch();
      }, bytes, signal);
    }

    if (unreadable > lines / 100) throw new Error(`离线数据包格式无法识别（${unreadable} / ${lines} 行无法读取）`);
    if (unreadable) console.warn(`[metadata] Bangumi Archive ${info.dump}: skipped ${unreadable} unreadable lines`);
    const meta = db.query('INSERT INTO meta (key, value) VALUES (?, ?)');
    const complete: ArchiveInfo = { ...info, importedAt: new Date().toISOString(), subjects: books.size };
    for (const [key, value] of Object.entries(complete)) if (value !== null) meta.run(key, String(value));
    db.exec('COMMIT');
    db.run("INSERT INTO subject_names (subject_names) VALUES ('optimize')");
    return books.size;
  } finally {
    db.close();
  }
}

// ---------- Reading ----------
interface SubjectRow {
  id: number; name: string; name_cn: string; platform: number; series: number; nsfw: number; date: string | null; volumes: number; summary: string;
  infobox: string; tags: string; meta_tags: string; popularity: number;
}

/** The imported archive as a BangumiApi (answers like the online API; no images offline). */
export class ArchiveReader implements BangumiApi {
  private db: Database | null = null;
  private cachedInfo: ArchiveInfo | null | undefined;

  constructor(readonly file: string) {}

  get ready(): boolean { return this.info() !== null; }

  private handle(): Database {
    if (!this.db) {
      if (!existsSync(this.file)) throw new Error('Bangumi 离线数据尚未导入');
      this.db = new Database(this.file, { readonly: true, strict: true });
    }
    return this.db;
  }

  /** Forget the open file (after it was replaced by a new import). */
  close() {
    this.db?.close();
    this.db = null;
    this.cachedInfo = undefined;
  }

  info(): ArchiveInfo | null {
    if (this.cachedInfo !== undefined) return this.cachedInfo;
    if (!existsSync(this.file)) return null;
    try {
      const meta = Object.fromEntries(this.handle().query<{ key: string; value: string }, []>('SELECT key, value FROM meta').all().map(row => [row.key, row.value]));
      this.cachedInfo = meta.dump && meta.importedAt ? {
        dump: meta.dump, dumpDate: meta.dumpDate ?? null, digest: meta.digest ?? null, importedAt: meta.importedAt, subjects: Number(meta.subjects ?? 0),
      } : null;
    } catch {
      this.cachedInfo = null;
    }
    return this.cachedInfo;
  }

  private chineseCredits(id: number): string[] {
    return this.handle().query<{ name_cn: string }, [number]>(`SELECT DISTINCT p.name_cn FROM credits c JOIN persons p ON p.id = c.person_id
      WHERE c.subject_id = ? AND c.position IN (${CREATORS.join(',')}) AND p.name_cn IS NOT NULL AND p.name_cn != ''`).all(id).map(row => row.name_cn);
  }

  private toSubject(row: SubjectRow): BgmSubject {
    return {
      id: row.id, type: BOOK, name: row.name, name_cn: row.name_cn, summary: row.summary, series: row.series === 1, platform: PLATFORMS[row.platform] ?? '其他',
      date: row.date, images: null, infobox: JSON.parse(row.infobox), volumes: row.volumes, tags: JSON.parse(row.tags), meta_tags: JSON.parse(row.meta_tags),
      nsfw: row.nsfw === 1, credits_cn: this.chineseCredits(row.id),
    };
  }

  async subject(id: number): Promise<BgmSubject | null> {
    const row = this.handle().query<SubjectRow, [number]>('SELECT * FROM subjects WHERE id = ?').get(id);
    return row ? this.toSubject(row) : null;
  }

  async persons(id: number): Promise<BgmPerson[]> {
    return this.handle().query<{ id: number; name: string; type: number; position: number }, [number]>(`SELECT p.id, p.name, p.type, c.position
      FROM credits c JOIN persons p ON p.id = c.person_id WHERE c.subject_id = ? ORDER BY c.position, p.id`).all(id)
      .map(row => ({ id: row.id, name: row.name, type: row.type, relation: POSITIONS[row.position] ?? '' }));
  }

  async related(id: number): Promise<BgmRelated[]> {
    return this.handle().query<{ id: number; relation: number; name: string; name_cn: string }, [number]>(`SELECT r.related_id AS id, r.relation, s.name, s.name_cn
      FROM relations r JOIN subjects s ON s.id = r.related_id WHERE r.subject_id = ? ORDER BY r.sort, r.related_id`).all(id)
      .map(row => ({ id: row.id, type: BOOK, name: row.name, name_cn: row.name_cn, relation: RELATIONS[row.relation] ?? '其他' }));
  }

  /**
   * Like the online search (top 10): trigram full-text match on folded names (LIKE for queries under 3 characters),
   * then exact names first, prefixes next, series before single volumes, popular before obscure.
   */
  async search(keyword: string): Promise<BgmSubject[]> {
    const query = fold(keyword);
    if (!query) return [];
    const db = this.handle();
    type Hit = SubjectRow & { names: string };
    const hits = Array.from(query).length >= 3
      ? db.query<Hit, [string]>(`SELECT s.*, n.names FROM subject_names n JOIN subjects s ON s.id = n.rowid WHERE subject_names MATCH ? ORDER BY n.rank LIMIT 200`)
        .all(`"${query.replaceAll('"', '""')}"`)
      : db.query<Hit, [string, string]>(`SELECT s.*, n.names FROM subject_names n JOIN subjects s ON s.id = n.rowid WHERE n.names LIKE ? ESCAPE '\\'
        ORDER BY instr(' ' || n.names || ' ', ?) > 0 DESC, s.series DESC, s.popularity DESC LIMIT 200`)
        .all(`%${query.replace(/[\\%_]/g, char => `\\${char}`)}%`, ` ${query} `);
    const closeness = (names: string[]) => names.includes(query) ? 0 : names.some(name => name.startsWith(query)) ? 1 : 2;
    return hits.map(hit => ({ hit, names: hit.names.split(' ') }))
      .sort((a, b) => closeness(a.names) - closeness(b.names) || b.hit.series - a.hit.series || b.hit.popularity - a.hit.popularity
        || Math.min(...a.names.map(name => name.length)) - Math.min(...b.names.map(name => name.length)))
      .slice(0, 10).map(({ hit }) => this.toSubject(hit));
  }
}
