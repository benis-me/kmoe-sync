// MCP server over Streamable HTTP (stateless, JSON responses): POST /mcp with the API token as a Bearer credential.
// Each tool is a thin wrapper over an admin API endpoint, so validation and behaviour are identical.
import { z } from 'zod';
import type { EndpointKey, ResponseOf } from '@shared/api';
import { ContentType, Format, Strategy, TaskStatus } from '@shared/model';
import { VERSION } from '../config';
import { AppError, errorResponse } from '../http/errors';
import { invoke, type Handlers } from '../http/router';
import { errorMessage } from '../lib/retry';
import type { App } from '../app';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export type Call = <K extends EndpointKey>(key: K, input?: { params?: Record<string, string | number>; query?: Record<string, unknown>; body?: unknown }) => Promise<ResponseOf<K>>;
export interface Tool { description: string; input: z.ZodObject; run(args: Record<string, unknown>, call: Call, app: App): Promise<unknown> }

const key = z.string().min(1).describe('Kmoe 漫画标识（详情页 /c/<key>.htm 中的 key），或完整的 Kmoe 链接');

/** Also the in-app assistant's tools (server/ai/assistant.ts). */
export const TOOLS: Record<string, Tool> = {
  search_comics: {
    description: '在 Kmoe 上搜索漫画（需要已登录 Kmoe）。返回标题、作者、key 与是否已在书架。',
    input: z.object({ query: z.string().min(1), page: z.number().int().min(1).optional() }),
    run: (args, call) => call('GET /api/search', { query: { q: args.query, page: args.page } }),
  },
  get_comic: {
    description: '读取一部漫画的详情、全部卷/话、订阅设置，以及每一项在默认书库中的状态（已下载/缺失/队列中/失败）。',
    input: z.object({ key, targetId: z.number().int().optional(), format: Format.optional() }),
    run: async (args, call) => {
      const { key: comicKey } = await call('POST /api/resolve', { body: { input: args.key } });
      const detail = await call('GET /api/comics/:key', { params: { key: comicKey }, query: { targetId: args.targetId, format: args.format } });
      return { ...detail, items: detail.items.map(item => ({ ...item, state: detail.states[item.id]?.state ?? 'missing' })), states: undefined };
    },
  },
  list_shelf: {
    description: '列出书架：所有已订阅或下载过的漫画及其下载进度。',
    input: z.object({}),
    run: (_, call) => call('GET /api/shelf'),
  },
  subscribe: {
    description: '订阅（或修改订阅）一部漫画：之后检查到新卷/话时自动下载。strategy=backfill（新订阅的默认）同时把现在缺失的章节加入下载队列，future 只追新。修改已有订阅时，没给的参数保持原样。',
    input: z.object({ key, types: z.array(ContentType).min(1).optional(), format: Format.optional(), targetId: z.number().int().optional(), strategy: Strategy.optional() }),
    run: async (args, call, app) => {
      const { key: comicKey } = await call('POST /api/resolve', { body: { input: args.key } });
      const settings = app.settings.get();
      const comic = app.comics.find(comicKey), existing = comic ? app.subscriptions.get(comic.id) : null;
      const targetId = (args.targetId as number | undefined) ?? existing?.targetId ?? app.targets.defaultId();
      if (targetId === null) throw new AppError(409, 'no_target', '还没有存储位置，请先在设置中添加');
      return call('PUT /api/comics/:key/subscription', { params: { key: comicKey }, body: {
        enabled: true, types: args.types ?? existing?.types ?? ['volume'], format: args.format ?? existing?.format ?? settings.defaultFormat, targetId,
        strategy: args.strategy ?? existing?.strategy ?? 'backfill', line: existing?.line ?? settings.defaultLine,
      } });
    },
  },
  unsubscribe: {
    description: '取消订阅；cancelPending=true 时同时取消队列中尚未开始的订阅下载。',
    input: z.object({ key, cancelPending: z.boolean().optional() }),
    run: async (args, call) => {
      const { key: comicKey } = await call('POST /api/resolve', { body: { input: args.key } });
      return call('DELETE /api/comics/:key/subscription', { params: { key: comicKey }, query: { cancelPending: args.cancelPending ? 'true' : 'false' } });
    },
  },
  check_updates: {
    description: '立即检查一部已订阅漫画的更新；不传 key 时检查全部订阅。',
    input: z.object({ key: key.optional() }),
    run: async (args, call) => {
      if (!args.key) return call('POST /api/checks/run');
      const { key: comicKey } = await call('POST /api/resolve', { body: { input: args.key } });
      await call('POST /api/comics/:key/check', { params: { key: comicKey } });
      return call('GET /api/comics/:key', { params: { key: comicKey } }).then(detail => ({ newItems: detail.items.filter(item => item.isNew).map(item => item.name) }));
    },
  },
  download: {
    description: '把指定卷/话加入下载队列。itemIds 省略时下载 types 中所有缺失的项（默认单行本）。已下载或已在队列中的会被跳过。',
    input: z.object({ key, itemIds: z.array(z.string()).optional(), types: z.array(ContentType).optional(), format: Format.optional(), targetId: z.number().int().optional() }),
    run: async (args, call, app) => {
      const { key: comicKey } = await call('POST /api/resolve', { body: { input: args.key } });
      const settings = app.settings.get();
      const format = (args.format as z.infer<typeof Format> | undefined) ?? settings.defaultFormat;
      const targetId = (args.targetId as number | undefined) ?? app.targets.defaultId();
      if (targetId === null) throw new AppError(409, 'no_target', '还没有存储位置，请先在设置中添加');
      let itemIds = args.itemIds as string[] | undefined;
      if (!itemIds?.length) {
        const detail = await call('GET /api/comics/:key', { params: { key: comicKey }, query: { targetId, format } });
        const types = (args.types as string[] | undefined) ?? ['volume'];
        itemIds = detail.items.filter(item => types.includes(item.type) && ['missing', 'failed'].includes(detail.states[item.id]?.state ?? 'missing')).map(item => item.id);
        if (!itemIds.length) return { created: 0, skipped: 0, sizeMB: 0, note: '没有需要下载的项' };
      }
      return call('POST /api/tasks', { body: { comicKey, itemIds, format, targetId, line: settings.defaultLine } });
    },
  },
  list_downloads: {
    description: '列出下载任务（最新在前），可按状态过滤。',
    input: z.object({ status: TaskStatus.optional(), limit: z.number().int().min(1).max(100).optional() }),
    run: async (args, call) => {
      const list = await call('GET /api/tasks', { query: { status: args.status, limit: args.limit ?? 20 } });
      return { counts: list.counts, tasks: list.tasks.map(task => ({ id: task.id, comic: task.comicTitle, item: task.itemName, status: task.status, phase: task.phase, error: task.error, path: task.path, finishedAt: task.finishedAt })) };
    },
  },
  library_check: {
    description: '扫描存储位置，核对一部漫画哪些卷/话已经在书库里（按命名规则匹配，只读）。',
    input: z.object({ key, targetId: z.number().int().optional(), format: Format.optional() }),
    run: async (args, call, app) => {
      const { key: comicKey } = await call('POST /api/resolve', { body: { input: args.key } });
      const targetId = (args.targetId as number | undefined) ?? app.targets.defaultId();
      if (targetId === null) throw new AppError(409, 'no_target', '还没有存储位置');
      return call('POST /api/comics/:key/library-check', { params: { key: comicKey }, body: { targetId, format: args.format ?? app.settings.get().defaultFormat } });
    },
  },
  library_status: {
    description: '书库概况：扫描到的系列文件夹数量、与 Kmoe / Bangumi / Komga 的关联状态，以及正在运行的后台任务；可列出待确认或未匹配的文件夹。',
    input: z.object({ targetId: z.number().int().optional(), show: z.enum(['none', 'suggested', 'unmatched', 'errors']).optional() }),
    run: async (args, call) => {
      const overview = await call('GET /api/library', { query: { targetId: args.targetId } });
      const pick = (predicate: (folder: (typeof overview.folders)[number]) => boolean) => overview.folders.filter(predicate).slice(0, 50).map(folder => ({
        id: folder.id, path: folder.path, books: folder.books, kmoe: folder.kmoe.state, candidates: folder.kmoe.candidates.slice(0, 3).map(c => `${c.title} (${c.key}, ${Math.round(c.score * 100)}%)`),
        bangumi: folder.metadata.bangumi.state, komga: folder.metadata.komga.state, error: folder.kmoe.error ?? folder.metadata.komga.error,
      }));
      const show = args.show ?? 'none';
      return {
        targetId: overview.targetId, counts: overview.counts, job: overview.job,
        folders: show === 'suggested' ? pick(f => f.kmoe.state === 'suggested') : show === 'unmatched' ? pick(f => f.kmoe.state === 'unmatched')
          : show === 'errors' ? pick(f => Boolean(f.kmoe.error) || f.metadata.komga.state === 'error') : undefined,
      };
    },
  },
  scan_library: {
    description: '扫描书库里已有的漫画文件夹，并在 Kmoe 上匹配（需已登录 Kmoe）。在后台运行，用 library_status 查看进度。',
    input: z.object({ targetId: z.number().int().optional(), match: z.boolean().optional() }),
    run: async (args, call, app) => {
      const targetId = (args.targetId as number | undefined) ?? app.targets.defaultId();
      if (targetId === null) throw new AppError(409, 'no_target', '还没有存储位置');
      return call('POST /api/library/scan', { body: { targetId, match: args.match ?? true } });
    },
  },
  sync_metadata: {
    description: '把 Bangumi 元数据写入 Komga：先为没有条目的文件夹匹配 Bangumi（step=match），或同步待更新的文件夹（step=sync，all=true 同步全部）。后台运行。',
    input: z.object({ targetId: z.number().int().optional(), step: z.enum(['match', 'sync']).optional(), all: z.boolean().optional() }),
    run: async (args, call, app) => {
      const targetId = (args.targetId as number | undefined) ?? app.targets.defaultId();
      if (targetId === null) throw new AppError(409, 'no_target', '还没有存储位置');
      return args.step === 'match'
        ? call('POST /api/library/match-bangumi', { body: { targetId, retry: false } })
        : call('POST /api/library/sync-komga', { body: { targetId, all: args.all ?? false } });
    },
  },
  get_status: {
    description: '服务状态：Kmoe 登录与额度、下载队列、下次检查时间。',
    input: z.object({}),
    run: (_, call) => call('GET /api/status'),
  },
  set_queue: {
    description: '暂停或继续下载队列。',
    input: z.object({ paused: z.boolean() }),
    run: (args, call) => call(args.paused ? 'POST /api/queue/pause' : 'POST /api/queue/resume'),
  },
  get_diagnostics: {
    description: '排查问题用的概况（只读）：服务状态（Kmoe 登录、额度、限流、下载队列）、最近动态、失败的下载、书库各状态数量与出错的文件夹、网络代理和 AI 设置（不含密钥）。',
    input: z.object({}),
    run: async (_, call, app) => {
      const [status, activity, failed, library] = await Promise.all([
        call('GET /api/status'), call('GET /api/activity', { query: { limit: 20 } }), call('GET /api/tasks', { query: { status: 'failed', limit: 10 } }), call('GET /api/library'),
      ]);
      const settings = app.settings.get(), ai = app.ai.settings();
      return {
        now: new Date().toISOString(), status,
        recentActivity: activity.map(entry => ({ at: entry.createdAt, level: entry.level, title: entry.title, detail: entry.detail })),
        failedDownloads: failed.tasks.map(task => ({ comic: task.comicTitle, item: task.itemName, error: task.error, at: task.finishedAt })),
        library: {
          counts: library.counts, job: library.job,
          errors: library.folders.filter(f => f.kmoe.error || f.metadata.komga.error).slice(0, 10).map(f => ({ path: f.path, kmoe: f.kmoe.error, komga: f.metadata.komga.error })),
        },
        network: { proxy: settings.proxy || '直连', kmoeViaProxy: settings.proxyKmoe },
        ai: { model: ai.model, usage: ai.usage, monthlyTokens: ai.monthlyTokens },
      };
    },
  },
};

/** Calls admin endpoints in-process, with the same validation as over HTTP (tools run as the API token or the signed-in admin). */
export function toolCaller(handlers: Handlers, via: 'session' | 'token'): Call {
  return async (key, input = {}) => {
    const url = new URL('http://tools.local/');
    for (const [name, value] of Object.entries(input.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value));
    const params = Object.fromEntries(Object.entries(input.params ?? {}).map(([name, value]) => [name, String(value)]));
    return invoke(key, handlers, { req: new Request(url), params, ip: via === 'token' ? 'mcp' : 'assistant', session: null, headers: new Headers(), via, rawBody: input.body ?? {} });
  };
}

const rpc = (id: unknown, result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string, status = 200) => Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });

export function mcpHandler(app: App, handlers: Handlers) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    // DNS-rebinding guard: browsers always send Origin; only same-host pages may call.
    const origin = req.headers.get('origin');
    if (origin && new URL(origin).host !== new URL(req.url).host) return rpcError(null, -32600, 'Origin not allowed', 403);
    if (!app.tokenValid(req)) return new Response(JSON.stringify({ error: { code: 'invalid_token', message: 'API Token 无效' } }), { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' } });
    let message: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try { message = await req.json(); } catch { return rpcError(null, -32700, 'Parse error', 400); }
    if (Array.isArray(message) || message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id, -32600, 'Invalid request', 400);
    if (message.id === undefined) return new Response(null, { status: 202 });

    const call = toolCaller(handlers, 'token');

    switch (message.method) {
      case 'initialize': {
        const requested = String(message.params?.protocolVersion ?? '');
        return rpc(message.id, {
          protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'kmoesync', title: 'Kmoe Sync', version: VERSION },
          instructions: '管理 NAS 上的 Kmoe 漫画书库：搜索漫画、订阅追更、下载指定卷话、查看队列与书库。漫画用 key（或 Kmoe 链接）指代。',
        });
      }
      case 'ping': return rpc(message.id, {});
      case 'tools/list':
        return rpc(message.id, { tools: Object.entries(TOOLS).map(([name, tool]) => ({ name, description: tool.description, inputSchema: z.toJSONSchema(tool.input) })) });
      case 'tools/call': {
        const name = String(message.params?.name ?? '');
        const tool = TOOLS[name];
        if (!tool) return rpcError(message.id, -32602, `Unknown tool: ${name}`);
        const parsed = tool.input.safeParse(message.params?.arguments ?? {});
        if (!parsed.success) return rpc(message.id, { content: [{ type: 'text', text: `参数无效：${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}` }], isError: true });
        try {
          const result = await tool.run(parsed.data, call, app);
          return rpc(message.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? result : { result } });
        } catch (error) {
          const text = error instanceof AppError ? error.message : await errorResponse(error).json().then((body: { error?: { message?: string } }) => body.error?.message ?? errorMessage(error)).catch(() => errorMessage(error));
          return rpc(message.id, { content: [{ type: 'text', text }], isError: true });
        }
      }
      default: return rpcError(message.id, -32601, `Method not found: ${message.method}`);
    }
  };
}
