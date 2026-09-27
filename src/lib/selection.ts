// Chapter selection per comic: UI state that survives leaving the page and coming back.
import { useCallback } from 'react';
import { create } from 'zustand';

export type Selection = ReadonlySet<string>;
const EMPTY: Selection = new Set();

const useStore = create<{ byComic: Record<string, Selection>; update: (key: string, next: (old: Selection) => Selection) => void }>(set => ({
  byComic: {},
  update: (key, next) => set(state => ({ byComic: { ...state.byComic, [key]: next(state.byComic[key] ?? EMPTY) } })),
}));

export function useSelection(key: string) {
  const selection = useStore(state => state.byComic[key] ?? EMPTY);
  const update = useStore(state => state.update);
  const setSelection = useCallback((next: (old: Selection) => Selection) => update(key, next), [key, update]);
  return [selection, setSelection] as const;
}
