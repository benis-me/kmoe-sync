// Library helpers shared by the 书库 page, its dialogs and the comic page: labels, counts and cache updates.
import type { QueryClient } from '@tanstack/react-query';
import { BangumiState, KmoeLinkState, KomgaState, type LibraryCounts, type LibraryFolder, type LibraryJob, type LibraryJobKind, type LibraryOverview, type MetadataSettings } from '@shared/model';
import { ApiError } from '@/lib/api';
import { libraryQuery } from '@/lib/queries';

export const JOB_LABELS: Record<LibraryJobKind, { label: string; running: string }> = {
  scan: { label: '扫描书库', running: '正在扫描书库' },
  kmoe: { label: '匹配 Kmoe', running: '正在匹配 Kmoe' },
  bangumi: { label: '匹配 Bangumi', running: '正在匹配 Bangumi' },
  komga: { label: '同步到 Komga', running: '正在同步到 Komga' },
  ai: { label: 'AI 处理', running: 'AI 正在处理' },
};
/** What each AI pass is called (they all run as the 'ai' job). */
export const AI_LABELS = {
  'ai-kmoe': { label: 'AI 判定 Kmoe', running: 'AI 正在判定 Kmoe 匹配' },
  'ai-bangumi': { label: 'AI 判定 Bangumi', running: 'AI 正在判定 Bangumi 条目' },
  'ai-polish': { label: 'AI 整理', running: 'AI 正在整理元数据' },
} as const;
/** A job's labels; an 'ai' job is named after the pass this page started, when it knows which. */
export const jobLabels = (kind: LibraryJobKind, ai: string | null) => kind === 'ai' && ai && ai in AI_LABELS ? AI_LABELS[ai as keyof typeof AI_LABELS] : JOB_LABELS[kind];

/** Suggestions at or above this score can be accepted in one go. */
export const CONFIDENT = 0.9;
/** Highest-scoring candidate (the contract does not promise an order). */
export const bestOf = <T extends { score: number }>(candidates: T[]): T | undefined => candidates.reduce<T | undefined>((best, c) => !best || c.score > best.score ? c : best, undefined);
export const bestScore = (folder: LibraryFolder) => Math.max(folder.kmoe.score ?? 0, ...folder.kmoe.candidates.map(c => c.score));
export const percentOf = (score: number) => `${Math.round(score * 100)}%`;

/** "/JOJO的奇妙冒險" for "/JOJO的奇妙冒險/JOJO Lands"; null at the top level. */
export const parentOf = (path: string) => path.lastIndexOf('/') > 0 ? path.slice(0, path.lastIndexOf('/')) : null;

/** The job works on this folder right now (`current` names the folder's path, or its name). */
export const isCurrent = (job: LibraryJob | undefined, folder: LibraryFolder) =>
  !!job?.running && job.targetId === folder.targetId && !!job.current && (job.current === folder.path || job.current === folder.name);

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>;
export function tally(folders: LibraryFolder[]): LibraryCounts {
  const counts: LibraryCounts = { folders: folders.length, books: 0, kmoe: zero(KmoeLinkState.options), bangumi: zero(BangumiState.options), komga: zero(KomgaState.options) };
  for (const folder of folders) {
    counts.books += folder.books;
    counts.kmoe[folder.kmoe.state]++;
    counts.bangumi[folder.metadata.bangumi.state]++;
    counts.komga[folder.metadata.komga.state]++;
  }
  return counts;
}

/** A folder changed (link, ignore, Bangumi, sync): show it at once; the server's `folders` event refetches the rest. */
export function applyFolder(client: QueryClient, folder: LibraryFolder) {
  client.setQueryData(libraryQuery(folder.targetId).queryKey, (old: LibraryOverview | undefined) => {
    if (!old) return old;
    const folders = old.folders.map(f => f.id === folder.id ? folder : f);
    return { ...old, folders, counts: tally(folders) };
  });
  // The folder's comic (and a comic it was just unlinked from) and the shelf follow the link.
  for (const queryKey of [['comic'], ['shelf']]) void client.invalidateQueries({ queryKey });
}

/** A job was accepted: every cached overview shows it until the live events take over. */
export const applyJob = (client: QueryClient, job: LibraryJob) =>
  client.setQueriesData<LibraryOverview>({ queryKey: ['library'] }, old => old && { ...old, job });

/**
 * Why Bangumi cannot be queried right now with the chosen source (online API unreachable at the last check,
 * offline data not imported), or null. An unchecked online API counts as usable.
 */
export function bangumiBlocked(bangumi: MetadataSettings['bangumi'] | undefined): string | null {
  if (!bangumi) return null;
  // A previously imported dump keeps serving while a newer one downloads or imports (or after a failed update).
  const offline = bangumi.online.reachable === false, noArchive = !bangumi.archive.importedAt || bangumi.archive.subjects === 0;
  if (bangumi.source === 'online' && offline) return '连不上 Bangumi';
  if (bangumi.source === 'archive' && noArchive) return '离线数据还没准备好';
  if (bangumi.source === 'auto' && offline && noArchive) return '连不上 Bangumi，离线数据也还没准备好';
  return null;
}

/** Search and link-by-search need a Kmoe login (409 from the server). */
export const needsKmoeLogin = (error: unknown) => error instanceof ApiError && error.status === 409 && /kmoe/i.test(error.code);
