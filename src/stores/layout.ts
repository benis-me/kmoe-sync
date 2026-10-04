// 宽屏模式: pages use all the room beside the sidebar instead of a centred column. Kept in this browser, like the theme.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useLayout = create<{ wide: boolean; toggleWide: () => void }>()(persist(
  set => ({ wide: false, toggleWide: () => set(state => ({ wide: !state.wide })) }),
  { name: 'kmoesync.layout' },
));
