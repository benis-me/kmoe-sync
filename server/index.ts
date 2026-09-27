// Entry point: `bun server/index.ts` (development) or the compiled binary in the Docker image.
import { createApp } from './app';
import { loadConfig, VERSION } from './config';
import { openDatabase } from './db';

const USAGE = `Kmoe Sync ${VERSION}
Usage: kmoesync [--healthcheck | --reset-admin | --version | --help]
  --reset-admin  forget the administrator password and sign every browser out; the next visit sets a new one
Configuration is read from the environment (PORT, DATA_DIR, LIBRARY_ROOT, …), see README.md.`;

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) { console.log(VERSION); process.exit(0); }
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }
// Anything unexpected must not start a second server on the same data directory.
const unknown = args.find(arg => arg !== '--healthcheck' && arg !== '--reset-admin');
if (unknown) { console.error(`Unknown option: ${unknown}\n${USAGE}`); process.exit(2); }

// A forgotten password: the next visit shows the first-run setup page again. Works while the server runs.
if (args.includes('--reset-admin')) {
  const db = openDatabase(loadConfig().dataDir);
  db.run('DELETE FROM sessions');
  db.run('DELETE FROM admin');
  db.close();
  console.log('管理员密码已清除，所有浏览器已退出。请立即打开网页设置新密码（在此之前，能访问这个端口的人都可以设置）。');
  process.exit(0);
}

// Docker HEALTHCHECK: the slim image has no curl.
if (args.includes('--healthcheck')) {
  // Probe the address the server listens on when HOST pins one (e.g. host networking bound to the LAN IP).
  const host = process.env.HOST?.trim();
  const probe = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const ok = await fetch(`http://${probe}:${process.env.PORT || 8080}/api/health`, { signal: AbortSignal.timeout(4000) }).then(response => response.ok, () => false);
  process.exit(ok ? 0 : 1);
}

/** One readable line for the usual NAS start-up problems instead of a stack trace. */
function startupError(error: unknown): string {
  const { code, path } = (error ?? {}) as { code?: string; path?: string };
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return `无法写入 ${path ?? '数据目录'}（${code}）。数据目录必须对运行用户可写：设置 PUID/PGID，或在 NAS 上调整该目录的权限。`;
  }
  if (code === 'EADDRINUSE') return `端口 ${process.env.PORT || 8080} 已被占用，请换一个 PORT 或端口映射。`;
  return error instanceof Error ? error.message : String(error);
}

let app: ReturnType<typeof createApp>;
try {
  const config = loadConfig();
  app = createApp(config);
  const server = app.start();
  console.log(`Kmoe Sync ${VERSION} listening on http://${server.hostname}:${server.port}`);
  console.log(`  data: ${config.dataDir}  library: ${config.libraryRoot}  mirrors: ${config.mirrors.map(origin => new URL(origin).host).join(', ')}`);
} catch (error) {
  console.error(`Kmoe Sync failed to start: ${startupError(error)}`);
  process.exit(1);
}

// A long-running NAS service logs stray async failures instead of exiting (and crash-looping under Docker).
process.on('unhandledRejection', error => console.error('[unhandled rejection]', error));

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('Shutting down…');
    void app.stop().finally(() => process.exit(0));
  });
}
