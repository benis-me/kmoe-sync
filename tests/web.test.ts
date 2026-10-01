// Web app logic that needs no browser: live task updates patching the cached task lists.
import { expect, test } from 'bun:test';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { Task, TaskList } from '@shared/model';
import { patchTask } from '@/lib/queries';

const task = (id: number, status: Task['status'] = 'queued', extra: Partial<Task> = {}) => ({ id, status, comicKey: 'k1', ...extra }) as Task;
const list = (...pages: number[][]): InfiniteData<TaskList> =>
  ({ pages: pages.map(ids => ({ tasks: ids.map(id => task(id)), nextCursor: null }) as unknown as TaskList), pageParams: pages.map((_, i) => i) });
const ids = (client: QueryClient, key: unknown[]) => client.getQueryData<InfiniteData<TaskList>>(key)!.pages.map(page => page.tasks.map(t => t.id));

test('a task update is replaced in place, leaves the lists it no longer fits, and is inserted by id where it now fits', () => {
  const client = new QueryClient();
  const all = ['tasks', {}], queued = ['tasks', { status: 'queued' }], other = ['tasks', { comicKey: 'k2' }];
  client.setQueryData(all, list([9, 7], [5, 3]));
  client.setQueryData(queued, list([9, 7], [5, 3]));
  client.setQueryData(other, list([]));

  // Progress on a listed task: patched where it is, nothing for the server to recount.
  expect(patchTask(client, task(5, 'queued', { loaded: 10 }))).toBe(false);
  expect(client.getQueryData<InfiniteData<TaskList>>(all)!.pages[1]!.tasks[0]!.loaded).toBe(10);
  // 7 finished: still in "all", gone from "queued".
  expect(patchTask(client, task(7, 'completed'))).toBe(true);
  expect(ids(client, all)).toEqual([[9, 7], [5, 3]]);
  expect(ids(client, queued)).toEqual([[9], [5, 3]]);
  // New tasks go on the first page in id order (newest first), only into lists they fit.
  expect(patchTask(client, task(8))).toBe(true);
  expect(patchTask(client, task(10))).toBe(true);
  expect(ids(client, all)).toEqual([[10, 9, 8, 7], [5, 3]]);
  expect(ids(client, queued)).toEqual([[10, 9, 8], [5, 3]]);
  expect(ids(client, other)).toEqual([[]]);
});
