// The assistant panel: open or closed, and a question to ask as it opens (the 「问问 AI」 buttons elsewhere).
import { create } from 'zustand';

export const useAssistant = create<{ open: boolean; ask: string | null; show: (ask?: string) => void; hide: () => void; asked: () => void }>(set => ({
  open: false,
  ask: null,
  show: ask => set({ open: true, ask: ask ?? null }),
  hide: () => set({ open: false }),
  asked: () => set({ ask: null }),
}));
