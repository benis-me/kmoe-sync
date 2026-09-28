import { expect, it } from 'bun:test';
import { countBy, needsAttention, passes, statusOf } from '@shared/folder-status';
import type { LibraryFolder } from '@shared/model';

const folder = (kmoe: string, bangumi = 'none', komga = 'pending', dirty = false) =>
  ({ kmoe: { state: kmoe }, metadata: { bangumi: { state: bangumi }, komga: { state: komga, dirty } } }) as unknown as LibraryFolder;

it('reads Komga the way the row shows it, and skips stages that do not apply', () => {
  expect(statusOf(folder('matched', 'suggested', 'pending'), 'komga')).toBe('waiting');
  expect(statusOf(folder('matched', 'matched', 'pending'), 'komga')).toBe('pending');
  expect(statusOf(folder('matched', 'matched', 'synced', true), 'komga')).toBe('pending');
  expect(statusOf(folder('matched', 'matched', 'synced'), 'komga')).toBe('synced');
  expect(statusOf(folder('matched', 'matched', 'error', true), 'komga')).toBe('error');
  expect(statusOf(folder('matched', 'matched', 'disabled'), 'komga')).toBeNull();
  expect(statusOf(folder('ignored', 'unmatched'), 'bangumi')).toBeNull();
  expect(countBy([folder('matched', 'matched', 'error'), folder('matched', 'matched', 'error', true), folder('ignored')], 'komga')).toEqual({ error: 2 });
});

it('待处理 is what waits for the user (metadata only while shown), and stage filters combine', () => {
  expect(needsAttention(folder('suggested'), false)).toBe(true);
  expect(needsAttention(folder('matched', 'unmatched'), false)).toBe(false);
  expect(needsAttention(folder('matched', 'unmatched'), true)).toBe(true);
  expect(needsAttention(folder('matched', 'matched', 'not_found'), true)).toBe(true);
  expect(needsAttention(folder('matched', 'matched', 'pending'), true)).toBe(false);
  expect(needsAttention(folder('ignored', 'unmatched'), true)).toBe(false);
  const linked = folder('matched', 'unmatched');
  expect(passes(linked, { kmoe: 'matched', bangumi: 'unmatched' }, true)).toBe(true);
  expect(passes(linked, { kmoe: 'matched', bangumi: 'matched' }, true)).toBe(false);
  expect(passes(linked, { kmoe: 'matched', bangumi: 'matched' }, true, 'bangumi')).toBe(true);
  expect(passes(linked, { todo: true }, false)).toBe(false);
});
