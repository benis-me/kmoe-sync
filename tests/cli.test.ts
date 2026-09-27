// The binary's command-line options, run as a separate process against a temporary data directory.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, openDatabase } from '../server/db';

const root = mkdtempSync(join(tmpdir(), 'kmoesync-cli-'));
const env = { ...process.env, DATA_DIR: join(root, 'data'), LIBRARY_ROOT: join(root, 'library') };
mkdirSync(env.DATA_DIR, { recursive: true });
const run = (...args: string[]) => Bun.spawnSync(['bun', 'server/index.ts', ...args], { env });
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('--reset-admin forgets the password and every session; unknown options are refused', () => {
  const db = openDatabase(env.DATA_DIR);
  db.run('INSERT INTO admin (id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?)', ['hash', now(), now()]);
  db.run('INSERT INTO sessions (id, csrf, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', ['s', 'c', now(), now(), now()]);
  db.close();
  const reset = run('--reset-admin');
  expect(reset.exitCode).toBe(0);
  expect(reset.stdout.toString()).toContain('管理员密码已清除');
  const after = openDatabase(env.DATA_DIR);
  expect(after.query('SELECT COUNT(*) AS n FROM admin').get()).toEqual({ n: 0 });
  expect(after.query('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  after.close();
  expect(run('--nope').exitCode).toBe(2);
});
