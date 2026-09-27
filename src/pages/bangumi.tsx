// Bangumi 书单: synced wish/watching lists; match each entry to a Kmoe comic, then subscribe from the comic page.
import { useState, type FormEvent } from 'react';
import { Link, getRouteApi } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { ChevronRight, ListChecks, LoaderCircle, RefreshCw, Search, Settings2, Undo2 } from 'lucide-react';
import { cn } from 'cn';
import { BANGUMI_LABELS, type SourceItem } from '@shared/model';
import { request } from '@/lib/api';
import { fromNow } from '@/lib/format';
import { searchQuery, sourceItemsQuery, sourcesQuery } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Cover } from '@/components/app/cover';
import { EmptyState, ErrorState, Loading } from '@/components/app/feedback';

const route = getRouteApi('/_app/discover/bangumi');
type Match = SourceItem['match']['state'];
const FILTERS: { value: Match; label: string; empty: string }[] = [
  { value: 'pending', label: '待匹配', empty: '没有待匹配的条目' },
  { value: 'matched', label: '已匹配', empty: '还没有匹配好的条目' },
  { value: 'dismissed', label: '已忽略', empty: '没有忽略的条目' },
];

export function BangumiPage() {
  const { source: sourceId, match = 'pending' } = route.useSearch();
  const navigate = route.useNavigate();
  const client = useQueryClient();
  const sources = useQuery(sourcesQuery);
  const source = sources.data?.find(s => s.id === sourceId) ?? sources.data?.[0];
  const items = useQuery({ ...sourceItemsQuery(source?.id ?? 0), enabled: !!source });
  const [matching, setMatching] = useState<SourceItem | null>(null);
  const sync = useMutation({
    mutationFn: (id: number) => request('POST /api/sources/:id/sync', { params: { id } }),
    onSuccess: next => {
      void client.invalidateQueries({ queryKey: ['sources'] });
      if (next.error) toast.error(next.error); else toast.success(`${next.name} 已同步`);
    },
  });
  const act = useMutation({
    mutationFn: ({ id, kind }: { id: number; kind: 'dismiss' | 'restore' }) => request(kind === 'dismiss' ? 'POST /api/source-items/:id/dismiss' : 'POST /api/source-items/:id/restore', { params: { id } }),
    onSuccess: (_, { kind }) => { void client.invalidateQueries({ queryKey: ['sources'] }); toast.success(kind === 'dismiss' ? '已忽略' : '已恢复为待匹配'); },
  });

  if (sources.error) return <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />;
  if (!sources.data) return <Loading label="正在读取书单…"><div className="flex flex-col gap-3"><Skeleton className="h-9 w-72" /><Skeleton className="h-64 rounded-2xl" /></div></Loading>;
  if (!source) return <EmptyState icon={<ListChecks />} title="还没有连接 Bangumi" description="填写 Bangumi 用户名后，想看、在看的条目会同步过来，帮你在 Kmoe 上找到对应的漫画。" className="border">
    <Button asChild><Link to="/settings/$section" params={{ section: 'sources' }}><Settings2 data-icon="inline-start" />设置书单同步</Link></Button>
  </EmptyState>;

  const list = items.data ?? [];
  const visible = list.filter(item => item.match.state === match);
  const current = FILTERS.find(f => f.value === match)!;

  return <>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      {sources.data.length > 1 ? <Select value={String(source.id)} onValueChange={value => void navigate({ search: old => ({ ...old, source: Number(value) }), replace: true })}>
        <SelectTrigger aria-label="书单" className="min-w-40"><SelectValue /></SelectTrigger>
        <SelectContent position="popper"><SelectGroup>{sources.data.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}</SelectGroup></SelectContent>
      </Select> : <span className="font-medium">{source.name}</span>}
      <span className="text-xs text-muted-foreground tabular-nums">
        @{source.username} · {source.types.map(t => BANGUMI_LABELS[t]).join('、')} · {source.lastSyncAt ? `${fromNow(source.lastSyncAt)}同步` : '尚未同步'}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" className="text-muted-foreground" aria-disabled={sync.isPending} onClick={() => { if (!sync.isPending) sync.mutate(source.id); }}>
          {sync.isPending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}立即同步
        </Button>
        <Button variant="ghost" size="sm" className="text-muted-foreground" asChild><Link to="/settings/$section" params={{ section: 'sources' }}><Settings2 data-icon="inline-start" />设置</Link></Button>
      </div>
    </div>
    {source.error && <p role="alert" className="-mt-3 text-xs text-destructive">{source.error}</p>}

    <div className="-mx-1 overflow-x-auto px-1 py-1 no-scrollbar">
      <ToggleGroup type="single" variant="segmented" aria-label="按匹配状态筛选" value={match}
        onValueChange={value => value && void navigate({ search: old => ({ ...old, match: value === 'pending' ? undefined : value as Exclude<Match, 'pending'> }), replace: true })}>
        {FILTERS.map(item => {
          const count = list.filter(i => i.match.state === item.value).length;
          return <ToggleGroupItem key={item.value} value={item.value} className="px-3" aria-label={`${item.label} ${count}`}>
            {item.label}<span key={count} className="inline-block min-w-3 animate-tick text-xs text-muted-foreground tabular-nums">{items.data ? count : ''}</span>
          </ToggleGroupItem>;
        })}
      </ToggleGroup>
    </div>

    {items.error ? <ErrorState error={items.error} onRetry={() => void items.refetch()} />
      : !items.data ? <Loading label="正在读取条目…"><div className="flex flex-col gap-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-20 rounded-xl" />)}</div></Loading>
      : !visible.length ? <EmptyState icon={<ListChecks />} title={current.empty} description={match === 'pending' ? '书单里的条目都处理好了。' : undefined} className="min-h-56 border" />
      : <ul aria-label={current.label} className="flex flex-col divide-y overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-border">
        <AnimatePresence initial={false}>
          {visible.map(item => <motion.li key={item.id} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}
            className="flex items-center gap-3.5 px-4 py-3 max-sm:flex-wrap sm:gap-4">
            <Cover src={item.cover} title={item.title} className="w-11 rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <a href={item.url} target="_blank" rel="noreferrer" className="w-fit max-w-full truncate rounded-sm text-sm font-medium decoration-foreground/30 underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{item.title}</a>
              <span className="truncate text-xs text-muted-foreground">{[item.originalTitle, BANGUMI_LABELS[item.status], `${fromNow(item.firstSeenAt)}加入`].filter(Boolean).join(' · ')}</span>
              {item.match.state === 'matched' && item.match.comicKey && <span className="truncate text-xs">
                <span className="text-muted-foreground">已关联 </span>
                <Link to="/comics/$key" params={{ key: item.match.comicKey }} className="font-medium underline decoration-foreground/25 underline-offset-4 hover:decoration-foreground">《{item.match.comicTitle}》</Link>
              </span>}
            </div>
            <div className={cn('flex shrink-0 items-center gap-1.5', 'max-sm:w-full max-sm:justify-end')}>
              {item.match.state === 'pending' && <>
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => act.mutate({ id: item.id, kind: 'dismiss' })}>忽略</Button>
                <Button variant="outline" size="sm" onClick={() => setMatching(item)}><Search data-icon="inline-start" />在 Kmoe 查找</Button>
              </>}
              {item.match.state === 'matched' && item.match.comicKey && <>
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setMatching(item)}>重新关联</Button>
                <Button variant="outline" size="sm" asChild><Link to="/comics/$key" params={{ key: item.match.comicKey }} hash="subscription">去订阅<ChevronRight data-icon="inline-end" /></Link></Button>
              </>}
              {item.match.state === 'dismissed' && <Button variant="ghost" size="sm" onClick={() => act.mutate({ id: item.id, kind: 'restore' })}><Undo2 data-icon="inline-start" />恢复</Button>}
            </div>
          </motion.li>)}
        </AnimatePresence>
      </ul>}

    {matching && <MatchDialog key={matching.id} item={matching} onClose={() => setMatching(null)} />}
  </>;
}

/** Search Kmoe with the entry's title, pick the right comic, link it. */
function MatchDialog({ item, onClose }: { item: SourceItem; onClose: () => void }) {
  const client = useQueryClient();
  const navigate = route.useNavigate();
  const [open, setOpen] = useState(true);
  const [text, setText] = useState(item.title);
  const [query, setQuery] = useState(item.title);
  const [picked, setPicked] = useState<string | null>(item.match.comicKey);
  const results = useQuery({ ...searchQuery(query, 1), enabled: !!query });
  const link = useMutation({
    mutationFn: (comicKey: string) => request('POST /api/source-items/:id/match', { params: { id: item.id }, body: { comicKey } }),
    onSuccess: linked => {
      void client.invalidateQueries({ queryKey: ['sources'] });
      setOpen(false);
      const key = linked.match.comicKey;
      toast.success(`已关联《${linked.match.comicTitle}》`, key ? { action: { label: '去订阅', onClick: () => void navigate({ to: '/comics/$key', params: { key }, hash: 'subscription' }) } } : undefined);
    },
  });
  const close = (next: boolean) => { setOpen(next); if (!next) setTimeout(onClose, 200); };
  const submit = (e: FormEvent) => { e.preventDefault(); setQuery(text.trim()); };

  return <Dialog open={open} onOpenChange={close}>
    <DialogContent className="flex max-h-[min(620px,calc(100dvh-32px))] flex-col gap-4 sm:max-w-lg">
      <DialogHeader className="pr-8">
        <DialogTitle>为「{item.title}」找到 Kmoe 漫画</DialogTitle>
        <DialogDescription>{item.originalTitle ? `原名 ${item.originalTitle}。` : ''}选中正确的一部，再点「关联」。</DialogDescription>
      </DialogHeader>
      <form role="search" onSubmit={submit}>
        <InputGroup>
          <InputGroupAddon><Search /></InputGroupAddon>
          <InputGroupInput aria-label="搜索 Kmoe" value={text} onChange={e => setText(e.target.value)} />
          <InputGroupAddon align="inline-end"><InputGroupButton type="submit">搜索</InputGroupButton></InputGroupAddon>
        </InputGroup>
      </form>
      {item.originalTitle && item.originalTitle !== query && <button type="button" onClick={() => { setText(item.originalTitle!); setQuery(item.originalTitle!); }}
        className="-mt-2 w-fit rounded-sm text-xs text-muted-foreground underline decoration-foreground/25 underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">改用原名搜索：{item.originalTitle}</button>}
      <div role="radiogroup" aria-label="搜索结果" aria-busy={results.isFetching} className="min-h-40 flex-1 overflow-y-auto overscroll-contain rounded-xl bg-card p-1 ring-1 ring-border">
        {results.error ? <ErrorState error={results.error} className="min-h-40 p-4" />
          : !results.data ? <Loading label="正在搜索…"><div className="flex flex-col gap-1 p-1">{[0, 1, 2].map(i => <Skeleton key={i} className="h-16 rounded-lg" />)}</div></Loading>
          : !results.data.results.length ? <EmptyState icon={<Search />} title="没有找到" description="换个写法再搜一次，例如只搜关键字或作者。" className="min-h-40 p-4" />
          : results.data.results.map(comic => <button key={comic.key} type="button" role="radio" aria-checked={picked === comic.key} onClick={() => setPicked(comic.key)}
            className="flex w-full items-center gap-3 rounded-lg p-2 text-left outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-checked:bg-seal-soft/70 aria-checked:ring-1 aria-checked:ring-seal/30">
            <Cover src={comic.cover} title={comic.title} className="w-9 rounded-md" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{comic.title}</span>
              <span className="truncate text-xs text-muted-foreground">{[comic.authors.join(' / '), comic.latest && `最新 ${comic.latest}`].filter(Boolean).join(' · ')}</span>
            </span>
            <span aria-hidden className={cn('grid size-4 shrink-0 place-items-center rounded-full border border-muted-foreground/60', picked === comic.key && 'border-seal bg-seal')}>
              {picked === comic.key && <span className="size-1.5 rounded-full bg-seal-foreground" />}
            </span>
          </button>)}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => close(false)}>取消</Button>
        <Button aria-disabled={!picked || link.isPending} onClick={() => { if (picked && !link.isPending) link.mutate(picked); }}>
          {link.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}关联
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
