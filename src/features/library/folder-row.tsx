// One series folder in the 书库 list: the folder, its Kmoe link, its Bangumi/Komga metadata and a menu.
// Memoized: rows only re-render when their folder (kept stable by structural sharing), pending action or job focus change.
import { memo, useRef, type CSSProperties, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, BookOpen, Check, CircleDashed, Ellipsis, EyeOff, FilePen, Folder, Link2, LoaderCircle, RefreshCw, RotateCcw, SearchX, Sparkles, Tags, Undo2 } from 'lucide-react';
import { cn } from 'cn';
import { statusOf } from '@shared/folder-status';
import type { AiVerdict, LibraryFolder } from '@shared/model';
import { FORMAT_LABELS, fromNow } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Cover } from '@/components/app/cover';
import { Dot } from '@/components/app/status';
import { bestOf, bestScore, parentOf, percentOf } from './state';

export type FolderAction = { folder: LibraryFolder; action: 'confirm'; comic: string } | { folder: LibraryFolder; action: 'ignore' | 'reset' | 'sync' };
/** `opener` gets focus back when the dialog closes (the row's menu button when it was a menu item). */
export type RowHandlers = {
  act: (action: FolderAction) => void; link: (folder: LibraryFolder, opener: HTMLElement | null) => void; pickBangumi: (folder: LibraryFolder, opener: HTMLElement | null) => void;
  rename: (folder: LibraryFolder, opener: HTMLElement | null) => void;
};

const thumb = 'w-7 shrink-0 rounded-[5px]';
/** Stand-in for a cover when there is no comic: same size, so every state keeps the row height. */
const Slot = ({ children }: { children: ReactNode }) =>
  <span aria-hidden className={cn(thumb, 'grid aspect-[3/4] place-items-center border border-dashed border-muted-foreground/35 text-muted-foreground [&_svg]:size-3.5')}>{children}</span>;
const Lines = ({ title, sub, className }: { title: ReactNode; sub: ReactNode; className?: string }) => <span className={cn('flex min-w-0 flex-1 flex-col', className)}>
  <span className="truncate text-[13px] leading-5 font-medium">{title}</span>
  <span className="-my-0.5 flex min-w-0 items-center gap-1.5 truncate py-0.5 text-xs leading-5 text-muted-foreground">{sub}</span>
</span>;
const inlineAction = 'rounded-sm font-medium text-foreground/80 underline decoration-foreground/25 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring';

/** The AI's verdict on a folder's candidates: a small mark, with how sure and why in a tooltip. */
function AiNote({ verdict }: { verdict: AiVerdict }) {
  return <Tooltip>
    <TooltipTrigger asChild>
      <span tabIndex={0} className="inline-flex shrink-0 cursor-default items-center gap-0.5 rounded-sm text-seal outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Sparkles aria-hidden className="size-3" />AI 推荐<span className="sr-only">：{verdict.reason}</span>
      </span>
    </TooltipTrigger>
    <TooltipContent className="max-w-72">把握 {percentOf(verdict.confidence)}：{verdict.reason}</TooltipContent>
  </Tooltip>;
}

function KmoeCell({ folder, pending, busy, handlers }: { folder: LibraryFolder; pending: FolderAction['action'] | null; busy: boolean; handlers: RowHandlers }) {
  const { kmoe } = folder;
  // The AI's pick when it made one, else the most similar title.
  const best = kmoe.candidates.find(c => c.key === kmoe.ai?.pick) ?? bestOf(kmoe.candidates);
  const error = kmoe.error && <span className="truncate text-destructive" title={kmoe.error}>{kmoe.error}</span>;
  if (kmoe.state === 'matched' && kmoe.comic) {
    const { comic } = kmoe;
    return <Link to="/comics/$key" params={{ key: comic.key }} search={{ targetId: folder.targetId }}
      className="group/comic -m-1 flex min-w-0 items-center gap-2.5 rounded-lg p-1 outline-none transition-colors duration-150 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring">
      <Cover src={comic.cover} title={comic.title} className={thumb} />
      <Lines title={<><span className="sr-only">已关联 </span>{comic.title}</>} sub={error || [comic.authors.join(' / '), comic.latest && `最新 ${comic.latest}`].filter(Boolean).join(' · ') || '已关联'} />
    </Link>;
  }
  if (kmoe.state === 'suggested' && best) {
    return <div className="flex min-w-0 items-center gap-2.5">
      <Cover src={best.cover} title={best.title} className={cn(thumb, 'opacity-90')} />
      <Lines title={best.title} sub={<>
        {kmoe.ai?.pick === best.key ? <AiNote verdict={kmoe.ai} /> : <span className="text-warning">建议</span>}<span aria-hidden>·</span><span className="tabular-nums">匹配 {percentOf(bestScore(folder))}</span><span aria-hidden>·</span>
        <button type="button" className={inlineAction} onClick={e => handlers.link(folder, e.currentTarget)}>{kmoe.candidates.length > 1 ? `其他 ${kmoe.candidates.length - 1} 个候选…` : '其他候选…'}</button>
      </>} />
      <Button variant="outline" size="xs" aria-disabled={!!pending} aria-label={`确认关联《${best.title}》`} onClick={() => { if (!pending) handlers.act({ folder, action: 'confirm', comic: best.key }); }}>
        {pending === 'confirm' ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Check data-icon="inline-start" />}确认
      </Button>
    </div>;
  }
  if (kmoe.state === 'unmatched') return <div className="flex min-w-0 items-center gap-2.5">
    <Slot><SearchX /></Slot>
    <Lines title={<span className="font-normal text-muted-foreground">Kmoe 上没有找到</span>} sub={error || (kmoe.ai ? `AI：${kmoe.ai.reason}` : '换个写法搜索，或粘贴链接')} />
    <Button variant="outline" size="xs" onClick={e => handlers.link(folder, e.currentTarget)}><Link2 data-icon="inline-start" />手动关联…</Button>
  </div>;
  if (kmoe.state === 'ignored') return <div className="flex min-w-0 items-center gap-2.5">
    <Slot><EyeOff /></Slot>
    <Lines title={<span className="font-normal text-muted-foreground">已忽略</span>} sub="不会出现在书架，也不参与匹配" />
    <Button variant="ghost" size="xs" className="text-muted-foreground" aria-disabled={!!pending} onClick={() => { if (!pending) handlers.act({ folder, action: 'reset' }); }}>
      {pending === 'reset' ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Undo2 data-icon="inline-start" />}恢复
    </Button>
  </div>;
  // pending (never matched yet)
  return <div className="flex min-w-0 items-center gap-2.5">
    <Slot>{busy ? <LoaderCircle className="animate-spin text-seal" /> : <CircleDashed />}</Slot>
    <Lines title={<span className={cn('font-normal', busy ? 'text-foreground' : 'text-muted-foreground')}>{busy ? '正在匹配…' : '待匹配'}</span>}
      sub={error || (folder.hint && folder.hint !== folder.name ? `将按「${folder.hint}」查找` : '还没有在 Kmoe 上查找')} />
  </div>;
}

function BangumiLine({ folder, onPick }: { folder: LibraryFolder; onPick: (opener: HTMLElement) => void }) {
  const { state, subject, candidates, source, ai } = folder.metadata.bangumi;
  if (state === 'matched' && subject) return <a href={subject.url} target="_blank" rel="noreferrer" title={`${subject.name}${source ? ` · ${{ auto: '自动匹配', manual: '手动选择', komga: '来自 Komga', ai: `AI 判定：${ai?.reason ?? ''}` }[source]}` : ''}`}
    className="flex min-w-0 items-center gap-1 rounded-sm outline-none hover:underline hover:decoration-foreground/30 hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring">
    <span className="truncate">{subject.nameCn || subject.name}</span><ArrowUpRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
  </a>;
  if (state === 'suggested' || state === 'unmatched') return <button type="button" onClick={e => onPick(e.currentTarget)} title={ai ? `AI（把握 ${percentOf(ai.confidence)}）：${ai.reason}` : undefined}
    className={cn('flex min-w-0 items-center gap-1.5 rounded-sm text-left outline-none hover:underline hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring', state === 'suggested' ? 'text-warning' : 'text-muted-foreground')}>
    <Dot tone={state === 'suggested' ? 'warning' : 'muted'} className="size-1.5" />
    <span className="truncate">{state === 'suggested' ? `${ai?.pick ? 'AI 推荐' : '待确认'} · ${candidates.length} 个候选` : ai ? 'AI 也没找到 · 手动选择' : '未找到 · 手动选择'}</span>
  </button>;
  return <span className="text-muted-foreground">未匹配</span>;
}

function KomgaLine({ folder }: { folder: LibraryFolder }) {
  const { syncedAt, seriesUrl, error } = folder.metadata.komga;
  const status = statusOf(folder, 'komga');
  if (status === 'waiting') return <span className="text-muted-foreground" title="选好 Bangumi 条目后才能同步">—</span>;
  if (status === 'error') return <Tooltip>
    <TooltipTrigger asChild>
      <span tabIndex={0} className="flex min-w-0 cursor-default items-center gap-1.5 rounded-sm text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Dot tone="destructive" className="size-1.5" /><span className="truncate">同步失败</span><span className="sr-only">：{error}</span>
      </span>
    </TooltipTrigger>
    <TooltipContent className="max-w-72">{error ?? '写入 Komga 失败'}</TooltipContent>
  </Tooltip>;
  if (status === 'not_found') return <span className="flex min-w-0 items-center gap-1.5 text-warning" title="Komga 里还没有这个文件夹的系列：先让 Komga 扫描书库，再同步。">
    <Dot tone="warning" className="size-1.5" /><span className="truncate">未找到系列</span>
  </span>;
  if (status === 'pending') return <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground"><Dot tone="muted" className="size-1.5" />待同步</span>;
  const text = <><Dot tone="muted" className="size-1.5" /><span className="truncate">已同步{syncedAt && ` · ${fromNow(syncedAt)}`}</span></>;
  return seriesUrl ? <a href={seriesUrl} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1.5 rounded-sm outline-none hover:underline hover:decoration-foreground/30 hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring">
    {text}<ArrowUpRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
  </a> : <span className="flex min-w-0 items-center gap-1.5">{text}</span>;
}

export const FolderRow = memo(function FolderRow({ folder, index, pending, busy, meta, handlers }: {
  folder: LibraryFolder;
  index: number;
  /** An action on this folder is in flight. */
  pending: FolderAction['action'] | null;
  /** The running job is working on this folder. */
  busy: boolean;
  /** Show the Bangumi/Komga column. */
  meta: boolean;
  handlers: RowHandlers;
}) {
  const parent = parentOf(folder.path);
  const menu = useRef<HTMLButtonElement>(null);
  const { kmoe, metadata } = folder;
  const komga = metadata.komga.state !== 'disabled';
  const syncable = komga && metadata.bangumi.state === 'matched';
  return <li style={{ '--i': index } as CSSProperties}
    className={cn('stagger grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 px-4 py-3 sm:px-5',
      meta ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_auto]' : 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto]',
      kmoe.state === 'ignored' && 'bg-muted/30')}>
    <div className="flex min-w-0 items-start gap-3">
      <Folder aria-hidden className={cn('mt-0.5 size-4 shrink-0', kmoe.state === 'ignored' ? 'text-muted-foreground/60' : 'text-muted-foreground')} />
      <div className="flex min-w-0 flex-col">
        <span className={cn('truncate font-medium', kmoe.state === 'ignored' && 'text-muted-foreground')} title={folder.sample ? `${folder.path}\n例如 ${folder.sample}` : folder.path}>{folder.name}</span>
        <span className="truncate text-xs text-muted-foreground tabular-nums">
          {parent && <><span className="font-mono text-[11px]">{parent}/</span> · </>}{folder.books} 本{folder.format && ` · ${FORMAT_LABELS[folder.format]}`}
        </span>
      </div>
    </div>

    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button ref={menu} data-folder-menu={folder.id} variant="ghost" size="icon-sm" className="text-muted-foreground lg:order-last" aria-label={`更多操作：${folder.name}`}><Ellipsis /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {kmoe.comic && <>
          <DropdownMenuItem asChild><Link to="/comics/$key" params={{ key: kmoe.comic.key }} search={{ targetId: folder.targetId }}><BookOpen />打开漫画</Link></DropdownMenuItem>
          <DropdownMenuItem onSelect={() => handlers.rename(folder, menu.current)}><FilePen />整理文件名…</DropdownMenuItem>
        </>}
        <DropdownMenuItem onSelect={() => handlers.link(folder, menu.current)}><Link2 />{kmoe.state === 'matched' ? '更换 Kmoe 漫画…' : '关联 Kmoe 漫画…'}</DropdownMenuItem>
        {kmoe.state !== 'pending' && <DropdownMenuItem onSelect={() => handlers.act({ folder, action: 'reset' })}>
          {kmoe.state === 'ignored' ? <><Undo2 />恢复</> : <><RotateCcw />重新匹配</>}
        </DropdownMenuItem>}
        {kmoe.state !== 'ignored' && <DropdownMenuItem onSelect={() => handlers.act({ folder, action: 'ignore' })}><EyeOff />忽略</DropdownMenuItem>}
        {meta && <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => handlers.pickBangumi(folder, menu.current)}><Tags />选择 Bangumi 条目…</DropdownMenuItem>
          {syncable && <DropdownMenuItem onSelect={() => handlers.act({ folder, action: 'sync' })}><RefreshCw />同步到 Komga</DropdownMenuItem>}
        </>}
      </DropdownMenuContent>
    </DropdownMenu>

    <div className="col-span-2 min-w-0 pl-7 lg:col-span-1 lg:pl-0">
      <KmoeCell folder={folder} pending={pending} busy={busy} handlers={handlers} />
    </div>

    {meta && kmoe.state === 'ignored' && <span aria-hidden className="max-lg:hidden" />}
    {meta && kmoe.state !== 'ignored' && <dl className="col-span-2 grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 pl-7 text-xs leading-5 lg:col-span-1 lg:pl-0">
      <dt className="text-muted-foreground">Bangumi</dt>
      <dd className="col-span-2 min-w-0"><BangumiLine folder={folder} onPick={opener => handlers.pickBangumi(folder, opener)} /></dd>
      {komga && <>
        <dt className="text-muted-foreground">Komga</dt>
        <dd className="min-w-0"><KomgaLine folder={folder} /></dd>
        <dd className="-my-1">{syncable && <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={`同步「${folder.name}」到 Komga`} aria-disabled={!!pending}
          onClick={() => { if (!pending) handlers.act({ folder, action: 'sync' }); }}>
          <RefreshCw className={cn(pending === 'sync' && 'animate-spin')} />
        </Button>}</dd>
      </>}
    </dl>}
  </li>;
});
