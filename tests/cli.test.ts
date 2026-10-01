// The binary's command-line options, run as a separate process against a temporary data directory.
import { afterAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, openDatabase } from '../server/db';

const root = mkdtempSync(join(tmpdir(), 'kmoesync-cli-'));
const env = { ...process.env, DATA_DIR: join(root, 'data'), LIBRARY_ROOT: join(root, 'library') };
mkdirSync(env.DATA_DIR, { recursive: true });
const run = (...args: string[]) => Bun.spawnSync(['bun', 'server/index.ts', ...args], { env });
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('an upgrade first leaves a consistent copy of the database; one from a newer version is refused', () => {
  const dir = join(root, 'upgrade');
  mkdirSync(dir, { recursive: true });
  // A database as 0.1.4 left it: four migrations.
  const old = openDatabase(dir);
  old.run("INSERT INTO comics (key, title, created_at, updated_at) VALUES ('k1', '旧库里的漫画', ?, ?)", [now(), now()]);
  old.exec('ALTER TABLE folder_metadata DROP COLUMN komga_written; DROP INDEX tasks_latest; UPDATE schema_version SET version = 4;');
  old.close();
  const upgraded = openDatabase(dir);
  expect(upgraded.query('SELECT version FROM schema_version').get()).toEqual({ version: 6 });
  upgraded.close();
  const backup = join(dir, 'kmoesync.db.v4.bak');
  expect(statSync(backup).mode & 0o777).toBe(0o600);
  const copy = new Database(backup, { readonly: true });
  expect(copy.query('SELECT version FROM schema_version').get()).toEqual({ version: 4 });
  expect(copy.query('SELECT title FROM comics').all()).toEqual([{ title: '旧库里的漫画' }]);
  copy.close();
  const newer = openDatabase(dir);
  newer.run('UPDATE schema_version SET version = 99');
  newer.close();
  expect(() => openDatabase(dir)).toThrow('更新的版本');
});

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
