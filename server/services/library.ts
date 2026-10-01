// Series folders on disk ("library folders"): scan a storage target, match folders to Kmoe comics, map comics to
// existing folders, and keep folder rows in step with downloads. One folder = one Komga series. Files are never moved.
import type { AiVerdict, ComicFolder, ContentType, Format, KmoeCandidate, KmoeLinkState, LibraryCheck, LibraryCounts, LibraryFolder, LibraryJob, LibraryOverview } from '@shared/model';
import { joinPath, normalizePath, renderRule } from '@shared/naming';
import { AI_CONFIDENT, type AiService, type FolderFacts } from '../ai/service';
import { now, json, type DB } from '../db';
import type { EventHub } from '../events';
import { AppError } from '../http/errors';
import { kmoeThrottle } from '../kmoe/client';
import { KmoeError } from '../kmoe/errors';
import { errorMessage, isRetryable } from '../lib/retry';
import { canonicalTitle, fold, similarity } from '../metadata/text';
import { inspectLibrary } from '../storage';
import { StorageError } from '../storage/types';
import type { MetadataService } from '../metadata/service';
import type { ActivityLog } from './activity';
import type { ComicService } from './comics';
import type { JobContext, JobRunner } from './jobs';
import type { KmoeService } from './kmoe';
import type { SettingsStore } from './settings';
import type { SubscriptionService } from './subscriptions';
import type { TargetService } from './targets';

export interface FolderRow {
  id: number; target_id: number; path: string; name: string; books: number; format: Format | null; sample: string | null; hint: string | null;
  scanned_at: string | null; comic_id: number | null; kmoe_state: KmoeLinkState; kmoe_candidates: string; kmoe_score: number | null;
  kmoe_error: string | null; linked_by: string | null; kmoe_ai: string | null; created_at: string; updated_at: string;
}

const BOOK_FILE = /\.(epub|kepub|mobi|azw3?|pdf|cbz|cbr|cb7|zip|rar|7z)$/i;
const MAX_DEPTH = 3;
/**
 * Spacing between Kmoe page views in bulk jobs (imports, subscription batches). Kmoe's robots.txt asks for 10 s and it
 * redirects clients that go faster to a search engine for over an hour (a burst of ~120 requests in 80 s did it).
 */
export const BULK_PACE_MS = 10_000;
const DAY_MS = 86_400_000;

// ---------- Title helpers (pure, exported for tests) ----------
const BRANDED = /^\[(?:kmoe|mox|kox|koz|kzo|kxo|kxx|kzz|vol\.moe)[^\]]*\]\[([^\]]+)\]/i;
const SUFFIXED = /^(.+?)\s*[-_]\s*(?:卷|巻|話|话|番外|第|vol\b|v\d)/i;
/** The title the files were named after: "[Kmoe][X]卷01.epub" or "X-卷 01.epub" (majority vote). */
export function titleHint(files: string[]): string | null {
  const votes = new Map<string, number>();
  for (const file of files) {
    const stem = file.replace(/\.[^.]+$/, '');
    const title = (BRANDED.exec(stem)?.[1] ?? SUFFIXED.exec(stem)?.[1])?.trim();
    if (title) votes.set(title, (votes.get(title) ?? 0) + 1);
  }
  return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Search keywords for a folder: the file-name title first (it is the Kmoe title at download time), then the folder name. */
export function folderKeywords(name: string, hint: string | null): string[] {
  const stripped = name.replace(/[[(（【][^\])）】]*[\])）】]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = [hint, name, stripped].map(value => value?.trim() ?? '').filter(Boolean);
  const unique: string[] = [];
  for (const word of words) if (!unique.some(other => canonicalTitle(other) === canonicalTitle(word))) unique.push(word);
  return unique.slice(0, 2);
}

export interface FileIds { key: string | null; bookId: string | null }
/**
 * Kmoe ids in an EPUB's OPF: the comic key in `<dc:seriesid>KMOE:8a3dbd</dc:seriesid>` (files from 2026 on), and the book
 * id inside the 13-digit identifier every Kmoe EPUB has (KSBN/ISBN/MOXBID/KBOOKID: "200" + book id + group + position + check digit).
 */
export function opfIds(opf: string): FileIds {
  return {
    key: /<dc:seriesid>\s*KMOE:([A-Za-z0-9]{1,32})\s*</i.exec(opf)?.[1] ?? null,
    bookId: /<dc:identifier\b[^>]*>\s*200(\d{5})\d{5}(?!\d)/i.exec(opf)?.[1] ?? null,
  };
}
/** Title and author written in an EPUB's OPF: the series name (else the title before " - 卷01") and the creator. */
export function opfInfo(opf: string): { title: string | null; author: string | null } {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const text = (tag: string) => new RegExp(`<dc:${tag}\\b[^>]*>([^<]*)<`, 'i').exec(opf)?.[1]?.replace(/&(\w+);/g, (all, name: string) => entities[name] ?? all).trim() || null;
  return { title: text('series') ?? text('title')?.split(/\s+-\s+/)[0]?.trim() ?? null, author: text('creator') };
}
/** The OPF of an EPUB via `unzip -p` (the image ships unzip for the Bangumi archive); '' when there is none. */
async function readOpf(file: string): Promise<string> {
  const child = Bun.spawn(['unzip', '-p', file, '*.opf'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => child.kill(), 10_000);
  try { return await new Response(child.stdout).text(); } finally { clearTimeout(timer); }
}

const dominantFormat = (files: string[]): Format | null => {
  const epub = files.filter(file => /\.(k?epub)$/i.test(file)).length, mobi = files.filter(file => /\.(mobi|azw3?)$/i.test(file)).length;
  return epub || mobi ? (epub >= mobi ? 'epub' : 'mobi') : null;
};
const basename = (path: string) => path.split('/').filter(Boolean).at(-1) ?? '/';
const parent = (path: string) => joinPath('/', path.split('/').filter(Boolean).slice(0, -1).join('/'));
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

export class LibraryService {
  constructor(private readonly deps: {
    db: DB; hub: EventHub; comics: ComicService; targets: TargetService; kmoe: KmoeService; settings: SettingsStore; jobs: JobRunner; metadata: MetadataService;
    subscriptions: SubscriptionService; activity: ActivityLog;
    /** Spacing between Kmoe requests in bulk jobs (tests shorten it). */
    pace?: number;
  }) {}

  private get pace() { return this.deps.pace ?? BULK_PACE_MS; }

  /**
   * Runs a Kmoe call for a bulk job; while Kmoe throttles this service, waits (showing when it resumes) and tries again.
   * The job can be cancelled during the wait.
   */
  private async kmoeCall<T>(context: JobContext, resume: string, call: () => Promise<T>): Promise<T> {
    for (;;) {
      try { return await call(); } catch (error) {
        if (!(error instanceof KmoeError) || error.code !== 'rate_limited') throw error;
      }
      let waited = false;
      for (let cooldown = kmoeThrottle(); cooldown; cooldown = kmoeThrottle()) {
        waited = true;
        const minutes = Math.max(1, Math.ceil((cooldown.until - Date.now()) / 60_000));
        context.progress({ current: `Kmoe 暂时限制了访问频率，约 ${minutes} 分钟后继续` });
        await sleep(Math.min(15_000, Math.max(50, cooldown.until - Date.now())), context.signal);
      }
      // A 429 without a known end: give Kmoe a minute.
      if (!waited) await sleep(Math.min(60_000, this.pace * 10), context.signal);
      context.progress({ current: resume });
    }
  }

  // ---------- Rows & DTOs ----------
  row(id: number): FolderRow {
    const row = this.deps.db.query<FolderRow, [number]>('SELECT * FROM library_folders WHERE id = ?').get(id);
    if (!row) throw new AppError(404, 'folder_not_found', '找不到该文件夹');
    return row;
  }
  private rowAt(targetId: number, path: string): FolderRow | null {
    return this.deps.db.query<FolderRow, [number, string]>('SELECT * FROM library_folders WHERE target_id = ? AND path = ?').get(targetId, path);
  }
  private rowOfComic(comicId: number, targetId: number): FolderRow | null {
    return this.deps.db.query<FolderRow, [number, number]>('SELECT * FROM library_folders WHERE comic_id = ? AND target_id = ?').get(comicId, targetId);
  }

  private dtos(rows: FolderRow[]): LibraryFolder[] {
    const metadata = this.deps.metadata.forFolders(rows.map(row => row.id));
    return rows.map(row => {
      const comic = row.comic_id ? this.deps.comics.byId(row.comic_id) : null;
      return {
        id: row.id, targetId: row.target_id, path: row.path, name: row.name, books: row.books, format: row.format, sample: row.sample, hint: row.hint,
        kmoe: {
          state: row.kmoe_state, comic: comic ? this.deps.comics.summary(comic) : null, candidates: json<KmoeCandidate[]>(row.kmoe_candidates, []), score: row.kmoe_score,
          error: row.kmoe_error, ai: json<AiVerdict | null>(row.kmoe_ai, null),
        },
        metadata: metadata.get(row.id)!,
        scannedAt: row.scanned_at,
      };
    });
  }
  folder(id: number): LibraryFolder { return this.dtos([this.row(id)])[0]!; }

  overview(targetId: number): LibraryOverview {
    this.deps.targets.get(targetId);
    const rows = this.deps.db.query<FolderRow, [number]>('SELECT * FROM library_folders WHERE target_id = ? ORDER BY path COLLATE NOCASE').all(targetId);
    const folders = this.dtos(rows);
    const counts: LibraryCounts = {
      folders: folders.length, books: folders.reduce((sum, folder) => sum + folder.books, 0),
      kmoe: { pending: 0, suggested: 0, matched: 0, unmatched: 0, ignored: 0 },
      bangumi: { none: 0, matched: 0, suggested: 0, unmatched: 0 },
      komga: { disabled: 0, pending: 0, not_found: 0, synced: 0, error: 0 },
    };
    for (const folder of folders) { counts.kmoe[folder.kmoe.state]++; counts.bangumi[folder.metadata.bangumi.state]++; counts.komga[folder.metadata.komga.state]++; }
    return { targetId, scannedAt: this.scannedAt(targetId), job: this.deps.jobs.current(), counts, folders, follow: this.unfollowed(targetId).length };
  }

  private scannedAt(targetId: number): string | null {
    const scanned = this.deps.db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(`libraryScan:${targetId}`);
    return scanned ? json<string | null>(scanned.value, null) : null;
  }

  private touched(row: FolderRow) {
    this.deps.hub.emit({ type: 'folders', targetId: row.target_id });
    if (row.comic_id) this.deps.hub.emit({ type: 'comic', key: this.deps.comics.byId(row.comic_id).key });
    this.deps.hub.emit({ type: 'shelf' });
  }

  // ---------- Where a comic lives ----------
  /** The folder the naming rule gives this comic on a target, e.g. "/葬送的芙莉蓮". */
  ruleFolder(comicId: number, targetId: number): string {
    const comic = this.deps.comics.byId(comicId), target = this.deps.targets.resolved(targetId);
    const rendered = renderRule(target.rule, { title: comic.title, filename: 'file', bookname: 'file', author: json<string[]>(comic.authors, []), ext: 'epub' });
    return parent(joinPath('/', rendered));
  }

  /** The linked folder of a comic on a target (mapped by the user, found by import, or created by downloads). */
  folderFor(comicId: number, targetId: number): { id: number; path: string } | null {
    const row = this.rowOfComic(comicId, targetId);
    return row ? { id: row.id, path: row.path } : null;
  }

  comicFolder(comicId: number, targetId: number): ComicFolder {
    const rule = this.ruleFolder(comicId, targetId);
    const row = this.rowOfComic(comicId, targetId);
    if (row) return { targetId, path: row.path, mapped: row.path !== rule, folderId: row.id };
    return { targetId, path: rule, mapped: false, folderId: null };
  }

  /** A finished download: make sure its folder is a linked library folder and flag it for a metadata sync. */
  recordDelivery(comicId: number, targetId: number, file: string) {
    const directory = parent(normalizePath(file));
    if (directory === '/') return;
    const { db } = this.deps;
    const time = now();
    let row = this.rowAt(targetId, directory);
    if (!row) {
      const linked = this.rowOfComic(comicId, targetId);
      db.run(`INSERT INTO library_folders (target_id, path, name, books, format, sample, comic_id, kmoe_state, kmoe_score, linked_by, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'download', ?, ?)`,
        [targetId, directory, basename(directory), dominantFormat([file]), basename(file), linked ? null : comicId, linked ? 'pending' : 'matched', linked ? null : 1, time, time]);
      row = this.rowAt(targetId, directory)!;
    } else {
      const linkable = !row.comic_id && !this.rowOfComic(comicId, targetId);
      db.run(`UPDATE library_folders SET books = books + 1, sample = COALESCE(sample, ?), format = COALESCE(format, ?), updated_at = ?
        ${linkable ? ", comic_id = ?, kmoe_state = 'matched', kmoe_score = 1, linked_by = 'download'" : ''} WHERE id = ?`,
        linkable ? [basename(file), dominantFormat([file]), time, comicId, row.id] : [basename(file), dominantFormat([file]), time, row.id]);
      row = this.row(row.id);
    }
    this.deps.metadata.markDirty(row.id);
    this.deps.hub.emit({ type: 'folders', targetId });
  }

  /** Comics downloaded before folders were tracked: link each to the folder most of its files are in (idempotent, runs at start). */
  backfill() {
    const { db } = this.deps;
    const deliveries = db.query<{ comic_id: number; target_id: number; path: string }, []>(`SELECT i.comic_id, d.target_id, d.path
      FROM deliveries d JOIN items i ON i.id = d.item_id
      WHERE NOT EXISTS (SELECT 1 FROM library_folders f WHERE f.comic_id = i.comic_id AND f.target_id = d.target_id)`).all();
    const byComic = new Map<string, Map<string, string[]>>();
    for (const delivery of deliveries) {
      const directory = parent(delivery.path);
      if (directory === '/') continue;
      const key = `${delivery.comic_id}:${delivery.target_id}`;
      const folders = byComic.get(key) ?? new Map<string, string[]>();
      folders.set(directory, [...folders.get(directory) ?? [], basename(delivery.path)]);
      byComic.set(key, folders);
    }
    for (const [key, folders] of byComic) {
      const [comicId, targetId] = key.split(':').map(Number) as [number, number];
      const [directory, files] = [...folders].sort((a, b) => b[1].length - a[1].length)[0]!;
      const existing = this.rowAt(targetId, directory);
      if (existing?.comic_id) continue;
      const time = now();
      db.query(`INSERT INTO library_folders (target_id, path, name, books, format, sample, hint, comic_id, kmoe_state, kmoe_score, linked_by, created_at, updated_at)
        VALUES ($target, $path, $name, $books, $format, $sample, $hint, $comic, 'matched', 1, 'download', $now, $now)
        ON CONFLICT (target_id, path) DO UPDATE SET comic_id = excluded.comic_id, kmoe_state = 'matched', kmoe_score = 1, linked_by = 'download', updated_at = excluded.updated_at`)
        .run({ target: targetId, path: directory, name: basename(directory), books: files.length, format: dominantFormat(files), sample: files[0] ?? null, hint: titleHint(files), comic: comicId, now: time });
      this.deps.metadata.markDirty(this.rowAt(targetId, directory)!.id);
    }
  }

  // ---------- Library check ----------
  /** Compares a comic's folder on a target with its items; also forgets delivery records whose files are gone. */
  async check(comicId: number, targetId: number, format: Format): Promise<LibraryCheck> {
    const { comics, targets, db, hub } = this.deps;
    const comic = comics.byId(comicId);
    const target = targets.resolved(targetId);
    const items = comics.items(comicId);
    const folder = this.folderFor(comicId, targetId);
    const history = db.query<{ remote_id: string; path: string; size: number }, [number, number, string]>(
      'SELECT i.remote_id, d.path, d.size FROM deliveries d JOIN items i ON i.id = d.item_id WHERE i.comic_id = ? AND d.target_id = ? AND d.format = ? ORDER BY d.delivered_at DESC').all(comicId, targetId, format);
    const result = await inspectLibrary(targets.open(target), {
      title: comic.title, authors: json<string[]>(comic.authors, []), format, rule: target.rule, basePath: target.path, folder: folder?.path,
      chapters: items.map(item => ({ id: item.remote_id, label: item.name })),
    }, history.map(row => ({ itemId: row.remote_id, path: row.path, size: row.size, ok: true })));
    const check: LibraryCheck = { targetId, format, checkedAt: now(), ...result };
    db.transaction(() => {
      comics.saveLibrary(comicId, check);
      const byRemote = new Map(items.map(item => [item.remote_id, item.id]));
      for (const chapter of check.chapters) {
        if (chapter.status === 'missing') db.run('DELETE FROM deliveries WHERE item_id = ? AND target_id = ? AND format = ?', [byRemote.get(chapter.id) ?? 0, targetId, format]);
      }
    })();
    hub.emit({ type: 'comic', key: comic.key });
    return check;
  }

  /** Format to check an imported folder with: what its files are, else the global default. */
  private formatOf(row: FolderRow): Format { return row.format ?? this.deps.settings.get().defaultFormat; }

  /** Fetch the linked comic from Kmoe (items) and check the folder against it. */
  private async hydrate(row: FolderRow) {
    if (!row.comic_id) return;
    const comic = this.deps.comics.byId(row.comic_id);
    await this.deps.comics.sync(comic.key);
    await this.check(row.comic_id, row.target_id, this.formatOf(row));
    this.deps.db.run('UPDATE library_folders SET kmoe_error = NULL WHERE id = ?', [row.id]);
  }

  // ---------- Linking ----------
  private link(row: FolderRow, comicId: number, linkedBy: string, score: number | null) {
    const other = this.rowOfComic(comicId, row.target_id);
    if (other && other.id !== row.id) throw new AppError(409, 'comic_linked', `这部漫画已对应文件夹「${other.path}」，请先在那里取消关联`);
    this.deps.db.run(`UPDATE library_folders SET comic_id = ?, kmoe_state = 'matched', kmoe_score = ?, kmoe_error = NULL, linked_by = ?, updated_at = ? WHERE id = ?`,
      [comicId, score, linkedBy, now(), row.id]);
    this.deps.metadata.markDirty(row.id);
  }

  /** Link a folder to a Kmoe comic given as key or link (candidate, search result or pasted URL). */
  async linkFolder(id: number, input: string): Promise<LibraryFolder> {
    const row = this.row(id);
    const key = this.deps.comics.resolve(input);
    const { id: comicId } = await this.deps.comics.sync(key);
    this.link(row, comicId, 'manual', 1);
    const linked = this.row(id);
    await this.check(comicId, linked.target_id, this.formatOf(linked)).catch(error => this.fail(linked, error));
    this.touched(linked);
    return this.folder(id);
  }

  /** Not a change to the folder: updated_at (and the shelf order that follows it) stays. */
  private fail(row: FolderRow, error: unknown) {
    this.deps.db.run('UPDATE library_folders SET kmoe_error = ? WHERE id = ?', [errorMessage(error), row.id]);
  }

  ignore(id: number): LibraryFolder {
    const row = this.row(id);
    this.deps.db.run("UPDATE library_folders SET comic_id = NULL, kmoe_state = 'ignored', linked_by = NULL, updated_at = ? WHERE id = ?", [now(), id]);
    this.touched(row);
    return this.folder(id);
  }

  reset(id: number): LibraryFolder {
    const row = this.row(id);
    this.deps.db.run(`UPDATE library_folders SET comic_id = NULL, kmoe_state = 'pending', kmoe_candidates = '[]', kmoe_score = NULL, kmoe_error = NULL,
      kmoe_ai = NULL, linked_by = NULL, updated_at = ? WHERE id = ?`, [now(), id]);
    this.touched(row);
    return this.folder(id);
  }

  /** Link every suggested folder whose best candidate scores at least minScore; details are fetched in the background. */
  acceptSuggested(targetId: number, minScore: number): { linked: number } {
    const rows = this.deps.db.query<FolderRow, [number]>("SELECT * FROM library_folders WHERE target_id = ? AND kmoe_state = 'suggested'").all(targetId);
    let linked = 0;
    for (const row of rows) {
      const best = json<KmoeCandidate[]>(row.kmoe_candidates, [])[0];
      const comic = best && best.score >= minScore ? this.deps.comics.find(best.key) : null;
      if (!comic) continue;
      try { this.link(row, comic.id, 'accepted', best!.score); linked++; } catch { /* comic already has a folder here */ }
    }
    if (linked) {
      this.deps.hub.emit({ type: 'folders', targetId });
      this.deps.hub.emit({ type: 'shelf' });
      if (!this.deps.jobs.busy) this.startHydrate(targetId);
    }
    return { linked };
  }

  /** Map a comic to an existing folder on a target: downloads go there and the library check reads it. */
  async mapComic(key: string, targetId: number, rawPath: string) {
    const { comics, targets, db } = this.deps;
    const { id: comicId } = await comics.sync(key);
    let path: string;
    try { path = normalizePath(rawPath); } catch (error) { throw new AppError(400, 'invalid_path', errorMessage(error)); }
    if (path === '/') throw new AppError(400, 'invalid_path', '请选择书库里的一个文件夹，而不是根目录');
    const storage = targets.storage(targetId);
    const entries = await storage.list(path, { signal: AbortSignal.timeout(20_000) }).catch(error => {
      if (error instanceof StorageError && error.code === 'not_found') throw new AppError(404, 'folder_not_found', `文件夹不存在：${path}`);
      throw error;
    });
    const books = entries.filter(entry => !entry.directory && BOOK_FILE.test(entry.name)).map(entry => entry.name);
    const existing = this.rowAt(targetId, path);
    if (existing?.comic_id && existing.comic_id !== comicId) {
      throw new AppError(409, 'folder_linked', `这个文件夹已对应《${comics.byId(existing.comic_id).title}》`);
    }
    const time = now();
    db.transaction(() => {
      // One folder per comic and target: the previous one (if any) goes back to "pending".
      db.run("UPDATE library_folders SET comic_id = NULL, kmoe_state = 'pending', linked_by = NULL, updated_at = ? WHERE comic_id = ? AND target_id = ? AND path != ?", [time, comicId, targetId, path]);
      db.query(`INSERT INTO library_folders (target_id, path, name, books, format, sample, hint, scanned_at, comic_id, kmoe_state, kmoe_score, linked_by, created_at, updated_at)
        VALUES ($target, $path, $name, $books, $format, $sample, $hint, $now, $comic, 'matched', 1, 'manual', $now, $now)
        ON CONFLICT (target_id, path) DO UPDATE SET books = excluded.books, format = excluded.format, sample = excluded.sample, hint = excluded.hint,
          scanned_at = excluded.scanned_at, comic_id = excluded.comic_id, kmoe_state = 'matched', kmoe_score = 1, kmoe_error = NULL, linked_by = 'manual', updated_at = excluded.updated_at`)
        .run({ target: targetId, path, name: basename(path), books: books.length, format: dominantFormat(books), sample: books[0] ?? null, hint: titleHint(books), now: time, comic: comicId });
    })();
    const row = this.rowAt(targetId, path)!;
    this.deps.metadata.markDirty(row.id);
    const view = comics.view(comicId, {}, targetId);
    await this.check(comicId, targetId, view.format);
    this.touched(row);
  }

  /** Back to the naming rule's folder (files stay where they are). */
  async unmapComic(key: string, targetId: number) {
    const comic = this.deps.comics.row(key);
    const row = this.rowOfComic(comic.id, targetId);
    if (row) {
      this.deps.db.run("UPDATE library_folders SET comic_id = NULL, kmoe_state = 'pending', linked_by = NULL, updated_at = ? WHERE id = ?", [now(), row.id]);
      this.touched(row);
    }
    const view = this.deps.comics.view(comic.id, {}, targetId);
    await this.check(comic.id, targetId, view.format).catch(() => undefined);
  }

  // ---------- Jobs ----------
  /** Walk the target (up to 3 levels) and record every folder that directly contains books. */
  private async scanFolders(targetId: number, context: JobContext): Promise<number> {
    const { db, targets } = this.deps;
    const storage = targets.storage(targetId);
    const found = new Map<string, string[]>();
    const walk = async (path: string, depth: number): Promise<void> => {
      context.signal.throwIfAborted();
      context.progress({ current: path === '/' ? '书库根目录' : path, done: found.size });
      let entries;
      try { entries = await storage.list(path, { signal: context.signal }); } catch (error) {
        if (path === '/' || !(error instanceof StorageError)) throw error;
        return;
      }
      const books = entries.filter(entry => !entry.directory && BOOK_FILE.test(entry.name)).map(entry => entry.name);
      if (books.length && path !== '/') found.set(path, books);
      if (depth < MAX_DEPTH) for (const entry of entries) if (entry.directory) await walk(entry.path, depth + 1);
    };
    await walk('/', 0);
    const time = now();
    const before = new Map(db.query<{ path: string; books: number }, [number]>('SELECT path, books FROM library_folders WHERE target_id = ?').all(targetId).map(row => [row.path, row.books]));
    const upsert = db.query(`INSERT INTO library_folders (target_id, path, name, books, format, sample, hint, scanned_at, created_at, updated_at)
      VALUES ($target, $path, $name, $books, $format, $sample, $hint, $now, $now, $now)
      ON CONFLICT (target_id, path) DO UPDATE SET name = excluded.name, books = excluded.books, format = excluded.format, sample = excluded.sample,
        hint = excluded.hint, scanned_at = excluded.scanned_at, updated_at = excluded.updated_at`);
    db.transaction(() => {
      for (const [path, books] of found) {
        upsert.run({ target: targetId, path, name: basename(path), books: books.length, format: dominantFormat(books), sample: books[0] ?? null, hint: titleHint(books), now: time });
      }
      // Folders that vanished: forget them unless linked (a linked comic keeps its folder; the check shows what is missing).
      for (const row of db.query<FolderRow, [number]>('SELECT * FROM library_folders WHERE target_id = ?').all(targetId)) {
        if (found.has(row.path)) continue;
        if (row.comic_id) db.run('UPDATE library_folders SET books = 0, scanned_at = ? WHERE id = ?', [time, row.id]);
        else db.run('DELETE FROM library_folders WHERE id = ?', [row.id]);
      }
      // Folders this service downloaded into are already known: link them without asking Kmoe.
      const delivered = db.query<{ comic_id: number; path: string }, [number]>(
        'SELECT i.comic_id, d.path FROM deliveries d JOIN items i ON i.id = d.item_id WHERE d.target_id = ? GROUP BY i.comic_id, d.path').all(targetId);
      for (const { comic_id: comicId, path } of delivered) {
        const row = this.rowAt(targetId, parent(path));
        if (row && !row.comic_id && row.kmoe_state !== 'ignored' && !this.rowOfComic(comicId, targetId)) {
          db.run("UPDATE library_folders SET comic_id = ?, kmoe_state = 'matched', kmoe_score = 1, linked_by = 'download' WHERE id = ?", [comicId, row.id]);
        }
      }
    })();
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [`libraryScan:${targetId}`, JSON.stringify(time)]);
    // New folders and ones whose books changed get their metadata written; the rest are as Komga already has them.
    for (const row of db.query<{ id: number; path: string; books: number }, [number]>('SELECT id, path, books FROM library_folders WHERE target_id = ?').all(targetId)) {
      if (before.get(row.path) !== row.books) this.deps.metadata.markDirty(row.id);
    }
    this.deps.hub.emit({ type: 'folders', targetId });
    this.deps.hub.emit({ type: 'shelf' });
    return found.size;
  }

  /** Kmoe ids in the folder's sample EPUB, read in place (local targets). */
  private async fileIds(row: FolderRow): Promise<FileIds | null> {
    if (!row.sample || !/\.k?epub$/i.test(row.sample)) return null;
    const storage = this.deps.targets.storage(row.target_id);
    // ponytail: WebDAV folders are matched by title only; reading their EPUBs would need ranged GETs.
    if (!storage.localPath) return null;
    try {
      const ids = opfIds(await readOpf(await storage.localPath(joinPath(row.path, row.sample))));
      return ids.key || ids.bookId ? ids : null;
    } catch { return null; }
  }

  /**
   * Links a folder by the Kmoe ids in its files, without searching: numeric Kmoe keys are the book id itself; hex keys
   * come from the series id (files from 2026 on) or a comic already known here. One detail fetch, which the library
   * check needs anyway. False when the files don't settle it (then the title search runs).
   */
  private async matchByFile(row: FolderRow, ids: FileIds, context: JobContext): Promise<boolean> {
    const { comics, db } = this.deps;
    const known = ids.bookId ? db.query<{ key: string }, [string]>('SELECT key FROM comics WHERE book_id = ?').get(ids.bookId)?.key : undefined;
    const key = ids.key ?? known ?? ids.bookId!;
    let comicId: number;
    try { comicId = (await this.kmoeCall(context, row.path, () => comics.sync(key))).id; } catch (error) {
      // A hex-key comic has no page under its book id (Kmoe shows a list page or 404): search by title instead.
      if (key !== ids.bookId || !(error instanceof KmoeError) || (error.code !== 'not_found' && error.code !== 'site_changed')) throw error;
      await sleep(this.pace, context.signal);
      return false;
    }
    if ((ids.bookId && comics.byId(comicId).book_id !== ids.bookId) || this.rowOfComic(comicId, row.target_id)) return false;
    this.link(row, comicId, 'file', 1);
    await this.check(comicId, row.target_id, this.formatOf(this.row(row.id))).catch(error => this.fail(row, error));
    return true;
  }

  /** Searches Kmoe for each keyword (paced, stops at an identical title) and ranks the hits by title similarity. */
  private async searchKmoe(row: FolderRow, keywords: string[], context: JobContext): Promise<{ ranked: KmoeCandidate[]; exact: string | null }> {
    const candidates = new Map<string, KmoeCandidate>();
    let exact: string | null = null;
    for (const [position, keyword] of keywords.entries()) {
      if (position) await sleep(this.pace, context.signal);
      const result = await this.kmoeCall(context, row.path, () => this.deps.comics.search(keyword, 1));
      for (const hit of result.results) {
        // Folded: a Simplified folder name scores 1 against the Traditional Kmoe title.
        const score = Math.max(...keywords.map(word => similarity(fold(hit.title), fold(word))));
        const previous = candidates.get(hit.key);
        if (!previous || previous.score < score) candidates.set(hit.key, { key: hit.key, title: hit.title, authors: hit.authors, cover: hit.cover, latest: hit.latest, score: Math.round(score * 1000) / 1000 });
        if (!exact && keywords.some(word => fold(word) === fold(hit.title))) exact = hit.key;
      }
      if (exact) break;
    }
    return { ranked: [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 5), exact };
  }

  /**
   * Fetches a comic and links the folder to it, unless the book id in the files says it is another comic (same title,
   * another edition or translation) or the comic already has a folder here. False when it did not link.
   */
  private async linkChecked(row: FolderRow, key: string, ids: FileIds | null, linkedBy: string, score: number, context: JobContext): Promise<boolean> {
    const { comics } = this.deps;
    await sleep(this.pace, context.signal);
    const { id } = await this.kmoeCall(context, row.path, () => comics.sync(key));
    if ((ids?.bookId && comics.byId(id).book_id !== ids.bookId) || this.rowOfComic(id, row.target_id)) return false;
    this.link(row, id, linkedBy, score);
    await this.check(id, row.target_id, this.formatOf(this.row(row.id))).catch(error => this.fail(row, error));
    return true;
  }

  /** Searches Kmoe for the folder's title: an identical title is linked right away, close ones become suggestions to confirm. */
  private async matchBySearch(row: FolderRow, ids: FileIds | null, context: JobContext) {
    const { comics, db } = this.deps;
    const { ranked, exact } = await this.searchKmoe(row, folderKeywords(row.name, row.hint), context);
    const suggest = () => {
      const state: KmoeLinkState = ranked.length && ranked[0]!.score >= 0.5 ? 'suggested' : 'unmatched';
      db.run('UPDATE library_folders SET kmoe_state = ?, kmoe_candidates = ?, kmoe_score = ?, kmoe_error = NULL, updated_at = ? WHERE id = ?',
        [state, JSON.stringify(ranked), ranked[0]?.score ?? null, now(), row.id]);
    };
    if (!exact || this.rowOfComic(comics.find(exact)!.id, row.target_id)) return suggest();
    db.run('UPDATE library_folders SET kmoe_candidates = ?, updated_at = ? WHERE id = ?', [JSON.stringify(ranked), now(), row.id]);
    if (!await this.linkChecked(row, exact, ids, 'auto', 1, context)) suggest();
  }

  /** What the AI is told about a folder: its name, a few file names, and the title/author written inside the files. */
  async folderFacts(row: FolderRow): Promise<FolderFacts> {
    const storage = this.deps.targets.storage(row.target_id);
    const files = (await storage.list(row.path, { signal: AbortSignal.timeout(20_000) }).catch(() => []))
      .filter(entry => !entry.directory && BOOK_FILE.test(entry.name)).map(entry => entry.name);
    let info: { title: string | null; author: string | null } = { title: null, author: null };
    if (storage.localPath && row.sample && /\.k?epub$/i.test(row.sample)) {
      try { info = opfInfo(await readOpf(await storage.localPath(joinPath(row.path, row.sample)))); } catch { /* unreadable: names only */ }
    }
    const spread = files.length <= 4 ? files : [files[0]!, files[1]!, files[Math.floor(files.length / 2)]!, files.at(-1)!];
    return { path: row.path, name: row.name, hint: row.hint, books: row.books, files: spread, fileTitle: info.title, fileAuthor: info.author };
  }

  /**
   * AI pass over folders awaiting confirmation or not found: when nothing was found it searches again with the AI's other
   * spellings, then lets the AI pick among the candidates. A confident pick is linked (as an identical title would be);
   * otherwise the pick goes first among the suggestions, with the AI's reason.
   */
  startAiMatch(targetId: number, ai: AiService): LibraryJob {
    this.deps.targets.get(targetId);
    this.requireKmoe();
    ai.client();
    const { db, comics } = this.deps;
    const rows = db.query<FolderRow, [number]>(`SELECT * FROM library_folders WHERE target_id = ? AND comic_id IS NULL
      AND kmoe_state IN ('suggested', 'unmatched') ORDER BY path COLLATE NOCASE`).all(targetId);
    return this.deps.jobs.start('ai', targetId, async context => {
      context.progress({ total: rows.length, done: 0 });
      for (const [index, row] of rows.entries()) {
        context.signal.throwIfAborted();
        context.progress({ done: index, current: row.path });
        try {
          const facts = await this.folderFacts(row);
          let candidates = json<KmoeCandidate[]>(row.kmoe_candidates, []);
          if (!candidates.length) {
            const words = await ai.keywords('kmoe', facts, context.signal);
            if (words.length) candidates = (await this.searchKmoe(row, words, context)).ranked;
          }
          const verdict: AiVerdict = candidates.length
            ? await ai.judge('kmoe', facts, candidates.map(c => ({ id: c.key, line: `${c.title}｜作者：${c.authors.join('、') || '未知'}${c.latest ? `｜最新：${c.latest}` : ''}` })), context.signal)
            : { pick: null, confidence: 0, reason: '换了几种写法搜索，Kmoe 上都没有找到', at: now() };
          const pick = candidates.find(c => c.key === verdict.pick);
          const ordered = pick ? [pick, ...candidates.filter(c => c !== pick)] : candidates;
          db.run('UPDATE library_folders SET kmoe_state = ?, kmoe_candidates = ?, kmoe_score = ?, kmoe_ai = ?, kmoe_error = NULL, updated_at = ? WHERE id = ?',
            [ordered.length ? 'suggested' : 'unmatched', JSON.stringify(ordered), ordered[0]?.score ?? null, JSON.stringify(verdict), now(), row.id]);
          if (pick && verdict.confidence >= AI_CONFIDENT && comics.find(pick.key)) {
            await this.linkChecked(this.row(row.id), pick.key, await this.fileIds(row), 'ai', verdict.confidence, context);
          }
        } catch (error) {
          if (context.signal.aborted) throw error;
          // The AI itself failed (setup, budget, unreachable): every other folder would fail the same way.
          if (error instanceof AppError && error.code.startsWith('ai_')) throw error;
          if (error instanceof KmoeError && error.code === 'login_required') throw new AppError(409, 'kmoe_login_required', 'Kmoe 登录已失效，请重新登录后继续');
          this.fail(row, error);
        }
        this.deps.hub.emit({ type: 'folders', targetId });
      }
      context.progress({ done: rows.length, current: null });
      this.deps.hub.emit({ type: 'shelf' });
    });
  }

  /** Matches each folder to a Kmoe comic: by the ids in its files when they have them, else by title. */
  private async matchFolders(rows: FolderRow[], context: JobContext) {
    context.progress({ kind: 'kmoe', done: 0, total: rows.length });
    for (const [index, row] of rows.entries()) {
      context.signal.throwIfAborted();
      context.progress({ done: index, current: row.path });
      try {
        const ids = await this.fileIds(row);
        if (!ids || !await this.matchByFile(row, ids, context)) await this.matchBySearch(row, ids, context);
      } catch (error) {
        if (context.signal.aborted) throw error;
        if (error instanceof KmoeError && error.code === 'login_required') throw new AppError(409, 'kmoe_login_required', 'Kmoe 登录已失效，请重新登录后继续匹配');
        this.fail(row, error);
      }
      this.deps.hub.emit({ type: 'folders', targetId: row.target_id });
      await sleep(this.pace, context.signal);
    }
    context.progress({ done: rows.length, current: null });
    this.deps.hub.emit({ type: 'shelf' });
    // Matching takes 10 s a folder: the outcome goes to the activity feed (and the shelf), not only to this page.
    if (!rows.length) return;
    const after = rows.flatMap(row => this.deps.db.query<{ kmoe_state: KmoeLinkState; kmoe_error: string | null }, [number]>('SELECT kmoe_state, kmoe_error FROM library_folders WHERE id = ?').get(row.id) ?? []);
    const count = (state: KmoeLinkState) => after.filter(row => row.kmoe_state === state).length, failed = after.filter(row => row.kmoe_error).length;
    this.deps.activity.add({
      kind: 'info', level: failed ? 'warning' : 'success',
      title: `Kmoe 匹配：关联 ${count('matched')} 部，待确认 ${count('suggested')} 部，未找到 ${count('unmatched')} 部${failed ? `，失败 ${failed} 部` : ''}`,
    });
  }

  private requireKmoe() {
    if (this.deps.kmoe.account().state !== 'active') throw new AppError(409, 'kmoe_login_required', '匹配需要先在设置中登录 Kmoe');
  }

  scan(targetId: number, match: boolean): LibraryJob {
    this.deps.targets.get(targetId);
    if (match) this.requireKmoe();
    return this.deps.jobs.start('scan', targetId, async context => {
      await this.scanFolders(targetId, context);
      if (match) await this.matchFolders(this.pending(targetId, false), context);
    });
  }

  matchKmoe(targetId: number, retry: boolean): LibraryJob {
    this.deps.targets.get(targetId);
    this.requireKmoe();
    return this.deps.jobs.start('kmoe', targetId, context => this.matchFolders(this.pending(targetId, retry), context));
  }

  private pending(targetId: number, retry: boolean): FolderRow[] {
    return this.deps.db.query<FolderRow, [number]>(`SELECT * FROM library_folders WHERE target_id = ? AND comic_id IS NULL
      AND kmoe_state IN ('pending'${retry ? ", 'unmatched', 'suggested'" : ''}) ORDER BY path COLLATE NOCASE`).all(targetId);
  }

  /** Linked folders whose comic was never fetched from Kmoe or never checked against the folder. */
  private unhydrated(targetId?: number): FolderRow[] {
    return this.deps.db.query<FolderRow, []>(`SELECT f.* FROM library_folders f JOIN comics c ON c.id = f.comic_id
      WHERE ${targetId ? `f.target_id = ${Number(targetId)} AND` : ''} (c.book_id IS NULL OR c.fetched_at IS NULL OR NOT EXISTS (
        SELECT 1 FROM library_checks l WHERE l.comic_id = f.comic_id AND l.target_id = f.target_id)) ORDER BY f.id`).all();
  }

  private startHydrate(targetId: number): LibraryJob {
    return this.deps.jobs.start('kmoe', targetId, async context => {
      const rows = this.unhydrated(targetId);
      context.progress({ total: rows.length });
      for (const [index, row] of rows.entries()) {
        context.signal.throwIfAborted();
        context.progress({ done: index, current: row.path });
        await this.kmoeCall(context, row.path, () => this.hydrate(row)).catch(error => { if (context.signal.aborted) throw error; this.fail(row, error); });
        this.deps.hub.emit({ type: 'folders', targetId });
        await sleep(this.pace, context.signal);
      }
      this.deps.hub.emit({ type: 'shelf' });
    });
  }

  /**
   * Linked folders whose comic is still coming out (連載) and not followed. Not those with subscription downloads still
   * waiting (from an earlier subscription): a new one would cancel them.
   */
  private unfollowed(targetId: number): (FolderRow & { key: string })[] {
    return this.deps.db.query<FolderRow & { key: string }, [number]>(`SELECT f.*, c.key FROM library_folders f JOIN comics c ON c.id = f.comic_id
      WHERE f.target_id = ? AND (c.status LIKE '%連載%' OR c.status LIKE '%连载%') AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.comic_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.comic_id = c.id AND t.status = 'queued' AND t.origin = 'subscription')
      ORDER BY f.path COLLATE NOCASE`).all(targetId);
  }

  /**
   * Follows every ongoing comic linked here, for new items only (仅追新) and in its folder's format: nothing is downloaded
   * now and no quota spent. A Kmoe page per comic gives the baseline of what is out already, so this is paced like a scan.
   */
  follow(targetId: number): LibraryJob {
    this.deps.targets.get(targetId);
    this.requireKmoe();
    return this.deps.jobs.start('follow', targetId, async context => {
      const rows = this.unfollowed(targetId);
      let failed = 0;
      context.progress({ total: rows.length, done: 0 });
      for (const [index, row] of rows.entries()) {
        context.signal.throwIfAborted();
        context.progress({ done: index, current: row.path });
        // What the comic page offers by default: volumes, else the one kind of item the comic has.
        const present = (['volume', 'extra', 'serial'] as const).filter(type => this.deps.comics.items(row.comic_id!).some(item => item.type === type));
        const types: ContentType[] = present.includes('volume') || !present.length ? ['volume'] : [present[0]!];
        const input = { enabled: true, types, format: this.formatOf(row), targetId, strategy: 'future' as const, line: this.deps.settings.get().defaultLine };
        try { await this.kmoeCall(context, row.path, () => this.deps.subscriptions.save(row.key, input)); } catch (error) {
          if (context.signal.aborted) throw error;
          if (error instanceof KmoeError && error.code === 'login_required') throw new AppError(409, 'kmoe_login_required', 'Kmoe 登录已失效，请重新登录后继续');
          // Kmoe out of reach: the rest would fail the same way. Those done stay followed; starting again does the rest.
          if (error instanceof KmoeError && error.code === 'network') throw error;
          this.fail(row, error);
          failed++;
        }
        this.deps.hub.emit({ type: 'folders', targetId });
        await sleep(this.pace, context.signal);
      }
      context.progress({ done: rows.length, current: null });
      this.deps.activity.add({ kind: 'info', level: failed ? 'warning' : 'success', title: `追更：订阅了 ${rows.length - failed} 部连载（仅追新）${failed ? `，失败 ${failed} 部` : ''}` });
    });
  }

  /**
   * Scheduler hook: a library Komga reads is scanned once a day, so series put there by other means (copied in, another
   * downloader) are found and the metadata tick matches and writes them. A scan asks Kmoe nothing.
   */
  scanStale(targetIds: number[]) {
    if (this.deps.jobs.busy) return;
    const stale = targetIds.find(id => this.deps.targets.exists(id) && !(Date.now() - Date.parse(this.scannedAt(id) ?? '') < DAY_MS));
    if (stale !== undefined) this.scan(stale, false);
  }

  /**
   * Scheduler hook: quietly finish linked folders that still lack Kmoe details or a library check, one a minute. A folder
   * that failed (gone from Kmoe, unreadable) is left to the user instead of holding up the rest; Kmoe or the network being
   * down is not the folder's fault, so that one is tried again next minute.
   */
  async tick() {
    if (this.deps.jobs.busy || kmoeThrottle() || this.deps.kmoe.account().state !== 'active') return;
    const row = this.unhydrated().find(folder => !folder.kmoe_error);
    if (!row) return;
    try { await this.hydrate(row); } catch (error) {
      if (isRetryable(error)) return;
      this.fail(row, error);
    }
    this.touched(row);
  }
}
