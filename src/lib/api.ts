// Typed client for the admin API contract in shared/api.ts. Every call goes through request('METHOD /path', …).
import type { BodyOf, EndpointKey, ParamsOf, QueryOf, ResponseOf } from '@shared/api';
import type { ServerEvent } from '@shared/model';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

let csrf: string | null = null;
export const setCsrf = (token: string | null) => { csrf = token; };

/** Swappable transport: the real fetch, or the in-browser mock (?mock) used for demos and UI development. */
type Transport = (input: string, init: RequestInit) => Promise<Response>;
let transport: Transport = (input, init) => fetch(input, init);
export const setTransport = (next: Transport) => { transport = next; };

export type RequestOptions<K extends EndpointKey> = {
  params?: ParamsOf<K>;
  query?: QueryOf<K>;
  body?: BodyOf<K>;
  signal?: AbortSignal;
};

export function endpointUrl(key: EndpointKey, params?: Record<string, string | number>, query?: Record<string, unknown>): string {
  const template = key.slice(key.indexOf(' ') + 1);
  const path = template.replace(/:(\w+)/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`Missing path parameter ${name} for ${key}`);
    return encodeURIComponent(String(value));
  });
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null && value !== '') search.set(name, String(value));
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export async function request<K extends EndpointKey>(key: K, options: RequestOptions<K> = {}): Promise<ResponseOf<K>> {
  const method = key.slice(0, key.indexOf(' '));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  let response: Response;
  try {
    response = await transport(endpointUrl(key, options.params as Record<string, string | number> | undefined, options.query as Record<string, unknown> | undefined), {
      method, headers, credentials: 'same-origin', signal: options.signal,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('无法连接 Kmoe Sync 服务，请检查网络或服务是否在运行', 0, 'offline');
  }
  if (!response.ok) throw await failure(response);
  return await response.json() as ResponseOf<K>;
}

async function failure(response: Response): Promise<ApiError> {
  let code = `http_${response.status}`, message = `请求失败（HTTP ${response.status}）`;
  try {
    const payload = await response.json() as { error?: { code?: string; message?: string } };
    if (payload.error?.message) message = payload.error.message;
    if (payload.error?.code) code = payload.error.code;
  } catch { /* non-JSON error page from a proxy */ }
  return new ApiError(message, response.status, code);
}

/** POST to a streaming endpoint (the assistant): the raw response, through the same transport and CSRF token. */
export async function postStream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' };
  if (csrf) headers['X-CSRF-Token'] = csrf;
  let response: Response;
  try {
    response = await transport(path, { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body), signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('无法连接 Kmoe Sync 服务，请检查网络或服务是否在运行', 0, 'offline');
  }
  if (!response.ok) throw await failure(response);
  return response;
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';

/** Server-sent events with automatic reconnect. Returns an unsubscribe function. */
type EventSourceFactory = (url: string) => { onmessage: ((event: MessageEvent) => void) | null; onerror: ((event: Event) => void) | null; onopen: ((event: Event) => void) | null; close(): void };
let createEventSource: EventSourceFactory = url => new EventSource(url, { withCredentials: true });
export const setEventSourceFactory = (factory: EventSourceFactory) => { createEventSource = factory; };

export function subscribeEvents(onEvent: (event: ServerEvent) => void, onConnection?: (connected: boolean) => void): () => void {
  let source: ReturnType<EventSourceFactory> | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false, delay = 1000;
  const open = () => {
    source = createEventSource('/api/events');
    source.onopen = () => { delay = 1000; onConnection?.(true); };
    source.onmessage = message => { try { onEvent(JSON.parse(message.data as string) as ServerEvent); } catch { /* ignore malformed frames */ } };
    source.onerror = () => {
      onConnection?.(false);
      source?.close();
      if (!closed) { retry = setTimeout(open, delay); delay = Math.min(delay * 2, 15_000); }
    };
  };
  open();
  return () => { closed = true; clearTimeout(retry); source?.close(); };
}
