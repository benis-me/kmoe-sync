import { useState, type SetStateAction } from 'react';

export type SettingsDraft<T> = { draft: T; base: T; remote: string };
const key = (value: unknown) => JSON.stringify(value);

/** Keep edits through optimistic updates, failed saves and background refetches. */
export function receiveDraft<T>(state: SettingsDraft<T>, initial: T): SettingsDraft<T> {
  if (state.remote === key(initial)) return state;
  return key(state.draft) === key(state.base)
    ? { draft: initial, base: initial, remote: key(initial) }
    : { ...state, remote: key(initial) };
}

export function saveDraft<T extends object>(state: SettingsDraft<T>, submitted: T, saved: T): SettingsDraft<T> {
  // A successful save clears secrets too. Keep only edits made after that submission.
  const draft = { ...saved };
  for (const field of Object.keys(state.draft) as (keyof T)[]) {
    if (key(state.draft[field]) !== key(submitted[field])) draft[field] = state.draft[field];
  }
  return { ...state, base: saved, draft };
}

export function useSettingsDraft<T extends object>(initial: T) {
  const [state, setState] = useState<SettingsDraft<T>>(() => ({ draft: initial, base: initial, remote: key(initial) }));
  const current = receiveDraft(state, initial);
  if (current !== state) setState(current);
  const setDraft = (next: SetStateAction<T>) => setState(old => ({ ...old, draft: typeof next === 'function' ? (next as (previous: T) => T)(old.draft) : next }));
  const saved = (submitted: T, value: T) => setState(old => saveDraft(old, submitted, value));
  return { draft: current.draft, setDraft, dirty: key(current.draft) !== key(current.base), saved };
}
