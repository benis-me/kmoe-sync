// Library check: which chapters already exist in a storage target under its naming rule. A port of the browser extension's
// lib/library.ts (same matching, limits and result), generalised from WebDAV to any StorageTarget.
import type { DirEntry, Format, LibraryCheck } from '@shared/model';
import { canonical, chapterKey, joinPath, normalizePath, renderRule, safeSegment, validateRule } from '@shared/naming';
import { StorageError, type StorageTarget } from './types';

export interface LibraryRequest {
  title: string;
  authors: string[];
  format: Format;
  /** The target's naming rule. */
  rule: string;
  chapters: { id: string; label: string }[];
  /**
   * The target's configured directory (Target.path). The storage is already rooted there, so this only feeds the extension's
   * rule that a folder named after the title in it counts as a title directory. Default "/".
   */
  basePath?: string;
  /** An existing folder the comic is mapped to (relative to the target): checked instead of the rule's folders, with the rule's file-name part. */
  folder?: string;
}
/** A file this service delivered, from history for the same target, comic and format only; newest first. */
export interface Delivered { itemId: string; path: string; size: number | null; ok: boolean }
type LibraryChapter = LibraryCheck['chapters'][number];
export type LibraryResult = Pick<LibraryCheck, 'directory' | 'directoryExists' | 'chapters' | 'unmatched'>;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Compare the whole chapter label: volume 01 is not volume 010, nor a chapter range.
function sourceMatches(stem: string, request: LibraryRequest, label: string, titleDirectory: boolean): boolean {
  const name = canonical(stem), chapter = chapterKey(safeSegment(label)), title = canonical(safeSegment(request.title));
  if (titleDirectory && chapterKey(name) === chapter) return true;
  if (name.startsWith(`${title}-`) && chapterKey(name.slice(title.length + 1)) === chapter) return true;
  if (titleDirectory) {
    // A folder of one series: "<any title>-卷 01" is volume 1 even when the files were named after an older or edition title.
    for (let dash = name.indexOf('-'); dash > 0; dash = name.indexOf('-', dash + 1)) if (chapterKey(name.slice(dash + 1)) === chapter) return true;
    const tagged = /^(?:\[(?:kmoe|kox|koz|kzo|mox|moe|kindle|vol)[^\]]*\])?\[[^\]]+\](.+)$/i.exec(name)?.[1];
    if (tagged && chapterKey(tagged) === chapter) return true;
  }
  const prefix = /^\[(?:kmoe|kox|koz|kzo|mox|moe|kindle|vol)[^\]]*\]/i;
  const unbranded = name.replace(prefix, '');
  if (!unbranded.startsWith(`[${title}]`)) return false;
  let suffix = unbranded.slice(title.length + 2);
  for (const author of request.authors) suffix = suffix.replace(new RegExp(`^\\[${escape(canonical(safeSegment(author)))}\\]`), '');
  return chapterKey(suffix) === chapter || chapterKey(suffix) === `[${chapter}]`;
}

/** Read-only, scoped to the target and its naming rule. Paths in the result are relative to the target. */
export async function inspectLibrary(storage: StorageTarget, request: LibraryRequest, history: Delivered[] = []): Promise<LibraryResult> {
  const rule = validateRule(request.rule), ext = request.format;
  // A mapped folder is used literally (never re-rendered, so names the rule would sanitise still match); only the file part comes from the rule.
  const folder = request.folder ? normalizePath(request.folder).normalize('NFC') : null;
  const fileRule = folder ? rule.split('/').filter(Boolean).at(-1)! : rule;
  const signal = AbortSignal.timeout(45_000);
  const marker = `KMOESCAN${crypto.randomUUID().replaceAll('-', '')}`;
  const filename = `${marker}filename`;
  const dates = ['year', 'month', 'day', 'hour', 'min'];
  const template = fileRule.replace(/\{(year|month|day|hour|min)\}/g, (_, key: string) => `${marker}${key}`);
  const pattern = (text: string) => {
    let source = escape(text).replaceAll(filename, '([^/]+)');
    for (const key of dates) source = source.replaceAll(`${marker}${key}`, `\\d{${key === 'year' ? 4 : 2}}`);
    return new RegExp(`^${source}$`, 'iu');
  };
  const plans = request.chapters.map(chapter => {
    const rendered = renderRule(template, { title: request.title, author: request.authors, filename, bookname: chapter.label, ext });
    const path = folder && folder !== '/' ? `${folder.slice(1)}/${rendered}` : rendered;
    const parts = path.split('/');
    return { chapter, parts, segments: parts.map(pattern), match: pattern(path) };
  });
  const prefix: string[] = [];
  for (let i = 0; i < (plans[0]?.parts.length ?? 1) - 1; i++) {
    const part = plans[0]!.parts[i]!;
    if (part.includes(marker) || plans.some(plan => plan.parts[i] !== part)) break;
    prefix.push(part);
  }
  const directory = joinPath('/', prefix.join('/'));
  const titleDirectory = Boolean(folder) || rule.split('/').slice(0, -1).some(part => part.includes('{title}'))
    || normalizePath(request.basePath).split('/').includes(safeSegment(request.title));
  const files: DirEntry[] = [], directories = new Set<string>();
  let reads = 0, entries = 0;
  async function walk(path: string, depth: number, candidates: typeof plans): Promise<void> {
    // ponytail: bounded Depth-1 traversal; add pagination/indexing only for libraries exceeding these limits.
    if (++reads > 100) throw new StorageError('invalid', '检查范围超过 100 个目录，请缩小目标目录');
    let children: DirEntry[];
    try { children = await storage.list(path, { signal, strict: true }); } catch (error) {
      if (error instanceof StorageError && error.code === 'not_found') return;
      throw error;
    }
    directories.add(path);
    entries += children.length;
    if (entries > 10000) throw new StorageError('invalid', '检查范围超过 10000 个条目，请缩小目标目录');
    for (const child of children) {
      const basename = child.path.split('/').pop()!.normalize('NFC');
      const matching = candidates.filter(plan => plan.segments[depth]?.test(basename));
      if (child.directory) {
        const nested = matching.filter(plan => depth < plan.parts.length - 1);
        if (nested.length) await walk(child.path, depth + 1, nested);
      } else if (matching.some(plan => depth === plan.parts.length - 1) || (
        rule.includes('{filename}') && candidates.some(plan => depth === plan.parts.length - 1) && child.path.toLowerCase().endsWith(`.${ext}`)
        && (titleDirectory || canonical(child.name).includes(canonical(safeSegment(request.title))))
      )) files.push(child);
    }
  }
  try { await walk(directory, prefix.length, plans); } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) throw new StorageError('network', '检查超时，请缩小目标目录后重试', true);
    throw error;
  }

  const results = new Map(plans.map(plan => [plan.chapter.id, { id: plan.chapter.id, status: 'missing', paths: [], reason: '' } as LibraryChapter]));
  const unmatched: string[] = [];
  const comparable = (path: string) => path.normalize('NFC');
  for (const file of files) {
    const relative = file.path.slice(1).normalize('NFC');
    const recorded = history.filter(item => comparable(item.path) === comparable(file.path) && results.has(item.itemId));
    const matches = recorded.length ? plans.filter(plan => recorded.some(item => item.itemId === plan.chapter.id)) : plans.filter(plan => {
      const match = plan.match.exec(relative);
      if (!match) return false;
      if (rule.includes('{bookname}') && (titleDirectory || rule.includes('{title}'))) return true;
      return rule.includes('{filename}') && match.slice(1).every(stem => sourceMatches(stem, request, plan.chapter.label, titleDirectory));
    });
    if (matches.length !== 1) {
      if (titleDirectory || canonical(file.name).includes(canonical(safeSegment(request.title))) || !rule.includes('{filename}')) unmatched.push(file.path);
      if (matches.length > 1) for (const { chapter } of matches) {
        const result = results.get(chapter.id)!;
        result.status = 'unknown'; result.reason = '文件名对应多个章节'; result.paths.push(file.path);
      }
      continue;
    }
    const result = results.get(matches[0]!.chapter.id)!;
    const record = recorded.find(item => item.itemId === result.id);
    const valid = file.size > 0 && Number.isFinite(file.size) && (!record || (record.ok && (!record.size || record.size === file.size)));
    result.paths.push(file.path);
    if (valid) { result.status = 'downloaded'; result.reason = record ? '已核对同步记录与书库文件' : '已匹配书库文件名'; }
    else if (result.status !== 'downloaded') { result.status = 'unknown'; result.reason = file.size <= 0 ? '文件为空或大小不可读' : '文件大小或同步状态尚未确认'; }
  }
  if (unmatched.length) for (const result of results.values()) if (result.status === 'missing') {
    result.status = 'unknown'; result.reason = `另有 ${unmatched.length} 个文件无法对应章节`;
  }
  return { directory, directoryExists: directories.has(directory), chapters: [...results.values()], unmatched };
}
