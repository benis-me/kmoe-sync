// Storage target contract: a local directory under the library root, or a WebDAV server.
// All paths are relative to the target's base directory and use "/" separators ("/Comics/書名/卷 01.epub").
import type { DirEntry } from '@shared/model';

export type StorageErrorCode = 'not_found' | 'conflict' | 'auth' | 'network' | 'invalid' | 'io' | 'no_space';

export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, message: string, readonly retryable = false, readonly status?: number) { super(message); }
}

export interface StoredFile { path: string; size: number }

export interface StorageTarget {
  readonly kind: 'local' | 'webdav';
  /** Human-readable location for messages, e.g. "/library/漫画" or "https://nas/dav/Comics". */
  readonly label: string;
  /**
   * Local targets only: an absolute directory on the same filesystem as the library (e.g. "<root>/.kmoesync-tmp"),
   * so finished downloads can be moved into place with a rename instead of a copy.
   */
  readonly scratchDir?: string;
  /** Local targets only: where a path is on this machine, to read a file in place (symlinks may not lead outside the root). */
  localPath?(path: string): Promise<string>;
  /** Directory listing, directories first. Throws StorageError('not_found') when the directory does not exist.
   *  strict: throw when any entry cannot be read (used by library checks so partial listings are never trusted). */
  list(path: string, options?: { signal?: AbortSignal; strict?: boolean }): Promise<DirEntry[]>;
  /** null when nothing exists at `path`. */
  stat(path: string, signal?: AbortSignal): Promise<{ size: number; directory: boolean } | null>;
  /** mkdir -p. */
  ensureDir(path: string, signal?: AbortSignal): Promise<void>;
  /**
   * Store the local file `source` at `path`, never overwriting. Parent directories are created.
   * If something already exists there: same size -> 'exists' (treated as done), otherwise StorageError('conflict').
   * Verifies the stored size before resolving. The source file is consumed (moved) for local targets on the same device.
   */
  put(path: string, source: StoredFile, options: { signal: AbortSignal; onProgress?: (sent: number, total: number) => void }): Promise<'stored' | 'exists'>;
  /** Renames the file at `from` to `to` (整理文件名), never replacing anything: StorageError('conflict') when `to` exists. */
  move(from: string, to: string, signal?: AbortSignal): Promise<void>;
  /** Settings "测试连接": reachability, credentials and write permission where cheap to check. */
  test(signal?: AbortSignal): Promise<{ ok: boolean; message: string }>;
}
