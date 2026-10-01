// Local target: a directory under the mounted library root. Symlinks may not lead outside the root, and writes never
// replace an existing file (a hard link, or an exclusive copy across filesystems).
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { DirEntry } from '@shared/model';
import { joinPath, NamingError, normalizePath } from '@shared/naming';
import { errorMessage, isRetryable } from '../lib/retry';
import { StorageError, type StorageTarget, type StoredFile } from './types';

/** Prefix of our own entries (scratch downloads, write probes): never listed. */
const OWN = '.kmoesync';
/** NAS housekeeping folders (Synology thumbnails / recycle bin / snapshots, QNAP thumbnails / recycle bin). */
const NAS_SYSTEM_DIRS = new Set(['@eaDir', '#recycle', '#snapshot', '.@__thumb', '@Recycle']);
/** link() refusals that mean "copy instead": another device, or a filesystem without hard links (SMB, exFAT, some FUSE). */
const NO_LINK = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS']);
const MISSING = new Set(['ENOENT', 'ENOTDIR']);
const collator = new Intl.Collator('zh');
const code = (error: unknown) => String((error as { code?: unknown } | null)?.code ?? '');

function checked<T>(fn: () => T): T {
  try { return fn(); } catch (error) { throw error instanceof NamingError ? new StorageError('invalid', error.message) : error; }
}

function failure(error: unknown, path: string): StorageError {
  switch (code(error)) {
    case 'ENOENT': case 'ENOTDIR': return new StorageError('not_found', `不存在：${path}`);
    case 'EACCES': case 'EPERM': return new StorageError('auth', `没有权限访问 ${path}，请检查 NAS 目录权限`);
    case 'ENOSPC': case 'EDQUOT': return new StorageError('no_space', `书库磁盘空间不足：${path}`);
    case 'EROFS': return new StorageError('io', `书库目录是只读的：${path}`);
    case 'EEXIST': return new StorageError('conflict', `已有同名文件：${path}`);
  }
  return new StorageError('io', `读写书库失败（${errorMessage(error)}）：${path}`, isRetryable(error));
}

export function createLocalTarget(options: { libraryRoot: string; path: string }): StorageTarget {
  const libraryRoot = resolve(options.libraryRoot);
  const dir = resolve(libraryRoot, `.${checked(() => normalizePath(options.path))}`);

  /** Real location of a target path (which need not exist yet); refuses anything a symlink leads outside the library root. */
  async function locate(path: string): Promise<{ path: string; real: string }> {
    const relative = checked(() => normalizePath(path));
    const root = await fs.realpath(libraryRoot).catch(error => { throw failure(error, libraryRoot); });
    let real = resolve(dir, `.${relative}`);
    const missing: string[] = [];
    for (;;) {
      try { real = join(await fs.realpath(real), ...missing); break; } catch (error) {
        if (!MISSING.has(code(error)) || dirname(real) === real) throw failure(error, real);
        missing.unshift(basename(real));
        real = dirname(real);
      }
    }
    if (real !== root && !real.startsWith(root.endsWith(sep) ? root : root + sep)) throw new StorageError('invalid', `路径经符号链接指向了书库之外，已拒绝：${relative}`);
    return { path: relative, real };
  }

  async function list(path: string, options: { signal?: AbortSignal; strict?: boolean } = {}): Promise<DirEntry[]> {
    options.signal?.throwIfAborted();
    const { path: current, real } = await locate(path);
    const children = await fs.readdir(real, { withFileTypes: true }).catch(error => { throw failure(error, real); });
    const entries = await Promise.all(children.filter(child => !child.name.startsWith(OWN) && !(child.isDirectory() && NAS_SYSTEM_DIRS.has(child.name))).map(async (child): Promise<DirEntry | null> => {
      const { name } = child;
      let path: string;
      try { path = joinPath(current, name); } catch { return null; }
      // Names normalizePath would read differently ("a\b", trailing spaces) are not addressable: skipped, like the extension.
      if (path.slice(path.lastIndexOf('/') + 1) !== name) return null;
      if (child.isDirectory()) return { name, path, directory: true, size: 0 };
      try {
        const info = await fs.stat(join(real, name));
        return { name, path, directory: info.isDirectory(), size: info.isDirectory() ? 0 : info.size };
      } catch {
        if (options.strict) throw new StorageError('io', '目录中有无法读取的条目，未完成书库检查');
        return null;
      }
    }));
    return entries.filter(entry => entry !== null).sort((a, b) => Number(b.directory) - Number(a.directory) || collator.compare(a.name, b.name));
  }

  async function stat(path: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { real } = await locate(path);
    try {
      const info = await fs.stat(real);
      return { size: info.isDirectory() ? 0 : info.size, directory: info.isDirectory() };
    } catch (error) {
      if (MISSING.has(code(error))) return null;
      throw failure(error, real);
    }
  }

  async function ensureDir(path: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { real } = await locate(path);
    await fs.mkdir(real, { recursive: true }).catch(error => { throw failure(error, real); });
  }

  async function settle(dest: string, source: StoredFile): Promise<'exists'> {
    const found = await fs.stat(dest).catch(() => null);
    if (found?.isFile() && found.size === source.size) return 'exists';
    throw new StorageError('conflict', '目标位置已有同名文件且大小不同，已保留原文件；请检查后重试');
  }

  async function put(path: string, source: StoredFile, options: { signal: AbortSignal; onProgress?: (sent: number, total: number) => void }): Promise<'stored' | 'exists'> {
    options.signal.throwIfAborted();
    const { path: current, real: dest } = await locate(path);
    if (current === '/') throw new StorageError('invalid', '文件路径无效');
    await fs.mkdir(dirname(dest), { recursive: true }).catch(error => { throw failure(error, dirname(dest)); });
    try {
      await fs.link(source.path, dest);
    } catch (error) {
      if (code(error) === 'EEXIST') return settle(dest, source);
      if (!NO_LINK.has(code(error))) throw failure(error, dest);
      options.signal.throwIfAborted();
      // Another filesystem (always the case between Docker volumes): copy next to the destination under a hidden name first,
      // so an interrupted copy never leaves a truncated book under the real name, then publish it atomically without clobbering.
      const temp = join(dirname(dest), `${OWN}-${crypto.randomUUID()}.part`);
      // copyFile reports nothing: watch the copy grow, so the task shows progress instead of 0 % for the whole copy.
      const watch = options.onProgress && setInterval(() => void fs.stat(temp).then(stat => options.onProgress?.(stat.size, source.size), () => undefined), 500);
      try {
        await fs.copyFile(source.path, temp, constants.COPYFILE_EXCL).finally(() => clearInterval(watch));
        if ((await fs.stat(temp)).size !== source.size) throw new StorageError('io', '复制后文件大小核验失败，已撤销写入');
        try { await fs.link(temp, dest); } catch (linkError) {
          if (code(linkError) === 'EEXIST') return await settle(dest, source);
          if (!NO_LINK.has(code(linkError))) throw failure(linkError, dest);
          // No hard links (SMB/exFAT/FUSE): rename is still atomic; check first so an existing file is never replaced.
          if (await fs.stat(dest).catch(() => null)) return await settle(dest, source);
          await fs.rename(temp, dest);
        }
      } catch (copyError) {
        throw copyError instanceof StorageError ? copyError : failure(copyError, dest);
      } finally {
        await fs.rm(temp, { force: true }).catch(() => undefined);
      }
    }
    const stored = await fs.stat(dest).catch(() => null);
    if (stored?.size !== source.size) {
      await fs.rm(dest, { force: true });
      throw new StorageError('io', '写入后文件大小核验失败，已撤销写入');
    }
    await fs.rm(source.path, { force: true }).catch(() => undefined);
    options.onProgress?.(source.size, source.size);
    return 'stored';
  }

  async function test(signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
    try {
      const found = await stat('/', signal);
      if (!found) return { ok: false, message: `目录不存在：${dir}` };
      if (!found.directory) return { ok: false, message: `不是目录：${dir}` };
      const probe = join((await locate('/')).real, `${OWN}-test-${crypto.randomUUID()}`);
      try { await fs.writeFile(probe, '', { flag: 'wx' }); } catch (error) {
        return { ok: false, message: `目录不可写：${dir}（${code(error) || errorMessage(error)}），请检查 NAS 目录权限` };
      }
      await fs.rm(probe, { force: true });
      return { ok: true, message: `可以写入：${dir}` };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ok: false, message: errorMessage(error) };
    }
  }

  // The scratch dir is created by whoever downloads into it (mkdir -p), not up front; list() hides it.
  const localPath = async (path: string) => (await locate(path)).real;
  return { kind: 'local', label: dir, scratchDir: join(dir, `${OWN}-tmp`), list, stat, ensureDir, put, test, localPath };
}
