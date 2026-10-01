// Download worker: claims queued tasks up to the concurrency limit and runs resolve → download → verify → store.
// Transient failures are retried with backoff (settings.autoRetry / maxRetries); quota and login problems pause the
// whole queue instead of burning retries.
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { open, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Format, PauseReason } from '@shared/model';
import { fileInfo, formatBytes, joinPath, renderRule } from '@shared/naming';
import { now, json, type DB } from '../db';
import { isOffline, KmoeError, offline } from '../kmoe/errors';
import { errorMessage, isRetryable, transientStatus } from '../lib/retry';
import { StorageError } from '../storage/types';
import type { ActivityLog } from './activity';
import { itemSize, type ComicService, type ItemRow } from './comics';
import type { KmoeService } from './kmoe';
import type { LibraryService } from './library';
import type { SettingsStore } from './settings';
import type { TaskRow, TaskService } from './tasks';
import type { TargetService } from './targets';

const IDLE_TIMEOUT_MS = 60_000;
/** Temp files must never take the worker down (a read-only or vanished disk makes rm throw even with force). */
const discard = (file: string) => rm(file, { force: true }).catch(() => {});
const PERSIST_EVERY_MS = 1000;

/** 2 s, 4 s, 8 s … capped at 60 s. */
export const retryDelay = (attempt: number) => Math.min(60_000, 2000 * 2 ** Math.max(0, attempt - 1));

class Paused extends Error { constructor(readonly reason: PauseReason, message: string) { super(message); } }

/** EPUB is a zip whose first entry is "mimetype"; MOBI has "BOOKMOBI" at offset 60. */
export function checkSignature(head: Uint8Array, format: Format): string | null {
  const text = new TextDecoder('latin1').decode(head);
  if (format === 'epub' ? text.startsWith('PK\x03\x04') : text.slice(60, 68) === 'BOOKMOBI') return null;
  if (/^\s*<(!doctype|html)/i.test(text)) return '下载到的是网页而不是电子书，可能是额度不足或登录失效';
  return `下载的文件不是有效的 ${format.toUpperCase()}`;
}

/** A complete zip ends with an end-of-central-directory record; a cut-off download does not. */
export async function isTruncatedZip(path: string): Promise<boolean> {
  const file = Bun.file(path);
  const tail = Buffer.from(await file.slice(Math.max(0, file.size - 65_557)).arrayBuffer());
  return tail.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1')) < 0;
}

/** A staged file that passes the checks made before uploading: the right kind of file, and (EPUB) not cut off. */
async function whole(path: string, format: Format): Promise<boolean> {
  return !checkSignature(new Uint8Array(await Bun.file(path).slice(0, 68).arrayBuffer()), format) && !(format === 'epub' && await isTruncatedZip(path));
}

interface Running { controller: AbortController; loaded: number; speed: number; lastAt: number; lastLoaded: number; persistedAt: number }

export class Worker {
  private readonly running = new Map<number, Running>();
  /** Resolved download links, reused on retry so a flaky connection does not ask Kmoe (and its quota) again. */
  private readonly links = new Map<number, { url: string; name: string }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private scheduled = false;
  private stopping = false;
  onChange = () => {};

  constructor(private readonly deps: {
    db: DB; tasks: TaskService; comics: ComicService; targets: TargetService; kmoe: KmoeService; settings: SettingsStore; activity: ActivityLog;
    library: LibraryService; tmpDir: string;
  }) {}
  private lastNetworkNotice = 0;

  get speed() { let total = 0; for (const entry of this.running.values()) total += entry.speed; return total; }
  get pauseReason(): PauseReason | null { return this.deps.settings.pause().reason; }

  start() {
    const { db, tmpDir } = this.deps;
    // A restart interrupts running tasks: put them back at the front of the queue.
    db.run("UPDATE tasks SET status = 'queued', phase = NULL, speed = 0, retry_at = NULL WHERE status = 'running'");
    db.run("UPDATE tasks SET status = 'cancelled', phase = NULL, finished_at = ? WHERE status = 'queued' AND cancel_requested = 1", [now()]);
    mkdirSync(tmpDir, { recursive: true });
    const keep = new Set(db.query<{ id: number }, []>("SELECT id FROM tasks WHERE status = 'queued'").all().map(row => `task-${row.id}.part`));
    for (const name of readdirSync(tmpDir)) if (!keep.has(name)) rmSync(join(tmpDir, name), { force: true, recursive: true });
    this.deps.tasks.worker = { wake: () => this.wake(), abort: id => this.running.get(id)?.controller.abort(new Error('cancelled')) };
    this.timer = setInterval(() => this.pump(), 5000);
    this.wake();
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const entry of this.running.values()) entry.controller.abort(new Error('shutdown'));
    const deadline = Date.now() + 5000;
    while (this.running.size && Date.now() < deadline) await Bun.sleep(50);
  }

  wake() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }

  pause(reason: PauseReason) {
    if (this.pauseReason === reason) return;
    this.deps.settings.setPause(reason);
    this.onChange();
  }

  resume() {
    if (!this.pauseReason) return;
    this.deps.settings.setPause(null);
    this.onChange();
    this.wake();
  }

  private pump() {
    if (this.stopping || this.pauseReason) return;
    const { db, settings } = this.deps;
    const limit = settings.get().concurrency;
    while (this.running.size < limit) {
      const busy = [...this.running.keys()];
      const row = db.query<TaskRow, (string | number)[]>(`SELECT * FROM tasks WHERE status = 'queued' AND (retry_at IS NULL OR retry_at <= ?)
        ${busy.length ? `AND id NOT IN (${busy.map(() => '?').join(',')})` : ''} ORDER BY retry_at IS NOT NULL, origin = 'subscription', id LIMIT 1`).get(now(), ...busy);
      if (!row) return;
      // What the user picked (or an API call asked for) goes before subscription backfill: the quota goes to it first.
      // Claim atomically: another instance on the same data must not start the same task.
      const claimed = db.run("UPDATE tasks SET status = 'running', phase = 'resolving', retry_at = NULL, started_at = COALESCE(started_at, ?), speed = 0 WHERE id = ? AND status = 'queued'", [now(), row.id]);
      if (!claimed.changes) continue;
      const entry: Running = { controller: new AbortController(), loaded: 0, speed: 0, lastAt: Date.now(), lastLoaded: 0, persistedAt: 0 };
      this.running.set(row.id, entry);
      this.deps.tasks.emit(row.id);
      void this.run(row, entry)
        .catch(error => console.error(`[task ${row.id}] worker error`, error))
        .finally(() => { this.running.delete(row.id); this.onChange(); this.wake(); });
    }
  }

  private phase(id: number, phase: TaskRow['phase'], extra: { loaded?: number; total?: number | null; path?: string } = {}) {
    this.deps.db.run('UPDATE tasks SET phase = ?, loaded = COALESCE(?, loaded), total = COALESCE(?, total), path = COALESCE(?, path) WHERE id = ?',
      [phase, extra.loaded ?? null, extra.total ?? null, extra.path ?? null, id]);
    this.deps.tasks.emit(id, false);
  }

  private progress(id: number, entry: Running, loaded: number, total: number | null) {
    const time = Date.now();
    entry.loaded = loaded;
    if (time - entry.lastAt >= 500) {
      const instant = ((loaded - entry.lastLoaded) * 1000) / (time - entry.lastAt);
      entry.speed = entry.speed ? entry.speed * 0.7 + instant * 0.3 : instant;
      entry.lastAt = time; entry.lastLoaded = loaded;
    }
    if (time - entry.persistedAt < PERSIST_EVERY_MS && loaded !== total) return;
    entry.persistedAt = time;
    this.deps.db.run('UPDATE tasks SET loaded = ?, total = ?, speed = ? WHERE id = ?', [loaded, total, Math.round(entry.speed), id]);
    this.deps.tasks.emit(id, false);
  }

  /** Downloads are staged under /data: refuse before asking Kmoe (and spending quota) when it cannot hold the file. */
  private async ensureSpace(sizeMB: number) {
    let free: number;
    try { const info = await statfs(this.deps.tmpDir); free = Number(info.bavail) * Number(info.bsize); } catch { return; }
    const need = sizeMB * 1024 * 1024 * 1.1 + 64 * 1024 * 1024;
    if (free < need) throw new StorageError('no_space', `数据目录空间不足：剩余 ${formatBytes(free)}，暂存这一卷约需 ${formatBytes(need)}，请清理 /data 所在的磁盘`);
  }

  private guardQuota(item: ItemRow, format: Format) {
    const account = this.deps.kmoe.account();
    const reserve = this.deps.settings.get().quotaReserveMB;
    if (account.state !== 'active' || account.remainingMB === null) return;
    if (account.remainingMB - itemSize(item, format) < reserve) {
      throw new Paused('quota', `Kmoe 剩余额度约 ${Math.round(account.remainingMB)} MB，已低于保留额度 ${reserve} MB`);
    }
  }

  private async run(task: TaskRow, entry: Running) {
    const { db, comics, targets, kmoe, tasks } = this.deps;
    const signal = entry.controller.signal;
    const comic = comics.byId(task.comic_id);
    const item = db.query<ItemRow, [number]>('SELECT * FROM items WHERE id = ?').get(task.item_id)!;
    const target = targets.resolved(task.target_id);
    const storage = targets.open(target);
    // Downloads are staged under /data, never inside the user's library share; put() copies them into place.
    const scratch = this.deps.tmpDir;
    const part = join(scratch, `task-${task.id}.part`);
    try {
      // The whole file is staged already (its upload failed, or a restart came while it uploaded): it goes up again as it
      // is, instead of asking Kmoe for it again (a new link, a resume Kmoe refuses, then the whole transfer).
      // (The size alone is not enough: without a Content-Length the recorded total is what arrived before a cut.)
      const staged = task.total !== null && task.path !== null && await stat(part).then(info => info.size === task.total, () => false) && await whole(part, task.format);
      let relative = staged ? task.path!.replace(/^\//, '') : '';
      let download = { size: task.total ?? 0 };
      if (!staged) {
        this.guardQuota(item, task.format);
        await this.ensureSpace(itemSize(item, task.format));
        let link = this.links.get(task.id);
        if (!link) {
          link = await kmoe.withSession(site => site.downloadLink({ key: comic.key, bookId: comic.book_id ?? '', itemId: item.remote_id, format: task.format, line: task.line }));
          this.links.set(task.id, link);
        }
        signal.throwIfAborted();
        mkdirSync(scratch, { recursive: true });
        this.phase(task.id, 'downloading');
        const name = link.name;
        download = await this.download(link.url, part, signal, (header) => {
          const info = fileInfo(name, header, comic.title, item.name, task.format);
          relative = renderRule(target.rule, { title: comic.title, filename: info.stem, bookname: item.name, author: json(comic.authors, []), ext: info.ext });
          // A comic mapped to (or already living in) a folder keeps its files there; the rule only names the file.
          const folder = this.deps.library.folderFor(comic.id, task.target_id);
          if (folder) relative = joinPath(folder.path, relative.split('/').at(-1)!);
          this.phase(task.id, 'downloading', { path: joinPath('/', relative) });
        }, (loaded, total) => this.progress(task.id, entry, loaded, total));
      }

      this.phase(task.id, 'verifying');
      const head = new Uint8Array(await Bun.file(part).slice(0, 68).arrayBuffer());
      const invalid = checkSignature(head, task.format);
      if (invalid) { this.links.delete(task.id); await discard(part); throw new KmoeError('refused', invalid); }
      // Kept for a ranged resume on the next attempt.
      if (task.format === 'epub' && await isTruncatedZip(part)) throw new KmoeError('network', '下载的 EPUB 不完整，将续传');

      this.phase(task.id, 'uploading', { loaded: 0, total: download.size });
      entry.speed = 0; entry.lastLoaded = 0; entry.lastAt = Date.now();
      const outcome = await storage.put(relative, { path: part, size: download.size }, { signal, onProgress: (sent, total) => this.progress(task.id, entry, sent, total) });
      await discard(part);
      this.links.delete(task.id);

      const path = joinPath('/', relative);
      db.transaction(() => {
        db.run(`INSERT INTO deliveries (item_id, target_id, format, path, size, delivered_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (item_id, target_id, format) DO UPDATE SET path = excluded.path, size = excluded.size, delivered_at = excluded.delivered_at`,
          [task.item_id, task.target_id, task.format, path, download.size, now()]);
        db.run(`UPDATE tasks SET status = 'completed', phase = NULL, loaded = ?, total = ?, speed = 0, path = ?, error = ?, error_code = NULL, finished_at = ? WHERE id = ?`,
          [download.size, download.size, path, outcome === 'exists' ? '目标位置已有同样大小的文件，未覆盖' : null, now(), task.id]);
      })();
      kmoe.recordUsage(download.size / 1024 / 1024);
      tasks.emit(task.id);
      try { this.deps.library.recordDelivery(comic.id, task.target_id, path); } catch (error) { console.error(`[task ${task.id}] library folder`, error); }
      this.deps.activity.add({
        kind: 'download_done', level: 'success', comicId: comic.id, title: `《${comic.title}》下载了 1 个文件`, detail: item.name,
        merge: previous => {
          const count = Number(/下载了 (\d+) 个文件/.exec(previous.title)?.[1] ?? 1) + 1;
          const names = `${previous.detail ?? ''}、${item.name}`.replace(/^、/, '');
          return { title: `《${comic.title}》下载了 ${count} 个文件`, detail: names.length > 120 ? `${names.slice(0, 117)}…` : names };
        },
      });
    } catch (error) {
      await this.fail(task, comic, item, part, error, signal);
    }
  }

  private async fail(task: TaskRow, comic: { id: number; title: string }, item: ItemRow, part: string, error: unknown, signal: AbortSignal) {
    const { db, tasks, activity, kmoe } = this.deps;
    const requeue = (message: string | null, code: string | null) => {
      db.run("UPDATE tasks SET status = 'queued', phase = NULL, speed = 0, error = ?, error_code = ? WHERE id = ?", [message, code, task.id]);
      tasks.emit(task.id);
    };
    const reason = signal.aborted ? errorMessage(signal.reason) : '';
    if (reason === 'shutdown') return requeue(null, null);
    if (reason === 'cancelled' || db.query<{ c: number }, [number]>('SELECT cancel_requested AS c FROM tasks WHERE id = ?').get(task.id)?.c) {
      await discard(part);
      this.links.delete(task.id);
      db.run("UPDATE tasks SET status = 'cancelled', phase = NULL, speed = 0, finished_at = ? WHERE id = ?", [now(), task.id]);
      return tasks.emit(task.id);
    }
    if (error instanceof Paused) {
      requeue(error.message, `paused_${error.reason}`);
      if (this.pauseReason !== error.reason) activity.add({ kind: 'quota_low', level: 'warning', title: '下载额度不足，队列已暂停', detail: error.message });
      return this.pause(error.reason);
    }
    if (error instanceof KmoeError && error.code === 'quota_exhausted') {
      this.links.delete(task.id);
      requeue(error.message, 'kmoe_quota_exhausted');
      if (this.pauseReason !== 'quota') activity.add({ kind: 'quota_low', level: 'warning', title: 'Kmoe 下载额度已用完，队列已暂停', detail: '额度恢复后在下载页点「继续」，或等待每日检查自动恢复' });
      await kmoe.refresh().catch(() => {});
      return this.pause('quota');
    }
    if (error instanceof KmoeError && error.code === 'login_required') {
      // KmoeService.expire() already paused the queue for 'auth' through its hook.
      this.links.delete(task.id);
      requeue(error.message, 'kmoe_login_required');
      return this.pause('auth');
    }
    if (error instanceof KmoeError && error.code === 'rate_limited') {
      // Kmoe throttles this service for minutes: retrying every few seconds would only extend it. Wait for the cooldown.
      db.run("UPDATE tasks SET status = 'queued', phase = NULL, speed = 0, error = ?, error_code = 'kmoe_rate_limited' WHERE id = ?", [error.message, task.id]);
      tasks.emit(task.id);
      if (this.pauseReason !== 'throttled') activity.add({ kind: 'queue_paused', level: 'warning', title: 'Kmoe 暂时限制访问频率，下载队列已暂停', detail: `${error.message}。` });
      return this.pause('throttled');
    }
    if (error instanceof KmoeError && error.code === 'download_expired') this.links.delete(task.id);
    const settings = this.deps.settings.get();
    const attempt = task.attempt + 1;
    const code = error instanceof KmoeError ? `kmoe_${error.code}` : error instanceof StorageError ? `storage_${error.code}` : null;
    const message = errorMessage(error);
    if (settings.autoRetry && attempt <= settings.maxRetries && isRetryable(error)) {
      db.run("UPDATE tasks SET status = 'queued', phase = 'waiting', attempt = ?, retry_at = ?, speed = 0, error = ?, error_code = ? WHERE id = ?",
        [attempt, new Date(Date.now() + retryDelay(attempt)).toISOString(), message, code, task.id]);
      tasks.emit(task.id, false);
      setTimeout(() => this.wake(), retryDelay(attempt) + 50);
      return;
    }
    if (isOffline(error) || (error instanceof StorageError && error.code === 'network')) {
      // The connection itself is down (not this file): wait for the network instead of failing everything that is queued.
      db.run("UPDATE tasks SET status = 'queued', phase = NULL, attempt = 0, retry_at = NULL, speed = 0, error = ?, error_code = ? WHERE id = ?", [message, code, task.id]);
      tasks.emit(task.id);
      if (Date.now() - this.lastNetworkNotice > 3_600_000) {
        this.lastNetworkNotice = Date.now();
        activity.add({ kind: 'queue_paused', level: 'warning', title: '网络中断，下载队列已暂停', detail: `${message}。每隔几分钟会自动重试。` });
      }
      return this.pause('network');
    }
    await discard(part);
    this.links.delete(task.id);
    db.run("UPDATE tasks SET status = 'failed', phase = NULL, attempt = ?, retry_at = NULL, speed = 0, error = ?, error_code = ?, finished_at = ? WHERE id = ?",
      [attempt, message, code, now(), task.id]);
    tasks.emit(task.id);
    if (!(error instanceof KmoeError) && !(error instanceof StorageError) && !isRetryable(error)) console.error(`[task ${task.id}]`, error);
    activity.add({
      kind: 'download_failed', level: 'error', comicId: comic.id, title: `《${comic.title}》${item.name} 下载失败`, detail: message,
      merge: previous => {
        const count = Number(/(\d+) 个文件下载失败/.exec(previous.title)?.[1] ?? 1) + 1;
        return { title: `《${comic.title}》${count} 个文件下载失败`, detail: message };
      },
    });
  }

  /**
   * Streams the file to `file`, resuming a previous partial download with a Range request. `named` receives the
   * Content-Disposition header before the body is read, so the destination path is known early.
   */
  private async download(url: string, file: string, signal: AbortSignal, named: (header: string | null) => void, progress: (loaded: number, total: number | null) => void): Promise<{ size: number }> {
    const existing = await stat(file).then(info => info.size, () => 0);
    const idle = new AbortController();
    let idleTimer = setTimeout(() => idle.abort(new DOMException('idle', 'TimeoutError')), IDLE_TIMEOUT_MS);
    const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(new DOMException('idle', 'TimeoutError')), IDLE_TIMEOUT_MS); };
    const combined = AbortSignal.any([signal, idle.signal]);
    try {
      let response: Response;
      try {
        response = await this.deps.kmoe.net(url, { signal: combined, headers: { 'User-Agent': 'Mozilla/5.0 KmoeSync', ...(existing ? { Range: `bytes=${existing}-` } : {}) } });
      } catch (error) {
        if (signal.aborted) throw error;
        throw offline(idle.signal.aborted ? '下载连接超时' : `下载连接失败（${errorMessage(error)}）`);
      }
      if (response.status === 416) { await discard(file); throw new KmoeError('network', '续传位置无效，将重新下载'); }
      if ([401, 403, 404, 410].includes(response.status)) throw new KmoeError('download_expired', `下载链接已失效（HTTP ${response.status}），将重新获取`);
      if (!response.ok) {
        if (transientStatus(response.status)) throw new KmoeError('network', `下载服务器暂时不可用（HTTP ${response.status}）`);
        throw new KmoeError('download_forbidden', `下载被拒绝（HTTP ${response.status}）`);
      }
      const append = response.status === 206 && existing > 0;
      const length = Number(response.headers.get('content-length') ?? NaN);
      const total = Number.isFinite(length) ? length + (append ? existing : 0) : null;
      named(response.headers.get('content-disposition'));
      const handle = await open(file, append ? 'a' : 'w');
      let loaded = append ? existing : 0;
      try {
        for await (const chunk of response.body ?? []) {
          touch();
          await handle.write(chunk);
          loaded += chunk.byteLength;
          progress(loaded, total);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        throw offline(idle.signal.aborted ? '下载中断：长时间没有收到数据' : `下载中断（${errorMessage(error)}）`);
      } finally { await handle.close(); }
      if (total !== null && loaded !== total) throw new KmoeError('network', `下载不完整（${loaded}/${total} 字节）`);
      progress(loaded, total ?? loaded);
      return { size: loaded };
    } finally { clearTimeout(idleTimer); }
  }
}
