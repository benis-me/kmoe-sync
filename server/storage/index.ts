// Storage targets: a local directory under the library root, or a WebDAV server.
import { createLocalTarget } from './local';
import { StorageError, type StorageTarget } from './types';
import { createWebdavTarget } from './webdav';

export * from './types';
export { createLocalTarget } from './local';
export { createWebdavTarget } from './webdav';
export { inspectLibrary, type Delivered, type LibraryRequest, type LibraryResult } from './library';

/** A saved target or an unsaved draft. Throws StorageError('invalid') for an unusable URL or path. */
export function createStorage(
  target: { kind: 'local' | 'webdav'; path: string; url: string | null; username: string | null; password: string | null },
  env: { libraryRoot: string },
): StorageTarget {
  if (target.kind === 'local') return createLocalTarget({ libraryRoot: env.libraryRoot, path: target.path });
  if (!target.url) throw new StorageError('invalid', '请填写 WebDAV 服务器地址');
  return createWebdavTarget({ url: target.url, username: target.username, password: target.password, basePath: target.path });
}
