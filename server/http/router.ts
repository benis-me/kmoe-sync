// Turns the typed endpoint registry (shared/api.ts) into Bun routes: validation, authentication, CSRF and JSON errors.
import type { Server } from 'bun';
import type { z } from 'zod';
import { endpoints, type EndpointKey, type ResponseOf } from '@shared/api';
import type { AdminAuth, Session } from './auth';
import { AppError, errorResponse } from './errors';

type Field<K extends EndpointKey, F extends string> = (typeof endpoints)[K] extends Record<F, infer S extends z.ZodType> ? z.output<S> : undefined;

export interface Context<K extends EndpointKey> {
  req: Request;
  params: Record<string, string>;
  query: Field<K, 'query'>;
  body: Field<K, 'body'>;
  ip: string;
  session: Session | null;
  /** Extra response headers (Set-Cookie on login/logout). */
  headers: Headers;
  via: 'session' | 'token';
}
export type Handlers = { [K in EndpointKey]: (ctx: Context<K>) => Promise<ResponseOf<K>> | ResponseOf<K> };
type BunHandler = (req: Request & { params: Record<string, string> }, server: Server<unknown>) => Promise<Response>;
export type Routes = Record<string, Partial<Record<string, BunHandler>>>;

const PUBLIC = new Set<EndpointKey>(['GET /api/auth/state', 'POST /api/auth/setup', 'POST /api/auth/login']);

/** Endpoints reachable with the API token under /api/v1 (and by MCP tools). Admin-only actions stay session-only. */
export const TOKEN_ENDPOINTS = new Set<EndpointKey>([
  'GET /api/status', 'GET /api/search', 'POST /api/resolve', 'GET /api/comics/:key', 'POST /api/comics/:key/refresh',
  'POST /api/comics/:key/library-check', 'PUT /api/comics/:key/subscription', 'POST /api/comics/:key/subscription/preview',
  'DELETE /api/comics/:key/subscription', 'POST /api/comics/:key/check', 'GET /api/shelf', 'POST /api/checks/run',
  'GET /api/tasks', 'POST /api/tasks', 'POST /api/tasks/:id/cancel', 'POST /api/tasks/:id/retry', 'POST /api/tasks/retry-failed', 'POST /api/tasks/cancel-queued',
  'POST /api/queue/pause', 'POST /api/queue/resume', 'GET /api/targets', 'GET /api/activity', 'GET /api/sources', 'GET /api/sources/:id/items',
  'GET /api/library', 'POST /api/library/scan', 'POST /api/library/match-kmoe', 'POST /api/library/match-bangumi', 'POST /api/library/sync-komga',
  'POST /api/library/folders/:id/sync', 'GET /api/bangumi/search',
]);

export function clientIp(req: Request, server: Server<unknown>) { return server.requestIP(req)?.address ?? 'unknown'; }

/** Validates input and calls the handler; `authorize` decides who may call. */
export async function invoke<K extends EndpointKey>(key: K, handlers: Handlers, ctx: Omit<Context<K>, 'query' | 'body'> & { rawBody?: unknown }): Promise<ResponseOf<K>> {
  const spec = endpoints[key] as { query?: z.ZodType; body?: z.ZodType };
  const url = new URL(ctx.req.url);
  const query = spec.query ? spec.query.parse(Object.fromEntries(url.searchParams)) : undefined;
  let body: unknown;
  if (spec.body) {
    let raw = ctx.rawBody;
    if (raw === undefined) {
      const text = await ctx.req.text();
      raw = text ? JSON.parse(text) : {};
    }
    body = spec.body.parse(raw);
  }
  const handler = handlers[key] as (context: Context<K>) => Promise<ResponseOf<K>> | ResponseOf<K>;
  return handler({ ...ctx, query: query as Field<K, 'query'>, body: body as Field<K, 'body'> });
}

export function buildRoutes(handlers: Handlers, auth: AdminAuth, tokenValid: (req: Request) => boolean): Routes {
  const routes: Routes = {};
  const add = (path: string, method: string, handler: BunHandler) => { (routes[path] ??= {})[method] = handler; };

  for (const key of Object.keys(endpoints) as EndpointKey[]) {
    const [method, path] = key.split(' ') as [string, string];
    add(path, method, async (req, server) => {
      try {
        // Another web page can post text/plain, form or multipart bodies here without asking first, but not JSON: setup
        // and login have no CSRF token to check, so this keeps them from being called across sites.
        const body = Number(req.headers.get('content-length') ?? 0) > 0 || req.headers.has('transfer-encoding');
        if (method !== 'GET' && body && !/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) {
          throw new AppError(415, 'unsupported_media_type', '请求内容必须是 JSON');
        }
        const session = auth.session(req);
        if (!PUBLIC.has(key)) {
          if (!session) throw new AppError(401, 'unauthenticated', '请先登录');
          if (method !== 'GET') auth.checkCsrf(req, session);
        }
        const headers = new Headers({ 'Cache-Control': 'no-store' });
        const result = await invoke(key, handlers, { req, params: req.params, ip: clientIp(req, server), session, headers, via: 'session' });
        return Response.json(result, { headers });
      } catch (error) { return errorResponse(error); }
    });
    if (TOKEN_ENDPOINTS.has(key)) {
      add(path.replace(/^\/api\//, '/api/v1/'), method, async (req, server) => {
        try {
          if (!tokenValid(req)) throw new AppError(401, 'invalid_token', 'API Token 无效，请在设置中生成');
          const headers = new Headers({ 'Cache-Control': 'no-store' });
          return Response.json(await invoke(key, handlers, { req, params: req.params, ip: clientIp(req, server), session: null, headers, via: 'token' }), { headers });
        } catch (error) { return errorResponse(error); }
      });
    }
  }
  return routes;
}
