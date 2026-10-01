// Download tasks: creation (with de-duplication), listing, and user actions. Execution lives in worker.ts.
import type { DownloadRequest, DownloadResult, QueueCounts, Task, TaskList, TaskStatus } from '@shared/model';
import { now, type DB } from '../db';
import type { EventHub } from '../events';
import { AppError } from '../http/errors';
import { itemSize, type ComicService, type ItemRow } from './comics';
import type { SettingsStore } from './settings';
import type { TargetService } from './targets';

export interface TaskRow {
  id: number; comic_id: number; item_id: number; target_id: number; format: Task['format']; line: 0 | 1; status: TaskStatus; phase: Task['phase'];
  attempt: number; retry_at: string | null; loaded: number; total: number | null; speed: number; path: string | null; error: string | null;
  error_code: string | null; origin: Task['origin']; cancel_requested: number; created_at: string; started_at: string | null; finished_at: string | null;
}
type JoinedRow = TaskRow & { comic_key: string; comic_title: string; cover_url: string | null; item_name: string; remote_id: string; type: Task['type']; target_name: string };

const SELECT = `SELECT t.*, c.key AS comic_key, c.title AS comic_title, c.cover_url, i.name AS item_name, i.remote_id, i.type, g.name AS target_name
  FROM tasks t JOIN comics c ON c.id = t.comic_id JOIN items i ON i.id = t.item_id JOIN targets g ON g.id = t.target_id`;

export interface WorkerControl { wake(): void; abort(id: number): void }

export class TaskService {
  worker: WorkerControl = { wake() {}, abort() {} };
  /** Called after queue membership changes (status bar counts). */
  onChange = () => {};

  constructor(private readonly db: DB, private readonly hub: EventHub, private readonly settings: SettingsStore, private readonly comics: ComicService, private readonly targets: TargetService) {}

  get maxAttempts() { const settings = this.settings.get(); return settings.autoRetry ? settings.maxRetries + 1 : 1; }

  row(id: number): TaskRow {
    const row = this.db.query<TaskRow, [number]>('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) throw new AppError(404, 'task_not_found', '找不到该任务');
    return row;
  }

  private dto = (row: JoinedRow): Task => ({
    id: row.id, comicKey: row.comic_key, comicTitle: row.comic_title, cover: row.cover_url ? `/api/covers/${row.comic_key}` : null,
    itemId: row.remote_id, itemName: row.item_name, type: row.type, format: row.format, targetId: row.target_id, targetName: row.target_name,
    status: row.status, phase: row.phase, attempt: row.attempt, maxAttempts: this.maxAttempts, retryAt: row.retry_at, loaded: row.loaded,
    total: row.total, speed: row.speed, path: row.path, error: row.error, errorCode: row.error_code, origin: row.origin,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
  });

  get(id: number): Task {
    const row = this.db.query<JoinedRow, [number]>(`${SELECT} WHERE t.id = ?`).get(id);
    if (!row) throw new AppError(404, 'task_not_found', '找不到该任务');
    return this.dto(row);
  }

  /** Pushes the task to live clients; `structural` also refreshes the comic page and status counts. */
  emit(id: number, structural = true) {
    const task = this.get(id);
    this.hub.emit({ type: 'task', task });
    if (structural) { this.hub.emit({ type: 'comic', key: task.comicKey }); this.onChange(); }
  }

  counts(): QueueCounts {
    const counts: QueueCounts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const row of this.db.query<{ status: TaskStatus; n: number }, []>('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all()) counts[row.status] = row.n;
    return counts;
  }

  list(query: { status?: TaskStatus; comicKey?: string; cursor?: number; limit?: number }): TaskList {
    const where: string[] = [], params: (string | number)[] = [];
    if (query.status) { where.push('t.status = ?'); params.push(query.status); }
    if (query.comicKey) { where.push('c.key = ?'); params.push(query.comicKey); }
    if (query.cursor) { where.push('t.id < ?'); params.push(query.cursor); }
    const limit = query.limit ?? 50;
    const rows = this.db.query<JoinedRow, (string | number)[]>(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.id DESC LIMIT ?`).all(...params, limit + 1);
    const page = rows.slice(0, limit);
    return { tasks: page.map(this.dto), counts: this.counts(), nextCursor: rows.length > limit ? page.at(-1)!.id : null };
  }

  /** Queues items that are not already delivered, queued or known to be in the library. */
  async create(request: DownloadRequest, origin: Task['origin']): Promise<DownloadResult> {
    if (!this.targets.exists(request.targetId)) throw new AppError(404, 'target_not_found', '找不到该存储位置');
    const { id: comicId } = await this.comics.sync(request.comicKey);
    const items = new Map(this.comics.items(comicId).map(item => [item.remote_id, item]));
    const unknown = request.itemIds.filter(id => !items.has(id));
    if (unknown.length === request.itemIds.length) throw new AppError(404, 'item_not_found', '所选章节在 Kmoe 上已不存在，请刷新后重试');
    return this.enqueue(comicId, request.itemIds.flatMap(id => items.get(id) ?? []), { targetId: request.targetId, format: request.format, line: request.line }, origin, unknown.length);
  }

  enqueue(comicId: number, items: ItemRow[], options: { targetId: number; format: Task['format']; line: 0 | 1 }, origin: Task['origin'], skipped = 0): DownloadResult {
    const states = this.comics.states(comicId, options.targetId, options.format);
    const created: number[] = [];
    let sizeMB = 0;
    this.db.transaction(() => {
      for (const item of items) {
        const state = states[item.remote_id]?.state;
        if (state === 'downloaded' || state === 'queued' || state === 'running') { skipped++; continue; }
        const result = this.db.run(`INSERT OR IGNORE INTO tasks (comic_id, item_id, target_id, format, line, status, origin, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
          [comicId, item.id, options.targetId, options.format, options.line, origin, now()]);
        if (!result.changes) { skipped++; continue; }
        created.push(Number(result.lastInsertRowid));
        sizeMB += itemSize(item, options.format);
      }
    })();
    for (const id of created) this.emit(id, false);
    if (created.length) {
      this.hub.emit({ type: 'comic', key: this.comics.byId(comicId).key });
      this.hub.emit({ type: 'shelf' });
      this.onChange();
      this.worker.wake();
    }
    return { created: created.length, skipped, sizeMB: Math.round(sizeMB * 10) / 10 };
  }

  cancel(id: number) {
    const row = this.row(id);
    if (row.status === 'queued') {
      this.db.run("UPDATE tasks SET status = 'cancelled', phase = NULL, retry_at = NULL, speed = 0, finished_at = ? WHERE id = ? AND status = 'queued'", [now(), id]);
      this.emit(id);
    } else if (row.status === 'running') {
      this.db.run('UPDATE tasks SET cancel_requested = 1 WHERE id = ?', [id]);
      this.worker.abort(id);
    } else throw new AppError(409, 'task_finished', '任务已经结束');
  }

  /** Cancels queued tasks (not running ones) matching a filter; used by subscription changes. */
  cancelQueued(ids: number[]) {
    for (const id of ids) {
      const result = this.db.run("UPDATE tasks SET status = 'cancelled', phase = NULL, retry_at = NULL, finished_at = ? WHERE id = ? AND status = 'queued'", [now(), id]);
      if (result.changes) this.emit(id, false);
    }
  }

  retry(id: number) {
    const row = this.row(id);
    if (row.status !== 'failed' && row.status !== 'cancelled') throw new AppError(409, 'task_active', '只能重试失败或已取消的任务');
    const active = this.db.query("SELECT 1 FROM tasks WHERE item_id = ? AND target_id = ? AND format = ? AND status IN ('queued', 'running')").get(row.item_id, row.target_id, row.format);
    if (active) throw new AppError(409, 'task_duplicate', '这一卷已经在队列中');
    this.db.run(`UPDATE tasks SET status = 'queued', phase = NULL, attempt = 0, retry_at = NULL, loaded = 0, total = NULL, speed = 0, error = NULL,
      error_code = NULL, cancel_requested = 0, started_at = NULL, finished_at = NULL WHERE id = ?`, [id]);
    this.emit(id);
    this.worker.wake();
  }

  retryFailed(): number {
    // Only the latest failure per item/target/format; older ones were superseded.
    const ids = this.db.query<{ id: number }, []>(`SELECT t.id FROM tasks t WHERE t.status = 'failed'
      AND t.id = (SELECT MAX(id) FROM tasks WHERE item_id = t.item_id AND target_id = t.target_id AND format = t.format)`).all().map(row => row.id);
    let retried = 0;
    for (const id of ids) { try { this.retry(id); retried++; } catch { /* became active meanwhile */ } }
    return retried;
  }

  /** Completed only: a cancelled task is how a subscription knows the user does not want that item. */
  clearFinished(): number {
    const removed = this.db.run("DELETE FROM tasks WHERE status = 'completed'").changes;
    if (removed) { this.hub.emit({ type: 'shelf' }); this.onChange(); }
    return removed;
  }
}
