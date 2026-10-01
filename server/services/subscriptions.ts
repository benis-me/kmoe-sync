// Subscriptions: which content types of a comic to keep in which library, and the checks that find new items.
import type { PolicyImpact, Subscription, SubscriptionInput } from '@shared/model';
import { now, type DB } from '../db';
import type { EventHub } from '../events';
import { AppError } from '../http/errors';
import { kmoeThrottle } from '../kmoe/client';
import { KmoeError } from '../kmoe/errors';
import { errorMessage } from '../lib/retry';
import type { ActivityLog } from './activity';
import { itemSize, type ComicService, type ItemRow } from './comics';
import type { SettingsStore } from './settings';
import type { TargetService } from './targets';
import type { TaskService } from './tasks';
import { BULK_PACE_MS } from './library';

type Policy = Pick<SubscriptionInput, 'enabled' | 'types' | 'format' | 'targetId' | 'strategy'> & { createdAt: string };

/** First retry of a check that failed on the network; later ones double it. */
const RETRY_MS = 5 * 60_000;
/** Kmoe unreachable, timing out or answering 5xx: not the comic's fault, and usually over within minutes. */
const networkFailure = (error: unknown) => error instanceof KmoeError && error.code === 'network';

export class SubscriptionService {
  private running: Promise<void> | null = null;
  /** Network failures in a row per comic id (a restart forgets them: the next failure retries soon again). */
  private readonly failures = new Map<number, number>();
  checking = false;
  onChange = () => {};

  constructor(private readonly deps: {
    db: DB; hub: EventHub; comics: ComicService; tasks: TaskService; targets: TargetService; settings: SettingsStore; activity: ActivityLog;
    /** Spacing between checks in a batch (tests shorten it). */
    pace?: number;
  }) {}

  /**
   * What the policy wants right now: items to queue (not delivered, not queued, not in the library, not cancelled by
   * the user), and queued subscription tasks that no longer fit. `future` only takes items first seen after subscribing.
   * Items a library check could not confirm (unknown) may well be there: they are counted, never queued.
   */
  private plan(comicId: number, policy: Policy, includeFailed: boolean): { queue: ItemRow[]; cancel: number[]; unknown: number } {
    const { db, comics } = this.deps;
    const cancel = db.query<{ id: number; item_id: number; target_id: number; format: string }, [number]>(
      "SELECT id, item_id, target_id, format FROM tasks WHERE comic_id = ? AND status = 'queued' AND origin = 'subscription'").all(comicId);
    if (!policy.enabled) return { queue: [], cancel: cancel.map(task => task.id), unknown: 0 };
    const wanted = comics.items(comicId).filter(item => policy.types.includes(item.type) && (policy.strategy === 'backfill' || item.first_seen_at > policy.createdAt));
    const wantedIds = new Set(wanted.map(item => item.id));
    const states = comics.states(comicId, policy.targetId, policy.format);
    const latest = new Map(db.query<{ item_id: number; status: string }, [number, number, string]>(
      `SELECT t.item_id, t.status FROM tasks t WHERE t.comic_id = ? AND t.target_id = ? AND t.format = ?
       AND t.id = (SELECT MAX(id) FROM tasks WHERE item_id = t.item_id AND target_id = t.target_id AND format = t.format)`).all(comicId, policy.targetId, policy.format).map(row => [row.item_id, row.status]));
    const queue = wanted.filter(item => {
      const state = states[item.remote_id]?.state ?? 'missing';
      if (state === 'downloaded' || state === 'unknown' || state === 'queued' || state === 'running') return false;
      const last = latest.get(item.id);
      return last !== 'cancelled' && (includeFailed || last !== 'failed');
    });
    return {
      queue,
      cancel: cancel.filter(task => !wantedIds.has(task.item_id) || task.target_id !== policy.targetId || task.format !== policy.format).map(task => task.id),
      unknown: wanted.filter(item => states[item.remote_id]?.state === 'unknown').length,
    };
  }

  private policyOf(input: SubscriptionInput, existing: Subscription | null): Policy {
    return { ...input, createdAt: existing?.createdAt ?? now() };
  }

  async preview(key: string, input: SubscriptionInput): Promise<PolicyImpact> {
    const { id } = await this.deps.comics.sync(key);
    const existing = this.get(id);
    const plan = this.plan(id, this.policyOf(input, existing), true);
    return { queue: plan.queue.length, cancel: plan.cancel.length, sizeMB: Math.round(plan.queue.reduce((sum, item) => sum + itemSize(item, input.format), 0) * 10) / 10, unknown: plan.unknown };
  }

  get(comicId: number): Subscription | null {
    const row = this.deps.comics.subscriptionRow(comicId);
    return row ? this.deps.comics.subscriptionDto(row, this.deps.comics.byId(comicId).key) : null;
  }

  private nextCheck() {
    const hours = this.deps.settings.get().checkIntervalHours;
    // ±10 % jitter so many subscriptions do not hit the site at the same minute.
    return new Date(Date.now() + hours * 3_600_000 * (0.9 + Math.random() * 0.2)).toISOString();
  }

  async save(key: string, input: SubscriptionInput): Promise<Subscription> {
    const { db, comics, tasks, targets, hub } = this.deps;
    if (!targets.exists(input.targetId)) throw new AppError(404, 'target_not_found', '找不到该存储位置');
    const { id: comicId } = await comics.sync(key);
    const existing = this.get(comicId);
    const time = now();
    db.query(`INSERT INTO subscriptions (comic_id, enabled, types, format, target_id, strategy, line, next_check_at, created_at, updated_at)
      VALUES ($comic, $enabled, $types, $format, $target, $strategy, $line, $next, $now, $now)
      ON CONFLICT (comic_id) DO UPDATE SET enabled = excluded.enabled, types = excluded.types, format = excluded.format, target_id = excluded.target_id,
        strategy = excluded.strategy, line = excluded.line, next_check_at = COALESCE(next_check_at, excluded.next_check_at), updated_at = excluded.updated_at`).run({ comic: comicId, enabled: input.enabled ? 1 : 0, types: JSON.stringify(input.types), format: input.format, target: input.targetId,
        strategy: input.strategy, line: input.line, next: this.nextCheck(), now: time });
    const plan = this.plan(comicId, this.policyOf(input, existing), true);
    tasks.cancelQueued(plan.cancel);
    tasks.enqueue(comicId, plan.queue, { targetId: input.targetId, format: input.format, line: input.line }, 'subscription');
    hub.emit({ type: 'comic', key });
    hub.emit({ type: 'shelf' });
    this.onChange();
    return this.get(comicId)!;
  }

  remove(key: string, cancelPending: boolean) {
    const { db, comics, tasks, hub } = this.deps;
    const comic = comics.row(key);
    if (cancelPending) {
      tasks.cancelQueued(db.query<{ id: number }, [number]>("SELECT id FROM tasks WHERE comic_id = ? AND status = 'queued' AND origin = 'subscription'").all(comic.id).map(row => row.id));
    }
    db.run('DELETE FROM subscriptions WHERE comic_id = ?', [comic.id]);
    hub.emit({ type: 'comic', key });
    hub.emit({ type: 'shelf' });
    this.onChange();
  }

  /** Re-reads the comic from Kmoe and queues whatever the subscription now wants. Returns the new items found. */
  async check(key: string): Promise<number> {
    const { db, comics, tasks, activity, hub } = this.deps;
    const comic = comics.row(key);
    const row = comics.subscriptionRow(comic.id);
    if (!row) throw new AppError(404, 'not_subscribed', '尚未订阅这部漫画');
    const time = now();
    try {
      const { added } = await comics.sync(key, true);
      const subscription = this.get(comic.id)!;
      const plan = this.plan(comic.id, { ...subscription, createdAt: subscription.createdAt }, false);
      const result = tasks.enqueue(comic.id, plan.queue, { targetId: subscription.targetId, format: subscription.format, line: subscription.line }, 'subscription');
      this.failures.delete(comic.id);
      db.run('UPDATE subscriptions SET last_check_at = ?, last_success_at = ?, next_check_at = ?, error = NULL WHERE comic_id = ?', [time, time, this.nextCheck(), comic.id]);
      const relevant = added.filter(item => subscription.types.includes(item.type));
      if (relevant.length) {
        const names = relevant.map(item => item.name).join('、');
        activity.add({
          kind: 'new_items', level: 'info', comicId: comic.id, title: `《${comics.byId(comic.id).title}》更新了 ${relevant.length} 项`,
          detail: `${names.length > 100 ? `${names.slice(0, 97)}…` : names}${result.created ? `，已加入下载队列` : ''}`,
        });
      }
      hub.emit({ type: 'shelf' });
      return relevant.length;
    } catch (error) {
      const cooldown = error instanceof KmoeError && error.code === 'rate_limited' ? kmoeThrottle() : null;
      if (cooldown) {
        // Kmoe is throttling: not this comic's fault, so check again right after the cooldown instead of in hours.
        db.run('UPDATE subscriptions SET next_check_at = ? WHERE comic_id = ?', [new Date(cooldown.until + 60_000).toISOString(), comic.id]);
        throw error;
      }
      const message = errorMessage(error);
      // Retry a network failure after 5, 10, 20… minutes until that reaches the normal interval; the activity feed hears
      // of it only once the first retry has failed too.
      const failures = networkFailure(error) ? (this.failures.get(comic.id) ?? 0) + 1 : 0;
      if (failures) this.failures.set(comic.id, failures); else this.failures.delete(comic.id);
      const retry = failures ? RETRY_MS * 2 ** (failures - 1) : Infinity;
      const next = retry < this.deps.settings.get().checkIntervalHours * 3_600_000 ? new Date(Date.now() + retry).toISOString() : this.nextCheck();
      db.run('UPDATE subscriptions SET last_check_at = ?, next_check_at = ?, error = ? WHERE comic_id = ?', [time, next, message, comic.id]);
      const detail = failures ? `${message}，会自动重试` : message;
      if (failures === 0 || failures === 2) activity.add({ kind: 'check_failed', level: 'warning', comicId: comic.id, title: `《${comic.title}》检查更新失败`, detail, merge: () => ({ title: `《${comic.title}》检查更新失败`, detail }) });
      hub.emit({ type: 'comic', key });
      throw error;
    }
  }

  /** Checks every due subscription one after another (the Kmoe client already spaces requests). */
  checkDue(all = false): Promise<void> {
    if (this.running) return this.running;
    const due = this.deps.db.query<{ key: string }, [string]>(`SELECT c.key FROM subscriptions s JOIN comics c ON c.id = s.comic_id
      WHERE s.enabled = 1 AND (?1 = '' OR s.next_check_at IS NULL OR s.next_check_at <= ?1) ORDER BY s.next_check_at`).all(all ? '' : now()).map(row => row.key);
    if (!due.length) return Promise.resolve();
    this.checking = true;
    this.onChange();
    this.running = (async () => {
      for (const [index, key] of due.entries()) {
        // Spaced out like other bulk Kmoe work. A throttled or unreachable Kmoe ends the batch (the rest stay due), so an
        // outage costs one failed check per scheduler tick instead of a timeout for every subscription in a row.
        if (index) await Bun.sleep(this.deps.pace ?? BULK_PACE_MS);
        if (kmoeThrottle()) break;
        if (await this.check(key).then(() => false, networkFailure)) break;
      }
    })().finally(() => { this.running = null; this.checking = false; this.onChange(); });
    return this.running;
  }

  count(all: boolean): number {
    return this.deps.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM subscriptions WHERE enabled = 1 AND (?1 = '' OR next_check_at IS NULL OR next_check_at <= ?1)").get(all ? '' : now())!.n;
  }

  nextCheckAt(): string | null {
    return this.deps.db.query<{ at: string | null }, []>('SELECT MIN(next_check_at) AS at FROM subscriptions WHERE enabled = 1').get()?.at ?? null;
  }
}
