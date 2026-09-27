// Storage targets: local directories under the library root and WebDAV servers. Passwords are sealed at rest.
import type { Target, TargetInput } from '@shared/model';
import { DEFAULT_RULE, NamingError, normalizePath, validateRule } from '@shared/naming';
import { now, type DB } from '../db';
import { AppError } from '../http/errors';
import type { Sealer } from '../lib/crypto';
import { createStorage } from '../storage';
import type { StorageTarget } from '../storage/types';
import type { SettingsStore } from './settings';

interface Row { id: number; kind: 'local' | 'webdav'; name: string; path: string; url: string | null; username: string | null; password: Uint8Array | null; rule: string; created_at: string }
export interface ResolvedTarget { kind: 'local' | 'webdav'; name: string; path: string; url: string | null; username: string | null; password: string | null; rule: string }

function webdavUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`); } catch { throw new AppError(400, 'invalid_target', 'WebDAV 地址无效'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new AppError(400, 'invalid_target', 'WebDAV 地址需为 HTTP(S) 地址，账号密码请单独填写');
  return url.href.replace(/\/+$/, '');
}

export class TargetService {
  constructor(private readonly db: DB, private readonly sealer: Sealer, private readonly settings: SettingsStore, private readonly libraryRoot: string) {}

  private rows(): Row[] { return this.db.query<Row, []>('SELECT * FROM targets ORDER BY id').all(); }
  private row(id: number): Row {
    const row = this.db.query<Row, [number]>('SELECT * FROM targets WHERE id = ?').get(id);
    if (!row) throw new AppError(404, 'target_not_found', '找不到该存储位置');
    return row;
  }
  private dto = (row: Row): Target => ({
    id: row.id, kind: row.kind, name: row.name, path: row.path, url: row.url, username: row.username,
    hasPassword: Boolean(row.password?.length), rule: row.rule, isDefault: this.defaultId() === row.id, createdAt: row.created_at,
  });

  list(): Target[] { return this.rows().map(this.dto); }
  get(id: number): Target { return this.dto(this.row(id)); }
  exists(id: number) { return Boolean(this.db.query('SELECT 1 FROM targets WHERE id = ?').get(id)); }

  defaultId(): number | null {
    const id = this.settings.get().defaultTargetId;
    if (id !== null && this.db.query('SELECT 1 FROM targets WHERE id = ?').get(id)) return id;
    return this.db.query<{ id: number }, []>('SELECT id FROM targets ORDER BY id LIMIT 1').get()?.id ?? null;
  }

  resolved(id: number): ResolvedTarget {
    const row = this.row(id);
    return { kind: row.kind, name: row.name, path: row.path, url: row.url, username: row.username, password: this.sealer.open(row.password), rule: row.rule };
  }

  storage(id: number): StorageTarget { return this.open(this.resolved(id)); }
  open(target: ResolvedTarget): StorageTarget { return createStorage(target, { libraryRoot: this.libraryRoot }); }

  private validate(input: TargetInput, previous?: ResolvedTarget): ResolvedTarget {
    try {
      const rule = validateRule(input.rule || DEFAULT_RULE);
      const path = normalizePath(input.path || '/');
      if (input.kind === 'local') return { kind: 'local', name: input.name, path, url: null, username: null, password: null, rule };
      const password = input.password === undefined ? previous?.password ?? null : input.password || null;
      return { kind: 'webdav', name: input.name, path, url: webdavUrl(input.url), username: input.username?.trim() || null, password, rule };
    } catch (error) {
      if (error instanceof NamingError) throw new AppError(400, 'invalid_target', error.message);
      throw error;
    }
  }

  /** A saved target merged with unsaved edits, or a brand-new draft; used by test/browse before saving. */
  fromRef(ref: { targetId?: number; draft?: TargetInput }): ResolvedTarget {
    const saved = ref.targetId !== undefined ? this.resolved(ref.targetId) : undefined;
    if (!ref.draft) return saved!;
    return this.validate(ref.draft, saved);
  }

  create(input: TargetInput): Target {
    const target = this.validate(input);
    const result = this.db.run('INSERT INTO targets (kind, name, path, url, username, password, rule, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [target.kind, target.name, target.path, target.url, target.username, target.password ? this.sealer.seal(target.password) : null, target.rule, now()]);
    const id = Number(result.lastInsertRowid);
    if (this.settings.get().defaultTargetId === null) this.settings.patch({ defaultTargetId: id });
    return this.get(id);
  }

  update(id: number, patch: Partial<TargetInput>): Target {
    const current = this.resolved(id);
    const merged: TargetInput = {
      kind: patch.kind ?? current.kind, name: patch.name ?? current.name, path: patch.path ?? current.path,
      url: patch.url ?? current.url ?? undefined, username: patch.username ?? current.username ?? undefined, password: patch.password, rule: patch.rule ?? current.rule,
    };
    const target = this.validate(merged, current);
    this.db.run('UPDATE targets SET kind = ?, name = ?, path = ?, url = ?, username = ?, password = ?, rule = ? WHERE id = ?',
      [target.kind, target.name, target.path, target.url, target.username, target.password ? this.sealer.seal(target.password) : null, target.rule, id]);
    return this.get(id);
  }

  remove(id: number) {
    this.row(id);
    const subscriptions = this.db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM subscriptions WHERE target_id = ?').get(id)!.n;
    if (subscriptions) throw new AppError(409, 'target_in_use', `有 ${subscriptions} 个订阅保存到这里，请先修改这些订阅的存储位置`);
    const active = this.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM tasks WHERE target_id = ? AND status IN ('queued', 'running')").get(id)!.n;
    if (active) throw new AppError(409, 'target_in_use', `还有 ${active} 个下载任务保存到这里，请先取消或等待完成`);
    this.db.run('DELETE FROM targets WHERE id = ?', [id]);
    if (this.settings.get().defaultTargetId === id) this.settings.patch({ defaultTargetId: this.defaultId() });
  }

  setDefault(id: number) { this.row(id); this.settings.patch({ defaultTargetId: id }); }

  /** First start: a local library at the root of the mounted /library volume. */
  ensureDefault() {
    if (!this.rows().length) this.create({ kind: 'local', name: '本地书库', path: '/', rule: DEFAULT_RULE });
  }

  /** Import WebDAV servers and the naming rule from a Kmoe Sync browser-extension export. */
  importExtension(config: unknown): { targets: number; rule: boolean } {
    const root = config && typeof config === 'object' ? config as Record<string, unknown> : {};
    const data = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;
    if (!Array.isArray(data.webdavServers) && typeof data.downloadRule !== 'string') throw new AppError(400, 'invalid_config', '这不是浏览器扩展导出的配置文件');
    let rule: string | null = null;
    if (typeof data.downloadRule === 'string') { try { rule = validateRule(data.downloadRule); } catch { rule = null; } }
    let created = 0;
    const existing = this.rows();
    for (const raw of Array.isArray(data.webdavServers) ? data.webdavServers : []) {
      if (!raw || typeof raw !== 'object') continue;
      const server = raw as Record<string, unknown>;
      const url = typeof server.baseUrl === 'string' ? server.baseUrl : '';
      if (!url || url === 'https://example.com/webdav') continue;
      const path = typeof server.defaultPath === 'string' ? server.defaultPath : '/';
      const username = typeof server.username === 'string' ? server.username : '';
      let normalizedUrl: string;
      try { normalizedUrl = webdavUrl(url); } catch { continue; }
      if (existing.some(row => row.kind === 'webdav' && row.url === normalizedUrl && (row.username ?? '') === username && row.path === normalizePath(path))) continue;
      this.create({ kind: 'webdav', name: typeof server.name === 'string' && server.name.trim() ? server.name.trim().slice(0, 60) : 'WebDAV', url: normalizedUrl, username,
        password: typeof server.password === 'string' ? server.password : undefined, path, rule: rule ?? DEFAULT_RULE });
      created++;
    }
    if (rule) for (const row of this.rows()) if (row.kind === 'local' && row.rule === DEFAULT_RULE) this.db.run('UPDATE targets SET rule = ? WHERE id = ?', [rule, row.id]);
    return { targets: created, rule: rule !== null };
  }
}
