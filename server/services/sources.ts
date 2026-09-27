// Bangumi reading lists (https://bgm.tv): a user's public manga collections become a to-do list of comics to find on
// Kmoe. Matching is confirmed by the user; nothing is subscribed automatically.
import type { BangumiType, Source, SourceInput, SourceItem } from '@shared/model';
import { json, now, type DB } from '../db';
import { AppError } from '../http/errors';
import { errorMessage, networkError, transientStatus } from '../lib/retry';
import { VERSION } from '../config';
import type { ActivityLog } from './activity';
import type { EventHub } from '../events';

const TYPE_CODES: Record<BangumiType, number> = { wish: 1, collect: 2, doing: 3, on_hold: 4, dropped: 5 };
const CODE_TYPES = Object.fromEntries(Object.entries(TYPE_CODES).map(([type, code]) => [code, type])) as Record<number, BangumiType>;
const PAGE = 50, MAX_PAGES = 40;

interface Row { id: number; name: string; username: string; types: string; enabled: number; interval_hours: number; last_sync_at: string | null; error: string | null }
interface ItemRow { id: number; source_id: number; external_id: string; title: string; original_title: string | null; status: BangumiType; cover: string | null; url: string; match_state: SourceItem['match']['state']; comic_key: string | null; comic_title: string | null; first_seen_at: string }
interface Collection { subject_id: number; type: number; subject?: { id: number; name?: string; name_cn?: string; images?: { common?: string; medium?: string } | null } }

export interface BangumiEntry { externalId: string; title: string; originalTitle: string | null; status: BangumiType; cover: string | null; url: string }

/** All manga (subject_type=1) in the chosen collection types of a public Bangumi user. */
export async function fetchCollections(username: string, types: BangumiType[], fetchImpl: typeof fetch = fetch): Promise<BangumiEntry[]> {
  const entries: BangumiEntry[] = [];
  for (const type of types) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `https://api.bgm.tv/v0/users/${encodeURIComponent(username)}/collections?subject_type=1&type=${TYPE_CODES[type]}&limit=${PAGE}&offset=${page * PAGE}`;
      let response: Response;
      try {
        response = await fetchImpl(url, { headers: { 'User-Agent': `kmoesync/${VERSION} (self-hosted; https://bgm.tv/dev)`, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      } catch (error) { throw networkError(error, ' Bangumi '); }
      if (response.status === 404) throw new AppError(404, 'bangumi_user', `Bangumi 上找不到用户「${username}」`);
      if (!response.ok) throw Object.assign(new Error(`Bangumi 返回 HTTP ${response.status}`), { retryable: transientStatus(response.status) });
      const body = await response.json() as { data?: Collection[]; total?: number };
      for (const entry of body.data ?? []) {
        const subject = entry.subject;
        const id = String(subject?.id ?? entry.subject_id);
        entries.push({
          externalId: id, title: subject?.name_cn || subject?.name || `#${id}`, originalTitle: subject?.name_cn && subject.name ? subject.name : null,
          status: CODE_TYPES[entry.type] ?? type, cover: subject?.images?.common || subject?.images?.medium || null, url: `https://bgm.tv/subject/${id}`,
        });
      }
      if ((page + 1) * PAGE >= (body.total ?? 0) || !body.data?.length) break;
    }
  }
  return entries;
}

export class SourceService {
  constructor(private readonly db: DB, private readonly hub: EventHub, private readonly activity: ActivityLog, private readonly fetchImpl: typeof fetch = fetch) {}

  private row(id: number): Row {
    const row = this.db.query<Row, [number]>('SELECT * FROM sources WHERE id = ?').get(id);
    if (!row) throw new AppError(404, 'source_not_found', '找不到该书单');
    return row;
  }
  private dto(row: Row): Source {
    const counts = this.db.query<{ total: number; pending: number }, [number]>("SELECT COUNT(*) AS total, COALESCE(SUM(match_state = 'pending'), 0) AS pending FROM source_items WHERE source_id = ?").get(row.id)!;
    return { id: row.id, name: row.name, username: row.username, types: json(row.types, ['wish']), enabled: row.enabled === 1, intervalHours: row.interval_hours,
      itemCount: counts.total, pendingCount: counts.pending, lastSyncAt: row.last_sync_at, error: row.error };
  }

  list(): Source[] { return this.db.query<Row, []>('SELECT * FROM sources ORDER BY id').all().map(row => this.dto(row)); }
  get(id: number): Source { return this.dto(this.row(id)); }

  async create(input: SourceInput): Promise<Source> {
    const result = this.db.run('INSERT INTO sources (name, username, types, enabled, interval_hours, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [input.name, input.username, JSON.stringify(input.types), input.enabled ? 1 : 0, input.intervalHours, now()]);
    const id = Number(result.lastInsertRowid);
    await this.sync(id).catch(() => {});
    return this.get(id);
  }

  update(id: number, patch: Partial<SourceInput>): Source {
    const current = this.get(id);
    const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as Source;
    this.db.run('UPDATE sources SET name = ?, username = ?, types = ?, enabled = ?, interval_hours = ? WHERE id = ?',
      [next.name, next.username, JSON.stringify(next.types), next.enabled ? 1 : 0, next.intervalHours, id]);
    return this.get(id);
  }

  remove(id: number) { this.row(id); this.db.run('DELETE FROM sources WHERE id = ?', [id]); }

  async sync(id: number): Promise<Source> {
    const row = this.row(id);
    try {
      const entries = await fetchCollections(row.username, json<BangumiType[]>(row.types, ['wish']), this.fetchImpl);
      const time = now();
      const known = new Set(this.db.query<{ id: string }, [number]>('SELECT external_id AS id FROM source_items WHERE source_id = ?').all(id).map(item => item.id));
      const added = new Set(entries.map(entry => entry.externalId).filter(externalId => !known.has(externalId))).size;
      this.db.transaction(() => {
        for (const entry of entries) {
          this.db.query(`INSERT INTO source_items (source_id, external_id, title, original_title, status, cover, url, first_seen_at, last_seen_at)
            VALUES ($source, $id, $title, $original, $status, $cover, $url, $now, $now)
            ON CONFLICT (source_id, external_id) DO UPDATE SET title = excluded.title, original_title = excluded.original_title, status = excluded.status,
              cover = excluded.cover, url = excluded.url, last_seen_at = excluded.last_seen_at`).run({ source: id, id: entry.externalId, title: entry.title, original: entry.originalTitle, status: entry.status, cover: entry.cover, url: entry.url, now: time });
        }
        // Left the list (or its type is no longer followed): forget it unless it was matched to a comic.
        this.db.run("DELETE FROM source_items WHERE source_id = ? AND last_seen_at < ? AND match_state != 'matched'", [id, time]);
        this.db.run('UPDATE sources SET last_sync_at = ?, error = NULL WHERE id = ?', [time, id]);
      })();
      if (added && row.last_sync_at) this.activity.add({ kind: 'source_synced', level: 'info', title: `书单「${row.name}」新增 ${added} 部`, detail: '在「发现 → 书单」中匹配 Kmoe 漫画后即可订阅' });
    } catch (error) {
      this.db.run('UPDATE sources SET last_sync_at = ?, error = ? WHERE id = ?', [now(), errorMessage(error), id]);
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'bangumi_failed', errorMessage(error));
    } finally {
      this.hub.emit({ type: 'shelf' });
    }
    return this.get(id);
  }

  async syncDue() {
    for (const row of this.db.query<Row, []>('SELECT * FROM sources WHERE enabled = 1').all()) {
      if (row.last_sync_at && Date.parse(row.last_sync_at) + row.interval_hours * 3_600_000 > Date.now()) continue;
      await this.sync(row.id).catch(() => {});
    }
  }

  private itemRow(id: number): ItemRow {
    const row = this.db.query<ItemRow, [number]>('SELECT s.*, c.title AS comic_title FROM source_items s LEFT JOIN comics c ON c.key = s.comic_key WHERE s.id = ?').get(id);
    if (!row) throw new AppError(404, 'source_item_not_found', '找不到该书单条目');
    return row;
  }
  private itemDto = (row: ItemRow): SourceItem => ({
    id: row.id, sourceId: row.source_id, externalId: row.external_id, title: row.title, originalTitle: row.original_title, status: row.status, cover: row.cover,
    url: row.url, match: { state: row.match_state, comicKey: row.comic_key, comicTitle: row.comic_title }, firstSeenAt: row.first_seen_at,
  });

  items(sourceId: number): SourceItem[] {
    this.row(sourceId);
    return this.db.query<ItemRow, [number]>(`SELECT s.*, c.title AS comic_title FROM source_items s LEFT JOIN comics c ON c.key = s.comic_key
      WHERE s.source_id = ? ORDER BY CASE s.match_state WHEN 'pending' THEN 0 WHEN 'matched' THEN 1 ELSE 2 END, s.first_seen_at DESC, s.id DESC`).all(sourceId).map(this.itemDto);
  }

  setMatch(id: number, state: SourceItem['match']['state'], comicKey: string | null = null): SourceItem {
    this.itemRow(id);
    this.db.run('UPDATE source_items SET match_state = ?, comic_key = ? WHERE id = ?', [state, comicKey, id]);
    this.hub.emit({ type: 'shelf' });
    return this.itemDto(this.itemRow(id));
  }
}
