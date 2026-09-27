import { useEffect, useState, useSyncExternalStore } from 'react';

/** True once `ms` have passed, so fast loads never flash a skeleton. */
export function useDelayed(ms = 200) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return shown;
}

/** The current time, refreshed every `ms` (countdowns, "3 分钟前"). */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    listener => { const list = matchMedia(query); list.addEventListener('change', listener); return () => list.removeEventListener('change', listener); },
    () => matchMedia(query).matches,
  );
}

export function useDebounced<T>(value: T, ms = 400) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
