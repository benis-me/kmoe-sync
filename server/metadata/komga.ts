// Komga REST client (API key or HTTP Basic on every request, no cookie sessions) and the path helpers that map a
// library folder ("/GRAND BLUE 碧藍之海") to the Komga series of the same directory ("/data/GRAND BLUE 碧藍之海").
import type { KomgaLibrary } from '@shared/model';
import { VERSION } from '../config';
import { AppError } from '../http/errors';
import { errorMessage } from '../lib/retry';

export interface KomgaConfig { url: string; auth: 'apiKey' | 'basic'; username: string; secret: string }
export interface KomgaLink { label: string; url: string }
export interface KomgaSeries { id: string; libraryId: string; name: string; url: string; metadata: Record<string, unknown> & { links?: KomgaLink[] } }
export interface KomgaBook { id: string; seriesId: string; name: string; url: string; metadata: Record<string, unknown> }
export interface KomgaThumbnail { id: string; type: string; selected: boolean }
export interface Image { bytes: Blob; name: string }

/** Settings value → "http://host:port[/prefix]" without trailing slash; '' = not configured. */
export function komgaUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) throw new AppError(400, 'invalid_settings', 'Komga 地址需为 http:// 或 https:// 地址');
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`); } catch { throw new AppError(400, 'invalid_settings', 'Komga 地址无效'); }
  if (url.username || url.password) throw new AppError(400, 'invalid_settings', 'Komga 地址不能包含账号密码，请在下方单独填写');
  if (url.search || url.hash) throw new AppError(400, 'invalid_settings', 'Komga 地址不能包含查询参数');
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** A Komga path as a plain absolute path: "file:" prefix and percent-encoding removed, NFC, no trailing slash. */
export function plainPath(raw: string): string {
  let path = raw.trim();
  if (/^file:/i.test(path)) {
    path = path.replace(/^file:(?:\/\/[^/]*)?/i, '');
    try { path = decodeURIComponent(path); } catch { /* keep as is */ }
  }
  path = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').normalize('NFC');
  if (!path.startsWith('/')) path = `/${path}`;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** `path` relative to `root` ("/GRAND BLUE 碧藍之海"), or null when it lies outside. */
export function below(root: string, path: string): string | null {
  const base = plainPath(root), full = plainPath(path);
  if (base === '/') return full;
  if (full === base) return '/';
  return full.startsWith(`${base}/`) ? full.slice(base.length) : null;
}

const notDeleted = { deleted: { operator: 'isFalse' } };
interface CallInit { json?: unknown; form?: FormData; signal?: AbortSignal; timeout?: number }

export class KomgaClient {
  constructor(readonly config: KomgaConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call(method: string, path: string, init: CallInit = {}): Promise<Response> {
    const headers = new Headers({ Accept: 'application/json', 'User-Agent': `kmoesync/${VERSION}` });
    if (this.config.auth === 'apiKey') headers.set('X-API-Key', this.config.secret);
    else headers.set('Authorization', `Basic ${Buffer.from(`${this.config.username}:${this.config.secret}`).toString('base64')}`);
    let body: BodyInit | undefined;
    if (init.json !== undefined) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(init.json); }
    else if (init.form) body = init.form;
    const timeout = AbortSignal.timeout(init.timeout ?? 30_000);
    let response: Response;
    try {
      // Redirects are not followed: the credentials must only ever go to the configured address.
      response = await this.fetchImpl(`${this.config.url}${path}`, { method, headers, body, redirect: 'manual', signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      if (error instanceof DOMException && error.name === 'TimeoutError') throw new AppError(504, 'komga_timeout', `连接 Komga 超时（${this.config.url}），请检查地址和网络`);
      throw new AppError(502, 'komga_unreachable', `无法连接 Komga（${this.config.url}）：${errorMessage(error)}`);
    }
    if (response.ok) return response;
    const text = await response.text().catch(() => '');
    if (response.status === 401) throw new AppError(502, 'komga_auth', 'Komga 拒绝了登录凭据（HTTP 401），请检查 API Key 或用户名和密码');
    if (response.status === 403) throw new AppError(502, 'komga_forbidden', 'Komga 拒绝访问（HTTP 403）：写入元数据需要管理员（ADMIN）权限');
    if (response.status === 413) throw new AppError(502, 'komga_too_large', 'Komga 拒绝了过大的文件（HTTP 413）');
    if (response.status >= 300 && response.status < 400) throw new AppError(502, 'komga_redirect', `Komga 地址发生了跳转（HTTP ${response.status}），请填写 Komga 的实际访问地址`);
    let detail = '';
    try {
      const parsed = JSON.parse(text) as { message?: string; violations?: { fieldName?: string; message?: string }[] };
      detail = parsed.violations?.map(item => `${item.fieldName ?? ''} ${item.message ?? ''}`.trim()).join('；') || parsed.message || '';
    } catch { /* not JSON */ }
    throw new AppError(502, 'komga_failed', `Komga 返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
  }

  private async json<T>(method: string, path: string, init?: CallInit): Promise<T> {
    return await (await this.call(method, path, init)).json() as T;
  }

  async libraries(signal?: AbortSignal): Promise<KomgaLibrary[]> {
    const rows = await this.json<{ id: string; name: string; root: string }[]>('GET', '/api/v1/libraries', { signal });
    return rows.map(row => ({ id: row.id, name: row.name, root: row.root }));
  }
  /** One library's settings; hashFiles: Komga hashes book files, so a renamed or moved file keeps its read progress. */
  library(id: string, signal?: AbortSignal): Promise<{ id: string; name: string; hashFiles?: boolean }> {
    return this.json('GET', `/api/v1/libraries/${encodeURIComponent(id)}`, { signal });
  }
  /** Server version from /actuator/info (admin only). */
  async version(signal?: AbortSignal): Promise<string | null> {
    return (await this.json<{ build?: { version?: string } }>('GET', '/actuator/info', { signal })).build?.version ?? null;
  }
  async roles(signal?: AbortSignal): Promise<string[]> {
    return (await this.json<{ roles?: string[] }>('GET', '/api/v2/users/me', { signal })).roles ?? [];
  }
  async seriesIn(libraryId: string, signal?: AbortSignal): Promise<KomgaSeries[]> {
    const body = { condition: { allOf: [{ libraryId: { operator: 'is', value: libraryId } }, notDeleted] } };
    return (await this.json<{ content?: KomgaSeries[] }>('POST', '/api/v1/series/list?unpaged=true', { json: body, signal, timeout: 120_000 })).content ?? [];
  }
  series(id: string, signal?: AbortSignal): Promise<KomgaSeries> {
    return this.json('GET', `/api/v1/series/${encodeURIComponent(id)}`, { signal });
  }
  async books(seriesId: string, signal?: AbortSignal): Promise<KomgaBook[]> {
    const body = { condition: { allOf: [{ seriesId: { operator: 'is', value: seriesId } }, notDeleted] } };
    return (await this.json<{ content?: KomgaBook[] }>('POST', '/api/v1/books/list?unpaged=true', { json: body, signal, timeout: 60_000 })).content ?? [];
  }
  async patch(kind: 'series' | 'books', id: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    await this.call('PATCH', `/api/v1/${kind}/${encodeURIComponent(id)}/metadata`, { json: body, signal });
  }
  thumbnails(kind: 'series' | 'books', id: string, signal?: AbortSignal): Promise<KomgaThumbnail[]> {
    return this.json('GET', `/api/v1/${kind}/${encodeURIComponent(id)}/thumbnails`, { signal });
  }
  async upload(kind: 'series' | 'books', id: string, image: Image, signal?: AbortSignal): Promise<void> {
    const form = new FormData();
    form.append('file', image.bytes, image.name);
    await this.call('POST', `/api/v1/${kind}/${encodeURIComponent(id)}/thumbnails?selected=true`, { form, signal, timeout: 60_000 });
  }
  async scan(libraryId: string, signal?: AbortSignal): Promise<void> {
    await this.call('POST', `/api/v1/libraries/${encodeURIComponent(libraryId)}/scan`, { signal });
  }
}
