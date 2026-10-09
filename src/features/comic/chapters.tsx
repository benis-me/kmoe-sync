// The chapter grid (ported from the extension): groups with sticky headers and tri-state checkboxes,
// state-aware tiles, Shift ranges, and one tab stop with arrow-key roving, Space, Shift+Space and Ctrl+A.
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { CheckCheck, ChevronDown, CircleCheck, Clock, Folder, FolderSearch, ListChecks, LoaderCircle, RefreshCw, RotateCcw, Search, X } from 'lucide-react';
import { cn } from 'cn';
import type { ContentType, Format, Item, ItemState, ItemStateInfo, LibraryCheck, Task } from '@shared/model';
import { formatMB, fromNow, searchKey } from '@/lib/format';
import { useSelection } from '@/lib/selection';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/app/feedback';
import { groupItems, isMissing, isSelectable, rowNeighbour, toggleAll, toggleRange } from './logic';

const SEAL_CHECK = 'data-checked:border-seal data-checked:bg-seal data-checked:text-seal-foreground dark:data-checked:bg-seal data-indeterminate:border-seal data-indeterminate:bg-seal data-indeterminate:text-seal-foreground';

const TAGS: Record<ItemState, { label: string; dot: string; text: string; reason: string }> = {
  downloaded: { label: '已下载', dot: 'bg-foreground/60', text: 'text-muted-foreground', reason: '已在保存位置找到' },
  missing: { label: '未下载', dot: 'ring-1 ring-inset ring-muted-foreground/70', text: 'text-muted-foreground', reason: '保存位置里还没有这一项' },
  unknown: { label: '待确认', dot: 'bg-warning', text: 'text-warning', reason: '找到了文件，但无法确认是否完整' },
  failed: { label: '失败', dot: 'bg-destructive', text: 'text-destructive', reason: '上次下载失败' },
  queued: { label: '排队中', dot: 'bg-muted-foreground/50', text: 'text-muted-foreground', reason: '已在下载队列中' },
  running: { label: '下载中', dot: 'bg-seal', text: 'text-seal', reason: '正在下载' },
};

function tagLabel(state: ItemState, info: ItemStateInfo | undefined, task: Task | undefined) {
  if (state === 'queued' && info?.reason) return '等待重试';
  if (state !== 'running' || !task) return TAGS[state].label;
  const share = task.total ? Math.floor(task.loaded / task.total * 100) : 0;
  return task.phase === 'uploading' ? `上传中 ${share}%` : task.phase === 'verifying' ? '校验中' : task.phase === 'resolving' ? '准备中' : `下载中 ${share}%`;
}

/** Not a tab stop: the tile's checkbox points at the same text through aria-describedby. */
function StateTag({ id, state, info, task, open, onOpenChange }: { id: string; state: ItemState; info?: ItemStateInfo; task?: Task; open: boolean; onOpenChange: (open: boolean) => void }) {
  const tag = TAGS[state], label = tagLabel(state, info, task), reason = info?.reason || tag.reason, paths = info?.paths ?? [];
  return <Tooltip open={open} onOpenChange={onOpenChange}>
    <TooltipTrigger asChild>
      <span className={cn('inline-flex h-5 shrink-0 cursor-default items-center gap-1 text-[11px] font-medium tabular-nums', state === 'queued' && info?.reason ? 'text-warning' : tag.text)}>
        {state === 'running' ? <LoaderCircle aria-hidden className="size-3 animate-spin" /> : <span aria-hidden className={cn('size-1.5 rounded-full', state === 'queued' && info?.reason ? 'bg-warning' : tag.dot)} />}
        <span aria-hidden>{label}</span>
      </span>
    </TooltipTrigger>
    <TooltipContent side="top" className="block max-w-80">
      <p>{reason}</p>
      {paths.map(path => <p key={path} className="mt-1 font-mono text-[11px] break-all opacity-75">{path}</p>)}
    </TooltipContent>
    <span id={id} hidden>{label}：{reason}{paths.length ? `，${paths.join('、')}` : ''}</span>
  </Tooltip>;
}

function StateIcon({ state, waiting, progress }: { state: ItemState; waiting: boolean; progress: number | null }) {
  if (state === 'downloaded') return <CircleCheck aria-hidden className="mt-px size-[18px] shrink-0 text-foreground/60" />;
  if (state === 'queued') return waiting ? <RotateCcw aria-hidden className="mt-px size-4 shrink-0 text-warning" /> : <Clock aria-hidden className="mt-px size-4 shrink-0 text-muted-foreground" />;
  // Running: a ring that fills with the transfer.
  return <svg aria-hidden viewBox="0 0 20 20" className="mt-px size-[18px] shrink-0 -rotate-90">
    <circle cx="10" cy="10" r="8" fill="none" strokeWidth="2.5" className="stroke-seal/20" />
    <circle cx="10" cy="10" r="8" fill="none" strokeWidth="2.5" strokeLinecap="round" pathLength={100} strokeDasharray="100" strokeDashoffset={100 - (progress ?? 0) * 100}
      className="stroke-seal transition-[stroke-dashoffset] duration-1000 ease-linear" />
  </svg>;
}

const Tile = memo(function Tile({ item, info, task, format, selected, tabbable, index, intro, onToggle, onFocusTile }: {
  item: Item;
  info: ItemStateInfo | undefined;
  task: Task | undefined;
  format: Format;
  selected: boolean;
  tabbable: boolean;
  index: number;
  intro: number;
  onToggle: (id: string, range: boolean) => void;
  onFocusTile: (id: string) => void;
}) {
  // Only tiles present when the page opens take part in the entrance.
  const [stagger] = useState(() => performance.now() < intro);
  const [tip, setTip] = useState(false);
  const state = info?.state ?? 'missing';
  const selectable = isSelectable(state);
  const id = `item-${item.id}`;
  const size = item.sizeMB[format];
  const pages = item.pages ? `${item.pages} 页` : '';
  const progress = state === 'running' && task?.total ? Math.min(1, task.loaded / task.total) : null;
  return <div
    data-selected={selected || undefined}
    style={stagger ? { '--i': index } as CSSProperties : undefined}
    className={cn(
      'group/tile @container relative flex min-w-0 scroll-my-28 flex-col gap-1 overflow-hidden rounded-xl border bg-card px-3 py-2.5 shadow-soft select-none',
      // Picking tiles is the most frequent thing on this page: the colours change at once, and a press is felt (a tile is
      // wider than a button, so it gives less).
      'transition-[scale] duration-150 ease-out-strong',
      'has-[[role=checkbox]:focus-visible]:ring-2 has-[[role=checkbox]:focus-visible]:ring-ring',
      'data-selected:border-seal/50 data-selected:bg-seal-soft/60 data-selected:ring-1 data-selected:ring-seal/25',
      selectable ? 'cursor-pointer hover:border-input active:scale-[0.98] active:duration-75 data-selected:hover:border-seal/70' : 'border-border/70 bg-card/55 shadow-none',
      stagger && 'stagger',
    )}
    onClick={e => { if (selectable) onToggle(item.id, e.shiftKey); }}
  >
    <div className="flex items-start gap-2">
      <span id={`${id}-label`} title={item.name} className={cn('min-w-0 flex-1 truncate text-sm leading-5 font-medium', !selectable && 'text-foreground/80')}>{item.name}</span>
      {item.isNew && <span className="h-5 shrink-0 rounded-full bg-seal-soft px-1.5 text-[11px] leading-5 font-semibold text-seal">新<span className="sr-only">章节</span></span>}
      {selectable ? <Checkbox
        data-item={item.id}
        checked={selected}
        tabIndex={tabbable ? 0 : -1}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-state`}
        // The tile handles the toggle, so Shift+click works on the box as well.
        onClick={e => e.preventDefault()}
        onFocus={e => { onFocusTile(item.id); if (e.currentTarget.matches(':focus-visible')) setTip(true); }}
        onBlur={() => setTip(false)}
        className={cn('mt-px focus-visible:ring-0 focus-visible:ring-offset-0', SEAL_CHECK)}
      /> : <StateIcon state={state} waiting={!!info?.reason} progress={progress} />}
    </div>
    <div className="flex min-h-5 items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
      {/* The page count only where it fits beside the state (a narrow tile would cut it to 「19…」). */}
      <span className="truncate">{size != null ? <>{formatMB(size)}{pages && <span className="hidden @min-[200px]:inline"> · {pages}</span>}</> : pages || '—'}</span>
      <StateTag id={`${id}-state`} state={state} info={info} task={task} open={tip} onOpenChange={setTip} />
    </div>
    {progress !== null && <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-seal/15">
      <span className="block h-full origin-left bg-seal transition-transform duration-1000 ease-linear" style={{ transform: `scaleX(${progress})` }} />
    </span>}
  </div>;
});

function LibrarySummary({ items, states, library, checking, onCheck }: {
  items: Item[]; states: Record<string, ItemStateInfo>; library: LibraryCheck | null; checking: boolean; onCheck: () => void;
}) {
  const count = (...kinds: ItemState[]) => items.filter(item => kinds.includes(states[item.id]?.state ?? 'missing')).length;
  const parts = [
    { label: '已下载', value: count('downloaded'), dot: TAGS.downloaded.dot },
    { label: '缺失', value: count('missing', 'failed'), dot: TAGS.missing.dot },
    { label: '待确认', value: count('unknown'), dot: TAGS.unknown.dot },
    { label: '队列中', value: count('queued', 'running'), dot: TAGS.running.dot },
  ].filter((part, i) => i < 2 || part.value);
  return <div className="flex flex-col gap-1.5 text-xs">
    <div className="flex min-h-7 flex-wrap items-center gap-x-4 gap-y-1.5">
      <span className="flex items-center gap-3 tabular-nums">
        {parts.map(part => <span key={part.label} className="flex items-center gap-1.5">
          <span aria-hidden className={cn('size-2 rounded-full', part.dot)} />
          <span className="text-muted-foreground">{part.label}</span>
          <span className="font-medium">{part.value}</span>
        </span>)}
      </span>
      {library && <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Folder aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate font-mono text-[11px]">{library.directory}</span>
            {!library.directoryExists && <span className="shrink-0 rounded-full bg-warning-soft px-1.5 text-[11px] leading-5 text-warning">尚未创建</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent className="break-all">{library.directoryExists ? '已找到目录' : '目录不存在，下载时会自动创建'} · {library.directory}</TooltipContent>
      </Tooltip>}
      <Button variant="ghost" size="xs" className="-mr-2 ml-auto text-muted-foreground" aria-disabled={checking} onClick={() => { if (!checking) onCheck(); }}>
        {checking ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : library ? <RefreshCw data-icon="inline-start" /> : <FolderSearch data-icon="inline-start" />}
        {checking ? '检查中…' : library ? `重新检查 · ${fromNow(library.checkedAt)}` : '检查书库'}
      </Button>
    </div>
    {!!library?.unmatched.length && <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="xs" className="group -ml-2 w-fit text-muted-foreground">
          未识别的文件 {library.unmatched.length}
          <ChevronDown data-icon="inline-end" className="transition-transform duration-250 ease-out-strong group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul aria-label="未识别的文件" className="mt-1 flex max-h-28 flex-col gap-1 overflow-y-auto overscroll-contain rounded-lg border bg-card p-2.5 font-mono text-[11px] text-muted-foreground">
          {library.unmatched.map(path => <li key={path} className="break-all">{path}</li>)}
        </ul>
      </CollapsibleContent>
    </Collapsible>}
  </div>;
}

export function Chapters({ comicKey, items, states, format, running, library, checking, onCheck, dimmed }: {
  comicKey: string;
  items: Item[];
  states: Record<string, ItemStateInfo>;
  format: Format;
  /** Running tasks of this view by item id, for live progress. */
  running: Map<string, Task>;
  library: LibraryCheck | null;
  checking: boolean;
  onCheck: () => void;
  /** Another view is loading: keep this one visible but quiet. */
  dimmed: boolean;
}) {
  const [selection, setSelection] = useSelection(comicKey);
  const [query, setQuery] = useState('');
  const [intro] = useState(() => performance.now() + 450);
  const [collapsed, setCollapsed] = useState<ReadonlySet<ContentType>>(() => new Set());
  const [focusId, setFocusId] = useState('');
  const grid = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const anchor = useRef<string | null>(null);

  const needle = searchKey(query);
  const groups = useMemo(() => groupItems(needle ? items.filter(item => searchKey(item.name).includes(needle)) : items), [items, needle]);
  const selectable = useMemo(() => groups.flatMap(g => g.items).filter(item => isSelectable(states[item.id]?.state)).map(item => item.id), [groups, states]);
  // Keyboard order and Shift ranges follow what is on screen: collapsed groups are skipped.
  const order = useMemo(() => groups.filter(g => !collapsed.has(g.type)).flatMap(g => g.items).filter(item => isSelectable(states[item.id]?.state)).map(item => item.id), [groups, collapsed, states]);
  const missing = useMemo(() => items.filter(item => isMissing(states[item.id]?.state)).map(item => item.id), [items, states]);
  const tabbable = order.includes(focusId) ? focusId : order[0];

  const orderRef = useRef(order);
  useLayoutEffect(() => { orderRef.current = order; });
  const toggle = useCallback((id: string, range: boolean) => {
    const from = anchor.current;
    anchor.current = id;
    setFocusId(id);
    setSelection(old => toggleRange(old, orderRef.current, id, from, range));
  }, [setSelection]);
  const selectAll = () => setSelection(old => new Set([...old, ...selectable]));
  const allSelected = selectable.every(id => selection.has(id));
  const missingSelected = missing.length > 0 && missing.every(id => selection.has(id)) && selection.size === missing.length;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const id = (e.target as HTMLElement).dataset.item;
    if (!id) return;
    const move = (index: number) => {
      e.preventDefault();
      const next = order[Math.max(0, Math.min(order.length - 1, index))];
      if (next) grid.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(next)}"]`)?.focus();
    };
    const at = order.indexOf(id);
    if (e.key === 'ArrowRight') move(at + 1);
    else if (e.key === 'ArrowLeft') move(at - 1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      rowNeighbour(grid.current, order, at, e.key === 'ArrowDown' ? 1 : -1)?.focus();
    }
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(order.length - 1);
    else if (e.key === ' ') { e.preventDefault(); if (!e.repeat) toggle(id, e.shiftKey); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); }
  }

  return <section aria-label="章节" className={cn('flex flex-col gap-3 transition-opacity duration-200', dimmed && 'opacity-60')}>
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="h-8 min-w-44 flex-1 sm:max-w-64">
          <InputGroupAddon><Search /></InputGroupAddon>
          <InputGroupInput ref={search} aria-label="筛选章节" placeholder="筛选章节" value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }} />
          {query && <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" aria-label="清除筛选" onClick={() => { setQuery(''); search.current?.focus(); }}><X /></InputGroupButton>
          </InputGroupAddon>}
        </InputGroup>
        <span className="ml-auto hidden text-xs text-muted-foreground pointer-fine:2xl:inline">
          <kbd className="rounded border bg-card px-1 font-sans text-[11px]">Shift</kbd> 可连选
        </span>
        <div className="-m-1 flex items-center gap-1 overflow-x-auto p-1 no-scrollbar edge-fade-x max-sm:w-full">
          {/* aria-disabled once done, so the focused button keeps keyboard focus instead of dropping it. */}
          <Button variant="ghost" size="sm" disabled={!selectable.length} aria-disabled={allSelected} onClick={() => { if (!allSelected) selectAll(); }}>
            <CheckCheck data-icon="inline-start" />全选可下载<span className="text-muted-foreground tabular-nums">{selectable.length}</span>
          </Button>
          <Button variant="ghost" size="sm" disabled={!missing.length} aria-disabled={missingSelected} onClick={() => { if (!missingSelected) setSelection(() => new Set(missing)); }}>
            <ListChecks data-icon="inline-start" />选择缺失<span className="text-muted-foreground tabular-nums">{missing.length}</span>
          </Button>
          <Button variant="ghost" size="sm" aria-disabled={!selection.size} onClick={() => { if (selection.size) setSelection(() => new Set()); }}>清空</Button>
        </div>
      </div>
      <LibrarySummary items={items} states={states} library={library} checking={checking} onCheck={onCheck} />
    </div>

    {!groups.length ? <EmptyState icon={<Search />} title="没有匹配的章节" description={`换个关键词，或清除筛选查看全部 ${items.length} 项。`} className="min-h-56 border">
      <Button variant="outline" size="sm" onClick={() => { setQuery(''); search.current?.focus(); }}>清除筛选</Button>
    </EmptyState> : <div
      ref={grid}
      role="group"
      aria-label="章节列表"
      aria-describedby="chapter-keys"
      onKeyDown={onKeyDown}
      onKeyUp={e => { if (e.key === ' ' && (e.target as HTMLElement).dataset.item) e.preventDefault(); }}
    >
      <span id="chapter-keys" hidden>方向键移动，空格选择，Shift 加空格连选，Ctrl 加 A 全选</span>
      {groups.map((group, groupIndex) => {
        const ids = group.items.filter(item => isSelectable(states[item.id]?.state)).map(item => item.id);
        const count = ids.filter(id => selection.has(id)).length;
        const done = group.items.filter(item => states[item.id]?.state === 'downloaded').length;
        const size = group.items.reduce((sum, item) => sum + (item.sizeMB[format] ?? 0), 0);
        const start = groups.slice(0, groupIndex).reduce((sum, g) => sum + g.items.length, 0);
        return <Collapsible asChild key={group.type} open={!collapsed.has(group.type)}
          onOpenChange={open => setCollapsed(old => { const next = new Set(old); if (open) next.delete(group.type); else next.add(group.type); return next; })}>
          <section aria-label={group.label}>
            <div className="sticky top-13 z-10 -mx-4 flex h-11 items-center gap-3 bg-background/90 px-4 backdrop-blur-sm md:top-0 md:-mx-2 md:px-2">
              <Checkbox
                aria-label={`全选${group.label}`}
                className={SEAL_CHECK}
                checked={count > 0 && count === ids.length ? true : count > 0 ? 'indeterminate' : false}
                disabled={!ids.length}
                onCheckedChange={() => setSelection(old => toggleAll(old, ids))}
              />
              <CollapsibleTrigger className="group/group flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="truncate text-[13px] font-semibold">{group.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{group.items.length} 项 · {formatMB(size)}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums max-sm:hidden">已下载 {done}/{group.items.length}</span>
                <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform duration-250 ease-out-strong group-data-[state=closed]/group:-rotate-90 max-sm:ml-auto" />
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(172px,1fr))] gap-2 pt-1 pb-5 max-sm:grid-cols-2">
                {group.items.map((item, i) => <Tile
                  key={item.id}
                  item={item}
                  info={states[item.id]}
                  task={running.get(item.id)}
                  format={format}
                  selected={selection.has(item.id) && isSelectable(states[item.id]?.state)}
                  tabbable={item.id === tabbable}
                  index={start + i}
                  intro={intro}
                  onToggle={toggle}
                  onFocusTile={setFocusId}
                />)}
              </div>
            </CollapsibleContent>
          </section>
        </Collapsible>;
      })}
    </div>}
  </section>;
}
