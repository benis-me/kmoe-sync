// SQLite storage (bun:sqlite, WAL). Forward-only migrations; each entry runs once inside a transaction.
import { Database } from 'bun:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE admin (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
  CREATE TABLE kmoe_account (
    id INTEGER PRIMARY KEY CHECK (id = 1), email TEXT, mirror TEXT, cookies BLOB, state TEXT NOT NULL DEFAULT 'none',
    level INTEGER, vip INTEGER, free_quota TEXT, vip_quota TEXT, checked_at TEXT, error TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE targets (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('local', 'webdav')), name TEXT NOT NULL, path TEXT NOT NULL,
    url TEXT, username TEXT, password BLOB, rule TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE comics (
    id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, book_id TEXT, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '[]',
    cover_url TEXT, language TEXT, status TEXT, description TEXT, latest TEXT, remote_updated_at TEXT, fetched_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE items (
    id INTEGER PRIMARY KEY, comic_id INTEGER NOT NULL REFERENCES comics(id) ON DELETE CASCADE, remote_id TEXT NOT NULL,
    type TEXT NOT NULL, name TEXT NOT NULL, sort_order INTEGER, pages INTEGER, epub_mb REAL, mobi_mb REAL,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, gone_at TEXT, is_new INTEGER NOT NULL DEFAULT 0,
    UNIQUE (comic_id, remote_id)
  );
  CREATE TABLE subscriptions (
    id INTEGER PRIMARY KEY, comic_id INTEGER NOT NULL UNIQUE REFERENCES comics(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 1,
    types TEXT NOT NULL, format TEXT NOT NULL, target_id INTEGER NOT NULL REFERENCES targets(id), strategy TEXT NOT NULL,
    line INTEGER NOT NULL DEFAULT 0, last_check_at TEXT, last_success_at TEXT, next_check_at TEXT, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY, comic_id INTEGER NOT NULL REFERENCES comics(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    format TEXT NOT NULL, line INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, phase TEXT, attempt INTEGER NOT NULL DEFAULT 0,
    retry_at TEXT, loaded INTEGER NOT NULL DEFAULT 0, total INTEGER, speed REAL NOT NULL DEFAULT 0, path TEXT, error TEXT,
    error_code TEXT, origin TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
  );
  CREATE INDEX tasks_by_status ON tasks (status, id);
  CREATE INDEX tasks_by_comic ON tasks (comic_id, id);
  CREATE UNIQUE INDEX tasks_one_active ON tasks (item_id, target_id, format) WHERE status IN ('queued', 'running');
  CREATE TABLE deliveries (
    id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE, format TEXT NOT NULL, path TEXT NOT NULL,
    size INTEGER NOT NULL, delivered_at TEXT NOT NULL, UNIQUE (item_id, target_id, format)
  );
  CREATE TABLE library_checks (
    comic_id INTEGER NOT NULL REFERENCES comics(id) ON DELETE CASCADE, target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    format TEXT NOT NULL, result TEXT NOT NULL, checked_at TEXT NOT NULL, PRIMARY KEY (comic_id, target_id, format)
  );
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, level TEXT NOT NULL, title TEXT NOT NULL, detail TEXT,
    comic_id INTEGER REFERENCES comics(id) ON DELETE SET NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX activity_recent ON activity (id DESC);
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL, types TEXT NOT NULL, enabled INTEGER NOT NULL,
    interval_hours INTEGER NOT NULL, last_sync_at TEXT, error TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE source_items (
    id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE, external_id TEXT NOT NULL,
    title TEXT NOT NULL, original_title TEXT, status TEXT NOT NULL, cover TEXT, url TEXT NOT NULL,
    match_state TEXT NOT NULL DEFAULT 'pending', comic_key TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    UNIQUE (source_id, external_id)
  );
  `,
  // v2: series folders on disk (library import, folder mapping) and their Bangumi/Komga metadata state.
  `
  CREATE TABLE library_folders (
    id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE, path TEXT NOT NULL, name TEXT NOT NULL,
    books INTEGER NOT NULL DEFAULT 0, format TEXT, sample TEXT, hint TEXT, scanned_at TEXT,
    comic_id INTEGER REFERENCES comics(id) ON DELETE SET NULL, kmoe_state TEXT NOT NULL DEFAULT 'pending',
    kmoe_candidates TEXT NOT NULL DEFAULT '[]', kmoe_score REAL, kmoe_error TEXT, linked_by TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (target_id, path)
  );
  CREATE UNIQUE INDEX library_folders_comic ON library_folders (comic_id, target_id) WHERE comic_id IS NOT NULL;
  CREATE TABLE folder_metadata (
    folder_id INTEGER PRIMARY KEY REFERENCES library_folders(id) ON DELETE CASCADE,
    bangumi_id INTEGER, bangumi_state TEXT NOT NULL DEFAULT 'none', bangumi_subject TEXT, bangumi_candidates TEXT NOT NULL DEFAULT '[]',
    bangumi_source TEXT, bangumi_checked_at TEXT,
    komga_series_id TEXT, komga_state TEXT NOT NULL DEFAULT 'pending', komga_synced_at TEXT, komga_error TEXT,
    dirty INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE bangumi_cache (url TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at TEXT NOT NULL);
  `,
  // v3: what the AI concluded about Kmoe / Bangumi candidates, and its tidied summary + tags awaiting review.
  `
  ALTER TABLE library_folders ADD COLUMN kmoe_ai TEXT;
  ALTER TABLE folder_metadata ADD COLUMN bangumi_ai TEXT;
  ALTER TABLE folder_metadata ADD COLUMN ai_polish TEXT;
  `,
  // v4: the Kmoe password (sealed) for logging in again by itself when the session expires, and whether the user wants that.
  `
  ALTER TABLE kmoe_account ADD COLUMN password BLOB;
  ALTER TABLE kmoe_account ADD COLUMN remember INTEGER NOT NULL DEFAULT 0;
  `,
  // v5: what this service wrote to each Komga series and its books, so fields someone else locked there are left alone.
  `
  ALTER TABLE folder_metadata ADD COLUMN komga_written TEXT;
  `,
];

export type DB = Database;

export function openDatabase(dataDir: string, file = 'kmoesync.db'): DB {
  const db = new Database(file === ':memory:' ? ':memory:' : join(dataDir, file), { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  // Sessions and sealed secrets live here: keep the files private like secret.key (best effort on NAS filesystems).
  if (file !== ':memory:') for (const suffix of ['', '-wal', '-shm']) { try { chmodSync(join(dataDir, file + suffix), 0o600); } catch { /* not created yet or not supported */ } }
  return db;
}

export function migrate(db: DB) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.query<{ version: number }, []>('SELECT version FROM schema_version').get();
  let version = row?.version ?? 0;
  if (!row) db.run('INSERT INTO schema_version (version) VALUES (0)');
  for (; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.run('UPDATE schema_version SET version = ?', [version + 1]);
    })();
  }
}

export const now = () => new Date().toISOString();
export const json = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
