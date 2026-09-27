// Server state: query definitions shared by routes and components, and the live (SSE) cache updates.
import { infiniteQueryOptions, queryOptions, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import type { Format, LibraryOverview, Task, TaskList, TaskStatus } from '@shared/model';
import { request, setCsrf, subscribeEvents } from '@/lib/api';

type View = { targetId?: number; format?: Format };
type TaskFilter = { status?: TaskStatus; comicKey?: string };

export const authQuery = queryOptions({
  queryKey: ['auth'],
  queryFn: async ({ signal }) => {
    const state = await request('GET /api/auth/state', { signal });
    setCsrf(state.csrf);
    return state;
  },
  staleTime: Infinity,
});

export const statusQuery = queryOptions({ queryKey: ['status'], queryFn: ({ signal }) => request('GET /api/status', { signal }) });
export const shelfQuery = queryOptions({ queryKey: ['shelf'], queryFn: ({ signal }) => request('GET /api/shelf', { signal }) });
export const activityQuery = queryOptions({ queryKey: ['activity'], queryFn: ({ signal }) => request('GET /api/activity', { query: { limit: 30 }, signal }) });
export const targetsQuery = queryOptions({ queryKey: ['targets'], queryFn: ({ signal }) => request('GET /api/targets', { signal }) });
export const settingsQuery = queryOptions({ queryKey: ['settings'], queryFn: ({ signal }) => request('GET /api/settings', { signal }) });
export const mirrorsQuery = queryOptions({ queryKey: ['mirrors'], queryFn: ({ signal }) => request('GET /api/kmoe/mirrors', { signal }), staleTime: 60 * 60_000 });
export const sourcesQuery = queryOptions({ queryKey: ['sources'], queryFn: ({ signal }) => request('GET /api/sources', { signal }) });
export const sourceItemsQuery = (id: number) => queryOptions({
  queryKey: ['sources', id, 'items'],
  queryFn: ({ signal }) => request('GET /api/sources/:id/items', { params: { id }, signal }),
});

export const metadataSettingsQuery = queryOptions({ queryKey: ['metadata-settings'], queryFn: ({ signal }) => request('GET /api/metadata/settings', { signal }) });
export const aboutQuery = queryOptions({ queryKey: ['about'], queryFn: ({ signal }) => request('GET /api/about', { signal }) });
export const aiSettingsQuery = queryOptions({ queryKey: ['ai-settings'], queryFn: ({ signal }) => request('GET /api/ai/settings', { signal }) });
/** AI-tidied summaries and tags of a target's folders, for review before they go to Komga. */
export const aiPolishQuery = (targetId: number) => queryOptions({
  queryKey: ['ai-polish', targetId], queryFn: ({ signal }) => request('GET /api/library/ai-polish', { query: { targetId }, signal }),
});
/** Series folders of one target with their link/metadata state and the (global) library job. */
export const libraryQuery = (targetId: number) => queryOptions({
  queryKey: ['library', targetId],
  queryFn: ({ signal }) => request('GET /api/library', { query: { targetId }, signal }),
});

export const searchQuery = (q: string, page: number) => queryOptions({
  queryKey: ['search', q, page],
  queryFn: ({ signal }) => request('GET /api/search', { query: { q, page }, signal }),
  staleTime: 5 * 60_000,
});

/** Keeps the previous view on screen while another target/format of the same comic loads. */
export const comicQuery = (key: string, view: View) => queryOptions({
  queryKey: ['comic', key, view],
  queryFn: ({ signal }) => request('GET /api/comics/:key', { params: { key }, query: view, signal }),
  placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === key ? previous : undefined,
});

export const tasksQuery = (filter: TaskFilter) => infiniteQueryOptions({
  queryKey: ['tasks', filter],
  queryFn: ({ pageParam, signal }) => request('GET /api/tasks', { query: { ...filter, cursor: pageParam, limit: 40 }, signal }),
  initialPageParam: undefined as number | undefined,
  getNextPageParam: (last: TaskList) => last.nextCursor ?? undefined,
});

/**
 * Apply one task update to every cached task list: replace it, drop it from lists it no longer fits,
 * or insert it where it now belongs. Returns true when a list's membership or a status changed.
 */
function patchTask(client: QueryClient, task: Task): boolean {
  let changed = false;
  for (const query of client.getQueryCache().findAll({ queryKey: ['tasks'] })) {
    const filter = query.queryKey[1] as TaskFilter;
    const fits = (!filter.status || filter.status === task.status) && (!filter.comicKey || filter.comicKey === task.comicKey);
    client.setQueryData<InfiniteData<TaskList>>(query.queryKey, data => {
      if (!data) return data;
      const old = data.pages.flatMap(page => page.tasks).find(t => t.id === task.id);
      if (old && old.status !== task.status) changed = true;
      if (!old && !fits) return data;
      if (!old || !fits) changed = true;
      const pages = data.pages.map(page => ({ ...page, tasks: page.tasks.flatMap(t => t.id !== task.id ? [t] : fits ? [task] : []) }));
      if (!old && pages[0]) {
        const list = pages[0].tasks, at = list.findIndex(t => t.id < task.id);
        pages[0] = { ...pages[0], tasks: at < 0 ? [...list, task] : [...list.slice(0, at), task, ...list.slice(at)] };
      }
      return { ...data, pages };
    });
  }
  return changed;
}

/** One SSE connection for the whole app; progress ticks patch caches, structural changes refetch. */
export function connectLive(client: QueryClient, onConnection: (connected: boolean) => void) {
  let opened = false;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const stop = subscribeEvents(event => {
    switch (event.type) {
      case 'task':
        // Counts and page boundaries come from the server: refetch shortly after a status change.
        if (patchTask(client, event.task)) {
          clearTimeout(settle);
          settle = setTimeout(() => void client.invalidateQueries({ queryKey: ['tasks'] }), 800);
        }
        break;
      case 'status':
        client.setQueryData(statusQuery.queryKey, event.status);
        break;
      case 'activity':
        client.setQueryData(activityQuery.queryKey, old => old && [event.activity, ...old.filter(a => a.id !== event.activity.id)].slice(0, 50));
        break;
      case 'comic':
        void client.invalidateQueries({ queryKey: ['comic', event.key] });
        break;
      case 'shelf':
        void client.invalidateQueries({ queryKey: shelfQuery.queryKey });
        break;
      case 'library': {
        // One job at a time for all targets: every cached overview shows it. When it ends, folders and the shelf changed.
        const ended = !event.job.running && client.getQueriesData<LibraryOverview>({ queryKey: ['library'] }).some(([, data]) => data?.job.running);
        client.setQueriesData<LibraryOverview>({ queryKey: ['library'] }, old => old && { ...old, job: event.job });
        if (ended) for (const queryKey of [['library'], shelfQuery.queryKey]) void client.invalidateQueries({ queryKey });
        break;
      }
      case 'folders':
        void client.invalidateQueries({ queryKey: ['library', event.targetId] });
        break;
      case 'bangumi-archive':
        client.setQueryData(metadataSettingsQuery.queryKey, old => old && { ...old, bangumi: { ...old.bangumi, archive: event.archive } });
        break;
    }
  }, connected => {
    // Back after a gap: anything may have changed meanwhile.
    if (connected && opened) void client.invalidateQueries({ predicate: query => query.queryKey[0] !== 'auth' });
    if (connected) opened = true;
    onConnection(connected);
  });
  return () => { clearTimeout(settle); stop(); };
}
