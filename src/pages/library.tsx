// 书库整理: series folders already on a storage target, their Kmoe links and Bangumi/Komga metadata, and the background jobs.
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, getRouteApi } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CircleAlert, CircleCheck, FolderX, HardDrive, ScanSearch, Search, SearchX, Settings2, X } from 'lucide-react';
import { cn } from 'cn';
import { STAGES, STAGE_KEYS, countBy, optionOf, passes, statusOf, type FolderFilters, type Stage } from '@shared/folder-status';
import type { LibraryFolder, LibraryJob, LibraryOverview, Target } from '@shared/model';
import { request } from '@/lib/api';
import { searchKey } from '@/lib/format';
import { aiSettingsQuery, libraryQuery, metadataSettingsQuery, settingsQuery, statusQuery, targetsQuery } from '@/lib/queries';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { EmptyState, ErrorState, Loading } from '@/components/app/feedback';
import { Page, PageHeader } from '@/components/app/page';
import { StageMenu } from '@/features/library/filters';
import { FolderRow, type FolderAction, type RowHandlers } from '@/features/library/folder-row';
import { PolishBanner, PolishReview } from '@/features/library/ai-polish';
import { AcceptSuggestions, JobBar, LibraryIntro, LibraryStrip, type JobControl, type JobStart } from '@/features/library/overview';
import { BangumiDialog, LinkKmoeDialog } from '@/features/library/pickers';
import { CONFIDENT, applyFolder, applyJob, bestScore, isCurrent, jobLabels } from '@/features/library/state';

const route = getRouteApi('/_app/library');
const collator = new Intl.Collator('zh-CN', { numeric: true });
/** A dialog opened for a folder, and what gets focus back when it closes. */
type Opened = { folder: LibraryFolder; opener: HTMLElement | null };

export function LibraryPage() {
  const { targetId, view, kmoe, bangumi, komga } = route.useSearch();
  const navigate = route.useNavigate();
  const filters = useMemo<FolderFilters>(() => ({ todo: view === 'todo', kmoe, bangumi, komga }), [view, kmoe, bangumi, komga]);
  const targets = useQuery(targetsQuery);
  const { data: defaultId } = useQuery({ ...settingsQuery, select: settings => settings.defaultTargetId });
  const list = targets.data ?? [];
  const target = list.find(t => t.id === targetId) ?? list.find(t => t.id === defaultId) ?? list.find(t => t.isDefault) ?? list[0];

  return <Page>
    <PageHeader title="书库整理">
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
      : <LibraryView key={target.id} target={target} targets={list} filters={filters}
        onFilters={next => void navigate({ search: old => ({ targetId: old.targetId, view: next.todo ? 'todo' : undefined, kmoe: next.kmoe, bangumi: next.bangumi, komga: next.komga }), replace: true, resetScroll: false })} />}
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

function LibraryView({ target, targets, filters, onFilters }: { target: Target; targets: Target[]; filters: FolderFilters; onFilters: (filters: FolderFilters) => void }) {
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
      if (kind === 'follow') return request('POST /api/library/follow', { body: { targetId } });
      // Nothing new to look at: look again at what was not found.
      if (kind === 'kmoe') return request('POST /api/library/match-kmoe', { body: { targetId, retry: counts.kmoe.pending === 0 } });
      if (kind === 'bangumi') return request('POST /api/library/match-bangumi', { body: { targetId, retry: counts.bangumi.none === 0 } });
      // Folders still to write (not those waiting for a Bangumi match, which cannot be): those first, else all of them again.
      const stale = overview!.folders.some(f => { const komga = statusOf(f, 'komga'); return komga === 'pending' || komga === 'error' || (komga === 'not_found' && f.metadata.komga.dirty); });
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
        // The only undo: it stays until used or closed.
        toast.success(`已取消关联《${comic.title}》`, { description: '文件夹回到「待匹配」，文件不受影响。', duration: Infinity, action: { label: '撤销', onClick: () => act.mutate({ folder, action: 'confirm', comic: comic.key }) } });
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
  const showMeta = !!meta.data?.enabled || folders.some(f => f.metadata.bangumi.state !== 'none');
  // The stages this target shows (Komga only where it is set up); a filter on a hidden stage is dropped, never applied unseen.
  const stages = useMemo(() => STAGE_KEYS.filter(stage => stage === 'kmoe' || (showMeta && (stage === 'bangumi' || folders.some(f => statusOf(f, 'komga') !== null)))), [folders, showMeta]);
  const applied = useMemo<FolderFilters>(() => ({
    todo: filters.todo, kmoe: filters.kmoe, bangumi: stages.includes('bangumi') ? filters.bangumi : undefined, komga: stages.includes('komga') ? filters.komga : undefined,
  }), [filters, stages]);
  const visible = useMemo(() => matched.filter(f => passes(f, applied, showMeta)), [matched, applied, showMeta]);
  // Hundreds of rows: typing and filter clicks respond at once, the list follows in an interruptible render.
  const shown = useDeferredValue(visible);
  const confident = folders.filter(f => f.kmoe.state === 'suggested' && bestScore(f) >= CONFIDENT).length;
  const polished = folders.filter(f => f.metadata.polish === 'pending').length;
  const metaReady = meta.data !== undefined || !!meta.error;
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

  // What each control offers: the view switch and every stage menu count with their own filter left out.
  const views = { all: matched.filter(f => passes(f, { ...applied, todo: false }, showMeta)).length, todo: matched.filter(f => passes(f, { ...applied, todo: true }, showMeta)).length };
  const menus = stages.map(stage => ({ stage, counts: countBy(matched.filter(f => passes(f, applied, showMeta, stage)), stage) }));
  const filtered = applied.todo || stages.some(stage => applied[stage]);
  const setStage = (stage: Stage, value: string | undefined) => onFilters({ ...applied, [stage]: value } as FolderFilters);
  // A count in the strip shows exactly those folders; picking the one that is on turns it off again.
  const pick = (stage: Stage, value: string) => {
    if (applied[stage] === value) return setStage(stage, undefined);
    setQ('');
    onFilters({ [stage]: value } as FolderFilters);
  };
  const clear = () => { onFilters({}); setQ(''); search.current?.focus(); };
  const label = [applied.todo ? '待处理' : '', ...stages.map(stage => {
    const option = optionOf(stage, applied[stage]);
    return option ? `${STAGES[stage].label} ${option.label}` : '';
  })].filter(Boolean).join('、') || '全部';
  return <>
    <div className="flex flex-col">
      <LibraryStrip overview={overview} metadata={meta.data ?? null} kmoeActive={kmoeActive} ai={aiReady} jobs={jobs} filters={applied} onPick={pick} />
      {jobArea}
    </div>

    <section aria-label="文件夹" className="flex flex-col gap-4">
      {confident > 0 && (!applied.kmoe || applied.kmoe === 'suggested') && !applied.bangumi && !applied.komga
        && <AcceptSuggestions count={confident} pending={accept.isPending} onAccept={() => accept.mutate()} />}
      {polished > 0 && <PolishBanner count={polished} onOpen={() => setReviewing(true)} />}
      {/* One row on wide screens. On phones: the search, then the view switch (and 清除), then the stage menus. */}
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" variant="segmented" aria-label="显示的文件夹" value={applied.todo ? 'todo' : 'all'} onValueChange={value => value && onFilters({ ...applied, todo: value === 'todo' })}>
          {([['all', '全部', views.all], ['todo', '待处理', views.todo]] as const).map(([value, text, n]) => <ToggleGroupItem key={value} value={value} className="px-3" aria-label={`${text} ${n}`}>
            {text}<span key={n} className="inline-block min-w-3 animate-tick text-xs text-muted-foreground tabular-nums">{n}</span>
          </ToggleGroupItem>)}
        </ToggleGroup>
        <div role="group" aria-label="按状态筛选" className="flex flex-wrap items-center gap-2 max-sm:order-3 max-sm:basis-full">
          {menus.map(({ stage, counts }) => <StageMenu key={stage} stage={stage} value={applied[stage]} counts={counts} onChange={value => setStage(stage, value)} />)}
        </div>
        {filtered && <Button variant="ghost" className="text-muted-foreground max-sm:order-2 max-sm:ml-auto" onClick={() => onFilters({})}><X data-icon="inline-start" />清除筛选</Button>}
        <InputGroup className="ml-auto min-w-44 flex-1 max-sm:order-first max-sm:basis-full sm:max-w-64">
          <InputGroupAddon><Search /></InputGroupAddon>
          <InputGroupInput ref={search} type="search" aria-label="搜索文件夹" placeholder="搜索文件夹或漫画" value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ(''); } }} />
          {q && <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label="清除搜索" onClick={() => { setQ(''); search.current?.focus(); }}><X /></InputGroupButton></InputGroupAddon>}
        </InputGroup>
      </div>

      <div role="status" aria-live="polite" className="sr-only">{q || filtered ? `找到 ${visible.length} 个文件夹` : ''}</div>
      {!visible.length ? applied.todo && !q && label === '待处理'
        ? <EmptyState icon={<CircleCheck />} title="没有待处理的文件夹" description="要你确认或手动选择的匹配都处理完了，Komga 同步也没有出错。" className="border">
          <Button variant="outline" onClick={clear}>查看全部文件夹</Button>
        </EmptyState>
        : <EmptyState icon={<SearchX />} title="没有符合条件的文件夹" description={q ? `没有和「${q}」相关的文件夹。` : '换个筛选条件看看。'} className="border">
          <Button variant="outline" onClick={clear}>清除筛选</Button>
        </EmptyState>
      : <div className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-border">
        <div aria-hidden className={cn('hidden gap-x-4 border-b bg-muted/35 px-5 py-2 text-xs text-muted-foreground lg:grid',
          showMeta ? 'grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.9fr)_2rem]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_2rem]')}>
          <span className="pl-7">文件夹</span><span>Kmoe 漫画</span>{showMeta && <span>元数据</span>}
        </div>
        <ul aria-label={`${label}的文件夹`} className={cn('flex flex-col divide-y transition-opacity duration-150', shown !== visible && 'opacity-60')}>
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
