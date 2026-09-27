// Runs the API server (watch mode) and the Vite dev server together. KMOESYNC_FAKE_KMOE=1 also starts a fake Kmoe mirror.
// Development binds to localhost only (the Docker image listens on all interfaces).
const env: Record<string, string | undefined> = { HOST: '127.0.0.1', ...process.env };
const children = [
  ...(env.KMOESYNC_FAKE_KMOE ? [Bun.spawn(['bun', '--watch', 'tests/fake-kmoe.ts'], { stdout: 'inherit', stderr: 'inherit', env })] : []),
  Bun.spawn(['bun', '--watch', 'server/index.ts'], { stdout: 'inherit', stderr: 'inherit', env }),
  Bun.spawn(['bun', 'run', 'dev:web'], { stdout: 'inherit', stderr: 'inherit', env }),
];
const stop = () => { for (const child of children) child.kill(); process.exit(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await Promise.race(children.map(child => child.exited));
stop();
export {};
