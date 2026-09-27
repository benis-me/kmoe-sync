// Light / dark: the choice made with the sidebar switch (kept in this browser), else the system theme (see index.html).
import { useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark';
const root = document.documentElement;
const current = (): Theme => root.dataset.theme === 'dark' ? 'dark' : 'light';
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

export function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(subscribe, current);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('kmoesync.theme', next); } catch { /* not kept (private mode) */ }
    // Swap in one frame, without every color transition on the page animating at once.
    root.classList.add('theme-switching');
    root.dataset.theme = next;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  };
  return [theme, toggle];
}
