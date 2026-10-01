// Admin API handlers: one per endpoint in shared/api.ts. Thin: validation happens in the router, logic in services.
import { normalizePath } from '@shared/naming';
import type { App } from '../app';
import { AppError } from '../http/errors';
import type { Handlers } from '../http/router';
import { proxyUrl } from '../lib/proxy';
import { errorMessage } from '../lib/retry';
import { randomToken, sha256 } from '../lib/crypto';
import { deliver } from '../notify';

const ok = { ok: true } as const;
const id = (value: string | undefined) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new AppError(400, 'invalid_id', '编号无效');
  return number;
};

export function createHandlers(app: App): Handlers {
  const { auth, kmoe, comics, tasks, worker, subscriptions, targets, settings, sources, activity, config, library, metadata, ai } = app;
  const detailOf = (key: string, targetId?: number) => comics.detail(key, targetId === undefined ? {} : { targetId }, targets.defaultId());
  const authState = (session: { csrf: string } | null) => ({ setupRequired: !auth.isSetUp(), authenticated: Boolean(session), csrf: session?.csrf ?? null });
  const queueState = () => app.status().queue;

  return {
    // ---------- Admin ----------
    'GET /api/auth/state': ({ session }) => authState(session),
    'POST /api/auth/setup': async ({ body, headers }) => {
      await auth.setup(body.password);
      const { token, session } = auth.createSession();
      headers.append('Set-Cookie', auth.cookie(token));
      return authState(session);
    },
    'POST /api/auth/login': async ({ body, ip, headers }) => {
      await auth.verify(body.password, ip);
      const { token, session } = auth.createSession();
      headers.append('Set-Cookie', auth.cookie(token));
      return authState(session);
    },
    'POST /api/auth/logout': ({ session, headers }) => {
      auth.endSession(session);
      headers.append('Set-Cookie', auth.cookie(null));
      return authState(null);
    },
    'POST /api/auth/password': async ({ body, ip, session }) => {
      await auth.changePassword(body.current, body.next, ip);
      auth.endOtherSessions(session);
      return ok;
    },

    'GET /api/status': () => app.status(),

    // ---------- Kmoe account ----------
    'POST /api/kmoe/login': async ({ body }) => {
      const account = await kmoe.login(body.email, body.password, body.mirror, body.remember);
      // The mirror setting names the mirror in use: the one this login went to.
      if (account.mirror) settings.patch({ preferredMirror: account.mirror });
      activity.add({ kind: 'info', level: 'success', title: `已登录 Kmoe（${account.email}）` });
      app.emitStatus();
      return account;
    },
    'POST /api/kmoe/refresh': async () => {
      const account = await kmoe.refresh();
      app.resumeIfQuotaRecovered();
      app.emitStatus();
      return account;
    },
    'POST /api/kmoe/logout': () => { const account = kmoe.logout(); app.emitStatus(); return account; },
    'DELETE /api/kmoe/password': () => { const account = kmoe.forgetPassword(); app.emitStatus(); return account; },
    'GET /api/kmoe/mirrors': () => config.mirrors.map(origin => new URL(origin).host),

    // ---------- Discover ----------
    'GET /api/search': ({ query }) => comics.search(query.q, query.page ?? 1),
    'POST /api/resolve': ({ body }) => ({ key: comics.resolve(body.input) }),

    // ---------- Comics ----------
    'GET /api/comics/:key': ({ params, query }) => comics.detail(params.key!, query, targets.defaultId()),
    'POST /api/comics/:key/refresh': ({ params, query }) => comics.detail(params.key!, query, targets.defaultId(), true),
    'POST /api/comics/:key/library-check': async ({ params, body }) => {
      const { id: comicId } = await comics.sync(params.key!);
      return library.check(comicId, body.targetId, body.format);
    },
    'PUT /api/comics/:key/folder': async ({ params, body }) => {
      await library.mapComic(params.key!, body.targetId, body.path);
      return detailOf(params.key!, body.targetId);
    },
    'DELETE /api/comics/:key/folder': async ({ params, query }) => {
      await library.unmapComic(params.key!, query.targetId);
      return detailOf(params.key!, query.targetId);
    },
    'PUT /api/comics/:key/subscription': ({ params, body }) => subscriptions.save(params.key!, body),
    'POST /api/comics/:key/subscription/preview': ({ params, body }) => subscriptions.preview(params.key!, body),
    'DELETE /api/comics/:key/subscription': ({ params, query }) => { subscriptions.remove(params.key!, query.cancelPending ?? false); return ok; },
    'POST /api/comics/:key/check': async ({ params }) => { await subscriptions.check(params.key!); return ok; },

    'GET /api/shelf': () => comics.shelf(targets.defaultId()),
    'POST /api/checks/run': () => {
      const queued = subscriptions.count(true);
      void subscriptions.checkDue(true);
      return { queued };
    },

    // ---------- Queue ----------
    'GET /api/tasks': ({ query }) => tasks.list(query),
    'POST /api/tasks': ({ body, via }) => tasks.create(body, via === 'token' ? 'api' : 'manual'),
    'POST /api/tasks/:id/cancel': ({ params }) => { tasks.cancel(id(params.id)); return ok; },
    'POST /api/tasks/:id/retry': ({ params }) => { tasks.retry(id(params.id)); return ok; },
    'POST /api/tasks/retry-failed': () => ({ retried: tasks.retryFailed() }),
    'POST /api/tasks/cancel-queued': () => ({ cancelled: tasks.cancelAllQueued() }),
    'POST /api/tasks/clear-finished': () => ({ removed: tasks.clearFinished() }),
    'POST /api/queue/pause': () => { worker.pause('manual'); return queueState(); },
    'POST /api/queue/resume': () => {
      worker.resume();
      activity.add({ kind: 'queue_resumed', level: 'info', title: '下载队列已继续' });
      return queueState();
    },

    // ---------- Targets ----------
    'GET /api/targets': () => targets.list(),
    'POST /api/targets': ({ body }) => { const target = targets.create(body); app.emitStatus(); return target; },
    'PATCH /api/targets/:id': ({ params, body }) => targets.update(id(params.id), body),
    'DELETE /api/targets/:id': ({ params }) => { targets.remove(id(params.id)); app.emitStatus(); return ok; },
    'POST /api/targets/:id/default': ({ params }) => { targets.setDefault(id(params.id)); return ok; },
    'POST /api/targets/test': async ({ body }) => {
      try { return await targets.open(targets.fromRef(body)).test(AbortSignal.timeout(20_000)); } catch (error) { return { ok: false, message: errorMessage(error) }; }
    },
    'POST /api/targets/browse': async ({ body }) => {
      // Paths are relative to the library root (local) or the WebDAV server root, so the target's own folder can be chosen too.
      const path = normalizePath(body.path || '/');
      const root = targets.open({ ...targets.fromRef(body.ref), path: '/' });
      return { path, entries: await root.list(path, { signal: AbortSignal.timeout(20_000) }) };
    },

    // ---------- Settings ----------
    'GET /api/settings': () => settings.view(),
    'GET /api/about': () => app.about(),
    'PATCH /api/settings': async ({ body }) => {
      if (body.defaultTargetId != null && !targets.exists(body.defaultTargetId)) throw new AppError(404, 'target_not_found', '找不到该存储位置');
      if (body.preferredMirror && !config.mirrors.some(origin => new URL(origin).host === body.preferredMirror)) throw new AppError(400, 'invalid_mirror', '不支持的镜像站');
      if (body.notifications && new Set(body.notifications.map(channel => channel.id)).size !== body.notifications.length) throw new AppError(400, 'duplicate_channel', '通知渠道编号重复');
      // A logged-in session moves along, and only to a mirror that accepts it; otherwise nothing is saved.
      if (body.preferredMirror) await kmoe.moveSession(body.preferredMirror);
      const proxy = settings.get().proxy;
      settings.patch(body.proxy === undefined ? body : { ...body, proxy: proxyUrl(body.proxy) });
      if (settings.get().proxy !== proxy) metadata.networkChanged();
      worker.wake();
      app.emitStatus();
      return settings.view();
    },
    'POST /api/network/test': ({ body }) => metadata.testNetwork(body.proxy, body.kmoe ? kmoe.origin() : null),
    'POST /api/notifications/test': async ({ body }) => {
      try {
        await deliver(settings.unmask(body), { event: 'new_items', title: 'Kmoe Sync 测试通知', detail: '看到这条消息说明通知渠道已配置成功。' }, app.net);
        return { ok: true, message: '已发送测试通知' };
      } catch (error) { return { ok: false, message: errorMessage(error) }; }
    },
    'POST /api/token': () => {
      const token = `kms_${randomToken(24)}`;
      settings.setApiTokenHash(sha256(token));
      return { token };
    },
    'DELETE /api/token': () => { settings.setApiTokenHash(null); return ok; },
    'POST /api/import/extension': ({ body }) => { const result = targets.importExtension(body.config); app.emitStatus(); return result; },

    'GET /api/activity': ({ query }) => activity.list(query.limit ?? 50),

    // ---------- Library ----------
    'GET /api/library': ({ query }) => {
      const targetId = query.targetId ?? targets.defaultId();
      if (targetId === null) throw new AppError(404, 'target_not_found', '还没有存储位置');
      return library.overview(targetId);
    },
    'POST /api/library/scan': ({ body }) => library.scan(body.targetId, body.match),
    'POST /api/library/match-kmoe': ({ body }) => library.matchKmoe(body.targetId, body.retry),
    'POST /api/library/match-bangumi': ({ body }) => { targets.get(body.targetId); return metadata.startMatchJob(body.targetId, body.retry); },
    'POST /api/library/sync-komga': ({ body }) => { targets.get(body.targetId); return metadata.startSyncJob(body.targetId, body.all); },
    'POST /api/library/follow': ({ body }) => library.follow(body.targetId),
    'POST /api/library/cancel': () => app.jobs.cancel(),
    'POST /api/library/accept-suggested': ({ body }) => library.acceptSuggested(body.targetId, body.minScore),
    'POST /api/library/folders/:id/kmoe': ({ params, body }) => library.linkFolder(id(params.id), body.comic),
    'POST /api/library/folders/:id/ignore': ({ params }) => library.ignore(id(params.id)),
    'POST /api/library/folders/:id/reset': ({ params }) => library.reset(id(params.id)),
    'POST /api/library/folders/:id/bangumi': async ({ params, body }) => {
      const folderId = library.row(id(params.id)).id;
      if (!body.subject && !body.auto) throw new AppError(400, 'invalid_request', '请提供 Bangumi 条目，或选择自动匹配');
      await metadata.matchFolder(folderId, { subject: body.subject || undefined, auto: body.auto });
      return library.folder(folderId);
    },
    'DELETE /api/library/folders/:id/bangumi': ({ params }) => {
      const folderId = library.row(id(params.id)).id;
      metadata.unmatchFolder(folderId);
      return library.folder(folderId);
    },
    'POST /api/library/folders/:id/sync': async ({ params }) => {
      const folderId = library.row(id(params.id)).id;
      await metadata.syncFolder(folderId);
      return library.folder(folderId);
    },

    // ---------- AI ----------
    'GET /api/ai/settings': () => ai.settings(),
    'PATCH /api/ai/settings': ({ body }) => ai.patch(body),
    'POST /api/ai/test': ({ body }) => ai.test(body),
    'POST /api/library/ai-match': ({ body }) => body.kind === 'kmoe' ? library.startAiMatch(body.targetId, ai) : metadata.startAiMatch(body.targetId, ai),
    'POST /api/library/ai-polish': ({ body }) => metadata.startAiPolish(body.targetId, body.all, ai),
    'GET /api/library/ai-polish': ({ query }) => metadata.polishList(query.targetId),
    'POST /api/library/ai-polish/decide': ({ body }) => metadata.decidePolish(body.folderIds, body.accept),

    // ---------- Metadata ----------
    'GET /api/metadata/settings': () => metadata.settings(),
    'PATCH /api/metadata/settings': ({ body }) => metadata.patchSettings(body),
    'POST /api/metadata/komga/test': ({ body }) => metadata.testKomga(body),
    'GET /api/bangumi/search': ({ query }) => metadata.searchBangumi(query.q),
    'POST /api/bangumi/archive/update': ({ body }) => metadata.updateArchive(body.force),
    'POST /api/bangumi/online/test': ({ body }) => metadata.testOnline(body.proxy),

    // ---------- Bangumi ----------
    'GET /api/sources': () => sources.list(),
    'POST /api/sources': ({ body }) => sources.create(body),
    'PATCH /api/sources/:id': ({ params, body }) => sources.update(id(params.id), body),
    'DELETE /api/sources/:id': ({ params }) => { sources.remove(id(params.id)); return ok; },
    'POST /api/sources/:id/sync': ({ params }) => sources.sync(id(params.id)),
    'GET /api/sources/:id/items': ({ params }) => sources.items(id(params.id)),
    'POST /api/source-items/:id/match': async ({ params, body }) => {
      const key = comics.resolve(body.comicKey);
      await comics.sync(key);
      return sources.setMatch(id(params.id), 'matched', key);
    },
    'POST /api/source-items/:id/dismiss': ({ params }) => sources.setMatch(id(params.id), 'dismissed'),
    'POST /api/source-items/:id/restore': ({ params }) => sources.setMatch(id(params.id), 'pending'),
  };
}
