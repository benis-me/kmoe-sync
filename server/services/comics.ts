// Comics and their items: cached from Kmoe, merged with what this service has queued, delivered or found in a library.
import { followedTypes, type ComicDetail, type ComicFolder, type ComicSummary, type ContentType, type FolderMetadata, type Format, type Item, type ItemStateInfo, type LibraryCheck, type SearchResult, type ShelfEntry, type Subscription } from '@shared/model';
import { json, now, type DB } from '../db';
import type { EventHub } from '../events';
import { AppError } from '../http/errors';
import { KmoeError } from '../kmoe/errors';
import { keyFromUrl, type DetailPage, type RemoteItem, type SearchHit } from '../kmoe/parser';
import type { KmoeSite } from '../kmoe/site';
import type { KmoeService } from './kmoe';
import type { SettingsStore } from './settings';

export interface ComicRow {
  id: number; key: string; book_id: string | null; title: string; authors: string; cover_url: string | null; language: string | null;
  status: string | null; description: string | null; latest: string | null; remote_updated_at: string | null; fetched_at: string | null;
}
export interface ItemRow { id: number; comic_id: number; remote_id: string; type: Item['type']; name: string; sort_order: number | null; pages: number | null; epub_mb: number | null; mobi_mb: number | null; first_seen_at: string; gone_at: string | null; is_new: number }
interface SubscriptionRow { id: number; comic_id: number; enabled: number; types: string; format: Format; target_id: number; strategy: Subscription['strategy']; line: 0 | 1; last_check_at: string | null; last_success_at: string | null; next_check_at: string | null; error: string | null; created_at: string }

/** Detail pages fetched within this window are served from the cache unless a refresh is asked for. */
const MAX_AGE_MS = 10 * 60_000;
const TYPE_RANK = { volume: 0, extra: 1, serial: 2 } as const;

export const itemSize = (item: Pick<ItemRow, 'epub_mb' | 'mobi_mb'>, format: Format) => (format === 'epub' ? item.epub_mb : item.mobi_mb) ?? 0;
/** New: from the latest check that found items, and first seen within two weeks (it does not stay new for good). */
const NEW_FOR_MS = 14 * 86_400_000;
const isFresh = (item: ItemRow) => item.is_new === 1 && Date.now() - Date.parse(item.first_seen_at) < NEW_FOR_MS;

/** Folder/metadata lookups supplied by the library and metadata services (wired in app.ts). */
export interface ComicHooks {
  folder(comicId: number, targetId: number): ComicFolder;
  metadata(folderId: number): FolderMetadata | null;
}

export class ComicService {
  private readonly syncing = new Map<string, Promise<{ id: number; added: ItemRow[] }>>();
  hooks: ComicHooks = { folder: (_comicId, targetId) => ({ targetId, path: '/', mapped: false, folderId: null }), metadata: () => null };

  constructor(private readonly db: DB, private readonly kmoe: KmoeService, private readonly hub: EventHub, private readonly settings: SettingsStore) {}

  // ---------- Rows ----------
  find(key: string): ComicRow | null { return this.db.query<ComicRow, [string]>('SELECT * FROM comics WHERE key = ?').get(key); }
  row(key: string): ComicRow {
    const row = this.find(key);
    if (!row) throw new AppError(404, 'comic_not_found', '找不到这部漫画');
    return row;
  }
  byId(id: number): ComicRow { return this.db.query<ComicRow, [number]>('SELECT * FROM comics WHERE id = ?').get(id)!; }

  items(comicId: number): ItemRow[] {
    return this.db.query<ItemRow, [number]>('SELECT * FROM items WHERE comic_id = ? AND gone_at IS NULL').all(comicId)
      .sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || (a.sort_order ?? 0) - (b.sort_order ?? 0) || Number(a.remote_id) - Number(b.remote_id));
  }

  subscriptionRow(comicId: number): SubscriptionRow | null { return this.db.query<SubscriptionRow, [number]>('SELECT * FROM subscriptions WHERE comic_id = ?').get(comicId); }
  subscriptionDto(row: SubscriptionRow, key: string): Subscription {
    return {
      id: row.id, comicKey: key, enabled: row.enabled === 1, types: json(row.types, ['volume']), format: row.format, targetId: row.target_id, strategy: row.strategy,
      line: row.line, lastCheckAt: row.last_check_at, lastSuccessAt: row.last_success_at, nextCheckAt: row.next_check_at, error: row.error, createdAt: row.created_at,
    };
  }

  summary(row: ComicRow): ComicSummary {
    const tracked = Boolean(this.db.query(`SELECT 1 WHERE EXISTS (SELECT 1 FROM subscriptions WHERE comic_id = ?1)
      OR EXISTS (SELECT 1 FROM tasks WHERE comic_id = ?1) OR EXISTS (SELECT 1 FROM deliveries d JOIN items i ON i.id = d.item_id WHERE i.comic_id = ?1)
      OR EXISTS (SELECT 1 FROM library_folders WHERE comic_id = ?1)`).get(row.id));
    return {
      key: row.key, title: row.title, authors: json(row.authors, []), cover: row.cover_url ? `/api/covers/${row.key}` : null,
      language: row.language, latest: row.latest, updatedAt: row.remote_updated_at, tracked,
    };
  }

  // ---------- Kmoe ----------
  /** Logged-in site when possible (keeps the session warm), anonymous otherwise; detail pages work either way. */
  private async onSite<T>(operation: (site: KmoeSite) => Promise<T>): Promise<T> {
    if (this.kmoe.account().state === 'active') return this.kmoe.withSession(operation);
    return operation(this.kmoe.siteOrAnonymous().site);
  }

  resolve(input: string): string {
    const key = keyFromUrl(input, this.kmoe.trustedHosts);
    if (!key) throw new AppError(400, 'invalid_link', '无法识别这个链接，请粘贴 Kmoe 漫画详情页地址');
    return key;
  }

  async search(q: string, page: number): Promise<SearchResult> {
    const result = await this.kmoe.withSession(site => site.search(q, page));
    const results = this.db.transaction(() => result.hits.map(hit => this.summary(this.cacheHit(hit))))();
    return { query: q, page: result.page, totalPages: result.totalPages, results };
  }

  private cacheHit(hit: SearchHit): ComicRow {
    this.db.query(`INSERT INTO comics (key, title, authors, cover_url, language, latest, remote_updated_at, created_at, updated_at)
      VALUES ($key, $title, $authors, $cover, $language, $latest, $updated, $now, $now)
      ON CONFLICT (key) DO UPDATE SET title = excluded.title, authors = excluded.authors, cover_url = COALESCE(excluded.cover_url, cover_url),
        language = COALESCE(excluded.language, language), latest = COALESCE(excluded.latest, latest), remote_updated_at = COALESCE(excluded.remote_updated_at, remote_updated_at), updated_at = excluded.updated_at`).run({ key: hit.key, title: hit.title, authors: JSON.stringify(hit.authors), cover: hit.cover, language: hit.language, latest: hit.latest, updated: hit.updatedAt, now: now() });
    return this.find(hit.key)!;
  }

  /**
   * Fetches the detail page and volume list and merges them into the cache. Items seen for the first time on an
   * already-known comic are flagged new (and returned); items that disappeared are hidden but keep their history.
   */
  sync(key: string, force = false): Promise<{ id: number; added: ItemRow[] }> {
    const cached = this.find(key);
    if (!force && cached?.fetched_at && cached.book_id && Date.now() - Date.parse(cached.fetched_at) < MAX_AGE_MS) return Promise.resolve({ id: cached.id, added: [] });
    let running = this.syncing.get(key);
    if (!running) {
      running = this.onSite(site => site.comic(key)).then(({ detail, items }) => this.merge(detail, items)).finally(() => this.syncing.delete(key));
      this.syncing.set(key, running);
    }
    return running;
  }

  private merge(detail: DetailPage, remote: RemoteItem[]): { id: number; added: ItemRow[] } {
    const result = this.db.transaction(() => {
      const time = now();
      this.db.query(`INSERT INTO comics (key, book_id, title, authors, cover_url, language, status, description, fetched_at, created_at, updated_at)
        VALUES ($key, $bookId, $title, $authors, $cover, $language, $status, $description, $now, $now, $now)
        ON CONFLICT (key) DO UPDATE SET book_id = excluded.book_id, title = excluded.title, authors = CASE WHEN excluded.authors = '[]' THEN authors ELSE excluded.authors END,
          cover_url = COALESCE(excluded.cover_url, cover_url), language = COALESCE(excluded.language, language), status = excluded.status,
          description = excluded.description, fetched_at = excluded.fetched_at, updated_at = excluded.updated_at`).run({ key: detail.key, bookId: detail.bookId, title: detail.title, authors: JSON.stringify(detail.authors), cover: detail.cover, language: detail.language,
          status: detail.status, description: detail.description, now: time });
      const comic = this.find(detail.key)!;
      const known = new Map(this.db.query<{ id: number; remote_id: string }, [number]>('SELECT id, remote_id FROM items WHERE comic_id = ?').all(comic.id).map(row => [row.remote_id, row.id]));
      const firstSync = known.size === 0;
      const addedIds: number[] = [];
      for (const item of remote) {
        const values = { comic: comic.id, remote: item.id, type: item.type, name: item.name, order: item.order, pages: item.pages, epub: item.epubMB, mobi: item.mobiMB, now: time };
        if (known.has(item.id)) {
          this.db.query(`UPDATE items SET type = $type, name = $name, sort_order = $order, pages = $pages, epub_mb = $epub, mobi_mb = $mobi, last_seen_at = $now, gone_at = NULL
            WHERE comic_id = $comic AND remote_id = $remote`).run(values);
        } else {
          const inserted = this.db.query(`INSERT INTO items (comic_id, remote_id, type, name, sort_order, pages, epub_mb, mobi_mb, first_seen_at, last_seen_at)
            VALUES ($comic, $remote, $type, $name, $order, $pages, $epub, $mobi, $now, $now)`).run(values);
          if (!firstSync) addedIds.push(Number(inserted.lastInsertRowid));
        }
      }
      const present = new Set(remote.map(item => item.id));
      for (const [remoteId, id] of known) if (!present.has(remoteId)) this.db.run('UPDATE items SET gone_at = COALESCE(gone_at, ?) WHERE id = ?', [time, id]);
      if (addedIds.length) {
        this.db.run('UPDATE items SET is_new = 0 WHERE comic_id = ?', [comic.id]);
        for (const id of addedIds) this.db.run('UPDATE items SET is_new = 1 WHERE id = ?', [id]);
      }
      const latest = remote.filter(item => item.type !== 'extra').at(-1)?.name ?? remote.at(-1)?.name ?? null;
      if (latest) this.db.run('UPDATE comics SET latest = ? WHERE id = ?', [latest, comic.id]);
      const added = addedIds.map(id => this.db.query<ItemRow, [number]>('SELECT * FROM items WHERE id = ?').get(id)!);
      return { id: comic.id, added };
    })();
    this.hub.emit({ type: 'comic', key: detail.key });
    return result;
  }

  // ---------- Item states ----------
  /** Where each item stands for one target + format: in the queue, delivered by us, found by a library check, failed, or missing. */
  states(comicId: number, targetId: number | null, format: Format): Record<string, ItemStateInfo> {
    const items = this.items(comicId);
    const result: Record<string, ItemStateInfo> = {};
    for (const item of items) result[item.remote_id] = { state: 'missing', paths: [], reason: null, taskId: null };
    if (targetId === null) return result;
    const byId = new Map(items.map(item => [item.id, item.remote_id]));
    const library = this.library(comicId, targetId, format);
    for (const chapter of library?.chapters ?? []) {
      const entry = result[chapter.id];
      if (!entry) continue;
      if (chapter.status === 'downloaded') Object.assign(entry, { state: 'downloaded', paths: chapter.paths, reason: '书库中已存在' });
      else if (chapter.status === 'unknown') Object.assign(entry, { state: 'unknown', paths: chapter.paths, reason: chapter.reason });
    }
    // Latest task per item decides failed/queued/running; deliveries win over an older failure.
    const tasks = this.db.query<{ id: number; item_id: number; status: string; error: string | null }, [number, number, string]>(
      `SELECT t.id, t.item_id, t.status, t.error FROM tasks t WHERE t.comic_id = ? AND t.target_id = ? AND t.format = ?
       AND t.id = (SELECT MAX(id) FROM tasks WHERE item_id = t.item_id AND target_id = t.target_id AND format = t.format)`).all(comicId, targetId, format);
    const deliveries = this.db.query<{ item_id: number; path: string }, [number, number, string]>(
      'SELECT d.item_id, d.path FROM deliveries d JOIN items i ON i.id = d.item_id WHERE i.comic_id = ? AND d.target_id = ? AND d.format = ?').all(comicId, targetId, format);
    for (const task of tasks) {
      const entry = result[byId.get(task.item_id) ?? ''];
      if (entry && task.status === 'failed' && entry.state !== 'downloaded') Object.assign(entry, { state: 'failed', reason: task.error, taskId: task.id });
    }
    for (const delivery of deliveries) {
      const entry = result[byId.get(delivery.item_id) ?? ''];
      if (entry) Object.assign(entry, { state: 'downloaded', paths: [delivery.path], reason: null });
    }
    for (const task of tasks) {
      const entry = result[byId.get(task.item_id) ?? ''];
      if (entry && (task.status === 'queued' || task.status === 'running')) Object.assign(entry, { state: task.status, reason: null, taskId: task.id });
    }
    return result;
  }

  library(comicId: number, targetId: number, format: Format): LibraryCheck | null {
    const row = this.db.query<{ result: string }, [number, number, string]>('SELECT result FROM library_checks WHERE comic_id = ? AND target_id = ? AND format = ?').get(comicId, targetId, format);
    return row ? json<LibraryCheck | null>(row.result, null) : null;
  }

  saveLibrary(comicId: number, check: LibraryCheck) {
    this.db.run(`INSERT INTO library_checks (comic_id, target_id, format, result, checked_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (comic_id, target_id, format) DO UPDATE SET result = excluded.result, checked_at = excluded.checked_at`,
      [comicId, check.targetId, check.format, JSON.stringify(check), check.checkedAt]);
  }

  /** The target/format a comic page shows by default: its subscription's, else the global defaults. */
  view(comicId: number, query: { targetId?: number; format?: Format }, defaultTarget: number | null): { targetId: number | null; format: Format } {
    const subscription = this.subscriptionRow(comicId);
    // An imported comic is shown where its folder is, in the format its files are in.
    const folders = this.db.query<{ target_id: number; format: Format | null }, [number]>('SELECT target_id, format FROM library_folders WHERE comic_id = ? ORDER BY id').all(comicId);
    const targetId = query.targetId ?? subscription?.target_id ?? (folders.find(folder => folder.target_id === defaultTarget) ?? folders[0])?.target_id ?? defaultTarget;
    const folderFormat = folders.find(folder => folder.target_id === targetId)?.format;
    return { targetId, format: query.format ?? subscription?.format ?? folderFormat ?? this.settings.get().defaultFormat };
  }

  /** Comic page data. Serves the cached copy when Kmoe is unreachable, so a NAS without internet still shows the library. */
  async detail(key: string, query: { targetId?: number; format?: Format }, defaultTarget: number | null, refresh = false): Promise<ComicDetail> {
    try { await this.sync(key, refresh); } catch (error) {
      const cached = this.find(key);
      if (!cached?.book_id || refresh || (error instanceof KmoeError && error.code === 'not_found')) throw error;
    }
    const row = this.row(key);
    const view = this.view(row.id, query, defaultTarget);
    const subscription = this.subscriptionRow(row.id);
    return {
      comic: { ...this.summary(row), bookId: row.book_id ?? '', description: row.description, status: row.status, fetchedAt: row.fetched_at ?? now() },
      items: this.items(row.id).map(item => ({
        id: item.remote_id, type: item.type, name: item.name, order: item.sort_order, pages: item.pages,
        sizeMB: { epub: item.epub_mb, mobi: item.mobi_mb }, isNew: isFresh(item),
      })),
      subscription: subscription ? this.subscriptionDto(subscription, row.key) : null,
      view,
      states: this.states(row.id, view.targetId, view.format),
      library: view.targetId === null ? null : this.library(row.id, view.targetId, view.format),
      ...this.folderInfo(row.id, view.targetId),
    };
  }

  /** The comic's series in Komga's web UI (its folder on this target, synced), for notifications to open. */
  seriesUrl(comicId: number, targetId: number): string | null {
    return this.folderInfo(comicId, targetId).metadata?.komga.seriesUrl ?? null;
  }

  private folderInfo(comicId: number, targetId: number | null): { folder: ComicFolder | null; metadata: FolderMetadata | null } {
    if (targetId === null) return { folder: null, metadata: null };
    const folder = this.hooks.folder(comicId, targetId);
    return { folder, metadata: folder.folderId ? this.hooks.metadata(folder.folderId) : null };
  }

  // ---------- Shelf ----------
  /** Everything subscribed, downloaded, queued or imported, with counts for its usual target and format. */
  shelf(defaultTarget: number | null): ShelfEntry[] {
    const rows = this.db.query<ComicRow & { last_activity: string | null }, []>(`
      SELECT c.*, MAX(COALESCE(MAX(COALESCE(t.finished_at, t.created_at)), ''), COALESCE(s.last_check_at, ''), COALESCE(s.created_at, ''),
        COALESCE((SELECT MAX(f.updated_at) FROM library_folders f WHERE f.comic_id = c.id), '')) AS last_activity
      FROM comics c LEFT JOIN subscriptions s ON s.comic_id = c.id LEFT JOIN tasks t ON t.comic_id = c.id
      WHERE s.id IS NOT NULL OR t.id IS NOT NULL OR EXISTS (SELECT 1 FROM deliveries d JOIN items i ON i.id = d.item_id WHERE i.comic_id = c.id)
        OR EXISTS (SELECT 1 FROM library_folders f WHERE f.comic_id = c.id)
      GROUP BY c.id`).all();
    return rows.map(row => {
      const subscription = this.subscriptionRow(row.id);
      const view = this.view(row.id, {}, defaultTarget);
      const byItem = view.targetId === null ? {} : this.states(row.id, view.targetId, view.format);
      const items = this.items(row.id);
      // Only the kinds of items followed: volumes alone are not 12/300 because of 300 chapters nobody wants.
      const types = followedTypes(subscription ? json<ContentType[]>(subscription.types, []) : null, items.filter(item => byItem[item.remote_id]?.state === 'downloaded').map(item => item.type));
      const followed = items.filter(item => types.includes(item.type)), states = followed.map(item => byItem[item.remote_id]?.state);
      const { metadata } = this.folderInfo(row.id, view.targetId);
      return {
        comic: { ...this.summary(row), tracked: true },
        subscription: subscription ? this.subscriptionDto(subscription, row.key) : null,
        counts: {
          items: followed.length,
          downloaded: states.filter(state => state === 'downloaded').length,
          queued: states.filter(state => state === 'queued' || state === 'running').length,
          failed: states.filter(state => state === 'failed').length,
          new: followed.filter(isFresh).length,
        },
        lastActivityAt: row.last_activity || null,
        metadata: metadata ? { bangumi: metadata.bangumi.state, komga: metadata.komga.state } : null,
      };
    }).sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  }
}
