// Where a 书库整理 folder stands at each stage (Kmoe link → Bangumi match → Komga sync), as its row shows it. The rows,
// the overview strip and the filters all read it from here, so every count agrees with the rows it filters to.
import type { BangumiState, KmoeLinkState, LibraryFolder } from './model';

export type Stage = 'kmoe' | 'bangumi' | 'komga';
export const STAGE_KEYS: readonly Stage[] = ['kmoe', 'bangumi', 'komga'];
/** Komga as the row reads it: waiting for a Bangumi match, due for a sync, or the outcome of the last one. */
export const KOMGA_STATUSES = ['waiting', 'pending', 'not_found', 'error', 'synced'] as const;
export type KomgaStatus = (typeof KOMGA_STATUSES)[number];

export type Tone = 'success' | 'warning' | 'destructive' | 'muted';
/** `todo`: the folder waits for the user (a match to confirm or make by hand, a failed sync). */
export interface StageOption { value: string; label: string; tone: Tone; todo?: boolean }

/** Each stage's statuses, from not started through waiting-for-you to done: the order the menus list them in. */
export const STAGES: Record<Stage, { label: string; options: StageOption[] }> = {
  kmoe: { label: 'Kmoe', options: [
    { value: 'pending', label: '待匹配', tone: 'muted' },
    { value: 'suggested', label: '待确认', tone: 'warning', todo: true },
    { value: 'unmatched', label: '未找到', tone: 'muted', todo: true },
    { value: 'matched', label: '已关联', tone: 'success' },
    { value: 'ignored', label: '已忽略', tone: 'muted' },
  ] },
  bangumi: { label: 'Bangumi', options: [
    { value: 'none', label: '未匹配', tone: 'muted' },
    { value: 'suggested', label: '待确认', tone: 'warning', todo: true },
    { value: 'unmatched', label: '未找到', tone: 'muted', todo: true },
    { value: 'matched', label: '已匹配', tone: 'success' },
  ] },
  komga: { label: 'Komga', options: [
    { value: 'waiting', label: '等待 Bangumi', tone: 'muted' },
    { value: 'pending', label: '待同步', tone: 'muted' },
    { value: 'not_found', label: '未找到系列', tone: 'warning', todo: true },
    { value: 'error', label: '失败', tone: 'destructive', todo: true },
    { value: 'synced', label: '已同步', tone: 'success' },
  ] },
};

export const optionOf = (stage: Stage, value: string | null | undefined) => STAGES[stage].options.find(option => option.value === value);

/** A folder's status at one stage; null where the stage does not apply (an ignored folder's metadata, Komga not set up). */
export function statusOf(folder: LibraryFolder, stage: Stage): string | null {
  if (stage === 'kmoe') return folder.kmoe.state;
  if (folder.kmoe.state === 'ignored') return null;
  const { bangumi, komga } = folder.metadata;
  if (stage === 'bangumi') return bangumi.state;
  if (komga.state === 'disabled') return null;
  if (komga.state === 'pending' && bangumi.state !== 'matched') return 'waiting';
  if (komga.state === 'error' || komga.state === 'not_found') return komga.state;
  return komga.state === 'pending' || komga.dirty ? 'pending' : 'synced';
}

/** Filters of the folder list. `todo`: only folders waiting for the user. */
export interface FolderFilters { todo?: boolean; kmoe?: KmoeLinkState; bangumi?: BangumiState; komga?: KomgaStatus }

/** The folder waits for the user at some stage; Bangumi and Komga count only while metadata is shown (`meta`). */
export const needsAttention = (folder: LibraryFolder, meta: boolean) =>
  (meta ? STAGE_KEYS : STAGE_KEYS.slice(0, 1)).some(stage => optionOf(stage, statusOf(folder, stage))?.todo === true);

/** The folder passes every filter; `except` leaves one stage out, which is how a stage's menu counts its own options. */
export const passes = (folder: LibraryFolder, filters: FolderFilters, meta: boolean, except?: Stage) =>
  (!filters.todo || needsAttention(folder, meta)) && STAGE_KEYS.every(stage => stage === except || !filters[stage] || statusOf(folder, stage) === filters[stage]);

/** How many folders are in each status of a stage. */
export function countBy(folders: LibraryFolder[], stage: Stage): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const folder of folders) {
    const status = statusOf(folder, stage);
    if (status) counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}
