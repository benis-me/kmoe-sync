// In-browser implementation of every endpoint in shared/api.ts plus the SSE stream, backed by ./data.
// Requests are validated with the contract's schemas (like the real server) and, in dev, so are responses.
import type { z } from 'zod';
import { endpoints, type EndpointKey, type ResponseOf } from '@shared/api';
import {
  Activity as ActivitySchema, BangumiArchiveStatus as ArchiveSchema, LibraryJob as LibraryJobSchema, Status as StatusSchema, Task as TaskSchema,
  type Activity, type BangumiCandidate, type BangumiSubject, type ComicDetail, type ComicFolder, type ComicSummary, type DirEntry, type FolderMetadata, type Format,
  type Item, type ItemStateInfo, type KmoeCandidate, type LibraryCheck, type LibraryFolder, type LibraryJobKind, type LibraryOverview, type Line, type MetadataSettings,
  type AiPolishItem, type AiSettings, type AiVerdict, type ChatEvent, type ChatMessage, type PolicyImpact, type QueueCounts, type QueueState, type ServerEvent, type ShelfEntry, type Source, type SourceItem, type Status,
  type Subscription, type SubscriptionInput, type Target, type TargetInput, type Task,
} from '@shared/model';
import { DEFAULT_RULE, NamingError, joinPath, normalizePath, renderRule, validateRule } from '@shared/naming';
import { tally } from '@/features/library/state';
import { formatMB } from '@/lib/format';
import { version } from '../../package.json';
import { coverFor, hash } from './covers';
import {
  BANGUMI, KOMGA_LIBRARIES, LIBRARY_ROOT, MIRRORS, filePath, latestDump, latestLabel, libraryKey, seed, unknownComic,
  type BangumiEntry, type MockComic, type MockDb, type MockFolder, type Scenario,
} from './data';

type Spec<K extends EndpointKey> = (typeof endpoints)[K];
type Input<K extends EndpointKey, F extends 'query' | 'body'> = Spec<K> extends Record<F, infer S extends z.ZodType> ? z.output<S> : undefined;
type Handler<K extends EndpointKey> = (request: { params: Record<string, string>; query: Input<K, 'query'>; body: Input<K, 'body'> }) => ResponseOf<K>;

class Fail extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

type MockEventSource = { onmessage: ((event: MessageEvent) => void) | null; onerror: ((event: Event) => void) | null; onopen: ((event: Event) => void) | null; close(): void };

const MiB = 1024 ** 2;
const OK = { ok: true } as const;
const PUBLIC = new Set<EndpointKey>(['GET /api/auth/state', 'POST /api/auth/setup', 'POST /api/auth/login']);
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const sleep = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});
const random = (min: number, max: number) => min + Math.random() * (max - min);
const secret = (prefix: string) => `${prefix}${Array.from(crypto.getRandomValues(new Uint8Array(20)), b => b.toString(16).padStart(2, '0')).join('')}`;
const hostOf = (url: string | null | undefined) => { try { return new URL(url ?? '').host; } catch { return ''; } };
const needle = (text: string) => text.normalize('NFKC').replace(/\s/g, '').toLowerCase();
/** Titles compared without width, case, spaces or punctuation ("GRAND BLUE 碧藍之海" = "GRAND BLUE碧藍之海"). */
const titleKey = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
/** 1 = same title; containment scores high; otherwise the bigram overlap (Dice). */
function similarity(a: string, b: string): number {
  const x = titleKey(a), y = titleKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85 + 0.14 * Math.min(x.length, y.length) / Math.max(x.length, y.length);
  const grams = (t: string) => Array.from({ length: Math.max(0, [...t].length - 1) }, (_, i) => [...t].slice(i, i + 2).join(''));
  const left = grams(x), right = grams(y);
  let common = 0;
  const pool = [...right];
  for (const gram of left) { const at = pool.indexOf(gram); if (at >= 0) { common++; pool.splice(at, 1); } }
  return left.length + right.length ? 2 * common / (left.length + right.length) : 0;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const BOOK = /\.(epub|mobi)$/i;
/** "[Kmoe][書名]卷01.epub" or "書名-卷 01.epub" → 書名. */
function hintOf(files: string[]): string | null {
  for (const name of files) {
    const hint = name.match(/^\[Kmoe\]\[(.+?)\]/)?.[1] ?? name.match(/^(.+?)[\s_-]*(?:卷|第|vol\.?|話)\s*\d+/i)?.[1];
    if (hint?.trim()) return hint.trim();
  }
  return null;
}
/** Kmoe page key from a link (any mirror) or a bare key. */
const keyFrom = (input: string) => input.match(/\/c\/(\w+?)(?:\.htm|\/|$)/)?.[1] ?? (/^[0-9a-f]{4,}$/i.test(input.trim()) ? input.trim() : null);
/** The offline archive has no images: covers only come with the online API. */
const subjectOf = (entry: BangumiEntry, withCover: boolean): BangumiSubject => ({
  id: entry.id, name: entry.name, nameCn: entry.nameCn, platform: entry.platform ?? '漫画', date: entry.date, cover: withCover ? coverFor(entry.nameCn, `bgm-${entry.id}`) : null,
  volumes: entry.volumes, authors: entry.authors, series: entry.series ?? true, url: `https://bgm.tv/subject/${entry.id}`,
});
const JOB_NAMES: Record<LibraryJobKind, string> = { scan: '扫描书库', kmoe: '匹配 Kmoe', bangumi: '匹配 Bangumi', komga: '同步到 Komga', ai: 'AI 处理' };
/** Komga problems the demo shows: locked for good, not scanned by Komga yet, or a failure that goes away on retry. */
const KOMGA_LOCKED = new Set(['寄生獸 完全版']), KOMGA_MISSING = new Set(['惡之華', 'BLUE GIANT EXPLORER']);
const KOMGA_FLAKY: Record<string, string> = { AKIRA: '连接 Komga 超时（10 秒），稍后重试', 我推的孩子: 'Komga 返回 500：写入第 16 卷的信息时出错' };

function naming<T>(check: () => T): T {
  try { return check(); } catch (error) { if (error instanceof NamingError) throw new Fail(400, 'invalid', error.message); throw error; }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Fail(400, 'invalid', '这不是浏览器扩展导出的配置文件');
  return value as Record<string, unknown>;
}

export function createMockServer(scenario: Scenario) {
  const db: MockDb = seed(scenario);
  const listeners = new Set<MockEventSource>();
  const checks = new Map<string, LibraryCheck>();
  const batches = new Map<string, string[]>();
  const nextId = () => ++db.seq;

  // ---------- events ----------
  function emit(event: ServerEvent) {
    if (import.meta.env.DEV) {
      const [schema, value]: [z.ZodType | null, unknown] =
        event.type === 'task' ? [TaskSchema, event.task] : event.type === 'status' ? [StatusSchema, event.status] : event.type === 'activity' ? [ActivitySchema, event.activity]
        : event.type === 'library' ? [LibraryJobSchema, event.job] : event.type === 'bangumi-archive' ? [ArchiveSchema, event.archive] : [null, null];
      const result = schema?.safeParse(value);
      if (result && !result.success) console.error(`[mock] ${event.type} event does not match the schema`, result.error.issues, value);
    }
    const data = JSON.stringify(event);
    for (const listener of listeners) listener.onmessage?.(new MessageEvent('message', { data }));
  }
  const emitStatus = () => emit({ type: 'status', status: status() });
  const emitTask = (task: Task) => emit({ type: 'task', task: { ...task } });
  function touch(key: string) {
    const comic = db.comics.get(key);
    if (comic) comic.lastActivityAt = iso();
    emit({ type: 'comic', key });
    emit({ type: 'shelf' });
  }
  function log(kind: Activity['kind'], level: Activity['level'], title: string, detail: string | null, comicKey: string | null = null) {
    const activity: Activity = { id: nextId(), kind, level, title, detail, comicKey, createdAt: iso() };
    db.activity.unshift(activity);
    emit({ type: 'activity', activity });
  }

  // ---------- lookups ----------
  function comicOf(key: string): MockComic {
    let comic = db.comics.get(key);
    if (!comic) { comic = unknownComic(key); db.comics.set(key, comic); }
    return comic;
  }
  function targetOf(id: number): Target {
    const target = db.targets.find(t => t.id === id);
    if (!target) throw new Fail(404, 'not_found', '存储位置不存在，可能已被删除');
    return target;
  }
  const fsOf = (target: Pick<Target, 'kind' | 'url'>) => target.kind === 'local' ? 'local' : hostOf(target.url);
  const display = (target: Pick<Target, 'kind'>, path: string) => target.kind === 'local' ? joinPath(LIBRARY_ROOT, path) : path;
  const sizeOf = (entry: Item, format: Format) => entry.sizeMB[format] ?? 0;
  const tracked = (key: string) => db.subscriptions.has(key) || db.tasks.some(t => t.comicKey === key) || [...db.library.keys()].some(k => k.includes(`|${key}-`))
    || db.folders.some(f => f.kmoe.comicKey === key && f.kmoe.state === 'matched');

  function defaultView(key: string): { targetId: number | null; format: Format } {
    const sub = db.subscriptions.get(key);
    if (sub) return { targetId: sub.targetId, format: sub.format };
    const fallback = db.targets.find(t => t.id === db.settings.defaultTargetId) ?? db.targets[0];
    return { targetId: fallback?.id ?? null, format: db.settings.defaultFormat };
  }

  function stateOf(entry: Item, targetId: number, format: Format): ItemStateInfo {
    const task = db.tasks.filter(t => t.itemId === entry.id && t.targetId === targetId && t.format === format).at(-1);
    if (task?.status === 'running') return { state: 'running', paths: [], reason: null, taskId: task.id };
    if (task?.status === 'queued') return { state: 'queued', paths: [], reason: task.phase === 'waiting' ? task.error : null, taskId: task.id };
    const file = db.library.get(libraryKey(targetId, format, entry.id));
    const target = db.targets.find(t => t.id === targetId);
    if (file && target) return { state: file.unknown ? 'unknown' : 'downloaded', paths: [display(target, file.path)], reason: file.unknown ? '找到同名文件，但大小与 Kmoe 记录不一致' : null, taskId: null };
    if (task?.status === 'failed') return { state: 'failed', paths: [], reason: task.error, taskId: task.id };
    return { state: 'missing', paths: [], reason: null, taskId: null };
  }

  function summary(comic: MockComic): ComicSummary {
    return { key: comic.key, title: comic.title, authors: comic.authors, cover: comic.cover, language: '繁體', latest: latestLabel(comic), updatedAt: comic.fetchedAt, tracked: tracked(comic.key) };
  }

  function detail(key: string, view: { targetId?: number; format?: Format }): ComicDetail {
    const comic = comicOf(key);
    const fallback = defaultView(key);
    const targetId = view.targetId ?? fallback.targetId, format = view.format ?? fallback.format;
    if (targetId !== null) targetOf(targetId);
    return {
      comic: { ...summary(comic), bookId: String(10000 + hash(key) % 90000), description: comic.description, status: comic.status, fetchedAt: comic.fetchedAt },
      items: comic.items,
      subscription: db.subscriptions.get(key) ?? null,
      view: { targetId, format },
      states: targetId === null ? {} : Object.fromEntries(comic.items.map(entry => [entry.id, stateOf(entry, targetId, format)])),
      library: checks.get(`${key}|${targetId}|${format}`) ?? null,
      folder: targetId === null ? null : comicFolder(comic, targetOf(targetId)),
      metadata: targetId === null ? null : comicMetadata(comic, targetOf(targetId)),
    };
  }

  function shelf(): ShelfEntry[] {
    return [...db.comics.values()].filter(comic => tracked(comic.key)).map(comic => {
      const view = defaultView(comic.key);
      const states = view.targetId === null ? [] : comic.items.map(entry => stateOf(entry, view.targetId!, view.format).state);
      const count = (...kinds: ItemStateInfo['state'][]) => states.filter(state => kinds.includes(state)).length;
      return {
        comic: summary(comic),
        subscription: db.subscriptions.get(comic.key) ?? null,
        counts: { items: comic.items.length, downloaded: count('downloaded'), queued: count('queued', 'running'), failed: count('failed'), new: comic.items.filter(i => i.isNew).length },
        lastActivityAt: comic.lastActivityAt,
        metadata: (() => {
          const record = view.targetId === null ? undefined : folderRecord(comic, targetOf(view.targetId));
          return record ? { bangumi: record.metadata.bangumi.state, komga: record.metadata.komga.state } : null;
        })(),
      };
    }).sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  }

  function counts(comicKey?: string): QueueCounts {
    const result: QueueCounts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const task of db.tasks) if (!comicKey || task.comicKey === comicKey) result[task.status]++;
    return result;
  }
  const queueState = (): QueueState => ({ ...db.queue, counts: counts(), speed: db.tasks.reduce((sum, t) => sum + (t.status === 'running' ? t.speed : 0), 0) });
  function status(): Status {
    const next = [...db.subscriptions.values()].filter(s => s.enabled && s.nextCheckAt).map(s => s.nextCheckAt!).sort()[0] ?? null;
    return { version, kmoe: db.kmoe, queue: queueState(), nextCheckAt: next, checking: db.checking, libraryRoot: LIBRARY_ROOT, targets: db.targets.length };
  }

  // ---------- downloads ----------
  function createTasks(comic: MockComic, itemIds: string[], format: Format, targetId: number, origin: Task['origin']) {
    const target = targetOf(targetId);
    const created: Task[] = [];
    let skipped = 0;
    for (const id of itemIds) {
      const entry = comic.items.find(i => i.id === id);
      const state = entry && stateOf(entry, targetId, format).state;
      if (!entry || state === 'queued' || state === 'running' || state === 'downloaded') { skipped++; continue; }
      const task: Task = {
        id: nextId(), comicKey: comic.key, comicTitle: comic.title, cover: comic.cover, itemId: entry.id, itemName: entry.name, type: entry.type,
        format, targetId, targetName: target.name, status: 'queued', phase: null, attempt: 1, maxAttempts: db.settings.maxRetries, retryAt: null,
        loaded: 0, total: null, speed: 0, path: null, error: null, errorCode: null, origin, createdAt: iso(), startedAt: null, finishedAt: null,
      };
      db.tasks.push(task);
      created.push(task);
      emitTask(task);
    }
    if (created.length) { touch(comic.key); emitStatus(); }
    return { created, skipped, sizeMB: created.reduce((sum, task) => sum + sizeOf(comic.items.find(i => i.id === task.itemId)!, format), 0) };
  }

  function stop(task: Task, next: Task['status']) {
    Object.assign(task, { status: next, phase: null, speed: 0, retryAt: null, finishedAt: iso() });
    emitTask(task);
  }
  function requeue(task: Task) {
    Object.assign(task, { status: 'queued', phase: null, attempt: 1, retryAt: null, loaded: 0, total: null, speed: 0, error: null, errorCode: null, startedAt: null, finishedAt: null });
    emitTask(task);
  }

  function policy(comic: MockComic, input: SubscriptionInput, commit: boolean): PolicyImpact {
    const old = db.subscriptions.get(comic.key);
    const keep = (task: Task) => input.enabled && input.types.includes(task.type) && task.format === input.format && task.targetId === input.targetId;
    const cancel = db.tasks.filter(t => t.comicKey === comic.key && t.origin === 'subscription' && t.status === 'queued' && !!old && !keep(t));
    const backfill = input.enabled && input.strategy === 'backfill' ? comic.items.filter(entry => input.types.includes(entry.type)) : [];
    const wanted = backfill.filter(entry => ['missing', 'failed'].includes(stateOf(entry, input.targetId, input.format).state));
    const unknown = backfill.filter(entry => stateOf(entry, input.targetId, input.format).state === 'unknown').length;
    if (commit) {
      for (const task of cancel) stop(task, 'cancelled');
      if (wanted.length) createTasks(comic, wanted.map(entry => entry.id), input.format, input.targetId, 'subscription');
    }
    return { queue: wanted.length, cancel: cancel.length, sizeMB: Math.round(wanted.reduce((sum, entry) => sum + sizeOf(entry, input.format), 0) * 10) / 10, unknown };
  }

  /** A subscription check: reveals the next upcoming chapter, if the demo has one left. */
  function runCheck(key: string) {
    const sub = db.subscriptions.get(key), comic = db.comics.get(key);
    if (!sub || !comic) return;
    Object.assign(sub, { lastCheckAt: iso(), lastSuccessAt: iso(), error: null, nextCheckAt: sub.enabled ? iso(Date.now() + db.settings.checkIntervalHours * 3600_000) : null });
    const found = comic.upcoming.splice(0, 1);
    for (const entry of comic.items) entry.isNew = false;
    for (const entry of found) { entry.isNew = true; comic.items.push(entry); }
    if (found.length) {
      const names = found.map(entry => entry.name).join('、');
      const queue = sub.enabled ? found.filter(entry => sub.types.includes(entry.type)) : [];
      if (queue.length) createTasks(comic, queue.map(entry => entry.id), sub.format, sub.targetId, 'subscription');
      log('new_items', 'info', `发现新章节 · ${comic.title}`, queue.length ? `${names} 已加入下载队列` : names, key);
    }
    touch(key);
  }

  // ---------- storage ----------
  function buildTarget(input: TargetInput, old?: Target): Target {
    const path = naming(() => normalizePath(input.path || '/'));
    const rule = naming(() => validateRule(input.rule));
    const url = input.url?.trim() ?? '';
    if (input.kind === 'webdav' && !/^https?:\/\/[^/]+/i.test(url)) throw new Fail(400, 'invalid', url ? 'WebDAV 地址需要以 http:// 或 https:// 开头' : '请填写 WebDAV 地址');
    const webdav = input.kind === 'webdav';
    return {
      id: old?.id ?? nextId(), kind: input.kind, name: input.name, path, rule,
      url: webdav ? url : null, username: webdav ? input.username || null : null,
      hasPassword: webdav && (input.password === undefined ? old?.hasPassword ?? false : input.password !== ''),
      isDefault: old?.isDefault ?? false, createdAt: old?.createdAt ?? iso(),
    };
  }
  const inputOf = (target: Target): TargetInput => ({ kind: target.kind, name: target.name, path: target.path, url: target.url ?? undefined, username: target.username ?? undefined, rule: target.rule });
  function resolveRef(ref: { targetId?: number; draft?: TargetInput }): Target {
    if (ref.targetId !== undefined && !ref.draft) return targetOf(ref.targetId);
    const old = ref.targetId !== undefined ? targetOf(ref.targetId) : undefined;
    return buildTarget(ref.draft!, old);
  }

  /** Every file on a filesystem ("local" or a WebDAV host) by path; directories without files have size -1. */
  function filesOn(fs: string): Map<string, number> {
    const files = new Map<string, number>();
    for (const [key, file] of db.library) {
      const target = db.targets.find(t => t.id === Number(key.split('|')[0]));
      if (target && fsOf(target) === fs) files.set(file.path, file.size);
    }
    for (const extra of db.extras.get(fs) ?? ['/Comics/', '/Books/', '/Photos/']) {
      if (extra.endsWith('/')) files.set(extra.slice(0, -1), -1); else files.set(extra, 3.2 * MiB);
    }
    return files;
  }

  function listDir(fs: string, dir: string): DirEntry[] {
    const files = filesOn(fs);
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const entries = new Map<string, DirEntry>();
    let exists = dir === '/';
    for (const [path, size] of files) {
      if (path === dir) exists = true;
      if (!path.startsWith(prefix)) continue;
      exists = true;
      const [name, ...rest] = path.slice(prefix.length).split('/');
      if (!name) continue;
      const directory = rest.length > 0 || size < 0;
      if (!entries.has(name) || directory) entries.set(name, { name, path: `${prefix}${name}`, directory, size: directory ? 0 : size });
    }
    if (!exists) throw new Fail(404, 'not_found', `目录不存在：${dir}`);
    return [...entries.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  }

  function libraryCheck(key: string, targetId: number, format: Format): LibraryCheck {
    const comic = comicOf(key), target = targetOf(targetId);
    const chapters = comic.items.map(entry => {
      const file = db.library.get(libraryKey(targetId, format, entry.id));
      if (!file) return { id: entry.id, status: 'missing' as const, paths: [], reason: '目标目录中没有这一项' };
      return { id: entry.id, status: file.unknown ? 'unknown' as const : 'downloaded' as const, paths: [display(target, file.path)], reason: file.unknown ? '找到同名文件，但大小与 Kmoe 记录不一致' : '已在目标目录找到' };
    });
    const sample = comic.items[0] ? fileFor(target, comic, comic.items[0], format) : joinPath(target.path, `${comic.title}/x`);
    const directory = sample.slice(0, sample.lastIndexOf('/')) || '/';
    const strays = (db.extras.get(fsOf(target)) ?? []).filter(path => !path.endsWith('/') && path.startsWith(`${directory}/`));
    const check: LibraryCheck = {
      targetId, format, checkedAt: iso(), directory: display(target, directory),
      directoryExists: strays.length > 0 || chapters.some(c => c.status !== 'missing'), chapters, unmatched: strays.map(path => display(target, path)),
    };
    checks.set(`${key}|${targetId}|${format}`, check);
    return check;
  }

  // ---------- sources ----------
  function sourceView(source: Source): Source {
    const items = db.sourceItems.filter(i => i.sourceId === source.id);
    return { ...source, itemCount: items.length, pendingCount: items.filter(i => i.match.state === 'pending').length };
  }
  function sourceItem(id: number): SourceItem {
    const found = db.sourceItems.find(i => i.id === id);
    if (!found) throw new Fail(404, 'not_found', '书单条目不存在');
    return found;
  }
  function syncSource(source: Source) {
    source.lastSyncAt = iso();
    source.error = /^(nobody|none)$/i.test(source.username) ? `找不到 Bangumi 用户 ${source.username}` : null;
    if (source.error) return;
    const known = new Set(db.sourceItems.map(i => i.title));
    const fresh = [...db.comics.values()].filter(c => !tracked(c.key) && !known.has(c.title)).slice(0, source.itemCount ? 1 : 3);
    for (const comic of fresh) {
      const id = nextId();
      db.sourceItems.push({
        id, sourceId: source.id, externalId: String(300000 + id), title: comic.title, originalTitle: null, status: source.types[0] ?? 'wish',
        cover: coverFor(comic.title, `bgm-${id}`), url: `https://bgm.tv/subject/${300000 + id}`, match: { state: 'pending', comicKey: null, comicTitle: null }, firstSeenAt: iso(),
      });
    }
    log('source_synced', 'info', `${source.name} 已同步`, fresh.length ? `新增 ${fresh.length} 部待匹配` : '没有新条目');
  }

  // ---------- simulation ----------
  function consume(mb: number) {
    const account = db.kmoe;
    if (account.state !== 'active' || account.remainingMB === null) return;
    let left = mb;
    for (const quota of [account.free, account.vipQuota]) {
      if (!quota?.totalMB || quota.usedMB === null) continue;
      const take = Math.min(left, quota.totalMB - quota.usedMB);
      quota.usedMB = Math.round((quota.usedMB + take) * 10) / 10;
      left -= take;
    }
    account.remainingMB = Math.max(0, Math.round((account.remainingMB - mb) * 10) / 10);
    if (!db.queue.paused && account.remainingMB < db.settings.quotaReserveMB) {
      db.queue = { paused: true, reason: 'quota' };
      log('quota_low', 'warning', '额度不足，队列已暂停', `剩余 ${Math.round(account.remainingMB)} MB，低于保留的 ${db.settings.quotaReserveMB} MB`);
    }
  }

  function complete(task: Task) {
    const comic = comicOf(task.comicKey), entry = comic.items.find(i => i.id === task.itemId)!, target = targetOf(task.targetId);
    const path = fileFor(target, comic, entry, task.format);
    // A scanned folder gains the book; Komga needs the new volume.
    const record = folderRecord(comic, target);
    if (record && !record.files.includes(leaf(path))) {
      record.files.push(leaf(path));
      if (record.metadata.komga.state !== 'disabled') record.metadata.komga.dirty = true;
      emit({ type: 'folders', targetId: target.id });
    }
    Object.assign(task, { status: 'completed', phase: null, speed: 0, loaded: task.total ?? 0, finishedAt: iso(), path: display(target, path), error: null, errorCode: null });
    db.library.set(libraryKey(task.targetId, task.format, task.itemId), { path, size: task.total ?? 0 });
    consume(sizeOf(entry, task.format));
    emitTask(task);
    const batch = [...(batches.get(comic.key) ?? []), entry.name];
    batches.set(comic.key, batch);
    if (!db.tasks.some(t => t.comicKey === comic.key && (t.status === 'queued' || t.status === 'running'))) {
      batches.delete(comic.key);
      log('download_done', 'success', `下载完成 · ${comic.title}`, `${batch.slice(0, 3).join('、')}${batch.length > 3 ? ` 等 ${batch.length} 项` : ''} · ${target.name}`, comic.key);
    }
    touch(comic.key);
  }

  function fail(task: Task, error: string, code: string) {
    const comic = comicOf(task.comicKey);
    if (db.settings.autoRetry && task.attempt < task.maxAttempts) {
      Object.assign(task, { status: 'queued', phase: 'waiting', attempt: task.attempt + 1, retryAt: iso(Date.now() + 20_000), loaded: 0, speed: 0, error, errorCode: code });
      emitTask(task);
    } else {
      Object.assign(task, { status: 'failed', phase: null, speed: 0, finishedAt: iso(), error, errorCode: code });
      emitTask(task);
      log('download_failed', 'error', `下载失败 · ${comic.title}`, `${task.itemName}：${error}`, comic.key);
    }
    touch(comic.key);
  }

  function tick() {
    const now = Date.now();
    let changed = false;
    if (db.queue.paused && db.queue.reason === 'network' && now >= networkRetryAt) { resume('网络已恢复，自动继续'); changed = true; }
    for (const task of db.tasks) {
      if (task.status === 'queued' && task.phase === 'waiting' && task.retryAt && Date.parse(task.retryAt) <= now) {
        Object.assign(task, { phase: null, retryAt: null });
        emitTask(task);
        changed = true;
      }
    }
    for (const task of db.tasks.filter(t => t.status === 'running')) {
      changed = true;
      const total = task.total ?? 0, target = targetOf(task.targetId);
      const base = (2.2 + (task.id % 5) * 0.6) * MiB;
      if (task.phase === 'resolving') { task.phase = 'downloading'; task.speed = base; }
      else if (task.phase === 'downloading') {
        task.speed = base * random(0.85, 1.15);
        task.loaded = Math.min(total, task.loaded + task.speed);
        // Every seventh task drops its connection once, to show the automatic retry.
        if (task.id % 7 === 0 && task.attempt === 1 && task.loaded > total * 0.55) { fail(task, '连接超时（ETIMEDOUT）', 'network'); continue; }
        if (task.loaded >= total) Object.assign(task, target.kind === 'webdav' ? { phase: 'uploading', loaded: 0 } : { phase: 'verifying', speed: 0 });
      } else if (task.phase === 'uploading') {
        task.speed = 6 * MiB * random(0.8, 1.2);
        task.loaded = Math.min(total, task.loaded + task.speed);
        if (task.loaded >= total) Object.assign(task, { phase: 'verifying', speed: 0 });
      } else { complete(task); continue; }
      emitTask(task);
    }
    if (!db.queue.paused && db.kmoe.state === 'active') {
      let running = db.tasks.filter(t => t.status === 'running').length;
      for (const task of db.tasks) {
        if (running >= db.settings.concurrency) break;
        if (task.status !== 'queued' || task.phase === 'waiting') continue;
        const entry = comicOf(task.comicKey).items.find(i => i.id === task.itemId)!;
        Object.assign(task, { status: 'running', phase: 'resolving', startedAt: task.startedAt ?? iso(), loaded: 0, total: Math.round(sizeOf(entry, task.format) * MiB), speed: 0 });
        emitTask(task);
        touch(task.comicKey);
        running++;
        changed = true;
      }
    }
    if (changed) emitStatus();
  }
  // A network pause retries by itself (every few minutes on the server; once, after a while, here).
  const networkRetryAt = Date.now() + 90_000;
  setInterval(tick, 1000);

  // ---------- library: series folders ↔ Kmoe comics ↔ Bangumi / Komga ----------
  const ago = (minutes: number) => iso(Date.now() - minutes * 60_000);
  const komgaOn = (targetId: number) => db.metadata.enabled && !!db.metadata.komga.url && db.metadata.komga.libraries.some(l => l.targetId === targetId);
  const emitFolders = (targetId: number) => emit({ type: 'folders', targetId });
  const emitJob = () => emit({ type: 'library', job: { ...db.job } });
  function folderById(id: string): MockFolder {
    const found = db.folders.find(f => f.id === Number(id));
    if (!found) throw new Fail(404, 'not_found', '文件夹不存在，可能已经重新扫描过');
    return found;
  }
  const freshMetadata = (targetId: number): FolderMetadata => ({
    bangumi: { state: 'none', subject: null, candidates: [], source: null, checkedAt: null, ai: null },
    komga: { state: komgaOn(targetId) ? 'pending' : 'disabled', seriesId: null, seriesUrl: null, syncedAt: null, error: null, dirty: false },
    polish: null,
  });
  function folderView(f: MockFolder): LibraryFolder {
    const books = f.files.filter(name => BOOK.test(name));
    const mobi = books.filter(name => /\.mobi$/i.test(name)).length;
    return {
      id: f.id, targetId: f.targetId, path: f.path, name: leaf(f.path), books: books.length,
      format: books.length ? mobi > books.length / 2 ? 'mobi' : 'epub' : null, sample: books[0] ?? null, hint: hintOf(books),
      kmoe: { state: f.kmoe.state, comic: f.kmoe.comicKey ? summary(comicOf(f.kmoe.comicKey)) : null, candidates: f.kmoe.candidates, score: f.kmoe.score, error: f.kmoe.error, ai: f.kmoe.ai ?? null },
      metadata: { ...structuredClone(f.metadata), bangumi: { ...structuredClone(f.metadata.bangumi), ai: f.metadata.bangumi.ai ?? null }, polish: f.polish?.status ?? null }, scannedAt: f.scannedAt,
    };
  }
  function overview(targetId: number): LibraryOverview {
    targetOf(targetId);
    const folders = db.folders.filter(f => f.targetId === targetId).map(folderView);
    const scannedAt = folders.reduce<string | null>((last, f) => f.scannedAt && (!last || f.scannedAt > last) ? f.scannedAt : last, null) ?? db.lastScan[targetId] ?? null;
    return { targetId, scannedAt, job: { ...db.job }, counts: tally(folders), folders };
  }

  /** The naming rule's folder for a comic, relative to the target. */
  function ruleDir(target: Target, comic: MockComic) {
    const file = joinPath('/', renderRule(target.rule, { title: comic.title, filename: `[Kmoe][${comic.title}]卷01`, bookname: comic.items[0]?.name ?? '卷 01', author: comic.authors, ext: 'epub' }));
    return file.slice(0, file.lastIndexOf('/')) || '/';
  }
  const dirOf = (comic: MockComic, target: Target) => db.comicFolders.get(`${comic.key}|${target.id}`) ?? ruleDir(target, comic);
  const folderRecord = (comic: MockComic, target: Target) => db.folders.find(f => f.targetId === target.id && f.path === dirOf(comic, target));
  /** Where a chapter lands: in the comic's folder when it has one, else by the naming rule. */
  function fileFor(target: Target, comic: MockComic, entry: Item, format: Format) {
    const mapped = db.comicFolders.get(`${comic.key}|${target.id}`);
    const rule = filePath(target, comic, entry, format);
    return mapped ? joinPath(joinPath(target.path, mapped), leaf(rule)) : rule;
  }
  function comicFolder(comic: MockComic, target: Target): ComicFolder {
    const mapped = db.comicFolders.get(`${comic.key}|${target.id}`), rule = ruleDir(target, comic);
    return { targetId: target.id, path: mapped ?? rule, mapped: !!mapped && mapped !== rule, folderId: folderRecord(comic, target)?.id ?? null };
  }
  function comicMetadata(comic: MockComic, target: Target): FolderMetadata | null {
    const record = folderRecord(comic, target);
    if (record) return structuredClone(record.metadata);
    const dir = joinPath(target.path, dirOf(comic, target));
    return [...filesOn(fsOf(target)).keys()].some(path => path.startsWith(`${dir}/`)) ? freshMetadata(target.id) : null;
  }

  /** Folders that directly hold e-books, relative to the target; other targets inside this one are theirs. */
  function scanTarget(target: Target) {
    const base = target.path === '/' ? '' : target.path;
    const others = db.targets.filter(t => t.id !== target.id && fsOf(t) === fsOf(target) && t.path !== target.path && t.path.startsWith(`${base}/`)).map(t => t.path);
    const dirs = new Map<string, string[]>();
    for (const [path, size] of filesOn(fsOf(target))) {
      if (size < 0 || !path.startsWith(`${base}/`) || !BOOK.test(path) || others.some(other => path.startsWith(`${other}/`))) continue;
      const dir = path.slice(base.length, path.lastIndexOf('/'));
      if (dir) dirs.set(dir, [...dirs.get(dir) ?? [], leaf(path)]);
    }
    // Everything in the folder (not only books), like a directory listing.
    for (const [path, size] of filesOn(fsOf(target))) {
      const dir = path.slice(base.length, path.lastIndexOf('/'));
      if (size >= 0 && dirs.has(dir) && !BOOK.test(path) && path.startsWith(`${base}/`)) dirs.get(dir)!.push(leaf(path));
    }
    return [...dirs].map(([path, files]) => ({ path, files: files.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })) }));
  }
  function upsertFolder(target: Target, found: { path: string; files: string[] }, at = iso()): MockFolder {
    const old = db.folders.find(f => f.targetId === target.id && f.path === found.path);
    if (old) { old.files = found.files; old.scannedAt = at; return old; }
    const folder: MockFolder = {
      id: nextId(), targetId: target.id, path: found.path, files: found.files, scannedAt: at,
      kmoe: { state: 'pending', comicKey: null, candidates: [], score: null, error: null }, metadata: freshMetadata(target.id),
    };
    db.folders.push(folder);
    return folder;
  }

  /** Files of the folder as downloaded chapters of the comic ("卷 01", "話 012", "番外 1"). */
  function indexFiles(f: MockFolder, comic: MockComic, target: Target) {
    for (const name of f.files) {
      const format: Format | null = /\.epub$/i.test(name) ? 'epub' : /\.mobi$/i.test(name) ? 'mobi' : null;
      const match = name.match(/(卷|話|话|番外|vol\.?)\s*0*(\d+)/i);
      if (!format || !match) continue;
      const type = /話|话/.test(match[1]!) ? 'serial' : match[1] === '番外' ? 'extra' : 'volume';
      const entry = comic.items.find(i => i.type === type && i.order === Number(match[2]));
      if (entry) db.library.set(libraryKey(target.id, format, entry.id), { path: joinPath(joinPath(target.path, f.path), name), size: sizeOf(entry, format) * MiB });
    }
  }
  function unlinkFolder(f: MockFolder, next: 'pending' | 'ignored') {
    const key = f.kmoe.comicKey;
    if (key && f.kmoe.state === 'matched') {
      const target = targetOf(f.targetId), comic = comicOf(key);
      if (db.comicFolders.get(`${key}|${target.id}`) === f.path) db.comicFolders.delete(`${key}|${target.id}`);
      // Chapters found in a folder other than the rule's own are no longer this comic's.
      if (f.path !== ruleDir(target, comic)) {
        const dir = `${joinPath(target.path, f.path)}/`;
        for (const [libraryId, file] of db.library) if (libraryId.includes(`|${key}-`) && file.path.startsWith(dir)) db.library.delete(libraryId);
      }
      emit({ type: 'comic', key });
    }
    f.kmoe = { state: next, comicKey: null, candidates: next === 'ignored' ? f.kmoe.candidates : [], score: null, error: null };
  }
  /** One folder per comic and target: linking here unlinks the comic's previous folder. */
  function linkFolder(f: MockFolder, key: string) {
    const comic = comicOf(key), target = targetOf(f.targetId);
    for (const other of db.folders) if (other !== f && other.targetId === f.targetId && other.kmoe.comicKey === key) unlinkFolder(other, 'pending');
    if (f.kmoe.comicKey && f.kmoe.comicKey !== key) unlinkFolder(f, 'pending');
    const score = f.kmoe.candidates.find(c => c.key === key)?.score ?? null;
    f.kmoe = { state: 'matched', comicKey: key, candidates: f.kmoe.candidates, score, error: null };
    db.comicFolders.set(`${key}|${target.id}`, f.path);
    indexFiles(f, comic, target);
    comic.lastActivityAt ??= f.scannedAt;
    emit({ type: 'comic', key });
  }

  function matchKmoe(f: MockFolder) {
    const text = hintOf(f.files) ?? leaf(f.path);
    const candidates: KmoeCandidate[] = [...db.comics.values()]
      .map(comic => ({ comic, score: round2(similarity(text, comic.title)) })).filter(c => c.score >= 0.3).sort((a, b) => b.score - a.score).slice(0, 3)
      .map(({ comic, score }) => ({ key: comic.key, title: comic.title, authors: comic.authors, cover: comic.cover, latest: latestLabel(comic), score }));
    const best = candidates[0];
    f.kmoe = { ...f.kmoe, candidates, score: best?.score ?? null, error: null };
    if (best?.score === 1) linkFolder(f, best.key);
    else f.kmoe.state = best && best.score >= 0.5 ? 'suggested' : 'unmatched';
    if (f.kmoe.state === 'unmatched') f.kmoe.candidates = [];
  }
  // Bangumi comes from the online API (blocked on the demo NAS unless a proxy is set) or the offline archive dump.
  /** Where Bangumi data comes from right now, or null when the chosen source cannot answer (unchecked counts as reachable). */
  function bangumiVia(): 'online' | 'archive' | null {
    const b = db.metadata.bangumi, online = b.online.reachable !== false, archive = b.archive.state === 'ready';
    if (b.source === 'online') return online ? 'online' : null;
    if (b.source === 'archive') return archive ? 'archive' : null;
    return online ? 'online' : archive ? 'archive' : null;
  }
  function needBangumi() {
    if (!bangumiVia()) throw new Fail(503, 'bangumi_unavailable', db.metadata.bangumi.source === 'archive'
      ? 'Bangumi 离线数据还没准备好，请先在设置里下载' : '连不上 Bangumi（bgm.tv）：请在设置里填写代理，或使用离线数据');
  }
  function subject(entry: BangumiEntry) { return subjectOf(entry, bangumiVia() === 'online'); }
  const emitArchive = () => emit({ type: 'bangumi-archive', archive: structuredClone(db.metadata.bangumi.archive) });
  let archiveTimer: ReturnType<typeof setInterval> | undefined;
  /** Download (or only re-import) the newest dump with progress events; a proxy containing "bad" fails the download. */
  function runArchive(download: boolean) {
    const b = db.metadata.bangumi, latest = latestDump(), bytes = 461_373_440, lines = 1_150_000_000; // import progress counts uncompressed bytes
    b.archive = { ...b.archive, state: download ? 'downloading' : 'importing', dump: latest.name, progress: { done: 0, total: download ? bytes : lines }, error: null };
    emitArchive();
    clearInterval(archiveTimer);
    archiveTimer = setInterval(() => {
      const a = b.archive, p = a.progress!;
      const done = Math.round(Math.min(p.total, p.done + p.total * random(0.07, 0.12)));
      const proxy = db.settings.proxy;
      if (a.state === 'downloading' && /bad|wrong|fail/i.test(proxy) && done > p.total * 0.3) {
        clearInterval(archiveTimer);
        b.archive = { ...a, state: 'error', progress: null, error: `下载失败：代理 ${hostOf(proxy) || proxy} 拒绝了到 github.com 的连接。检查代理后重试。` };
      } else if (done < p.total) b.archive = { ...a, progress: { ...p, done } };
      else if (a.state === 'downloading') b.archive = { ...a, state: 'importing', progress: { done: 0, total: lines } };
      else {
        clearInterval(archiveTimer);
        b.archive = { state: 'ready', dump: latest.name, dumpDate: latest.date, importedAt: iso(), subjects: 123_456, progress: null, error: null, checkedAt: iso() };
      }
      emitArchive();
    }, 400);
  }

  function setSubject(f: MockFolder, subject: BangumiSubject, source: 'auto' | 'manual' | 'komga' | 'ai', ai: AiVerdict | null = null) {
    f.metadata.bangumi = { state: 'matched', subject, candidates: [], source, checkedAt: iso(), ai };
    if (f.metadata.komga.state !== 'disabled') f.metadata.komga.dirty = true;
  }
  function matchBangumi(f: MockFolder) {
    const text = hintOf(f.files) ?? leaf(f.path);
    const scored = BANGUMI.map(entry => ({ entry, score: round2(Math.max(...[entry.name, entry.nameCn, ...entry.aliases].map(title => similarity(text, title)))) }))
      .filter(c => c.score >= 0.3).sort((a, b) => b.score - a.score).slice(0, 3);
    const best = scored[0];
    if (best?.score === 1) return setSubject(f, subject(best.entry), 'auto');
    const candidates: BangumiCandidate[] = best && best.score >= 0.5 ? scored.map(({ entry, score }) => ({ ...subject(entry), score })) : [];
    f.metadata.bangumi = { state: candidates.length ? 'suggested' : 'unmatched', subject: null, candidates, source: null, checkedAt: iso(), ai: null };
  }
  function findSubject(input: string): BangumiSubject {
    const id = Number(input.match(/subject\/(\d+)/)?.[1] ?? (/^\d+$/.test(input.trim()) ? input.trim() : NaN));
    if (!id) throw new Fail(400, 'invalid', '无法识别，请粘贴 bgm.tv 条目页的链接或条目 ID');
    const entry = BANGUMI.find(e => e.id === id);
    if (!entry) throw new Fail(404, 'not_found', `Bangumi 上没有找到条目 ${id}`);
    return subject(entry);
  }
  function syncFolder(f: MockFolder, attempt: 'job' | 'manual') {
    if (!komgaOn(f.targetId)) throw new Fail(409, 'metadata_disabled', '这个存储位置没有对应的 Komga 库，先在设置里选择');
    if (f.metadata.bangumi.state !== 'matched') throw new Fail(409, 'bangumi_required', '先为这个文件夹选择 Bangumi 条目');
    const name = leaf(f.path), komga = f.metadata.komga;
    const seriesId = `0S${hash(f.path).toString(36).toUpperCase().slice(0, 7)}`;
    if (KOMGA_LOCKED.has(name)) Object.assign(komga, { state: 'error', error: 'Komga 返回 409：这个系列的元数据已锁定，请在 Komga 里解锁后重试', dirty: false });
    else if (KOMGA_MISSING.has(name)) Object.assign(komga, { state: 'not_found', seriesId: null, seriesUrl: null, error: null, dirty: false });
    else if (KOMGA_FLAKY[name] && komga.state !== 'error' && attempt === 'job') Object.assign(komga, { state: 'error', error: KOMGA_FLAKY[name], dirty: false });
    else Object.assign(komga, { state: 'synced', seriesId, seriesUrl: `${db.metadata.komga.url.replace(/\/$/, '')}/series/${seriesId}`, syncedAt: iso(), error: null, dirty: false });
  }
  /** The switch or the library mapping changed: folders follow. */
  function refreshKomga() {
    for (const f of db.folders) {
      const on = komgaOn(f.targetId), komga = f.metadata.komga;
      if (!on && komga.state !== 'disabled') Object.assign(komga, { state: 'disabled', dirty: false, error: null });
      if (on && komga.state === 'disabled') komga.state = komga.seriesId ? 'synced' : 'pending';
    }
    for (const target of db.targets) emitFolders(target.id);
    emit({ type: 'shelf' });
  }

  // Jobs: one at a time, stepping through folders with progress events; `then` chains the next phase (scan → Kmoe).
  let jobTimer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = new Date(Date.now() - 3 * 86_400_000 - 4 * 3_600_000).toISOString();
  function aiView(): AiSettings {
    const { key, tokens, ...rest } = db.ai;
    return { ...rest, hasKey: !!key, usage: { month: iso().slice(0, 7), tokens }, ready: !!key && !!db.ai.baseUrl && !!db.ai.model };
  }
  function requireAi() {
    if (!aiView().ready) throw new Fail(409, 'ai_not_configured', '请先在「设置 → AI」中填写接口地址、模型和 API Key');
    db.ai.tokens += Math.round(random(800, 2400));
  }
  /** The assistant in demo mode: canned answers from the demo data (the real one needs a model service), streamed like the real one. */
  function demoChat(body: { messages: ChatMessage[]; page?: string }): Response {
    if (!aiView().ready) return reply(409, { error: { code: 'ai_not_configured', message: '请先在「设置 → AI」中填写接口地址、模型和 API Key' } });
    const question = String(body.messages.findLast(message => message.role === 'user')?.content ?? '');
    const link = (comic: { key: string; title: string }) => `[《${comic.title}》](/comics/${comic.key})`;
    const pageKey = /^\/comics\/([^/?#]+)/.exec(body.page ?? '')?.[1];
    const comic = pageKey ? db.comics.get(decodeURIComponent(pageKey)) : undefined;
    const folders = db.folders.filter(f => f.targetId === 1), count = (test: (f: MockFolder) => boolean) => folders.filter(test).length;
    let tool: { name: string; label: string }, text: string;
    if (/诊断|问题|怎么回事|失败/.test(question)) {
      tool = { name: 'get_diagnostics', label: '收集诊断信息' };
      const komga = count(f => f.metadata.komga.state === 'error'), bangumi = count(f => f.metadata.bangumi.state === 'suggested');
      text = `**整体运行正常。**有 ${komga && bangumi ? 2 : 1} 处需要留意：\n\n| 项目 | 状态 |\n| --- | --- |\n`
        + `| Kmoe | ${db.kmoe.state === 'active' ? `已登录${db.kmoe.vip ? '（VIP）' : ''}，剩余 **${formatMB(db.kmoe.remainingMB ?? 0)}**` : '**登录已失效**'} |\n`
        + `| 下载队列 | ${db.queue.paused ? '**已暂停**' : '正常运行'} |\n| 书库 | ${folders.length} 个文件夹，${count(f => f.kmoe.state === 'suggested')} 个待确认 |\n\n**需要处理**\n\n`
        + `1. **Komga 同步失败 ${komga} 部**：多半是 Komga 还没扫描到这些系列。先在 Komga 里扫描书库，再到[书库整理](/library?filter=komga)里重试。\n`
        + `2. **Bangumi 待确认 ${bangumi} 部**：到[书库整理](/library?filter=bangumi)逐个确认，或者用「AI 判定」。\n\n> 这是演示数据；真实部署时，这些数字来自你的 NAS。`;
    } else if (comic) {
      tool = { name: 'get_comic', label: `查看漫画 《${comic.title}》` };
      const volumes = comic.items.filter(item => item.type === 'volume');
      text = `${link(comic)}（${comic.authors.join(' / ') || '作者未知'}，${comic.status}）一共 **${comic.items.length}** 项：\n\n`
        + `- 单行本 ${volumes.length} 卷${volumes.length ? `（${volumes[0]!.name} – ${volumes.at(-1)!.name}）` : ''}\n- 其他 ${comic.items.length - volumes.length} 项（话、番外）\n\n`
        + '要补齐缺的卷，可以说「下载缺的卷」，我会先列出来请你确认。';
    } else {
      tool = { name: 'list_shelf', label: '查看书架' };
      const shelved = shelf().slice(0, 4);
      text = shelved.length
        ? `书架上正在追的漫画里，最近有动静的是这几部：\n\n${shelved.map(entry => `- ${link(entry.comic)}：已下载 ${entry.counts.downloaded}/${entry.counts.items}${entry.counts.new ? `，**新 ${entry.counts.new} 项**` : ''}`).join('\n')}\n\n`
          + '想补齐哪一部，直接告诉我就行；下载之前我会先请你确认。\n\n> 这是演示数据里的 AI 助手：真实部署时，回答来自你设置的模型和 NAS 上的数据。'
        : '书架上还没有漫画。可以去[发现](/discover)搜索，或者到[书库整理](/library)导入 NAS 上已有的文件夹。';
    }
    const id = `call_demo_${Date.now().toString(36)}`;
    const messages: ChatMessage[] = [...body.messages,
      { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: tool.name, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: id, content: '{"demo":true}' },
      { role: 'assistant', content: text }];
    const events: ChatEvent[] = [
      { type: 'tool', id, name: tool.name, label: tool.label, status: 'running' }, { type: 'tool', id, name: tool.name, label: tool.label, status: 'done' },
      ...(text.match(/[\s\S]{1,6}/gu) ?? []).map(piece => ({ type: 'text' as const, text: piece })), { type: 'messages', messages }, { type: 'done' }];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const event of events) { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); await sleep(event.type === 'tool' ? 700 : 30); }
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
  }
  type Step = { label: string; run: () => void };
  function ensureIdle() {
    if (db.job.running) throw new Fail(409, 'job_running', `正在${JOB_NAMES[db.job.kind ?? 'scan']}，完成或取消后再试`);
  }
  function runJob(kind: LibraryJobKind, target: Target, steps: Step[], then?: () => void, ms = 120) {
    db.job = { kind, running: true, targetId: target.id, done: 0, total: steps.length, current: steps[0]?.label ?? null, error: null, cancelled: false, startedAt: db.job.running ? db.job.startedAt : iso(), finishedAt: null };
    emitJob();
    let at = 0;
    const step = () => {
      const current = steps[at];
      if (!current) { if (then) then(); else finishJob(target.id); return; }
      try { current.run(); } catch (error) { finishJob(target.id, error instanceof Fail ? error.message : '演示服务出错了'); return; }
      at++;
      db.job = { ...db.job, done: at, current: steps[at]?.label ?? null };
      emitJob();
      if (at % 10 === 0) emitFolders(target.id);
      jobTimer = setTimeout(step, ms);
    };
    jobTimer = setTimeout(step, ms);
    return { ...db.job };
  }
  function finishJob(targetId: number, error: string | null = null, cancelled = false) {
    clearTimeout(jobTimer);
    if (db.job.kind === 'scan' && !cancelled && !error) db.lastScan[targetId] = iso();
    db.job = { ...db.job, running: false, current: null, error, cancelled, finishedAt: iso() };
    emitJob();
    emitFolders(targetId);
    emit({ type: 'shelf' });
  }
  const foldersOf = (targetId: number) => db.folders.filter(f => f.targetId === targetId);
  function kmoeJob(target: Target, retry: boolean) {
    if (db.kmoe.state !== 'active') throw new Fail(409, 'kmoe_login_required', db.kmoe.state === 'expired' ? 'Kmoe 登录已失效，重新登录后才能匹配' : '匹配需要先登录 Kmoe');
    const todo = foldersOf(target.id).filter(f => f.kmoe.state === 'pending' || (retry && f.kmoe.state === 'unmatched'));
    return runJob('kmoe', target, todo.map(f => ({ label: f.path, run: () => matchKmoe(f) })));
  }
  function scanJob(target: Target, match: boolean) {
    const found = scanTarget(target), seen = new Set<number>(), at = iso();
    const steps = found.map(entry => ({ label: entry.path, run: () => { seen.add(upsertFolder(target, entry, at).id); } }));
    return runJob('scan', target, steps, () => {
      db.lastScan[target.id] = iso();
      for (const gone of foldersOf(target.id).filter(f => !seen.has(f.id))) unlinkFolder(gone, 'pending');
      db.folders = db.folders.filter(f => f.targetId !== target.id || seen.has(f.id));
      emitFolders(target.id);
      if (match && db.kmoe.state === 'active') kmoeJob(target, false); else finishJob(target.id);
    }, 60);
  }
  function metadataView(): MetadataSettings {
    const { enabled, komga, bangumi, options } = db.metadata;
    return {
      enabled, komga: { url: komga.url, auth: komga.auth, username: komga.username, hasSecret: !!komga.secret, libraries: komga.libraries.map(l => ({ ...l })) },
      bangumi: { hasToken: !!bangumi.token, source: bangumi.source, online: { ...bangumi.online }, archive: structuredClone(bangumi.archive) },
      options: { ...options },
    };
  }

  /** `full` and friends start with the library root scanned and matched a few hours ago. */
  function seedFolders() {
    const target = targetOf(1), at = ago(190);
    for (const entry of scanTarget(target)) upsertFolder(target, entry, at);
    for (const f of foldersOf(1)) {
      const name = leaf(f.path);
      if (name === '_待整理' || name === '週刊少年Jump 2024') { f.kmoe.state = 'ignored'; continue; }
      if (name === 'BLUE GIANT EXPLORER' || name === '鬼滅之刃' || name === '蟲師') continue; // added after the last match
      matchKmoe(f);
      matchBangumi(f);
      const komga = f.metadata.komga;
      if (f.metadata.bangumi.state === 'matched') { komga.dirty = false; syncFolder(f, 'job'); komga.syncedAt &&= ago(60 * 50 + (hash(name) % 600)); }
    }
    const byName = (name: string) => foldersOf(1).find(f => leaf(f.path) === name)!;
    byName('海賊王').metadata.bangumi.source = 'komga';
    byName('進擊的巨人').metadata.bangumi.source = 'komga';
    byName('輝夜姬想讓人告白～天才們的戀愛頭腦戰～').metadata.bangumi.source = 'manual';
    byName('葬送的芙莉蓮').metadata.komga.dirty = true;
    byName('銀之匙 Silver Spoon').kmoe.error = '上次匹配时 Kmoe 搜索超时，下次会重试';
    db.job = { kind: 'kmoe', running: false, targetId: 1, done: 28, total: 28, current: null, error: null, cancelled: false, startedAt: ago(192), finishedAt: at };
  }
  if (scenario !== 'setup' && scenario !== 'fresh') seedFolders();

  // ---------- endpoints ----------
  const authState = () => ({ setupRequired: db.auth.setupRequired, authenticated: db.auth.authenticated, csrf: db.auth.authenticated ? db.auth.csrf : null });
  const settings = () => ({ ...db.settings, apiToken: !!db.token });
  const noKmoe = () => ({ state: 'none' as const, email: null, mirror: null, level: null, vip: null, free: null, vipQuota: null, remainingMB: null, checkedAt: null, error: null, throttledUntil: null, remember: false });
  const subscriptionOf = (key: string) => {
    const sub = db.subscriptions.get(key);
    if (!sub) throw new Fail(404, 'not_found', '这部漫画还没有订阅');
    return sub;
  };
  const taskOf = (id: string) => {
    const task = db.tasks.find(t => t.id === Number(id));
    if (!task) throw new Fail(404, 'not_found', '任务不存在');
    return task;
  };
  const resume = (reason: string) => { db.queue = { paused: false, reason: null }; log('queue_resumed', 'info', '下载队列已恢复', reason); };

  const handlers: { [K in EndpointKey]: Handler<K> } = {
    'GET /api/auth/state': () => authState(),
    'POST /api/auth/setup': ({ body }) => {
      if (!db.auth.setupRequired) throw new Fail(409, 'conflict', '管理员密码已经设置过了');
      db.auth = { setupRequired: false, authenticated: true, password: body.password, csrf: secret('csrf-') };
      return authState();
    },
    'POST /api/auth/login': ({ body }) => {
      if (body.password !== db.auth.password) throw new Fail(401, 'invalid_password', '密码不正确');
      db.auth = { ...db.auth, authenticated: true, csrf: secret('csrf-') };
      return authState();
    },
    'POST /api/auth/logout': () => { db.auth = { ...db.auth, authenticated: false, csrf: null }; return authState(); },
    'POST /api/auth/password': ({ body }) => {
      if (body.current !== db.auth.password) throw new Fail(400, 'invalid_password', '当前密码不正确');
      db.auth.password = body.next;
      return OK;
    },

    'GET /api/status': () => status(),

    'POST /api/kmoe/login': ({ body }) => {
      if (body.password === 'wrong') throw new Fail(401, 'kmoe_auth', 'Kmoe 登录失败：邮箱或密码不正确');
      const restored = db.kmoe.state === 'expired';
      const keep = db.kmoe.email === body.email ? db.kmoe : null;
      db.kmoe = {
        state: 'active', email: body.email, mirror: body.mirror ?? db.settings.preferredMirror, level: keep?.level ?? 2, vip: keep?.vip ?? false,
        free: keep?.free ?? { totalMB: 1024, usedMB: 0, resetDay: 1 }, vipQuota: keep?.vipQuota ?? null, remainingMB: keep?.remainingMB ?? 1024, checkedAt: iso(), error: null, throttledUntil: null, remember: body.remember ?? db.kmoe.remember,
      };
      if (db.kmoe.mirror) db.settings.preferredMirror = db.kmoe.mirror;
      if (restored) log('session_restored', 'success', 'Kmoe 登录已恢复', null);
      if (db.queue.reason === 'auth') resume('重新登录 Kmoe 后自动继续');
      emitStatus();
      return db.kmoe;
    },
    'POST /api/kmoe/refresh': () => {
      if (db.kmoe.state === 'none') throw new Fail(409, 'kmoe_required', '还没有登录 Kmoe');
      db.kmoe = { ...db.kmoe, checkedAt: iso() };
      emitStatus();
      return db.kmoe;
    },
    'POST /api/kmoe/logout': () => { db.kmoe = noKmoe(); emitStatus(); return db.kmoe; },
    'DELETE /api/kmoe/password': () => { db.kmoe = { ...db.kmoe, remember: false }; emitStatus(); return db.kmoe; },
    'GET /api/kmoe/mirrors': () => MIRRORS,

    'GET /api/search': ({ query }) => {
      if (db.kmoe.state !== 'active') throw new Fail(409, 'kmoe_required', db.kmoe.state === 'expired' ? 'Kmoe 登录已失效，重新登录后才能搜索' : '搜索需要先登录 Kmoe');
      const q = needle(query.q), page = query.page ?? 1, size = 12;
      const matches = [...db.comics.values()].filter(c => needle(`${c.title}${c.authors.join('')}`).includes(q));
      return { query: query.q, page, totalPages: Math.max(1, Math.ceil(matches.length / size)), results: matches.slice((page - 1) * size, page * size).map(summary) };
    },
    'POST /api/resolve': ({ body }) => {
      const key = keyFrom(body.input);
      if (!key) throw new Fail(400, 'invalid', '无法识别这个链接，请粘贴 Kmoe 漫画页的地址');
      comicOf(key);
      return { key };
    },

    'GET /api/comics/:key': ({ params, query }) => detail(params.key!, query),
    'POST /api/comics/:key/refresh': ({ params, query }) => { comicOf(params.key!).fetchedAt = iso(); return detail(params.key!, query); },
    'POST /api/comics/:key/library-check': ({ params, body }) => libraryCheck(params.key!, body.targetId, body.format),
    'PUT /api/comics/:key/subscription': ({ params, body }) => {
      const comic = comicOf(params.key!);
      targetOf(body.targetId);
      const old = db.subscriptions.get(comic.key);
      policy(comic, body, true);
      const next: Subscription = {
        id: old?.id ?? nextId(), comicKey: comic.key, enabled: body.enabled, types: body.types, format: body.format, targetId: body.targetId,
        strategy: body.strategy, line: body.line as Line, lastCheckAt: old?.lastCheckAt ?? null, lastSuccessAt: old?.lastSuccessAt ?? null,
        nextCheckAt: body.enabled ? old?.nextCheckAt ?? iso(Date.now() + db.settings.checkIntervalHours * 3600_000) : null,
        error: old?.error ?? null, createdAt: old?.createdAt ?? iso(),
      };
      db.subscriptions.set(comic.key, next);
      touch(comic.key);
      emitStatus();
      return next;
    },
    'POST /api/comics/:key/subscription/preview': ({ params, body }) => { targetOf(body.targetId); return policy(comicOf(params.key!), body, false); },
    'DELETE /api/comics/:key/subscription': ({ params, query }) => {
      subscriptionOf(params.key!);
      if (query.cancelPending) for (const task of db.tasks) if (task.comicKey === params.key && task.origin === 'subscription' && task.status === 'queued') stop(task, 'cancelled');
      db.subscriptions.delete(params.key!);
      touch(params.key!);
      emitStatus();
      return OK;
    },
    'POST /api/comics/:key/check': ({ params }) => {
      subscriptionOf(params.key!);
      setTimeout(() => { runCheck(params.key!); emitStatus(); }, 1200);
      return OK;
    },

    'GET /api/shelf': () => shelf(),
    'POST /api/checks/run': () => {
      const keys = [...db.subscriptions.values()].filter(s => s.enabled).map(s => s.comicKey);
      db.checking = true;
      emitStatus();
      setTimeout(() => { for (const key of keys) runCheck(key); db.checking = false; emitStatus(); }, 2500);
      return { queued: keys.length };
    },

    'GET /api/tasks': ({ query }) => {
      const matching = [...db.tasks].sort((a, b) => b.id - a.id)
        .filter(t => (!query.status || t.status === query.status) && (!query.comicKey || t.comicKey === query.comicKey) && (!query.cursor || t.id < query.cursor));
      const limit = query.limit ?? 50, page = matching.slice(0, limit);
      return { tasks: page, counts: counts(query.comicKey), nextCursor: matching.length > limit ? page.at(-1)!.id : null };
    },
    'POST /api/tasks': ({ body }) => {
      if (db.kmoe.state !== 'active') throw new Fail(409, 'kmoe_required', db.kmoe.state === 'expired' ? 'Kmoe 登录已失效，请重新登录后再下载' : '请先在设置里登录 Kmoe 账号');
      const { created, skipped, sizeMB } = createTasks(comicOf(body.comicKey), body.itemIds, body.format, body.targetId, 'manual');
      return { created: created.length, skipped, sizeMB: Math.round(sizeMB * 10) / 10 };
    },
    'POST /api/tasks/:id/cancel': ({ params }) => {
      const task = taskOf(params.id!);
      if (task.status !== 'queued' && task.status !== 'running') throw new Fail(409, 'conflict', '任务已经结束');
      stop(task, 'cancelled');
      touch(task.comicKey);
      emitStatus();
      return OK;
    },
    'POST /api/tasks/:id/retry': ({ params }) => {
      const task = taskOf(params.id!);
      if (task.status !== 'failed' && task.status !== 'cancelled') throw new Fail(409, 'conflict', '只有失败或已取消的任务可以重试');
      requeue(task);
      touch(task.comicKey);
      emitStatus();
      return OK;
    },
    'POST /api/tasks/retry-failed': () => {
      const failed = db.tasks.filter(t => t.status === 'failed');
      for (const task of failed) requeue(task);
      for (const key of new Set(failed.map(t => t.comicKey))) touch(key);
      emitStatus();
      return { retried: failed.length };
    },
    'POST /api/tasks/clear-finished': () => {
      const before = db.tasks.length;
      db.tasks = db.tasks.filter(t => t.status !== 'completed');
      emitStatus();
      return { removed: before - db.tasks.length };
    },
    'POST /api/queue/pause': () => {
      if (!db.queue.paused) { db.queue = { paused: true, reason: 'manual' }; log('queue_paused', 'warning', '下载队列已暂停', '手动暂停'); }
      emitStatus();
      return queueState();
    },
    'POST /api/queue/resume': () => {
      if (db.kmoe.state === 'expired') throw new Fail(409, 'kmoe_expired', 'Kmoe 登录已失效，重新登录后队列会自动继续');
      const remaining = db.kmoe.remainingMB;
      if (remaining !== null && remaining < db.settings.quotaReserveMB) throw new Fail(409, 'quota', `剩余额度低于保留的 ${db.settings.quotaReserveMB} MB，调低保留额度后再继续`);
      if (db.queue.paused) resume('手动继续');
      emitStatus();
      return queueState();
    },

    'GET /api/targets': () => db.targets,
    'POST /api/targets': ({ body }) => {
      const target = buildTarget(body);
      db.targets.push(target);
      emitStatus();
      return target;
    },
    'PATCH /api/targets/:id': ({ params, body }) => {
      const old = targetOf(Number(params.id));
      const next = buildTarget({ ...inputOf(old), ...body }, old);
      db.targets = db.targets.map(t => t.id === old.id ? next : t);
      return next;
    },
    'DELETE /api/targets/:id': ({ params }) => {
      const target = targetOf(Number(params.id));
      if (target.isDefault) throw new Fail(409, 'conflict', '默认存储位置不能删除，请先把其他位置设为默认');
      const users = [...db.subscriptions.values()].filter(s => s.targetId === target.id).length;
      if (users) throw new Fail(409, 'conflict', `有 ${users} 个订阅正在使用这个位置，请先修改它们的存储位置`);
      db.targets = db.targets.filter(t => t.id !== target.id);
      emitStatus();
      return OK;
    },
    'POST /api/targets/:id/default': ({ params }) => {
      const target = targetOf(Number(params.id));
      db.targets = db.targets.map(t => ({ ...t, isDefault: t.id === target.id }));
      db.settings.defaultTargetId = target.id;
      return OK;
    },
    'POST /api/targets/test': ({ body }) => {
      const target = resolveRef(body);
      if (target.kind === 'local') {
        const exists = target.path === '/' || listDir('local', '/').some(e => e.directory && target.path.startsWith(e.path));
        return { ok: true, message: exists ? `可以写入 ${display(target, target.path)}` : `目录 ${display(target, target.path)} 还不存在，第一次下载时会自动创建` };
      }
      if (/fail|wrong/i.test(`${target.url}${target.username ?? ''}`)) return { ok: false, message: 'WebDAV 认证失败（401），请检查用户名和密码' };
      if (/offline|unreachable/i.test(target.url ?? '')) return { ok: false, message: `无法连接 ${hostOf(target.url)}：连接超时` };
      return { ok: true, message: `已连接 ${hostOf(target.url)}，${target.path} 可以写入` };
    },
    'POST /api/targets/browse': ({ body }) => {
      const target = resolveRef(body.ref);
      const path = naming(() => normalizePath(body.path || '/'));
      if (target.kind === 'webdav' && /fail|wrong/i.test(`${target.url}${target.username ?? ''}`)) throw new Fail(401, 'auth', 'WebDAV 认证失败（401），请检查用户名和密码');
      return { path, entries: listDir(fsOf(target), path) };
    },

    'GET /api/settings': () => settings(),
    'GET /api/about': () => ({
      version, startedAt, paths: { data: '/data', library: LIBRARY_ROOT },
      runtime: { bun: '1.3.14', platform: 'linux', arch: 'x64', timezone: 'Asia/Shanghai' }, user: { uid: 1026, gid: 100 }, databaseBytes: 3_276_800,
      counts: { comics: db.comics.size, subscriptions: db.subscriptions.size, folders: db.folders.length, tasks: db.tasks.length },
    }),
    'GET /api/ai/settings': () => aiView(),
    'PATCH /api/ai/settings': ({ body }) => {
      const { apiKey, ...rest } = body;
      Object.assign(db.ai, Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)));
      if (apiKey !== undefined) db.ai.key = apiKey.trim() || null;
      return aiView();
    },
    'POST /api/ai/test': ({ body }) => {
      const key = body.apiKey?.trim() || db.ai.key, url = (body.baseUrl ?? db.ai.baseUrl).trim();
      if (!key) return { ok: false, message: '请填写 API Key', models: [], json: null };
      if (/wrong|bad/i.test(key)) return { ok: false, message: 'AI 服务拒绝了 API Key，请检查是否填对', models: [], json: null };
      if (!/^https?:\/\//.test(url)) return { ok: false, message: '接口地址需要以 http:// 或 https:// 开头', models: [], json: null };
      const models = ['deepseek-flash', 'deepseek-v4-pro'], model = (body.model ?? db.ai.model).trim();
      return model ? { ok: true, message: `可以使用 ${model}`, models, json: true } : { ok: true, message: `可以连接，这个接口提供 ${models.length} 个模型，请选择一个`, models, json: null };
    },
    'POST /api/library/ai-match': ({ body }) => {
      ensureIdle();
      requireAi();
      const target = targetOf(body.targetId);
      const verdict = (pick: string | null, confidence: number, reason: string): AiVerdict => ({ pick, confidence, reason, at: iso() });
      if (body.kind === 'kmoe') {
        const todo = foldersOf(target.id).filter(f => f.kmoe.state === 'suggested' || f.kmoe.state === 'unmatched');
        return runJob('ai', target, todo.map(f => ({ label: f.path, run: () => {
          const best = f.kmoe.candidates[0];
          if (!best) { f.kmoe.ai = verdict(null, 0.2, '换了几种写法搜索，Kmoe 上都没有找到'); return; }
          const sure = best.score >= 0.7;
          f.kmoe.ai = verdict(best.key, sure ? 0.93 : 0.62, sure ? '书名只差版本后缀，作者一致' : '书名接近，但缺少作者信息，请确认');
          if (sure) linkFolder(f, best.key);
        } })));
      }
      const todo = foldersOf(target.id).filter(f => f.metadata.bangumi.state === 'suggested' || f.metadata.bangumi.state === 'unmatched');
      return runJob('ai', target, todo.map(f => ({ label: f.path, run: () => {
        const best = f.metadata.bangumi.candidates[0];
        if (!best) { f.metadata.bangumi.ai = verdict(null, 0.3, '换了几种写法搜索，Bangumi 上都没有找到'); return; }
        if (best.series) setSubject(f, best, 'ai', verdict(String(best.id), 0.9, '系列条目，作者和卷数都对得上'));
        else f.metadata.bangumi.ai = verdict(String(best.id), 0.55, '候选是单册条目，请确认');
      } })));
    },
    'POST /api/library/ai-polish': ({ body }) => {
      ensureIdle();
      requireAi();
      const target = targetOf(body.targetId);
      const todo = foldersOf(target.id).filter(f => f.metadata.bangumi.state === 'matched' && (body.all || !f.polish));
      return runJob('ai', target, todo.map(f => ({ label: f.path, run: () => {
        const title = f.metadata.bangumi.subject?.nameCn || f.metadata.bangumi.subject?.name || leaf(f.path);
        f.polish = {
          original: { summary: `${title}是一部漫画。（Bangumi 原简介，夹着出版信息和宣传语）`, genres: ['漫画', '日本'], tags: ['2019年', '漫画', '单行本', '讲谈社'] },
          polished: { summary: `${title}讲述了主人公的成长与冒险。\n\n故事节奏明快，人物关系细腻。`, genres: ['冒险', '剧情'], tags: ['成长', '友情', '热血'] },
          status: 'pending', at: iso(),
        };
      } })));
    },
    'GET /api/library/ai-polish': ({ query }) => foldersOf(targetOf(query.targetId).id).flatMap((f): AiPolishItem[] => f.polish ? [{
      folderId: f.id, path: f.path, title: f.metadata.bangumi.subject?.nameCn || leaf(f.path), original: f.polish.original, polished: f.polish.polished, status: f.polish.status, at: f.polish.at,
    }] : []),
    'POST /api/library/ai-polish/decide': ({ body }) => {
      let updated = 0;
      for (const f of db.folders) {
        if (!body.folderIds.includes(f.id) || !f.polish) continue;
        const status = body.accept ? 'accepted' : 'rejected';
        if (f.polish.status === status) continue;
        if (body.accept || f.polish.status === 'accepted') f.metadata.komga.dirty = f.metadata.komga.state !== 'disabled';
        f.polish.status = status;
        updated++;
        emitFolders(f.targetId);
      }
      return { updated };
    },
    'PATCH /api/settings': ({ body }) => {
      if (body.defaultTargetId != null) {
        targetOf(body.defaultTargetId);
        db.targets = db.targets.map(t => ({ ...t, isDefault: t.id === body.defaultTargetId }));
      }
      if (body.proxy !== undefined) {
        const proxy = body.proxy.trim() && (/^https?:\/\//i.test(body.proxy.trim()) ? body.proxy.trim() : `http://${body.proxy.trim()}`).replace(/\/$/, '');
        if (proxy && !/^https?:\/\/[^\s/@]+$/i.test(proxy)) throw new Fail(400, 'invalid_settings', '代理地址只需协议、主机和端口，例如 http://192.168.1.2:7890');
        // Another proxy: the last reachability check no longer applies.
        if (proxy !== db.settings.proxy) db.metadata.bangumi.online = { reachable: null, checkedAt: null, error: null };
        body = { ...body, proxy };
      }
      // Like the server: the logged-in session moves to the chosen mirror (every demo mirror accepts it).
      if (body.preferredMirror && db.kmoe.state === 'active') db.kmoe = { ...db.kmoe, mirror: body.preferredMirror };
      Object.assign(db.settings, body);
      const remaining = db.kmoe.remainingMB;
      if (db.queue.reason === 'quota' && remaining !== null && remaining >= db.settings.quotaReserveMB) resume('保留额度已调低');
      emitStatus();
      return settings();
    },
    'POST /api/network/test': ({ body }) => {
      // This demo NAS cannot reach bgm.tv directly and GitHub barely; a proxy (unless it is "bad") gets through.
      const proxy = body.proxy.trim(), bad = /bad|wrong|fail/i.test(proxy), via = hostOf(proxy) || proxy;
      const refused = `代理 ${via} 拒绝连接`;
      const results = [
        proxy ? (bad ? { name: 'Bangumi', ok: false, message: refused } : { name: 'Bangumi', ok: true, message: '通过代理可以访问' })
          : { name: 'Bangumi', ok: false, message: '无法访问 Bangumi（连接被重置）：当前网络可能屏蔽了 bgm.tv' },
        proxy ? (bad ? { name: 'GitHub（离线数据）', ok: false, message: refused } : { name: 'GitHub（离线数据）', ok: true, message: '通过代理可以访问' })
          : { name: 'GitHub（离线数据）', ok: false, message: '无法访问 GitHub（连接超时）' },
        ...(body.kmoe ? [bad ? { name: 'Kmoe', ok: false, message: refused } : { name: 'Kmoe', ok: true, message: proxy ? '通过代理可以访问' : '可以直接访问' }] : []),
      ];
      if (proxy === db.settings.proxy) db.metadata.bangumi.online = { reachable: results[0]!.ok, checkedAt: iso(), error: results[0]!.ok ? null : results[0]!.message };
      return results;
    },
    'POST /api/notifications/test': ({ body }) => {
      if (body.kind === 'webhook' && /fail/i.test(body.url)) return { ok: false, message: 'Webhook 返回 404 Not Found' };
      if (body.kind === 'telegram' && /bad|wrong/i.test(body.token)) return { ok: false, message: 'Telegram 返回 401：Bot 令牌无效' };
      return { ok: true, message: `测试通知已发送到「${body.name}」` };
    },
    'POST /api/token': () => { db.token = secret('kms_'); return { token: db.token }; },
    'DELETE /api/token': () => { db.token = null; return OK; },
    'POST /api/import/extension': ({ body }) => {
      const root = record(body.config);
      const data = record(root.data ?? root);
      if (!('webdavServers' in data) && !('downloadRule' in data)) throw new Fail(400, 'invalid', '这不是浏览器扩展导出的配置文件');
      const rule = typeof data.downloadRule === 'string' ? naming(() => validateRule(data.downloadRule as string)) : null;
      let added = 0;
      for (const raw of Array.isArray(data.webdavServers) ? data.webdavServers : []) {
        const server = record(raw), url = String(server.baseUrl ?? '');
        const path = naming(() => normalizePath(String(server.defaultPath || '/')));
        if (!/^https?:\/\//i.test(url) || db.targets.some(t => t.url === url && t.path === path)) continue;
        db.targets.push(buildTarget({ kind: 'webdav', name: String(server.name || 'WebDAV'), path, url, username: String(server.username ?? ''), password: String(server.password ?? ''), rule: rule ?? DEFAULT_RULE }));
        added++;
      }
      if (added) emitStatus();
      return { targets: added, rule: !!rule };
    },

    'GET /api/activity': ({ query }) => db.activity.slice(0, query.limit ?? 50),

    'GET /api/library': ({ query }) => overview(query.targetId ?? db.settings.defaultTargetId ?? db.targets[0]!.id),
    'POST /api/library/scan': ({ body }) => { ensureIdle(); return scanJob(targetOf(body.targetId), body.match); },
    'POST /api/library/match-kmoe': ({ body }) => { ensureIdle(); return kmoeJob(targetOf(body.targetId), body.retry); },
    'POST /api/library/match-bangumi': ({ body }) => {
      ensureIdle();
      needBangumi();
      const target = targetOf(body.targetId);
      const todo = foldersOf(target.id).filter(f => f.kmoe.state !== 'ignored' && (f.metadata.bangumi.state === 'none' || (body.retry && f.metadata.bangumi.state === 'unmatched')));
      return runJob('bangumi', target, todo.map(f => ({ label: f.path, run: () => matchBangumi(f) })));
    },
    'POST /api/library/sync-komga': ({ body }) => {
      ensureIdle();
      const target = targetOf(body.targetId);
      if (!komgaOn(target.id)) throw new Fail(409, 'metadata_disabled', db.metadata.enabled ? '这个存储位置没有对应的 Komga 库' : '还没有开启 Komga 元数据');
      const todo = foldersOf(target.id).filter(f => f.metadata.bangumi.state === 'matched' && (body.all || f.metadata.komga.dirty || f.metadata.komga.state === 'pending' || f.metadata.komga.state === 'error'));
      return runJob('komga', target, todo.map(f => ({ label: f.path, run: () => syncFolder(f, 'job') })), undefined, 180);
    },
    'POST /api/library/cancel': () => {
      if (db.job.running) finishJob(db.job.targetId!, null, true);
      return { ...db.job };
    },
    'POST /api/library/accept-suggested': ({ body }) => {
      const todo = foldersOf(targetOf(body.targetId).id).filter(f => f.kmoe.state === 'suggested' && (f.kmoe.candidates[0]?.score ?? 0) >= body.minScore);
      for (const f of todo) linkFolder(f, f.kmoe.candidates[0]!.key);
      if (todo.length) { emitFolders(body.targetId); emit({ type: 'shelf' }); }
      return { linked: todo.length };
    },
    'POST /api/library/folders/:id/kmoe': ({ params, body }) => {
      const f = folderById(params.id!);
      const key = keyFrom(body.comic);
      if (!key) throw new Fail(400, 'invalid', '无法识别，请粘贴 Kmoe 漫画页的地址');
      linkFolder(f, key);
      emitFolders(f.targetId);
      emit({ type: 'shelf' });
      return folderView(f);
    },
    'POST /api/library/folders/:id/ignore': ({ params }) => {
      const f = folderById(params.id!);
      unlinkFolder(f, 'ignored');
      emitFolders(f.targetId);
      emit({ type: 'shelf' });
      return folderView(f);
    },
    'POST /api/library/folders/:id/reset': ({ params }) => {
      const f = folderById(params.id!);
      unlinkFolder(f, 'pending');
      emitFolders(f.targetId);
      emit({ type: 'shelf' });
      return folderView(f);
    },
    'POST /api/library/folders/:id/bangumi': ({ params, body }) => {
      const f = folderById(params.id!);
      if (body.auto || body.subject) needBangumi();
      if (body.auto) matchBangumi(f);
      else if (body.subject) setSubject(f, findSubject(body.subject), 'manual');
      else throw new Fail(400, 'invalid', '请选择一个 Bangumi 条目');
      emitFolders(f.targetId);
      emit({ type: 'shelf' });
      return folderView(f);
    },
    'DELETE /api/library/folders/:id/bangumi': ({ params }) => {
      const f = folderById(params.id!);
      f.metadata.bangumi = { state: 'none', subject: null, candidates: [], source: null, checkedAt: null, ai: null };
      f.metadata.komga.dirty = false;
      emitFolders(f.targetId);
      emit({ type: 'shelf' });
      return folderView(f);
    },
    'POST /api/library/folders/:id/sync': ({ params }) => {
      const f = folderById(params.id!);
      syncFolder(f, 'manual');
      emitFolders(f.targetId);
      emit({ type: 'shelf' });
      return folderView(f);
    },
    'PUT /api/comics/:key/folder': ({ params, body }) => {
      const comic = comicOf(params.key!), target = targetOf(body.targetId);
      const path = naming(() => normalizePath(body.path));
      if (path === '/') throw new Fail(400, 'invalid', '请选择放着这部漫画的文件夹，而不是存储位置的根目录');
      const dir = joinPath(target.path, path);
      const inside = [...filesOn(fsOf(target))].filter(([file]) => file.startsWith(`${dir}/`));
      if (!inside.length) throw new Fail(404, 'not_found', `文件夹不存在：${path}`);
      const files = inside.filter(([file, size]) => size >= 0 && file.lastIndexOf('/') === dir.length).map(([file]) => leaf(file));
      linkFolder(upsertFolder(target, { path, files }), comic.key);
      for (const format of ['epub', 'mobi'] as const) checks.delete(`${comic.key}|${target.id}|${format}`);
      emitFolders(target.id);
      emit({ type: 'shelf' });
      return detail(comic.key, { targetId: target.id });
    },
    'DELETE /api/comics/:key/folder': ({ params, query }) => {
      const comic = comicOf(params.key!), target = targetOf(query.targetId);
      const mapped = db.comicFolders.get(`${comic.key}|${target.id}`);
      const record = mapped ? db.folders.find(f => f.targetId === target.id && f.path === mapped) : undefined;
      if (record?.kmoe.comicKey === comic.key) unlinkFolder(record, 'pending'); else db.comicFolders.delete(`${comic.key}|${target.id}`);
      for (const format of ['epub', 'mobi'] as const) checks.delete(`${comic.key}|${target.id}|${format}`);
      emitFolders(target.id);
      emit({ type: 'shelf' });
      return detail(comic.key, { targetId: target.id });
    },

    'GET /api/metadata/settings': () => metadataView(),
    'PATCH /api/metadata/settings': ({ body }) => {
      const m = db.metadata;
      if (body.komga?.url?.trim() && !/^https?:\/\/[^/\s]+/i.test(body.komga.url.trim())) throw new Fail(400, 'invalid', 'Komga 地址需要以 http:// 或 https:// 开头');
      for (const mapping of body.komga?.libraries ?? []) {
        targetOf(mapping.targetId);
        if (!KOMGA_LIBRARIES.some(l => l.id === mapping.libraryId)) throw new Fail(400, 'invalid', 'Komga 里没有这个库，请重新测试连接后选择');
      }
      if (body.enabled !== undefined) m.enabled = body.enabled;
      if (body.komga) {
        const { url, auth, username, secret, libraries } = body.komga;
        if (url !== undefined) m.komga.url = url.trim();
        if (auth !== undefined) m.komga.auth = auth;
        if (username !== undefined) m.komga.username = username.trim();
        if (secret !== undefined) m.komga.secret = secret || null;
        if (libraries) m.komga.libraries = libraries;
      }
      if (body.bangumi) {
        const b = m.bangumi, { token, source } = body.bangumi;
        if (token !== undefined) b.token = token || null;
        if (source !== undefined) b.source = source;
      }
      if (body.options) Object.assign(m.options, body.options);
      refreshKomga();
      return metadataView();
    },
    'POST /api/metadata/komga/test': ({ body }) => {
      const saved = db.metadata.komga;
      const url = (body.url ?? saved.url).trim(), auth = body.auth ?? saved.auth, username = body.username ?? saved.username;
      const secret = body.secret !== undefined ? body.secret : saved.secret;
      const fail = (message: string) => ({ ok: false, message, version: null, libraries: [] });
      if (!url) return fail('请先填写 Komga 地址');
      if (!/^https?:\/\/[^/\s]+/i.test(url)) return fail('地址需要以 http:// 或 https:// 开头');
      if (/offline|unreachable/i.test(url)) return fail(`无法连接 ${hostOf(url)}：连接超时，请确认 Komga 正在运行`);
      if (!secret) return fail(auth === 'basic' ? '请填写 Komga 密码' : '请填写 Komga 的 API Key');
      if (/wrong|fail/i.test(secret) || (auth === 'basic' && !username)) return fail('Komga 返回 401：认证失败，请检查 API Key 或账号密码');
      return { ok: true, message: `已连接 Komga 1.14.1 · ${KOMGA_LIBRARIES.length} 个库`, version: '1.14.1', libraries: KOMGA_LIBRARIES };
    },
    'GET /api/bangumi/search': ({ query }) => {
      needBangumi();
      const q = titleKey(query.q);
      return BANGUMI.filter(entry => [entry.name, entry.nameCn, ...entry.aliases].some(title => { const t = titleKey(title); return !!t && (t.includes(q) || q.includes(t)); }))
        .slice(0, 10).map(subject);
    },
    'POST /api/bangumi/archive/update': ({ body }) => {
      const b = db.metadata.bangumi, current = b.archive, latest = latestDump();
      if (current.state === 'downloading' || current.state === 'importing') return structuredClone(current);
      b.archive = { ...current, checkedAt: iso() };
      const fresh = current.state === 'ready' && current.dump === latest.name;
      if (fresh && !body.force) emitArchive(); // already the newest dump
      else runArchive(!fresh); // a newer (or missing) dump is downloaded first; force alone re-imports the one on disk
      return structuredClone(b.archive);
    },
    'POST /api/bangumi/online/test': ({ body }) => {
      const b = db.metadata.bangumi, proxy = (body.proxy ?? db.settings.proxy).trim();
      // This NAS cannot reach bgm.tv directly; a proxy (unless it is "bad") gets through.
      const reachable = !!proxy && !/bad|wrong|fail/i.test(proxy);
      const error = reachable ? null : proxy ? `代理 ${hostOf(proxy) || proxy} 拒绝连接` : '连接被重置（ECONNRESET），网络可能屏蔽了 Bangumi';
      if (proxy === db.settings.proxy) b.online = { reachable, checkedAt: iso(), error };
      return { reachable, message: reachable ? `可以访问 bgm.tv（经代理 ${hostOf(proxy) || proxy}，延迟 280 ms）` : `无法访问 bgm.tv：${error}` };
    },

    'GET /api/sources': () => db.sources.map(sourceView),
    'POST /api/sources': ({ body }) => {
      const source: Source = { ...body, id: nextId(), itemCount: 0, pendingCount: 0, lastSyncAt: null, error: null };
      db.sources.push(source);
      setTimeout(() => syncSource(source), 1500);
      return sourceView(source);
    },
    'PATCH /api/sources/:id': ({ params, body }) => {
      const source = db.sources.find(s => s.id === Number(params.id));
      if (!source) throw new Fail(404, 'not_found', '书单不存在');
      Object.assign(source, body);
      return sourceView(source);
    },
    'DELETE /api/sources/:id': ({ params }) => {
      db.sources = db.sources.filter(s => s.id !== Number(params.id));
      db.sourceItems = db.sourceItems.filter(i => i.sourceId !== Number(params.id));
      return OK;
    },
    'POST /api/sources/:id/sync': ({ params }) => {
      const source = db.sources.find(s => s.id === Number(params.id));
      if (!source) throw new Fail(404, 'not_found', '书单不存在');
      syncSource(source);
      return sourceView(source);
    },
    'GET /api/sources/:id/items': ({ params }) => db.sourceItems.filter(i => i.sourceId === Number(params.id)),
    'POST /api/source-items/:id/match': ({ params, body }) => {
      const found = sourceItem(Number(params.id)), comic = comicOf(body.comicKey);
      found.match = { state: 'matched', comicKey: comic.key, comicTitle: comic.title };
      return found;
    },
    'POST /api/source-items/:id/dismiss': ({ params }) => {
      const found = sourceItem(Number(params.id));
      found.match = { state: 'dismissed', comicKey: null, comicTitle: null };
      return found;
    },
    'POST /api/source-items/:id/restore': ({ params }) => {
      const found = sourceItem(Number(params.id));
      found.match = { state: 'pending', comicKey: null, comicTitle: null };
      return found;
    },
  };

  const routes = (Object.keys(endpoints) as EndpointKey[]).map(key => {
    const [method, template] = key.split(' ') as [string, string];
    const names: string[] = [];
    const pattern = new RegExp(`^${template.replace(/:(\w+)/g, (_, name: string) => { names.push(name); return '([^/]+)'; })}$`);
    return { key, method, pattern, names };
  });
  const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

  async function transport(input: string, init: RequestInit): Promise<Response> {
    const url = new URL(input, location.origin);
    const method = init.method ?? 'GET';
    if (method === 'POST' && url.pathname === '/api/ai/chat') {
      await sleep(random(300, 600), init.signal);
      if (!db.auth.authenticated) return reply(401, { error: { code: 'unauthorized', message: '登录已过期，请重新登录' } });
      return demoChat(JSON.parse(String(init.body)) as { messages: ChatMessage[]; page?: string });
    }
    const route = routes.find(r => r.method === method && r.pattern.test(url.pathname));
    const slow = route?.key.includes('/test') || route?.key.includes('/browse') || route?.key.includes('/login');
    await sleep(method === 'GET' ? random(90, 280) : slow ? random(500, 900) : random(220, 520), init.signal);
    if (!route) return reply(404, { error: { code: 'not_found', message: `演示数据没有实现 ${method} ${url.pathname}` } });
    if (!PUBLIC.has(route.key)) {
      if (!db.auth.authenticated) return reply(401, { error: { code: 'unauthorized', message: '登录已过期，请重新登录' } });
      if (method !== 'GET' && new Headers(init.headers).get('X-CSRF-Token') !== db.auth.csrf) return reply(403, { error: { code: 'csrf', message: '会话校验失败，请刷新页面后重试' } });
    }
    const spec = endpoints[route.key];
    const match = url.pathname.match(route.pattern)!;
    const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1]!)]));
    const query = 'query' in spec ? spec.query.safeParse(Object.fromEntries(url.searchParams)) : { success: true as const, data: undefined };
    const body = 'body' in spec ? spec.body.safeParse(init.body ? JSON.parse(String(init.body)) : undefined) : { success: true as const, data: undefined };
    const invalid = !query.success ? query.error : !body.success ? body.error : null;
    if (invalid) return reply(400, { error: { code: 'invalid', message: invalid.issues[0]?.message ?? '请求参数无效' } });
    try {
      const result = (handlers[route.key] as Handler<EndpointKey>)({ params, query: query.data as never, body: body.data as never });
      if (import.meta.env.DEV) {
        const check = spec.res.safeParse(result);
        if (!check.success) console.error(`[mock] ${route.key} response does not match the schema`, check.error.issues, result);
      }
      return reply(200, result);
    } catch (error) {
      if (error instanceof Fail) return reply(error.status, { error: { code: error.code, message: error.message } });
      console.error('[mock]', route.key, error);
      return reply(500, { error: { code: 'internal', message: '演示服务出错了' } });
    }
  }

  function eventSource(): MockEventSource {
    const source: MockEventSource = { onmessage: null, onerror: null, onopen: null, close: () => { listeners.delete(source); } };
    listeners.add(source);
    setTimeout(() => { if (listeners.has(source)) source.onopen?.(new Event('open')); }, 60);
    return source;
  }

  return { transport, eventSource };
}
