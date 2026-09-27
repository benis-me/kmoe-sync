// One background library job at a time (scan folders, match Kmoe, match Bangumi, sync Komga), with live progress.
import type { LibraryJob, LibraryJobKind } from '@shared/model';
import { now } from '../db';
import type { EventHub } from '../events';
import { AppError } from '../http/errors';
import { errorMessage } from '../lib/retry';

export interface JobContext {
  signal: AbortSignal;
  /** Report progress; also switches the job kind when a job chains into the next step (scan → match). */
  progress(update: { done?: number; total?: number; current?: string | null; kind?: LibraryJobKind }): void;
}

const IDLE: LibraryJob = { kind: null, running: false, targetId: null, done: 0, total: 0, current: null, error: null, cancelled: false, startedAt: null, finishedAt: null };

export class JobRunner {
  private job: LibraryJob = IDLE;
  private controller: AbortController | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly hub: EventHub) {}

  current(): LibraryJob { return this.job; }
  get busy() { return this.job.running; }

  /** Progress is pushed at most ~4 times a second; start and finish are pushed immediately. */
  private emit(immediate = false) {
    if (immediate) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
      this.hub.emit({ type: 'library', job: this.job });
      return;
    }
    this.emitTimer ??= setTimeout(() => { this.emitTimer = undefined; this.hub.emit({ type: 'library', job: this.job }); }, 250);
  }

  start(kind: LibraryJobKind, targetId: number, run: (context: JobContext) => Promise<void>): LibraryJob {
    if (this.job.running) throw new AppError(409, 'job_running', '已有书库任务在进行，请等待完成或先取消');
    const controller = new AbortController();
    this.controller = controller;
    this.job = { ...IDLE, kind, running: true, targetId, startedAt: now() };
    this.emit(true);
    const context: JobContext = {
      signal: controller.signal,
      progress: update => {
        this.job = { ...this.job, ...update };
        this.emit();
      },
    };
    const finish = (error: string | null) => {
      const cancelled = controller.signal.aborted;
      this.job = { ...this.job, running: false, current: null, finishedAt: now(), cancelled, error: cancelled ? null : error };
    };
    void run(context).then(() => finish(null), error => finish(errorMessage(error))).finally(() => {
      this.controller = null;
      this.emit(true);
      this.hub.emit({ type: 'folders', targetId });
    });
    return this.job;
  }

  cancel(): LibraryJob {
    this.controller?.abort(new Error('cancelled'));
    return this.job;
  }

  dispose() { this.controller?.abort(new Error('shutdown')); clearTimeout(this.emitTimer); }
}
