// Keeping the offline Bangumi data current: one background update at a time (newest dump → download → import → swap),
// a status for the settings page (pushed at most twice a second), started on demand when the online API is blocked.
import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BangumiArchiveStatus } from '@shared/model';
import { errorMessage } from '../lib/retry';
import { ArchiveReader, importDump } from './archive';
import { downloadDump, latestDump } from './dump';

/** Persisted between restarts (settings table): when latest.json was last read and the last failure. */
export interface OfflineState { checkedAt: string | null; error: string | null; failedAt: string | null }
export interface OfflineHooks {
  /** fetch for GitHub (through the Bangumi proxy when one is set). */
  fetch(): typeof fetch;
  load(): Partial<OfflineState> | null;
  save(state: OfflineState): void;
  /** Status changed (throttled while downloading/importing). */
  status(status: BangumiArchiveStatus): void;
  finished(result: { ok: true; dump: string; subjects: number } | { ok: false; error: string }): void;
}

const DAY_MS = 86_400_000;
/** After a failed download, automatic starts wait this long (a blocked GitHub must not loop); manual updates don't. */
const AUTO_RETRY_MS = 6 * 3_600_000;

export class OfflineData {
  readonly reader: ArchiveReader;
  private job: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private phase: 'downloading' | 'importing' | null = null;
  private progress: { done: number; total: number } | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private shownState: string | null = null;

  constructor(private readonly dir: string, private readonly hooks: OfflineHooks) {
    this.reader = new ArchiveReader(join(dir, 'archive.db'));
  }

  private state(): OfflineState { return { checkedAt: null, error: null, failedAt: null, ...this.hooks.load() }; }
  private save(patch: Partial<OfflineState>) { this.hooks.save({ ...this.state(), ...patch }); }

  status(): BangumiArchiveStatus {
    const info = this.reader.info(), saved = this.state();
    return {
      state: this.phase ?? (info ? 'ready' : saved.error ? 'error' : 'none'),
      dump: info?.dump ?? null, dumpDate: info?.dumpDate ?? null, importedAt: info?.importedAt ?? null, subjects: info?.subjects ?? 0,
      progress: this.progress, error: saved.error, checkedAt: saved.checkedAt,
    };
  }

  private emit() {
    const status = this.status();
    if (status.state !== this.shownState) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
      this.shownState = status.state;
      this.hooks.status(status);
      return;
    }
    this.emitTimer ??= setTimeout(() => { this.emitTimer = undefined; this.hooks.status(this.status()); }, 500);
  }

  /** Runs an update in the background unless one is running. force: download and import even the dump already imported. */
  start(force = false): BangumiArchiveStatus {
    if (!this.job) {
      const controller = new AbortController();
      this.controller = controller;
      this.phase = 'downloading';
      this.progress = null;
      this.save({ error: null });
      this.emit();
      this.job = this.update(force, controller.signal).finally(() => {
        this.job = null;
        this.controller = null;
        this.phase = null;
        this.progress = null;
        this.emit();
      });
    }
    return this.status();
  }

  /** On demand (the online API is blocked): true when a download is running now. */
  autoStart(): boolean {
    if (this.job) return true;
    const { failedAt } = this.state();
    if (failedAt && Date.now() - Date.parse(failedAt) < AUTO_RETRY_MS) return false;
    this.start();
    return true;
  }

  /** Scheduler: fetch the archive when it is needed but missing, and look for a newer dump at most daily while in use. */
  maintain(needed: boolean) {
    if (this.job || !needed) return;
    const { checkedAt } = this.state();
    if (!this.reader.ready || !checkedAt || Date.now() - Date.parse(checkedAt) >= DAY_MS) this.autoStart();
  }

  private async update(force: boolean, signal: AbortSignal) {
    const building = join(this.dir, 'archive.db.building');
    try {
      const fetchImpl = this.hooks.fetch();
      const dump = await latestDump(fetchImpl, signal);
      this.save({ checkedAt: new Date().toISOString() });
      if (!force && this.reader.info()?.dump === dump.name) { this.save({ error: null, failedAt: null }); return; }
      this.progress = { done: 0, total: dump.size };
      this.emit();
      const zip = await downloadDump(dump, this.dir, fetchImpl, (done, total) => { this.progress = { done, total }; this.emit(); }, signal);
      this.phase = 'importing';
      this.progress = { done: 0, total: 0 };
      this.emit();
      const subjects = await importDump(zip, building, { dump: dump.name, dumpDate: dump.createdAt, digest: `sha256:${dump.sha256}` },
        (done, total) => { this.progress = { done, total }; this.emit(); }, signal);
      // Swap in the new file; queries kept using the old one until here.
      renameSync(building, this.reader.file);
      this.reader.close();
      rmSync(zip, { force: true });
      this.save({ error: null, failedAt: null });
      this.hooks.finished({ ok: true, dump: dump.name, subjects });
    } catch (error) {
      rmSync(building, { force: true });
      if (signal.aborted) return;
      const message = errorMessage(error);
      this.save({ error: message, failedAt: new Date().toISOString() });
      this.hooks.finished({ ok: false, error: message });
    }
  }

  /** Stops a running update (the partial download stays and is resumed next time). */
  stop(): Promise<void> {
    this.controller?.abort(new Error('stopped'));
    clearTimeout(this.emitTimer);
    return this.job ?? Promise.resolve();
  }
}
