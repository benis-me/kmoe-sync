// Activity feed (shown on the shelf page) and the bridge to push notifications.
import type { Activity, NotifyEvent } from '@shared/model';
import { now, type DB } from '../db';
import type { EventHub } from '../events';
import type { Notifier } from '../notify';

type Kind = Activity['kind'];
type Level = Activity['level'];
const NOTIFY: Partial<Record<Kind, NotifyEvent>> = {
  new_items: 'new_items', download_done: 'download_done', download_failed: 'download_failed', session_expired: 'session_expired', quota_low: 'quota_low',
};

interface Row { id: number; kind: Kind; level: Level; title: string; detail: string | null; comic_key: string | null; created_at: string }

export class ActivityLog {
  constructor(private readonly db: DB, private readonly hub: EventHub, private readonly notifier: Notifier) {}

  private select(where: string, params: (string | number)[]) {
    return this.db.query<Row, (string | number)[]>(`SELECT a.id, a.kind, a.level, a.title, a.detail, c.key AS comic_key, a.created_at FROM activity a LEFT JOIN comics c ON c.id = a.comic_id ${where}`).all(...params);
  }
  private dto = (row: Row): Activity => ({ id: row.id, kind: row.kind, level: row.level, title: row.title, detail: row.detail, comicKey: row.comic_key, createdAt: row.created_at });

  list(limit = 50): Activity[] { return this.select('ORDER BY a.id DESC LIMIT ?', [limit]).map(this.dto); }

  /**
   * Records an event. With `merge`, an entry of the same kind for the same comic from the last few minutes is updated
   * instead (e.g. many finished downloads become one line); notifications are only sent for new entries.
   */
  /** `url`: where a push notification opens (the Komga series when there is one). */
  add(input: { kind: Kind; level: Level; title: string; detail?: string | null; comicId?: number | null; url?: string | null; merge?: (previous: { title: string; detail: string | null }) => { title: string; detail: string | null } }) {
    if (input.merge && input.comicId) {
      const recent = this.db.query<{ id: number; title: string; detail: string | null }, [string, number]>(
        "SELECT id, title, detail FROM activity WHERE kind = ? AND comic_id = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes') ORDER BY id DESC LIMIT 1").get(input.kind, input.comicId);
      if (recent) {
        const merged = input.merge({ title: recent.title, detail: recent.detail });
        this.db.run('UPDATE activity SET title = ?, detail = ?, created_at = ? WHERE id = ?', [merged.title, merged.detail, now(), recent.id]);
        const row = this.select('WHERE a.id = ?', [recent.id])[0];
        if (row) this.hub.emit({ type: 'activity', activity: this.dto(row) });
        return;
      }
    }
    const result = this.db.run('INSERT INTO activity (kind, level, title, detail, comic_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [input.kind, input.level, input.title, input.detail ?? null, input.comicId ?? null, now()]);
    this.db.run('DELETE FROM activity WHERE id <= (SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET 1000)');
    const row = this.select('WHERE a.id = ?', [Number(result.lastInsertRowid)])[0];
    if (row) this.hub.emit({ type: 'activity', activity: this.dto(row) });
    const event = NOTIFY[input.kind];
    if (event) this.notifier.send({ event, title: input.title, detail: input.detail, url: input.url });
  }
}
