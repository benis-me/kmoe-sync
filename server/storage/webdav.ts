// WebDAV target, ported from the Kmoe Sync browser extension (lib/webdav.ts, lib/transfer.ts, lib/paths.ts) so that both
// read and write the same libraries the same way. Paths are relative to `basePath` on the server.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { DirEntry } from '@shared/model';
import { joinPath, NamingError, normalizePath } from '@shared/naming';
import { errorMessage, isRetryable, networkError, transientStatus } from '../lib/retry';
import { StorageError, type StorageTarget, type StoredFile } from './types';

export const PROPFIND = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>';
/** Milliseconds. Metadata requests are capped; an upload only fails after silence, never for taking long. Mutable for tests. */
export const timeouts = { request: 30_000, idle: 90_000, finalise: 10 * 60_000 };

// htmlEntities also turns on numeric character references (&#20013;), which fast-xml-parser skips otherwise.
const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false, htmlEntities: true });
const collator = new Intl.Collator('zh');

type Stat = { size: number; directory: boolean };

function checked<T>(fn: () => T): T {
  try { return fn(); } catch (error) { throw error instanceof NamingError ? new StorageError('invalid', error.message) : error; }
}

/** "https://nas/dav": http(s) only, no credentials, query or fragment. A bare host means http. */
function baseUrl(raw: string): string {
  const value = raw.trim();
  try {
    const url = new URL(/^[a-z][\w+.-]*:\/\//i.test(value) ? value : `http://${value}`);
    if (/^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash) {
      normalizePath(decodeURIComponent(url.pathname));
      return url.href.replace(/\/+$/, '');
    }
  } catch { /* reported below */ }
  throw new StorageError('invalid', '服务器地址需为 HTTP(S) 地址；账号密码请单独填写');
}

function httpError(status: number, action: string, path: string): StorageError {
  if (status === 401) return new StorageError('auth', 'WebDAV 验证失败，请检查账号和密码', false, status);
  if (status === 403) return new StorageError('auth', 'WebDAV 验证失败，请检查账号、密码和目录权限', false, status);
  if (status === 404) return new StorageError('not_found', `${action}失败：${path} 不存在`, false, status);
  if (status === 412) return new StorageError('conflict', '目标文件已存在，已保留原文件；请调整保存路径后重试', false, status);
  if (status === 507) return new StorageError('no_space', 'WebDAV 服务器空间不足（HTTP 507）', false, status);
  const retryable = transientStatus(status);
  return new StorageError(retryable ? 'network' : 'io', `${action}失败（HTTP ${status}）`, retryable, status);
}

/** fetch() rejected: redirect (refused on purpose), TLS, or a network failure / timeout (retryable). */
function fetchFailure(error: unknown): StorageError {
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  if (code === 'UnexpectedRedirect') return new StorageError('invalid', 'WebDAV 服务器要求重定向，请检查地址（http/https、端口和路径）');
  if (/CERT|SSL|TLS|SIGNATURE|ISSUER/.test(code)) return new StorageError('network', `无法验证 WebDAV 服务器的 HTTPS 证书（${errorMessage(error)}），请为服务器配置受信任的证书`);
  const mapped = networkError(error, ' WebDAV 服务器');
  const failure = new StorageError('network', errorMessage(mapped), isRetryable(mapped));
  if (mapped instanceof Error && mapped.name === 'TimeoutError') failure.name = 'TimeoutError';
  return failure;
}

/** Every value of `tag` below `node` in document order, like getElementsByTagNameNS('*', tag). */
function all(node: unknown, tag: string, found: unknown[] = []): unknown[] {
  if (Array.isArray(node)) for (const item of node) all(item, tag, found);
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === tag) found.push(...(Array.isArray(value) ? value : [value]));
      all(value, tag, found);
    }
  }
  return found;
}
const first = (node: unknown, tag: string) => all(node, tag)[0];
const text = (node: unknown): string =>
  typeof node === 'string' ? node : node && typeof node === 'object' && '#text' in node ? String(node['#text']) : '';

function responses(body: string): unknown[] {
  const doc = XMLValidator.validate(body) === true ? parser.parse(body) : null;
  if (!all(doc, 'multistatus').length) throw new StorageError('invalid', '服务器未返回 WebDAV 目录，请检查地址是否指向 WebDAV 服务');
  return all(doc, 'response');
}
/** The response's first propstat with status 200. */
const readable = (response: unknown) => all(response, 'propstat').find(propstat => /\s200\b/.test(text(first(propstat, 'status'))));
const props = (propstat: unknown): Stat => ({
  directory: first(propstat, 'collection') !== undefined,
  size: Number(text(first(propstat, 'getcontentlength'))) || 0,
});

function settle(found: Stat | null, source: StoredFile): 'exists' {
  if (found && !found.directory && found.size === source.size) return 'exists';
  throw new StorageError('conflict', '目标位置已有同名文件且大小不同，已保留原文件；请检查后重试');
}

export function createWebdavTarget(options: { url: string; username?: string | null; password?: string | null; basePath?: string }): StorageTarget {
  const base = baseUrl(options.url);
  const { origin, pathname } = new URL(base);
  const basePath = checked(() => normalizePath(options.basePath));
  /** Decoded server path of the target directory, e.g. "/dav/Comics". */
  const root = checked(() => joinPath(decodeURIComponent(pathname), basePath));
  const user = options.username ?? '', password = options.password ?? '';
  const auth: Record<string, string> = user || password ? { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } : {};

  /** Server path below the base URL for a target path. */
  const remote = (path: string) => checked(() => joinPath(basePath, path));
  const href = (path: string, dir = false) => `${base}${path.split('/').map(encodeURIComponent).join('/')}${dir && path !== '/' ? '/' : ''}`;
  /** Target path of a multistatus href; null when it lies outside the target directory or on another origin. */
  function relative(value: string): string | null {
    try {
      const url = new URL(value, `${base}/`);
      if (url.origin !== origin) return null;
      const path = normalizePath(decodeURIComponent(url.pathname));
      if (root === '/') return path;
      if (path === root) return '/';
      return path.startsWith(`${root}/`) ? path.slice(root.length) : null;
    } catch { return null; }
  }

  async function request(method: 'PROPFIND' | 'MKCOL' | 'MOVE', path: string, options: { dir?: boolean; depth?: '0' | '1'; signal?: AbortSignal; headers?: Record<string, string> }) {
    const { dir, depth, signal } = options;
    const timeout = AbortSignal.timeout(timeouts.request);
    try {
      const response = await fetch(href(path, dir), {
        method, credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: depth ? { ...auth, Depth: depth, 'Content-Type': 'application/xml' } : { ...auth, ...options.headers },
        body: depth ? PROPFIND : undefined,
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      if (signal?.aborted) throw error;
      throw fetchFailure(error);
    }
  }

  function parseDirectory(body: string, current: string, strict: boolean): DirEntry[] {
    const prefix = current === '/' ? '/' : `${current}/`;
    const entries: DirEntry[] = [];
    let complete = false;
    for (const response of responses(body)) {
      const href = text(first(response, 'href'));
      const path = href ? relative(href) : null;
      if (path === null || (path !== current && (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')))) continue;
      const propstat = readable(response);
      if (!propstat || (strict && first(propstat, 'resourcetype') === undefined)) {
        if (strict) throw new StorageError('io', '目录中有无法读取的条目，未完成书库检查');
        continue;
      }
      complete = true;
      if (path !== current) entries.push({ name: text(first(propstat, 'displayname')) || path.split('/').pop() || '/', path, ...props(propstat) });
    }
    if (strict && !complete) throw new StorageError('io', '服务器返回了不完整的目录，未完成书库检查');
    return entries.sort((a, b) => Number(b.directory) - Number(a.directory) || collator.compare(a.name, b.name));
  }

  async function list(path: string, options: { signal?: AbortSignal; strict?: boolean } = {}): Promise<DirEntry[]> {
    const current = checked(() => normalizePath(path));
    const { status, body } = await request('PROPFIND', remote(current), { dir: true, depth: '1', signal: options.signal });
    if (status !== 207) throw httpError(status, '读取目录', current);
    return parseDirectory(body, current, options.strict ?? false);
  }

  async function stat(path: string, signal?: AbortSignal): Promise<Stat | null> {
    const current = checked(() => normalizePath(path));
    const { status, body } = await request('PROPFIND', remote(current), { dir: current === '/', depth: '0', signal });
    if (status === 404) return null;
    if (status !== 207) throw httpError(status, '读取', current);
    const propstat = responses(body).map(readable).find(Boolean);
    return propstat ? props(propstat) : null;
  }

  /** Probe + MKCOL per segment, from the base URL down (the base path may not exist yet either). */
  async function ensureDir(path: string, signal?: AbortSignal): Promise<void> {
    let current = '';
    for (const part of remote(path).split('/').filter(Boolean)) {
      current += `/${part}`;
      const probe = await request('PROPFIND', current, { dir: true, depth: '0', signal });
      if (probe.status === 404) {
        const made = await request('MKCOL', current, { dir: true, signal });
        if ((made.status < 200 || made.status >= 300) && made.status !== 405) throw httpError(made.status, '创建目录', current);
      } else if (probe.status !== 207) throw httpError(probe.status, '读取目录', current);
    }
  }

  /** Streams the file; only silence fails it: 90 s while sending, 10 min for the server to finalise afterwards. */
  async function upload(path: string, source: StoredFile, signal: AbortSignal, onProgress?: (sent: number, total: number) => void): Promise<number> {
    signal.throwIfAborted();
    const stall = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, settled = false;
    const idle = (ms = timeouts.idle) => { clearTimeout(timer); if (!settled) timer = setTimeout(() => stall.abort(), ms); };
    let sent = 0;
    const body = Bun.file(source.path).stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { sent += chunk.byteLength; idle(); onProgress?.(sent, source.size); controller.enqueue(chunk); },
      flush() { idle(timeouts.finalise); },
    }));
    idle();
    try {
      // Connection: close. A server may answer (412, 507…) before reading the body; Bun's fetch then pools the socket with the
      // body unsent, and the server takes the next request on it for this body (connection closed, or a hang on big files).
      const response = await fetch(href(path), {
        method: 'PUT', body, credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, stall.signal]),
        headers: { ...auth, 'Content-Type': 'application/octet-stream', 'Content-Length': String(source.size), 'If-None-Match': '*', Connection: 'close' },
      });
      await response.arrayBuffer().catch(() => undefined);
      return response.status;
    } catch (error) {
      if (signal.aborted) throw error;
      if (stall.signal.aborted) throw new StorageError('network', '传输长时间无响应，请检查网络后重试', true);
      throw fetchFailure(error);
    } finally { settled = true; clearTimeout(timer); }
  }

  async function put(path: string, source: StoredFile, options: { signal: AbortSignal; onProgress?: (sent: number, total: number) => void }): Promise<'stored' | 'exists'> {
    const current = checked(() => normalizePath(path));
    if (current === '/') throw new StorageError('invalid', '文件路径无效');
    // Checked up front too: a server that ignores If-None-Match would otherwise overwrite.
    const existing = await stat(current, options.signal);
    if (existing) return settle(existing, source);
    await ensureDir(current.slice(0, current.lastIndexOf('/')) || '/', options.signal);
    const status = await upload(remote(current), source, options.signal, options.onProgress);
    if (status === 412) return settle(await stat(current, options.signal), source);
    if (status < 200 || status >= 300) throw httpError(status, '上传', current);
    const stored = await stat(current, options.signal);
    if (!stored || stored.directory || stored.size !== source.size) throw new StorageError('io', '上传后文件大小核验失败，请检查远程文件后重试');
    return 'stored';
  }

  async function move(from: string, to: string, signal?: AbortSignal): Promise<void> {
    const source = checked(() => normalizePath(from)), dest = checked(() => normalizePath(to));
    if (source === '/' || dest === '/') throw new StorageError('invalid', '文件路径无效');
    const taken = (status?: number) => new StorageError('conflict', `已有同名文件：${dest}`, false, status);
    // Checked up front too: a server that ignores Overwrite: F would replace the file.
    if (await stat(dest, signal)) throw taken();
    const { status } = await request('MOVE', remote(source), { signal, headers: { Destination: href(remote(dest)), Overwrite: 'F' } });
    if (status === 412) throw taken(status);
    if (status < 200 || status >= 300) throw httpError(status, '改名', source);
  }

  const label = `${origin}${root === '/' ? '' : root}`;
  async function test(signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
    try {
      const { status, body } = await request('PROPFIND', basePath, { dir: true, depth: '0', signal });
      if (status === 404) {
        // The server answers and credentials work: the directory is simply created by the first download.
        const root = basePath === '/' ? null : await request('PROPFIND', '/', { dir: true, depth: '0', signal });
        if (root?.status === 207) return { ok: true, message: `连接成功；目录 ${basePath} 还不存在，会在第一次下载时自动创建` };
        return { ok: false, message: `WebDAV 目录不存在：${basePath}，请检查地址和目录` };
      }
      if (status === 405 || status === 501) return { ok: false, message: `该地址不支持 WebDAV（HTTP ${status}），请检查地址是否指向 WebDAV 服务` };
      if (status !== 207) throw httpError(status, '连接 WebDAV 服务器', basePath);
      const propstat = responses(body).map(readable).find(Boolean);
      if (propstat && !props(propstat).directory) return { ok: false, message: `${basePath} 不是目录，请检查目录` };
      return { ok: true, message: `连接成功：${label}` };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ok: false, message: errorMessage(error) };
    }
  }

  return { kind: 'webdav', label, list, stat, ensureDir, put, move, test };
}
