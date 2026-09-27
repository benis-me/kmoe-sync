// Folder picker over POST /api/targets/browse (a saved target or an unsaved draft). Ported from the extension.
import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ChevronRight, CornerLeftUp, File, Folder, FolderOpen, LoaderCircle } from 'lucide-react';
import { cn } from 'cn';
import type { DirEntry, TargetInput } from '@shared/model';
import { normalizePath } from '@shared/naming';
import { errorMessage, request } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Loading, Notice } from '@/components/app/feedback';

/**
 * `root` names where paths start (书库根目录 or the WebDAV host); `opener` gets focus back on close.
 * `apply` may return a promise: the dialog stays open (busy) until it settles and shows a rejection inline.
 */
export type BrowseTarget = {
  ref: { targetId?: number; draft?: TargetInput }; name: string; root: string; path: string;
  apply: (path: string) => void | Promise<unknown>;
  opener?: HTMLElement | null; title?: string; description?: string; action?: string;
};

const row = 'flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm outline-none transition-colors duration-150 hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring';

/** Mount one per opened target (keyed), so nothing leaks between targets. */
export function DirectoryBrowser({ target, onClose }: { target: BrowseTarget; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  const [path, setPath] = useState(target.path);
  const [listing, setListing] = useState<{ path: string; entries: DirEntry[] } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const run = useRef(0);
  const list = useRef<HTMLDivElement>(null);

  async function browse(raw: string) {
    const token = ++run.current; // only the latest request may update the view
    setBusy(true); setError('');
    try {
      const next = await request('POST /api/targets/browse', { body: { ref: target.ref, path: normalizePath(raw) } });
      if (token !== run.current) return;
      // The clicked row or crumb is replaced by the new listing: keep keyboard focus in the list.
      const refocus = !!(document.activeElement as HTMLElement | null)?.closest('[data-refocus]');
      flushSync(() => { setPath(next.path); setListing(next); });
      if (refocus) (list.current?.querySelector('button') ?? document.getElementById('browse-path'))?.focus();
    } catch (e) {
      if (token === run.current) setError(errorMessage(e));
    } finally {
      if (token === run.current) setBusy(false);
    }
  }
  useEffect(() => {
    void browse(target.path);
    return () => { run.current++; };
  }, []); // once per mounted browser; later navigation goes through browse()

  const folders = useMemo(() => (listing?.entries ?? []).filter(e => e.directory), [listing]);
  const files = listing ? listing.entries.length - folders.length : 0;
  const crumbs = listing ? ['/', ...listing.path.split('/').filter(Boolean).map((_, i, all) => `/${all.slice(0, i + 1).join('/')}`)] : [];
  const ready = !!listing && !busy && path === listing.path;
  const close = () => { setOpen(false); setTimeout(onClose, 200); };
  async function use() {
    if (!listing || applying) return;
    const result = target.apply(listing.path);
    if (!(result instanceof Promise)) { close(); return; }
    setApplying(true); setError('');
    try { await result; close(); } catch (e) { setError(errorMessage(e)); } finally { setApplying(false); }
  }

  return <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
    {/* Opened from code, not a DialogTrigger, so Radix has nothing to return focus to by itself. */}
    <DialogContent className="flex h-[min(600px,calc(100dvh-32px))] flex-col gap-4 sm:max-w-xl"
      onCloseAutoFocus={e => { if (target.opener?.isConnected) { e.preventDefault(); target.opener.focus(); } }}>
      <DialogHeader className="pr-8">
        <DialogTitle className="flex items-center gap-2">{target.title ?? '选择目录'}{busy && listing && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}</DialogTitle>
        <DialogDescription>{target.description ?? `${target.name} · ${target.root}`}</DialogDescription>
      </DialogHeader>

      <form onSubmit={e => { e.preventDefault(); void browse(path); }}>
        <label htmlFor="browse-path" className="sr-only">目录路径</label>
        <InputGroup>
          <InputGroupInput id="browse-path" className="font-mono md:text-[13px]" value={path} onChange={e => setPath(e.target.value)} spellCheck={false} autoCapitalize="none" />
          <InputGroupAddon align="inline-end"><InputGroupButton type="submit" disabled={busy}>打开</InputGroupButton></InputGroupAddon>
        </InputGroup>
      </form>

      {crumbs.length > 0 && <nav data-refocus aria-label="当前位置" className="-mt-1 min-w-0">
        <ol className="flex flex-wrap items-center gap-0.5 text-[13px]">
          {crumbs.map((crumb, i) => {
            const name = i === 0 ? '根目录' : crumb.slice(crumb.lastIndexOf('/') + 1);
            return <li key={crumb} className="flex min-w-0 items-center gap-0.5">
              {i > 0 && <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />}
              {i === crumbs.length - 1
                ? <span aria-current="page" className="truncate px-1.5 font-medium">{name}</span>
                : <button type="button" className="truncate rounded-md px-1.5 py-0.5 text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void browse(crumb)}>{name}</button>}
            </li>;
          })}
        </ol>
      </nav>}

      {error && <Notice tone="error">{error}</Notice>}

      <div ref={list} data-refocus role="group" aria-label="目录列表" aria-busy={busy} className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-xl bg-card p-1 ring-1 ring-border">
        {!listing
          ? busy && <Loading label="正在读取目录…">
            <div className="flex flex-col gap-1 p-1">{[72, 56, 64, 48].map(w => <div key={w} className="flex h-8 items-center gap-3 px-2"><Skeleton className="size-4 rounded" /><Skeleton className="h-3.5" style={{ width: `${w}%` }} /></div>)}</div>
          </Loading>
          : <div className={cn('flex min-h-full flex-col transition-opacity duration-150', busy && 'opacity-50')}>
            {listing.path !== '/' && <button type="button" className={cn(row, 'text-muted-foreground')} onClick={() => void browse(listing.path.slice(0, listing.path.lastIndexOf('/')) || '/')}>
              <CornerLeftUp className="size-4 shrink-0" />上一级
            </button>}
            {folders.map(entry => <button key={entry.path} type="button" className={cn(row, 'group')} onClick={() => void browse(entry.path)}>
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform duration-150 ease-out-strong group-hover:translate-x-0.5" />
            </button>)}
            {files > 0 && <p className="flex h-10 items-center gap-3 px-3 text-xs text-muted-foreground tabular-nums"><File className="size-4 shrink-0" />{files} 个文件{!folders.length && '，没有子目录'}</p>}
            {!listing.entries.length && <Empty className="min-h-40 flex-1 p-6">
              <EmptyHeader><EmptyMedia variant="icon"><FolderOpen /></EmptyMedia><EmptyTitle>空目录</EmptyTitle></EmptyHeader>
            </Empty>}
          </div>}
      </div>

      <DialogFooter className="sm:items-center">
        <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground sm:mr-auto">
          <FolderOpen className="size-3.5 shrink-0" />
          <code className="truncate font-mono text-foreground" title={listing?.path}>{listing?.path ?? '—'}</code>
        </p>
        <Button variant="outline" onClick={close}>取消</Button>
        <Button disabled={!ready} aria-disabled={applying} onClick={() => void use()}>
          {applying && <LoaderCircle data-icon="inline-start" className="animate-spin" />}{target.action ?? '使用此目录'}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
