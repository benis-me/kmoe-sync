// Pure helpers for the chapter grid (ported from the extension's panel logic).
import { CONTENT_LABELS, type ContentType, type Item, type ItemState } from '@shared/model';
import type { Selection } from '@/lib/selection';

const TYPE_ORDER: ContentType[] = ['volume', 'extra', 'serial'];

/** Items that can be queued: not on disk yet, and not already queued or downloading. */
export const isSelectable = (state: ItemState | undefined) => !state || state === 'missing' || state === 'failed' || state === 'unknown';
/** 缺失: known not to be in the library. */
export const isMissing = (state: ItemState | undefined) => !state || state === 'missing' || state === 'failed';

export type Group = { type: ContentType; label: string; items: Item[] };
export function groupItems(items: Item[]): Group[] {
  return TYPE_ORDER.map(type => ({
    type, label: CONTENT_LABELS[type],
    items: items.filter(item => item.type === type).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true })),
  })).filter(group => group.items.length);
}

/**
 * Toggle `id`; with `range`, every id between the anchor and `id` (in `order`) follows the clicked item's new state.
 * Falls back to a single toggle when the anchor is no longer in `order` (filtered out, collapsed).
 */
export function toggleRange(selection: Selection, order: string[], id: string, anchor: string | null, range: boolean): Selection {
  const on = !selection.has(id);
  const from = range && anchor ? order.indexOf(anchor) : -1, to = order.indexOf(id);
  const ids = from >= 0 && to >= 0 ? order.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
  const next = new Set(selection);
  for (const item of ids) if (on) next.add(item); else next.delete(item);
  return next;
}

/** Group checkbox: select all, or clear all when every one is already selected. */
export function toggleAll(selection: Selection, ids: string[]): Selection {
  const next = new Set(selection);
  const remove = ids.every(id => next.has(id));
  for (const id of ids) if (remove) next.delete(id); else next.add(id);
  return next;
}

/** The tile in the next (dir 1) or previous (-1) visual row closest to the current column; rows can span groups. */
export function rowNeighbour(grid: HTMLElement | null, order: string[], at: number, dir: 1 | -1) {
  const find = (id: string) => grid?.querySelector<HTMLElement>(`[data-item="${CSS.escape(id)}"]`);
  const from = find(order[at] ?? '')?.getBoundingClientRect();
  if (!from) return;
  let best: HTMLElement | undefined, row: number | undefined, gap = Infinity;
  for (let i = at + dir; i >= 0 && i < order.length; i += dir) {
    const el = find(order[i]!);
    const box = el?.getBoundingClientRect();
    if (!el || !box || dir * (box.top - from.top) < 1) continue; // same row
    if (row === undefined) row = box.top;
    else if (Math.abs(box.top - row) >= 1) break; // past the neighbouring row
    const distance = Math.abs(box.left - from.left);
    if (distance < gap) { gap = distance; best = el; }
  }
  return best;
}
