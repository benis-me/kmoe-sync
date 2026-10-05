// 整理文件名, like Sonarr's "rename files": the book files of linked series folders get the target's naming rule. First a
// preview of what each file is and what it becomes (planned by shared/books.ts), the AI for files whose names do not say,
// then a library job that renames what the user kept. Only names change: files stay in their folder (one folder = one
// Komga series), and nothing is ever overwritten. Komga keeps read progress through renames when it hashes files.
import { BOOK_FILE, planRename } from '@shared/books';
import type { DirEntry, Format, LibraryJob, Rename, RenameFolder, RenamePreview } from '@shared/model';
import { joinPath, safeSegment } from '@shared/naming';
import type { AiService } from '../ai/service';
import { json, type DB } from '../db';
import { AppError } from '../http/errors';
import { errorMessage } from '../lib/retry';
import type { MetadataService } from '../metadata/service';
import { StorageError } from '../storage/types';
import type { ActivityLog } from './activity';
import type { ComicService } from './comics';
import type { JobRunner } from './jobs';
import type { FolderRow, LibraryService } from './library';
import type { TargetService } from './targets';

const nfc = (text: string) => text.normalize('NFC');
const same = (a: string, b: string) => nfc(a).toLowerCase() === nfc(b).toLowerCase();
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
/** Komga writes renamed books' metadata again once its scan has seen the new names. */
const SYNC_AFTER_MINUTES = 2;

export class RenameService {
  constructor(private readonly deps: {
    db: DB; comics: ComicService; targets: TargetService; library: LibraryService; metadata: MetadataService; jobs: JobRunner; activity: ActivityLog; ai: AiService;
  }) {}

  /** The rule's file-name part: files keep their folders. */
  private fileRule(targetId: number): string {
    return this.deps.targets.resolved(targetId).rule.split('/').filter(Boolean).at(-1)!;
  }

  private async plan(row: FolderRow, rule: string, ai?: ReadonlyMap<string, { item: string; confidence: number }>): Promise<RenameFolder> {
    const { comics, db } = this.deps;
    const comic = comics.byId(row.comic_id!);
    const folder: RenameFolder = { folderId: row.id, path: row.path, title: comic.title, comicKey: comic.key, named: 0, files: [], error: null };
    const items = comics.items(comic.id);
    if (!items.length) return { ...folder, error: '还没有读取这部漫画在 Kmoe 上的章节' };
    let entries: DirEntry[];
    try { entries = await this.deps.targets.storage(row.target_id).list(row.path, { signal: AbortSignal.timeout(20_000) }); } catch (error) {
      return { ...folder, error: errorMessage(error) };
    }
    const records = new Map<string, string>();
    for (const delivery of db.query<{ remote_id: string; path: string }, [number, number]>(
      'SELECT i.remote_id, d.path FROM deliveries d JOIN items i ON i.id = d.item_id WHERE i.comic_id = ? AND d.target_id = ?').all(comic.id, row.target_id)) {
      if (nfc(parent(delivery.path)) === nfc(row.path)) records.set(nfc(basename(delivery.path)), delivery.remote_id);
    }
    return {
      ...folder,
      ...planRename({
        title: comic.title, authors: json<string[]>(comic.authors, []), hint: row.hint, rule, records, ai,
        items: items.map(item => ({ id: item.remote_id, type: item.type, name: item.name, sort_order: item.sort_order })),
        entries: entries.map(entry => ({ name: entry.name, directory: entry.directory })),
      }),
    };
  }

  /** Linked folders of a target (or the given ones): what renaming their book files to the rule would change. */
  async preview(targetId: number, folderIds?: number[]): Promise<RenamePreview> {
    this.deps.targets.get(targetId);
    const rule = this.fileRule(targetId);
    const rows = this.deps.db.query<FolderRow, [number]>('SELECT * FROM library_folders WHERE target_id = ? AND comic_id IS NOT NULL ORDER BY path COLLATE NOCASE')
      .all(targetId).filter(row => !folderIds || folderIds.includes(row.id));
    const folders: RenameFolder[] = [];
    let named = 0;
    for (const row of rows) {
      const folder = await this.plan(row, rule);
      named += folder.named;
      if (folder.files.length || folder.error) folders.push(folder);
    }
    const komga = await this.deps.metadata.komgaLibrary(targetId).catch(() => null);
    return { targetId, rule, folders, named, komga };
  }

  /** The folder planned again with the AI's reading of the files whose names did not say which item they are. */
  async readWithAi(folderId: number): Promise<RenameFolder> {
    const row = this.deps.library.row(folderId);
    if (!row.comic_id) throw new AppError(409, 'folder_unlinked', '请先为这个文件夹关联 Kmoe 漫画');
    this.deps.ai.client();
    const rule = this.fileRule(row.target_id);
    const folder = await this.plan(row, rule);
    const unknown = folder.files.filter(file => !file.item).map(file => file.name);
    if (folder.error || !unknown.length) return folder;
    const comic = this.deps.comics.byId(row.comic_id);
    const items = this.deps.comics.items(comic.id).map(item => ({ id: item.remote_id, name: item.name, type: item.type }));
    const readings = await this.deps.ai.readFiles({ title: comic.title, authors: json<string[]>(comic.authors, []) }, unknown, items, AbortSignal.timeout(120_000));
    return this.plan(row, rule, readings);
  }

  /** Renames what the user kept from the preview, as a library job. Each file is renamed only onto a free name. */
  start(targetId: number, renames: Rename[]): LibraryJob {
    this.deps.targets.get(targetId);
    const byFolder = new Map<number, Rename[]>();
    for (const rename of renames) {
      const row = this.deps.library.row(rename.folderId);
      const book = (name: string) => BOOK_FILE.test(name) && !name.includes('/') && name !== '.' && name !== '..';
      if (row.target_id !== targetId) throw new AppError(400, 'invalid_rename', `「${row.path}」不在这个存储位置里`);
      if (!book(rename.name) || !book(rename.to) || safeSegment(rename.to) !== nfc(rename.to)) throw new AppError(400, 'invalid_rename', `不能把「${rename.name}」改成「${rename.to}」`);
      byFolder.set(row.id, [...byFolder.get(row.id) ?? [], rename]);
    }
    return this.deps.jobs.start('rename', targetId, async context => {
      const storage = this.deps.targets.storage(targetId);
      const failed: string[] = [];
      let done = 0, renamed = 0, folders = 0;
      context.progress({ total: renames.length, done });
      try {
        for (const [folderId, ops] of byFolder) {
          const row = this.deps.library.row(folderId);
          context.progress({ current: row.path });
          const moved: Rename[] = [];
          try {
            // A name taken by a file of this batch frees up once that file moves on: its rename waits a round while rounds move files.
            for (let pending = ops; pending.length;) {
              const waiting: Rename[] = [];
              for (const op of pending) {
                context.signal.throwIfAborted();
                try {
                  await storage.move(joinPath(row.path, op.name), joinPath(row.path, op.to), context.signal);
                  moved.push(op);
                } catch (error) {
                  if (context.signal.aborted) throw error;
                  if (error instanceof StorageError && error.code === 'conflict' && pending.some(other => other !== op && same(other.name, op.to))) { waiting.push(op); continue; }
                  failed.push(`${op.name}（${errorMessage(error)}）`);
                }
                context.progress({ done: ++done });
              }
              if (waiting.length === pending.length) {
                for (const op of waiting) failed.push(`${op.name}（已有同名文件「${op.to}」）`);
                context.progress({ done: done += waiting.length });
                break;
              }
              pending = waiting;
            }
          } finally {
            if (moved.length) {
              renamed += moved.length;
              folders++;
              await this.settle(row, moved);
            }
          }
        }
      } finally {
        // Also when cancelled: what was renamed is reported and goes to Komga.
        if (renamed) {
          await this.deps.metadata.rescan(targetId);
          this.deps.activity.add({
            kind: 'info', level: failed.length ? 'warning' : 'success', title: `整理文件名：改名了 ${folders} 部的 ${renamed} 个文件${failed.length ? `，${failed.length} 个没有改` : ''}`,
            detail: failed.length ? failed.slice(0, 5).join('；') : null,
          });
        }
      }
      if (failed.length) throw new Error(`${renamed ? `改名了 ${renamed} 个文件，` : ''}${failed.length} 个没有改：${failed.slice(0, 3).join('；')}${failed.length > 3 ? '…' : ''}`);
    });
  }

  /**
   * After renames in a folder: download records follow the files, the folder row and its comic's library check are read
   * again, and its metadata is written to Komga again once Komga has scanned the new names.
   */
  private async settle(row: FolderRow, moved: Rename[]) {
    const { db, library } = this.deps;
    const renamed = new Map(moved.map(op => [nfc(joinPath(row.path, op.name)), joinPath(row.path, op.to)]));
    db.transaction(() => {
      for (const delivery of db.query<{ id: number; path: string }, [number]>('SELECT id, path FROM deliveries WHERE target_id = ?').all(row.target_id)) {
        const to = renamed.get(nfc(delivery.path));
        if (to) db.run('UPDATE deliveries SET path = ? WHERE id = ?', [to, delivery.id]);
      }
    })();
    await library.refreshFolder(row.id).catch(error => console.warn(`[rename] ${row.path}: ${errorMessage(error)}`));
    const formats = new Set(moved.map(op => /\.mobi$/i.test(op.to) ? 'mobi' : /\.k?epub$/i.test(op.to) ? 'epub' : null).filter((format): format is Format => format !== null));
    for (const format of formats) await library.check(row.comic_id!, row.target_id, format).catch(error => console.warn(`[rename] check ${row.path}: ${errorMessage(error)}`));
    this.deps.metadata.markDirty(row.id, SYNC_AFTER_MINUTES);
  }
}
