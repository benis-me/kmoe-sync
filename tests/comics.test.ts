import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { now } from '../server/db';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'kmoesync-comics-'));
  const app = createApp({
    host: '127.0.0.1', port: 0, dataDir: join(root, 'data'), libraryRoot: join(root, 'library'), staticDir: join(root, 'web'),
    mirrors: ['http://fake.invalid'], secureCookies: false, secret: Buffer.alloc(32, 9), fakeKmoe: true,
  }, { database: ':memory:', scheduler: false, fetch: (async (_input: string | URL | Request): Promise<Response> => { throw new Error('unexpected network'); }) as typeof fetch });
  cleanups.push(async () => { await app.stop(); rmSync(root, { recursive: true, force: true }); });
  const time = now(), target = app.targets.defaultId()!;
  const comic = Number(app.db.run('INSERT INTO comics (key, title, created_at, updated_at) VALUES (?, ?, ?, ?)', ['alpha', 'Alpha', time, time]).lastInsertRowid);
  const item = Number(app.db.run(`INSERT INTO items (comic_id, remote_id, type, name, first_seen_at, last_seen_at)
    VALUES (?, '1', 'volume', '卷 01', ?, ?)`, [comic, time, time]).lastInsertRowid);
  return { app, time, target, comic, item };
}

test('backfill and subsequent deliveries preserve an explicitly ignored folder', () => {
  const { app, time, target, comic, item } = setup();
  app.db.run("INSERT INTO deliveries (item_id, target_id, format, path, size, delivered_at) VALUES (?, ?, 'epub', '/Alpha/01.epub', 4, ?)", [item, target, time]);
  app.library.backfill();
  const folder = app.library.folderFor(comic, target)!;
  expect(app.library.folder(folder.id).kmoe.state).toBe('matched');
  app.library.ignore(folder.id);
  app.db.run('UPDATE folder_metadata SET dirty = 0');
  app.library.backfill();
  app.library.backfill();
  expect(app.library.folder(folder.id).kmoe).toMatchObject({ state: 'ignored', comic: null });
  expect(app.db.query('SELECT dirty FROM folder_metadata WHERE folder_id = ?').get(folder.id)).toEqual({ dirty: 0 });
  app.library.recordDelivery(comic, target, '/Alpha/02.epub');
  expect(app.library.folder(folder.id).kmoe).toMatchObject({ state: 'ignored', comic: null });
  // Reset is an explicit invitation to associate it again.
  app.library.reset(folder.id);
  app.library.backfill();
  expect(app.library.folderFor(comic, target)?.id).toBe(folder.id);
});

test('shelf reuses items, subscription and tracked state within each request, without caching later requests', () => {
  const { app, time, target, comic, item } = setup();
  app.db.run(`INSERT INTO subscriptions (comic_id, enabled, types, format, target_id, strategy, created_at, updated_at)
    VALUES (?, 1, '["volume"]', 'epub', ?, 'backfill', ?, ?)`, [comic, target, time, time]);
  app.db.run(`INSERT INTO items (comic_id, remote_id, type, name, first_seen_at, last_seen_at, is_new)
    VALUES (?, '2', 'volume', '卷 02', ?, ?, 1), (?, '3', 'serial', '話 01', ?, ?, 1)`, [comic, time, time, comic, time, time]);
  app.db.run("INSERT INTO deliveries (item_id, target_id, format, path, size, delivered_at) VALUES (?, ?, 'epub', '/Alpha/01.epub', 4, ?)", [item, target, time]);
  const query = spyOn(app.db, 'query');
  try {
    expect(app.comics.shelf(target)[0]).toMatchObject({
      comic: { key: 'alpha', tracked: true }, subscription: { types: ['volume'] },
      counts: { items: 2, downloaded: 1, queued: 0, failed: 0, new: 1 },
    });
    const sql = query.mock.calls.map(([text]) => text);
    expect(sql.filter(text => text === 'SELECT * FROM items WHERE comic_id = ? AND gone_at IS NULL')).toHaveLength(1);
    expect(sql.filter(text => text === 'SELECT * FROM subscriptions WHERE comic_id = ?')).toHaveLength(1);
    expect(sql.filter(text => text.startsWith('SELECT 1 WHERE EXISTS'))).toHaveLength(0);
    app.db.run("UPDATE subscriptions SET types = '[\"serial\"]' WHERE comic_id = ?", [comic]);
    expect(app.comics.shelf(target)[0]?.counts).toEqual({ items: 1, downloaded: 0, queued: 0, failed: 0, new: 1 });
    app.db.run('DELETE FROM subscriptions');
    app.db.run('DELETE FROM deliveries');
    expect(app.comics.shelf(target)).toEqual([]);
    expect(app.comics.summary(app.comics.byId(comic)).tracked).toBe(false);
  } finally { query.mockRestore(); }
});

test('library DTOs read linked comic summaries in one batch and reflect subsequent changes', () => {
  const { app, time, target, comic } = setup();
  for (let i = 0; i < 3; i++) {
    const id = i === 0 ? comic : Number(app.db.run('INSERT INTO comics (key, title, created_at, updated_at) VALUES (?, ?, ?, ?)', [`book${i}`, `Book ${i}`, time, time]).lastInsertRowid);
    app.db.run(`INSERT INTO library_folders (target_id, path, name, comic_id, kmoe_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'matched', ?, ?)`, [target, `/Book ${i}`, `Book ${i}`, id, time, time]);
  }
  const query = spyOn(app.db, 'query');
  try {
    expect(app.library.overview(target).folders.every(folder => folder.kmoe.comic?.tracked)).toBe(true);
    const sql = query.mock.calls.map(([text]) => text);
    expect(sql.filter(text => text === 'SELECT * FROM comics WHERE id = ?')).toHaveLength(0);
    expect(sql.filter(text => text.startsWith('SELECT 1 WHERE EXISTS'))).toHaveLength(0);
    expect(sql.filter(text => text.startsWith('SELECT * FROM comics WHERE id IN'))).toHaveLength(1);
    app.db.run("UPDATE comics SET title = 'New title' WHERE id = ?", [comic]);
    expect(app.library.overview(target).folders.find(folder => folder.kmoe.comic?.key === 'alpha')?.kmoe.comic?.title).toBe('New title');
  } finally { query.mockRestore(); }
});
