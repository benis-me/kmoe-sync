// Composition root: builds every service, the HTTP routes and the background scheduler.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import type { Server } from 'bun';
import type { About, Status } from '@shared/model';
import { AiService } from './ai/service';
import { chatResponse } from './ai/assistant';
import { createHandlers } from './api/handlers';
import { mcpHandler, toolCaller } from './api/mcp';
import { VERSION, type Config } from './config';
import { json, now, openDatabase, type DB } from './db';
import { EventHub, sseResponse } from './events';
import { AdminAuth } from './http/auth';
import { AppError, errorResponse } from './http/errors';
import { buildRoutes, type Routes } from './http/router';
import { kmoeThrottle, persistKmoeThrottle } from './kmoe/client';
import { COMIC_KEY } from './kmoe/parser';
import { createSealer, safeEqual, sha256 } from './lib/crypto';
import { proxied } from './lib/proxy';
import { errorMessage } from './lib/retry';
import { Notifier } from './notify';
import { ActivityLog } from './services/activity';
import { ComicService } from './services/comics';
import { KmoeService } from './services/kmoe';
import { JobRunner } from './services/jobs';
import { LibraryService } from './services/library';
import { MetadataService } from './metadata/service';
import { SettingsStore } from './services/settings';
import { SourceService } from './services/sources';
import { SubscriptionService } from './services/subscriptions';
import { TargetService } from './services/targets';
import { TaskService } from './services/tasks';
import { Worker } from './services/worker';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
};
/** Session health: re-validate the Kmoe login (and refresh quota) this often. */
const ACCOUNT_REFRESH_MS = 6 * 3_600_000;
/** A queue paused for a lost connection tries again after this long. */
const NETWORK_RETRY_MS = 3 * 60_000;
/** An instance heartbeat older than this means that instance is gone. */
const INSTANCE_STALE_MS = 45_000;

export interface AppOptions {
  fetch?: typeof fetch; database?: string; scheduler?: boolean;
  /** Spacing between Kmoe requests in bulk jobs (imports, subscription batches); tests shorten it. */
  bulkPaceMs?: number;
}

/** Every service plus the cross-cutting helpers handlers need; no HTTP or timers. */
function createCore(config: Config, options: AppOptions) {
  for (const dir of [config.dataDir, config.libraryRoot]) mkdirSync(dir, { recursive: true });
  const db: DB = openDatabase(config.dataDir, options.database);
  const sealer = createSealer(config.secret);
  const hub = new EventHub();
  const settings = new SettingsStore(db);
  persistKmoeThrottle(settings.kmoeThrottle(), state => settings.setKmoeThrottle(state));
  /** fetch for everything that leaves the LAN (Bangumi lists, notifications): through 设置 → 网络代理 when set. */
  const net = proxied(options.fetch ?? fetch, () => settings.get().proxy);
  const notifier = new Notifier(() => settings.get().notifications, net);
  const activity = new ActivityLog(db, hub, notifier);
  const ai = new AiService({ db, sealer, settings, fetch: options.fetch });
  const kmoe = new KmoeService(db, sealer, config.mirrors, () => settings.get().preferredMirror, options.fetch, () => settings.get().proxyKmoe ? settings.get().proxy : '');
  const targets = new TargetService(db, sealer, settings, config.libraryRoot);
  const comics = new ComicService(db, kmoe, hub, settings);
  const tasks = new TaskService(db, hub, settings, comics, targets);
  const jobs = new JobRunner(hub);
  const metadata = new MetadataService({ db, hub, sealer, settings, activity, comics, targets, kmoe, jobs, fetch: options.fetch, dataDir: config.dataDir });
  const subscriptions = new SubscriptionService({ db, hub, comics, tasks, targets, settings, activity, pace: options.bulkPaceMs });
  const library = new LibraryService({ db, hub, comics, targets, kmoe, settings, jobs, metadata, subscriptions, activity, pace: options.bulkPaceMs });
  comics.hooks = { folder: (comicId, targetId) => library.comicFolder(comicId, targetId), metadata: id => metadata.forFolders([id]).get(id) ?? null };
  library.backfill();
  const worker = new Worker({ db, tasks, comics, targets, kmoe, settings, activity, library, tmpDir: join(config.dataDir, 'tmp') });
  const sources = new SourceService(db, hub, activity, net);
  const auth = new AdminAuth(db, config.secureCookies);

  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = now();
  const app = {
    config, db, hub, settings, activity, kmoe, targets, comics, tasks, jobs, metadata, library, worker, subscriptions, sources, auth, net, ai,

    status(): Status {
      const reason = settings.pause().reason;
      return {
        version: VERSION, kmoe: kmoe.account(), queue: { paused: reason !== null, reason, counts: tasks.counts(), speed: Math.round(worker.speed) },
        nextCheckAt: subscriptions.nextCheckAt(), checking: subscriptions.checking, libraryRoot: config.libraryRoot, targets: targets.list().length,
      };
    },
    about(): About {
      const file = options.database === ':memory:' ? null : join(config.dataDir, options.database ?? 'kmoesync.db');
      const size = (path: string) => { try { return statSync(path).size; } catch { return 0; } };
      const count = (table: string) => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
      return {
        version: VERSION, startedAt, paths: { data: config.dataDir, library: config.libraryRoot },
        runtime: { bun: Bun.version, platform: process.platform, arch: process.arch, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        user: typeof process.getuid === 'function' && typeof process.getgid === 'function' ? { uid: process.getuid(), gid: process.getgid() } : null,
        databaseBytes: file ? size(file) + size(`${file}-wal`) : 0,
        counts: { comics: count('comics'), subscriptions: count('subscriptions'), folders: count('library_folders'), tasks: count('tasks') },
      };
    },
    /** Status is pushed at most every 500 ms, however many changes happen. */
    emitStatus() {
      statusTimer ??= setTimeout(() => { statusTimer = undefined; hub.emit({ type: 'status', status: app.status() }); }, 500);
    },
    dispose() { clearTimeout(statusTimer); statusTimer = undefined; jobs.dispose(); },
    tokenValid(req: Request): boolean {
      const hash = settings.apiTokenHash();
      const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
      return Boolean(hash && token && safeEqual(sha256(token), hash));
    },
    /** Scheduler step: an expired session with a remembered password logs in again by itself; what went wrong is logged. */
    async autoLogin() {
      const result = await kmoe.autoLogin();
      if (result?.outcome === 'failed') {
        activity.add({ kind: 'session_expired', level: 'error', title: 'Kmoe 自动重新登录失败，下载已暂停', detail: `${result.message}。已删除保存的密码，请在设置中重新登录。` });
      } else if (result?.outcome === 'retry' && result.first) {
        activity.add({ kind: 'info', level: 'warning', title: 'Kmoe 自动重新登录暂时没成功，稍后再试', detail: result.message });
      }
      if (result) app.emitStatus();
    },
    /** After a quota refresh: continue a queue that was paused for quota once there is room again. */
    resumeIfQuotaRecovered() {
      const account = kmoe.account();
      if (settings.pause().reason === 'quota' && account.remainingMB !== null && account.remainingMB > settings.get().quotaReserveMB) {
        worker.resume();
        activity.add({ kind: 'queue_resumed', level: 'info', title: 'Kmoe 额度已恢复，继续下载' });
      }
    },
  };
  tasks.onChange = worker.onChange = subscriptions.onChange = app.emitStatus;

  kmoe.setHooks({
    expired(message) {
      worker.pause('auth');
      // With a remembered password the scheduler logs in again within a minute: no notification unless that fails.
      if (kmoe.autoLoginReady()) activity.add({ kind: 'info', level: 'warning', title: 'Kmoe 登录已失效，正在自动重新登录', detail: message });
      else activity.add({ kind: 'session_expired', level: 'error', title: 'Kmoe 登录已失效，下载已暂停', detail: `${message}。请在设置中重新登录。` });
      app.emitStatus();
    },
    restored(auto) {
      const paused = settings.pause().reason === 'auth';
      if (paused) worker.resume();
      if (paused || auto) activity.add({ kind: 'session_restored', level: 'success', title: `${auto ? '已自动重新登录 Kmoe' : 'Kmoe 已重新登录'}${paused ? '，下载继续' : ''}` });
      app.emitStatus();
    },
  });
  targets.ensureDefault();
  return app;
}

export type App = ReturnType<typeof createCore>;

export function createApp(config: Config, options: AppOptions = {}) {
  const app = createCore(config, options);
  const { db, hub, kmoe, comics, worker, subscriptions, sources, auth, settings, library, metadata } = app;

  // ---------- Covers: fetched once from Kmoe, cached on disk ----------
  const coversDir = join(config.dataDir, 'covers');
  const fetchingCovers = new Map<string, Promise<void>>();
  async function cover(key: string): Promise<Response> {
    if (!COMIC_KEY.test(key)) throw new AppError(400, 'invalid_key', '漫画标识无效');
    const file = join(coversDir, key);
    if (!existsSync(file)) {
      const comic = comics.find(key);
      if (!comic?.cover_url) throw new AppError(404, 'no_cover', '没有封面');
      let pending = fetchingCovers.get(key);
      if (!pending) {
        pending = (async () => {
          const response = await kmoe.net(comic.cover_url!, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'Mozilla/5.0 Kmoe Sync', Referer: `${kmoe.origin()}/` } });
          const type = response.headers.get('content-type') ?? '';
          if (!response.ok || !type.startsWith('image/')) throw new AppError(502, 'cover_failed', '封面下载失败');
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength > 5 * 1024 * 1024) throw new AppError(502, 'cover_failed', '封面过大');
          await mkdir(coversDir, { recursive: true });
          await Bun.write(`${file}.tmp`, bytes);
          await Bun.write(`${file}.type`, type.split(';')[0]!.trim());
          await rename(`${file}.tmp`, file);
        })().finally(() => fetchingCovers.delete(key));
        fetchingCovers.set(key, pending);
      }
      await pending;
    }
    const type = existsSync(`${file}.type`) ? await Bun.file(`${file}.type`).text() : 'image/jpeg';
    return new Response(Bun.file(file), { headers: {
      'Content-Type': /^image\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream', 'Cache-Control': 'private, max-age=604800',
      // Covers can be SVG: never let one run script in this origin.
      'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    } });
  }

  // ---------- HTTP ----------
  const handlers = createHandlers(app);
  const mcp = mcpHandler(app, handlers);
  const requireSession = (req: Request) => { if (!auth.session(req) && !app.tokenValid(req)) throw new AppError(401, 'unauthenticated', '请先登录'); };
  const guard = (handler: (req: Request & { params: Record<string, string> }) => Promise<Response> | Response) =>
    async (req: Request & { params: Record<string, string> }) => { try { return await handler(req); } catch (error) { return errorResponse(error); } };

  const routes: Routes = {
    ...buildRoutes(handlers, auth, app.tokenValid),
    // Also proves the database is writable: a full /data disk turns the container unhealthy instead of silently stuck.
    '/api/health': { GET: async () => {
      try { db.run("INSERT INTO meta (key, value) VALUES ('health', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [now()]); } catch (error) {
        return Response.json({ ok: false, version: VERSION, error: errorMessage(error) }, { status: 503 });
      }
      return Response.json({ ok: true, version: VERSION });
    } },
    '/api/events': { GET: guard(req => {
      const session = auth.session(req);
      if (!session) throw new AppError(401, 'unauthenticated', '请先登录');
      return sseResponse(hub, [{ type: 'status', status: app.status() }], req.signal);
    }) },
    '/api/covers/:key': { GET: guard(req => { requireSession(req); return cover(req.params.key ?? ''); }) },
    // The assistant streams its answer (newline-delimited JSON), so it is not a typed JSON endpoint.
    '/api/ai/chat': { POST: guard(req => {
      const session = auth.session(req);
      if (!session) throw new AppError(401, 'unauthenticated', '请先登录');
      auth.checkCsrf(req, session);
      return chatResponse(req, app, toolCaller(handlers, 'session'));
    }) },
    '/mcp': { POST: mcp, GET: mcp, DELETE: mcp },
  };
  // Security headers on every route response.
  for (const methods of Object.values(routes)) {
    for (const [method, handler] of Object.entries(methods)) {
      methods[method] = async (req, server) => {
        const response = await handler!(req, server);
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!response.headers.has(name)) response.headers.set(name, value);
        return response;
      };
    }
  }

  const staticRoot = resolve(config.staticDir);
  async function serveStatic(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const secured = (response: Response) => { for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value); return response; };
    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') return secured(errorResponse(new AppError(404, 'not_found', '接口不存在')));
    if (req.method !== 'GET' && req.method !== 'HEAD') return secured(new Response(null, { status: 405 }));
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { pathname = '/'; }
    const path = normalize(join(staticRoot, pathname));
    const headers = new Headers(SECURITY_HEADERS);
    if ((path === staticRoot || path.startsWith(staticRoot + sep)) && existsSync(path) && statSync(path).isFile()) {
      headers.set('Cache-Control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      // The build's Brotli / gzip copies (vite.config.ts), when the browser accepts them: a quarter of the bytes.
      const accepted = req.headers.get('accept-encoding') ?? '';
      const encoding = /\bbr\b/.test(accepted) && existsSync(`${path}.br`) ? 'br' : /\bgzip\b/.test(accepted) && existsSync(`${path}.gz`) ? 'gzip' : null;
      if (encoding) {
        headers.set('Content-Encoding', encoding);
        headers.set('Content-Type', Bun.file(path).type);
        headers.set('Vary', 'Accept-Encoding');
        return new Response(Bun.file(`${path}.${encoding === 'br' ? 'br' : 'gz'}`), { headers });
      }
      return new Response(Bun.file(path), { headers });
    }
    // A stale hashed asset (after an upgrade) must 404, not come back as HTML the browser tries to run.
    if (pathname.startsWith('/assets/')) return new Response('Not found', { status: 404, headers });
    const index = join(staticRoot, 'index.html');
    if (!existsSync(index)) return new Response('Web UI not built. Run `bun run build`, or use `bun run dev` during development.', { status: 404, headers });
    headers.set('Cache-Control', 'no-cache');
    return new Response(Bun.file(index), { headers: { ...Object.fromEntries(headers), 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // ---------- Background work ----------
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  // Quota spent since the last refresh lives in memory, so re-read it once after every start.
  let refreshedSinceStart = false;
  let wasThrottled = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await app.autoLogin();
      const account = kmoe.account();
      if (account.state === 'active' && (!refreshedSinceStart || !account.checkedAt || Date.now() - Date.parse(account.checkedAt) > ACCOUNT_REFRESH_MS)) {
        refreshedSinceStart = true;
        await kmoe.refresh().then(() => app.resumeIfQuotaRecovered(), () => {});
        app.emitStatus();
      }
      // A network pause resumes by itself; if the connection is still down the next failure pauses it again.
      const pause = settings.pause();
      if (pause.reason === 'network' && pause.since && Date.now() - Date.parse(pause.since) > NETWORK_RETRY_MS) worker.resume();
      if (pause.reason === 'throttled' && !kmoeThrottle()) worker.resume();
      const throttled = Boolean(kmoeThrottle());
      if (throttled !== wasThrottled) { wasThrottled = throttled; app.emitStatus(); }
      // A batch of checks takes 10 s a comic: it runs on by itself (one at a time) instead of holding up the next ticks,
      // which resume the queue and log in again. Library hydrating waits for it, so bulk Kmoe work stays one page per 10 s.
      void subscriptions.checkDue().catch(error => console.error('[subscriptions]', error));
      if (!subscriptions.checking) await library.tick();
      // A first metadata sync can take minutes at Bangumi's rate limit: never hold up subscription checks for it
      // (the metadata tick prevents its own overlap).
      void metadata.tick().catch(error => console.error('[metadata]', error));
      await sources.syncDue();
    } catch (error) { console.error('[scheduler]', error); } finally { ticking = false; }
  }

  // Two containers on the same /data would corrupt each other's queue: the second one refuses to start.
  const instanceId = crypto.randomUUID();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  function claimInstance() {
    const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'instance'").get();
    const other = row ? json<{ id: string; at: number } | null>(row.value, null) : null;
    if (other && other.id !== instanceId && Date.now() - other.at < INSTANCE_STALE_MS) {
      throw new Error('另一个 Kmoe Sync 实例正在使用这个数据目录（/data）。如果它已经停止，请在一分钟后重试。');
    }
    db.run("INSERT INTO meta (key, value) VALUES ('instance', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify({ id: instanceId, at: Date.now() })]);
  }

  let server: Server<unknown> | undefined;
  return {
    ...app,
    routes,
    serveStatic,
    tick,
    start() {
      claimInstance();
      // Bind first: a second instance on the same data (e.g. `docker exec ... kmoesync`) must fail here,
      // before its worker touches running tasks or temp files.
      server = Bun.serve({ hostname: config.host, port: config.port, routes, fetch: serveStatic, idleTimeout: 0, error: errorResponse });
      heartbeat = setInterval(() => { try { db.run("UPDATE meta SET value = ? WHERE key = 'instance'", [JSON.stringify({ id: instanceId, at: Date.now() })]); } catch { /* disk full: health reports it */ } }, 15_000);
      worker.start();
      if (options.scheduler !== false) {
        tickTimer = setInterval(() => void tick(), 60_000);
        setTimeout(() => void tick(), 5_000);
      }
      return server;
    },
    async stop() {
      clearInterval(tickTimer);
      clearInterval(heartbeat);
      app.dispose();
      await worker.stop();
      // Force-close open connections: live-update streams (SSE) never finish on their own.
      await server?.stop(true);
      // Stops a Bangumi Archive download/import cleanly (it resumes on the next start) before the database closes.
      await metadata.dispose();
      hub.flush();
      try { db.run("DELETE FROM meta WHERE key = 'instance' AND value LIKE ?", [`%${instanceId}%`]); } catch { /* ignore */ }
      db.close();
    },
  };
}
