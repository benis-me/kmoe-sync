// The newest Bangumi Archive dump on GitHub (aux/latest.json) and its download: resumable with HTTP Range, verified
// against the published sha256, written next to the archive as <name>.part until complete.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { VERSION } from '../config';
import { AppError } from '../http/errors';
import { transient } from '../lib/retry';
import { connectionProblem, sleep } from './bangumi';

export const LATEST_URL = 'https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json';
export interface Dump { name: string; url: string; size: number; sha256: string; createdAt: string | null }

const HEADERS = { 'User-Agent': `kmoesync/${VERSION} (self-hosted; https://github.com/)` };
/** stallMs: a transfer without bytes for this long is dropped and resumed; retryDelays: pauses between attempts (tests shorten both). */
export const downloadTiming = { stallMs: 60_000, retryDelays: [5_000, 15_000, 30_000, 60_000, 120_000] };

const unreachable = (error: unknown) =>
  transient(new AppError(502, 'archive_unreachable', `无法访问 GitHub（${connectionProblem(error)}）：离线数据从 GitHub 下载，请检查网络或在设置中填写代理`));

export async function latestDump(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Dump> {
  const timeout = AbortSignal.timeout(30_000);
  let response: Response;
  try { response = await fetchImpl(LATEST_URL, { headers: HEADERS, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); } catch (error) {
    if (signal?.aborted) throw error;
    throw unreachable(error);
  }
  if (!response.ok) throw transient(new AppError(502, 'archive_failed', `GitHub 返回 HTTP ${response.status}（latest.json）`), response.status >= 500);
  const body = await response.json() as { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown; created_at?: unknown };
  const name = String(body.name ?? ''), url = String(body.browser_download_url ?? ''), sha256 = /^sha256:([\da-f]{64})$/i.exec(String(body.digest ?? ''))?.[1];
  let host = '';
  try { host = new URL(url).hostname; } catch { /* checked below */ }
  if (!/^dump-[\w.-]+\.zip$/.test(name) || !url.startsWith('https://') || host !== 'github.com' || !Number.isSafeInteger(body.size) || !sha256) {
    throw new AppError(502, 'archive_failed', 'latest.json 的格式无法识别（Bangumi Archive 可能改了发布方式）');
  }
  return { name, url, size: body.size as number, sha256: sha256.toLowerCase(), createdAt: typeof body.created_at === 'string' ? body.created_at : null };
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

/** Appends to `part` from `offset`; returns the new length. Restarts from 0 when the server ignores the Range. */
async function transfer(dump: Dump, part: string, offset: number, fetchImpl: typeof fetch, progress: (done: number) => void, signal?: AbortSignal): Promise<number> {
  const stall = new AbortController();
  let timer = setTimeout(() => stall.abort(new DOMException('stalled', 'TimeoutError')), downloadTiming.stallMs);
  try {
    const response = await fetchImpl(dump.url, {
      headers: offset ? { ...HEADERS, Range: `bytes=${offset}-` } : HEADERS, signal: signal ? AbortSignal.any([signal, stall.signal]) : stall.signal,
    });
    if (response.status === 416) { rmSync(part, { force: true }); return 0; }
    if (!response.ok || !response.body) throw transient(new AppError(502, 'archive_failed', `GitHub 返回 HTTP ${response.status}（离线数据下载）`), response.status >= 500 || response.status === 429);
    const start = response.status === 206 ? Number(/bytes\s+(\d+)-/.exec(response.headers.get('content-range') ?? '')?.[1] ?? -1) : 0;
    if (start !== 0 && start !== offset) throw transient(new AppError(502, 'archive_failed', 'GitHub 返回了错误的续传位置'));
    const file = await open(part, start === 0 ? 'w' : 'a');
    let length = start;
    try {
      for await (const chunk of response.body) {
        clearTimeout(timer);
        timer = setTimeout(() => stall.abort(new DOMException('stalled', 'TimeoutError')), downloadTiming.stallMs);
        await file.write(chunk);
        length += chunk.byteLength;
        progress(length);
      }
    } finally {
      await file.close();
    }
    return length;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads `dump` into `dir` (resuming a `.part` left by an earlier attempt or restart) and verifies its sha256.
 * Other dumps' files in `dir` are removed. Returns the path of the complete zip.
 */
export async function downloadDump(dump: Dump, dir: string, fetchImpl: typeof fetch, progress: (done: number, total: number) => void, signal?: AbortSignal): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, dump.name), part = `${file}.part`;
  for (const entry of readdirSync(dir)) {
    if (/^dump-.*\.zip(\.part)?$/.test(entry) && entry !== dump.name && entry !== `${dump.name}.part`) rmSync(join(dir, entry), { force: true });
  }
  if (existsSync(file)) {
    if (await sha256(file) === dump.sha256) return file;
    rmSync(file, { force: true });
  }
  let offset = existsSync(part) ? statSync(part).size : 0;
  if (offset > dump.size) { rmSync(part, { force: true }); offset = 0; }
  progress(offset, dump.size);
  let failures = 0;
  while (offset < dump.size) {
    const before = offset;
    try {
      offset = await transfer(dump, part, offset, fetchImpl, done => { offset = done; progress(done, dump.size); }, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (existsSync(part)) offset = statSync(part).size;
      failures = offset > before ? 1 : failures + 1;
      if (failures > downloadTiming.retryDelays.length) throw error instanceof AppError ? error : unreachable(error);
      await sleep(downloadTiming.retryDelays[failures - 1]!, signal);
      continue;
    }
    if (offset < dump.size && offset === before) throw transient(new AppError(502, 'archive_failed', 'GitHub 提前结束了下载，请稍后重试'));
  }
  if (await sha256(part) !== dump.sha256) {
    rmSync(part, { force: true });
    throw transient(new AppError(502, 'archive_corrupt', '离线数据校验失败（sha256 不一致），已删除，请重新下载'));
  }
  renameSync(part, file);
  return file;
}
