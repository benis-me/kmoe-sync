// 书库整理: series folders already on a storage target, their Kmoe links and Bangumi/Komga metadata, and the background jobs.
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, getRouteApi } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CircleAlert, FolderX, HardDrive, ScanSearch, Search, SearchX, Settings2, X } from 'lucide-react';
import { cn } from 'cn';
import type { LibraryFolder, LibraryJob, LibraryOverview, Target } from '@shared/model';
import { request } from '@/lib/api';
import { searchKey } from '@/lib/format';
import { aiSettingsQuery, libraryQuery, metadataSettingsQuery, settingsQuery, statusQuery, targetsQuery } from '@/lib/queries';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { EmptyState, ErrorState, Loading } from '@/components/app/feedback';
import { Page, PageHeader } from '@/components/app/page';
import { FolderRow, type FolderAction, type RowHandlers } from '@/features/library/folder-row';
import { PolishBanner, PolishReview } from '@/features/library/ai-polish';
import { AcceptSuggestions, JobBar, LibraryIntro, LibraryStrip, type JobControl, type JobStart } from '@/features/library/overview';
import { BangumiDialog, LinkKmoeDialog } from '@/features/library/pickers';
import { CONFIDENT, FILTERS, applyFolder, applyJob, bestScore, isCurrent, jobLabels, type LibraryFilter } from '@/features/library/state';

const route = getRouteApi('/_app/library');
const collator = new Intl.Collator('zh-CN', { numeric: true });
const KMOE_FILTERS = FILTERS.filter(f => f.value !== 'bangumi' && f.value !== 'komga');
const META_FILTERS = FILTERS.filter(f => f.value === 'bangumi' || f.value === 'komga');
/** A dialog opened for a folder, and what gets focus back when it closes. */
type Opened = { folder: LibraryFolder; opener: HTMLElement | null };

export function LibraryPage() {
  const { targetId, filter = 'all' } = route.useSearch();
  const navigate = route.useNavigate();
  const targets = useQuery(targetsQuery);
  const { data: defaultId } = useQuery({ ...settingsQuery, select: settings => settings.defaultTargetId });
  const list = targets.data ?? [];
  const target = list.find(t => t.id === targetId) ?? list.find(t => t.id === defaultId) ?? list.find(t => t.isDefault) ?? list[0];

  return <Page width="wide">
    <PageHeader title="书库整理" description="NAS 上已有的漫画文件夹：关联 Kmoe 后出现在书架上，Bangumi 元数据写入 Komga。">
      {list.length > 1 && target && <Select value={String(target.id)} onValueChange={value => void navigate({ search: { targetId: Number(value) }, replace: true })}>
        <SelectTrigger size="sm" aria-label="存储位置" className="min-w-44 max-md:max-w-44 max-md:min-w-0 *:data-[slot=select-value]:flex-1 max-md:[&_[data-slot=select-value]_span]:hidden"><HardDrive className="text-muted-foreground" /><SelectValue /></SelectTrigger>
        <SelectContent position="popper" align="end">
          <SelectGroup>{list.map(t => <SelectItem key={t.id} value={String(t.id)}>
            {t.name}<span className="text-xs text-muted-foreground">{t.kind === 'local' ? '本地' : 'WebDAV'}{t.isDefault ? ' · 默认' : ''}</span>
          </SelectItem>)}</SelectGroup>
        </SelectContent>
      </Select>}
    </PageHeader>
    {targets.error ? <ErrorState error={targets.error} onRetry={() => void targets.refetch()} />
      : !targets.data ? <LibrarySkeleton />
      : !target ? <EmptyState icon={<HardDrive />} title="还没有存储位置" description="先添加一个本地目录或 WebDAV 书库，再扫描里面已有的漫画。" className="border">
        <Button asChild><Link to="/settings/$section" params={{ section: 'storage' }}>添加存储位置</Link></Button>
      </EmptyState>
      : <LibraryView key={target.id} target={target} targets={list} filter={filter}
        onFilter={next => void navigate({ search: old => ({ ...old, filter: next === 'all' ? undefined : next }), replace: true, resetScroll: false })} />}
  </Page>;
}

function LibrarySkeleton() {
  return <Loading label="正在读取书库…">
    <div className="flex flex-col gap-6">
      <Skeleton className="h-[122px] rounded-2xl" />
      <Skeleton className="h-9 w-96 max-w-full" />
      <div className="flex flex-col divide-y overflow-hidden rounded-2xl bg-card ring-1 ring-border">
        {[0, 1, 2, 3, 4, 5].map(i => <div key={i} className="flex items-center gap-4 px-5 py-4" style={{ opacity: 1 - i * 0.14 }}>
          <Skeleton className="size-4 rounded" /><div className="flex flex-1 flex-col gap-2"><Skeleton className="h-3.5 w-1/3" /><Skeleton className="h-3 w-1/5" /></div>
          <Skeleton className="h-9 w-7 rounded-[5px] max-lg:hidden" /><div className="flex w-1/4 flex-col gap-2 max-lg:hidden"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3 w-1/2" /></div>
        </div>)}
      </div>
    </div>
  </Loading>;
}

/** Toast once when a job this page watched comes to an end. */
function useJobEndToast(job: LibraryJob | undefined, ai: JobStart | null) {
  const seen = useRef(job);
  useEffect(() => {
    const before = seen.current;
    seen.current = job;
    if (!before?.running || !job || job.running || !job.kind || job.cancelled) return;
    const { label } = jobLabels(job.kind, ai);
    if (job.error) toast.error(`${label}没有完成`, { description: job.error });
    else if (job.done >= job.total) toast.success(`${label}完成`, { description: job.kind === 'scan' ? '文件夹列表已更新。' : `处理了 ${job.done} 个文件夹。` });
  }, [job, ai]);
}

function LibraryView({ target, targets, filter, onFilter }: { target: Target; targets: Target[]; filter: LibraryFilter; onFilter: (filter: LibraryFilter) => void }) {
  const client = useQueryClient();
  const library = useQuery(libraryQuery(target.id));
  const meta = useQuery(metadataSettingsQuery);
  const { data: kmoeState } = useQuery({ ...statusQuery, select: status => status.kmoe.state });
  const kmoeActive = kmoeState === 'active';
  const { data: aiReady = false } = useQuery({ ...aiSettingsQuery, select: settings => settings.ready });
  // Which AI pass the running 'ai' job is (they share one job kind).
  const [aiKind, setAiKind] = useState<JobStart | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [linking, setLinking] = useState<Opened | null>(null);
  const [picking, setPicking] = useState<Opened | null>(null);
  // Back to what opened the dialog; if that is gone (the row changed), to the row's menu button.
  const back = ({ folder, opener }: Opened) => () => opener?.isConnected ? opener : document.querySelector<HTMLElement>(`[data-folder-menu="${folder.id}"]`);
  const [pending, setPending] = useState<ReadonlyMap<number, FolderAction['action']>>(() => new Map());
  const [dismissed, setDismissed] = useState<string | null>(null);

  const overview: LibraryOverview | undefined = library.data;
  const job = overview?.job;
  const running = job?.running ? job : null;
  useJobEndToast(job, aiKind);

  const start = useMutation({
    mutationFn: (kind: JobStart) => {
      const counts = overview!.counts, targetId = target.id;
      if (kind === 'scan') return request('POST /api/library/scan', { body: { targetId, match: kmoeActive } });
      if (kind === 'ai-kmoe' || kind === 'ai-bangumi') return request('POST /api/library/ai-match', { body: { targetId, kind: kind === 'ai-kmoe' ? 'kmoe' : 'bangumi' } });
      if (kind === 'ai-polish') return request('POST /api/library/ai-polish', { body: { targetId, all: false } });
      // Nothing new to look at: look again at what was not found.
      if (kind === 'kmoe') return request('POST /api/library/match-kmoe', { body: { targetId, retry: counts.kmoe.pending === 0 } });
      if (kind === 'bangumi') return request('POST /api/library/match-bangumi', { body: { targetId, retry: counts.bangumi.none === 0 } });
      const stale = overview!.folders.some(f => f.metadata.komga.state === 'pending' || f.metadata.komga.state === 'error' || f.metadata.komga.dirty);
      return request('POST /api/library/sync-komga', { body: { targetId, all: !stale } });
    },
    onMutate: kind => { if (kind.startsWith('ai-')) setAiKind(kind); },
    onSuccess: next => applyJob(client, next),
  });
  const cancel = useMutation({
    mutationFn: () => request('POST /api/library/cancel'),
    onSuccess: next => { applyJob(client, next); toast.success('已取消', { description: '已经处理好的文件夹会保留结果。' }); },
  });
  const accept = useMutation({
    mutationFn: () => request('POST /api/library/accept-suggested', { body: { targetId: target.id, minScore: CONFIDENT } }),
    onSuccess: ({ linked }) => {
      toast.success(linked ? `已关联 ${linked} 个文件夹` : '没有可以接受的建议', { description: linked ? '它们已经出现在书架上。' : undefined });
      for (const queryKey of [libraryQuery(target.id).queryKey, ['shelf']]) void client.invalidateQueries({ queryKey });
    },
  });
  const act = useMutation({
    mutationFn: (a: FolderAction) => {
      const params = { id: a.folder.id };
      return a.action === 'confirm' ? request('POST /api/library/folders/:id/kmoe', { params, body: { comic: a.comic } })
        : a.action === 'ignore' ? request('POST /api/library/folders/:id/ignore', { params })
        : a.action === 'reset' ? request('POST /api/library/folders/:id/reset', { params })
        : request('POST /api/library/folders/:id/sync', { params });
    },
    onMutate: a => setPending(old => new Map(old).set(a.folder.id, a.action)),
    onSettled: (_, __, a) => setPending(old => { const next = new Map(old); next.delete(a.folder.id); return next; }),
    onSuccess: (folder, a) => {
      applyFolder(client, folder);
      const was = a.folder.kmoe;
      if (a.action === 'confirm') toast.success(`已关联《${folder.kmoe.comic?.title ?? folder.name}》`, { description: '已加入书架，文件夹里已有的卷算作已下载。' });
      else if (a.action === 'ignore') toast.success(`已忽略「${folder.name}」`, { description: '可以在「已忽略」里恢复。' });
      else if (a.action === 'reset' && was.comic) {
        const comic = was.comic;
        toast.success(`已取消关联《${comic.title}》`, { description: '文件夹回到「待匹配」，文件不受影响。', action: { label: '撤销', onClick: () => act.mutate({ folder, action: 'confirm', comic: comic.key }) } });
      } else if (a.action === 'reset') toast.success(was.state === 'ignored' ? `已恢复「${folder.name}」` : `已重置「${folder.name}」`, { description: '运行「匹配 Kmoe」时会重新查找。' });
      else if (folder.metadata.komga.state === 'error') toast.error('同步到 Komga 失败', { description: folder.metadata.komga.error ?? undefined });
      else if (folder.metadata.komga.state === 'not_found') toast.warning('Komga 里没有找到这个系列', { description: '先让 Komga 扫描书库，再同步。' });
      else toast.success(`已把「${folder.name}」同步到 Komga`);
    },
  });
  const handlers = useMemo<RowHandlers>(() => ({
    act: act.mutate, link: (folder, opener) => setLinking({ folder, opener }), pickBangumi: (folder, opener) => setPicking({ folder, opener }),
  }), [act.mutate]);
  const jobs: JobControl = { running, starting: start.isPending ? start.variables : null, start: start.mutate, ai: aiKind };

  const folders = useMemo(() => [...overview?.folders ?? []].sort((a, b) => collator.compare(a.path, b.path)), [overview?.folders]);
  const needle = searchKey(q);
  const matched = useMemo(() => needle ? folders.filter(f => searchKey(`${f.path}${f.hint ?? ''}${f.kmoe.comic?.title ?? ''}`).includes(needle)) : folders, [folders, needle]);
  const current = FILTERS.find(f => f.value === filter) ?? FILTERS[0]!;
  const visible = useMemo(() => matched.filter(current.test), [matched, current]);
  // Hundreds of rows: typing and filter clicks respond at once, the list follows in an interruptible render.
  const shown = useDeferredValue(visible);
  const confident = folders.filter(f => f.kmoe.state === 'suggested' && bestScore(f) >= CONFIDENT).length;
  const polished = folders.filter(f => f.metadata.polish === 'pending').length;
  const metaReady = meta.data !== undefined || !!meta.error;
  const showMeta = !!meta.data?.enabled || folders.some(f => f.metadata.bangumi.state !== 'none');
  const failed = job && !job.running && job.error && job.targetId === target.id && job.finishedAt !== dismissed ? job : null;
  const here = running?.targetId === target.id;

  if (library.error) return <ErrorState error={library.error} onRetry={() => void library.refetch()} />;
  if (!overview || !metaReady) return <LibrarySkeleton />;

  const jobArea = <>
    {/* The bar folds away when the job ends, instead of popping out. */}
    <div className={cn('grid transition-[grid-template-rows,opacity] duration-300 ease-out-strong', running ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}>
      <div className="min-h-0 overflow-hidden" inert={!running}>
        {job?.kind && <div className="pt-3"><JobBar job={job} target={here ? undefined : targets.find(t => t.id === job.targetId)} ai={aiKind} cancelling={cancel.isPending} onCancel={() => cancel.mutate()} /></div>}
      </div>
    </div>
    {failed?.kind && <Alert variant="destructive" className="mt-3">
      <CircleAlert />
      <AlertTitle>{jobLabels(failed.kind, aiKind).label}没有完成</AlertTitle>
      <AlertDescription>{failed.error}</AlertDescription>
      <AlertAction><Button variant="ghost" size="icon-xs" aria-label="关闭" onClick={() => setDismissed(failed.finishedAt)}><X /></Button></AlertAction>
    </Alert>}
  </>;

  if (!folders.length) {
    const scanned = !here && overview.scannedAt !== null;
    return <div className="flex flex-col">
      {scanned ? <EmptyState icon={<FolderX />} title="没有找到漫画文件夹" description={`「${target.name}」里没有直接放着 EPUB 或 MOBI 文件的文件夹。确认存储位置的目录是否正确。`} className="border">
        <Button variant="outline" aria-disabled={!!running || start.isPending} onClick={() => { if (!running && !start.isPending) start.mutate('scan'); }}><ScanSearch data-icon="inline-start" />重新扫描</Button>
        <Button variant="outline" asChild><Link to="/settings/$section" params={{ section: 'storage' }}><Settings2 data-icon="inline-start" />存储位置</Link></Button>
      </EmptyState> : !here && <LibraryIntro target={target} kmoeActive={kmoeActive} jobs={jobs} />}
      {jobArea}
      {here && <p className="mt-4 text-center text-xs text-muted-foreground">扫描完成后，找到的文件夹会列在这里。文件不会被移动或改名。</p>}
    </div>;
  }

  const count = (test: (folder: LibraryFolder) => boolean) => matched.filter(test).length;
  const metaFilters = META_FILTERS.filter(f => showMeta && (filter === f.value || count(f.test) > 0));
  return <>
    <div className="flex flex-col">
      <LibraryStrip overview={overview} metadata={meta.data ?? null} kmoeActive={kmoeActive} ai={aiReady} jobs={jobs} />
      {jobArea}
    </div>

    <section aria-label="文件夹" className="flex flex-col gap-4">
      {confident > 0 && (filter === 'all' || filter === 'suggested') && <AcceptSuggestions count={confident} pending={accept.isPending} onAccept={() => accept.mutate()} />}
      {polished > 0 && <PolishBanner count={polished} onOpen={() => setReviewing(true)} />}
      {/* Filters scroll sideways on phones; the search wraps to its own line when the row is full. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="-mx-1 max-w-[calc(100%+0.5rem)] overflow-x-auto px-1 py-1 no-scrollbar">
          <ToggleGroup type="single" variant="segmented" aria-label="按 Kmoe 关联筛选" value={KMOE_FILTERS.some(f => f.value === filter) ? filter : ''} onValueChange={value => value && onFilter(value as LibraryFilter)}>
            {KMOE_FILTERS.filter(f => f.value !== 'pending' || filter === 'pending' || count(f.test) > 0).map(item => {
              const n = count(item.test);
              return <ToggleGroupItem key={item.value} value={item.value} className="px-3" aria-label={`${item.label} ${n}`}>
                {item.label}<span key={n} className="inline-block min-w-3 animate-tick text-xs text-muted-foreground tabular-nums">{n}</span>
              </ToggleGroupItem>;
            })}
          </ToggleGroup>
        </div>
        {metaFilters.map(item => {
          const n = count(item.test);
          return <Toggle key={item.value} variant="outline" pressed={filter === item.value} onPressedChange={on => onFilter(on ? item.value : 'all')} aria-label={`${item.label} ${n}`}
            className="shrink-0 gap-1.5 px-3 data-[state=on]:border-seal/45 data-[state=on]:bg-seal-soft data-[state=on]:text-seal">
            {item.label}<span className="text-xs font-normal tabular-nums">{n}</span>
          </Toggle>;
        })}
        <InputGroup className="ml-auto min-w-44 flex-1 max-sm:order-first sm:max-w-64">
          <InputGroupAddon><Search /></InputGroupAddon>
          <InputGroupInput ref={search} type="search" aria-label="搜索文件夹" placeholder="搜索文件夹或漫画" value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ(''); } }} />
          {q && <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label="清除搜索" onClick={() => { setQ(''); search.current?.focus(); }}><X /></InputGroupButton></InputGroupAddon>}
        </InputGroup>
      </div>

      <div role="status" aria-live="polite" className="sr-only">{q || filter !== 'all' ? `找到 ${visible.length} 个文件夹` : ''}</div>
      {!visible.length ? <EmptyState icon={<SearchX />} title="没有符合条件的文件夹" description={q ? `没有和「${q}」相关的文件夹。` : '换个筛选条件看看。'} className="border">
        <Button variant="outline" onClick={() => { onFilter('all'); setQ(''); search.current?.focus(); }}>清除筛选</Button>
      </EmptyState> : <div className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-border">
        <div aria-hidden className={cn('hidden gap-x-4 border-b bg-muted/35 px-5 py-2 text-xs text-muted-foreground lg:grid',
          showMeta ? 'grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_2rem]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_2rem]')}>
          <span className="pl-7">文件夹</span><span>Kmoe 漫画</span>{showMeta && <span>元数据</span>}
        </div>
        <ul aria-label={`${current.label}的文件夹`} className={cn('flex flex-col divide-y transition-opacity duration-150', shown !== visible && 'opacity-60')}>
          {/* The index only staggers the first rows in; capping it keeps the others memoized when the filter changes. */}
          {shown.map((folder, index) => <FolderRow key={folder.id} folder={folder} index={Math.min(index, 15)} pending={pending.get(folder.id) ?? null}
            busy={isCurrent(running ?? undefined, folder)} meta={showMeta} handlers={handlers} />)}
        </ul>
      </div>}
    </section>

    {linking && <LinkKmoeDialog key={linking.folder.id} folder={linking.folder} returnFocus={back(linking)} onClose={() => setLinking(null)} />}
    {reviewing && <PolishReview targetId={target.id} onClose={() => setReviewing(false)} />}
    {picking && <BangumiDialog key={picking.folder.id} folderId={picking.folder.id} label={picking.folder.path} query={picking.folder.hint ?? picking.folder.name}
      bangumi={picking.folder.metadata.bangumi} returnFocus={back(picking)} onClose={() => setPicking(null)} />}
  </>;
}
