import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const UnsavedChanges = createContext<((id: string, dirty: boolean) => void) | null>(null);

/** Form values (including passwords) stay in the forms; the guard keeps only their dirty flags. */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [dirty, setDirty] = useState<Set<string>>(() => new Set());
  const opener = useRef<HTMLElement | null>(null);
  const leaving = useRef(false);
  const register = useCallback((id: string, changed: boolean) => setDirty(old => {
    if (old.has(id) === changed) return old;
    const next = new Set(old);
    if (changed) next.add(id); else next.delete(id);
    return next;
  }), []);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (!dirty.size || current.pathname === next.pathname) return false;
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      leaving.current = false;
      return true;
    },
    enableBeforeUnload: dirty.size > 0,
    withResolver: true,
  });
  useEffect(() => {
    if (!dirty.size && blocker.status === 'blocked') { leaving.current = true; blocker.proceed(); }
  }, [dirty.size, blocker]);

  return <UnsavedChanges.Provider value={register}>
    {children}
    <Dialog open={blocker.status === 'blocked'} onOpenChange={open => { if (!open) blocker.reset?.(); }}>
      <DialogContent onCloseAutoFocus={event => { event.preventDefault(); if (!leaving.current) opener.current?.focus(); }}>
        <DialogHeader>
          <DialogTitle>放弃未保存的更改？</DialogTitle>
          <DialogDescription>离开后，这个分区的未保存内容会丢失。可以继续编辑并保存，或明确放弃后离开。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => blocker.reset?.()}>继续编辑</Button>
          <Button type="button" variant="destructive" onClick={() => { leaving.current = true; blocker.proceed?.(); }}>放弃更改并离开</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </UnsavedChanges.Provider>;
}

export function useUnsavedChanges(dirty: boolean) {
  const register = useContext(UnsavedChanges);
  const id = useId();
  useEffect(() => {
    register?.(id, dirty);
    return () => register?.(id, false);
  }, [register, id, dirty]);
}
