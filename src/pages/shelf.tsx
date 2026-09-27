// 书架: status strip, pause banner, first-run guide, the cover wall with filters, and recent activity.
import { useMemo, useRef, useState } from 'react';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Compass, FolderInput, LibraryBig, Search, SearchX, X } from 'lucide-react';
import { cn } from 'cn';
import type { ShelfEntry } from '@shared/model';
import { searchKey } from '@/lib/format';
import { useMediaQuery } from '@/lib/hooks';
import { libraryQuery, settingsQuery, shelfQuery, statusQuery } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { EmptyState, ErrorState, Loading } from '@/components/app/feedback';
import { Page, PageHeader } from '@/components/app/page';
import { QueueBanner } from '@/components/app/queue-banner';
import { ActivityFeed } from '@/features/shelf/activity';
import { ComicCard } from '@/features/shelf/comic-card';
import { CheckAllButton, Onboarding, StatusStrip } from '@/features/shelf/overview';

const route = getRouteApi('/_app/');
type Filter = 'all' | 'tracking' | 'updates' | 'failed';
const FILTERS: { value: Filter; label: string; test: (entry: ShelfEntry) => boolean }[] = [
  { value: 'all', label: '全部', test: () => true },
  { value: 'tracking', label: '追更中', test: entry => !!entry.subscription?.enabled },
  { value: 'updates', label: '有更新', test: entry => entry.counts.new > 0 },
  { value: 'failed', label: '有失败', test: entry => entry.counts.failed > 0 },
];

export function ShelfPage() {
  const { filter = 'all' } = route.useSearch();
  const navigate = useNavigate({ from: '/' });
  const search = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const shelf = useQuery(shelfQuery);
  const { data: status } = useQuery(statusQuery);
  const { data: reserve } = useQuery({ ...settingsQuery, select: settings => settings.quotaReserveMB });
  const { data: defaultTarget } = useQuery({ ...settingsQuery, select: settings => settings.defaultTargetId });
  // Folders on the default target that still need a decision; a library never scanned counts as "to do" too.
  const { data: library } = useQuery({
    ...libraryQuery(defaultTarget ?? 0), enabled: defaultTarget != null,
    select: ({ counts, scannedAt }) => ({ todo: counts.kmoe.pending + counts.kmoe.suggested + counts.kmoe.unmatched, unscanned: !scannedAt }),
  });
  const desktop = useMediaQuery('(min-width: 768px)');

  const entries = shelf.data;
  const matched = useMemo(() => {
    const needle = searchKey(q);
    return (entries ?? []).filter(entry => !needle || searchKey(`${entry.comic.title}${entry.comic.authors.join('')}`).includes(needle));
  }, [entries, q]);
  const visible = matched.filter(FILTERS.find(f => f.value === filter)!.test);
  const subscribed = entries?.filter(entry => entry.subscription?.enabled).length ?? 0;
  const setFilter = (next: Filter) => void navigate({ search: { filter: next === 'all' ? undefined : next }, replace: true });

  const todo = library?.todo ?? 0;
  const prominent = entries?.length === 0 || todo > 0 || !!library?.unscanned;
  return <Page width="wide">
    <PageHeader title="书架" description={entries?.length ? `${entries.length} 部漫画 · 追更中 ${subscribed} 部` : '订阅或下载过的漫画都在这里。'}>
      {!desktop && status && !!subscribed && <CheckAllButton status={status} subscribed={subscribed} variant="ghost" size="icon-sm" />}
      {/* Phones reach 书库 from the tab bar: the button only shows there when something waits. */}
      {entries && (prominent || desktop) && <Button variant={prominent ? 'default' : 'outline'} size="sm" asChild>
        <Link to="/library" aria-label={todo ? `导入已有漫画，${todo} 个文件夹待处理` : undefined}>
          <FolderInput data-icon="inline-start" />导入已有漫画
          {todo > 0 && <span aria-hidden className="rounded-full bg-seal-soft px-1.5 text-[11px] leading-4.5 font-semibold text-seal tabular-nums">{todo}</span>}
        </Link>
      </Button>}
    </PageHeader>

    {status && <QueueBanner status={status} reserveMB={reserve} />}
    {status ? <StatusStrip status={status} reserveMB={reserve} subscribed={subscribed} /> : <Skeleton className="h-[72px] rounded-2xl max-sm:h-16" />}
    {status && entries && !entries.length && <Onboarding status={status} />}

    {/* An empty shelf shows the guide above instead of a cover wall; the activity then runs full width. */}
    <div className={cn('grid grid-cols-1 items-start gap-x-10 gap-y-8', entries?.length !== 0 && 'xl:grid-cols-[minmax(0,1fr)_300px]')}>
      <section aria-label="漫画" className="flex min-w-0 flex-col gap-5">
        {!!entries?.length && <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="-mx-1 overflow-x-auto px-1 py-1 no-scrollbar">
            <ToggleGroup type="single" variant="segmented" aria-label="筛选漫画" value={filter} onValueChange={value => value && setFilter(value as Filter)}>
              {FILTERS.map(item => {
                const count = matched.filter(item.test).length;
                return <ToggleGroupItem key={item.value} value={item.value} className="px-3" aria-label={`${item.label} ${count}`}>
                  {item.label}<span key={count} className="inline-block min-w-3 animate-tick text-xs text-muted-foreground tabular-nums">{count}</span>
                </ToggleGroupItem>;
              })}
            </ToggleGroup>
          </div>
          <InputGroup className="sm:w-60">
            <InputGroupAddon><Search /></InputGroupAddon>
            <InputGroupInput ref={search} type="search" aria-label="在书架中搜索" placeholder="搜索书名或作者" value={q} onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ(''); } }} />
            {q && <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="清除搜索" onClick={() => { setQ(''); search.current?.focus(); }}><X /></InputGroupButton>
            </InputGroupAddon>}
          </InputGroup>
        </div>}

        {shelf.error ? <ErrorState error={shelf.error} onRetry={() => void shelf.refetch()} />
          : !entries ? <Loading label="正在读取书架…">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-5 gap-y-7 max-sm:grid-cols-3 max-sm:gap-x-3">
              {Array.from({ length: 8 }, (_, i) => <div key={i} className="flex flex-col gap-2.5"><Skeleton className="aspect-[3/4] rounded-xl" /><Skeleton className="h-3.5 w-4/5" /><Skeleton className="h-3 w-1/2" /></div>)}
            </div>
          </Loading>
          : !entries.length ? status ? null : <EmptyState icon={<LibraryBig />} title="书架是空的" description="订阅一部漫画，或者下载几卷，它就会出现在这里。" className="border">
            <Button asChild><Link to="/discover"><Compass data-icon="inline-start" />去发现漫画</Link></Button>
          </EmptyState>
          : !visible.length ? <EmptyState icon={<SearchX />} title="没有符合条件的漫画" description={q ? `书架里没有和「${q}」相关的漫画。` : '换个筛选条件看看。'} className="border">
            <Button variant="outline" onClick={() => { setFilter('all'); setQ(''); search.current?.focus(); }}>清除筛选</Button>
          </EmptyState>
          : <div role="status" aria-live="polite" className="sr-only">{q || filter !== 'all' ? `找到 ${visible.length} 部` : ''}</div>}
        {!!visible.length && <ul aria-label="漫画列表" className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-5 gap-y-7 max-sm:grid-cols-3 max-sm:gap-x-3 max-sm:gap-y-5">
          {visible.map((entry, index) => <li key={entry.comic.key} className="min-w-0"><ComicCard entry={entry} index={index} /></li>)}
        </ul>}
      </section>
      <ActivityFeed className={cn('xl:sticky xl:top-8', entries?.length === 0 && 'max-w-2xl')} />
    </div>
  </Page>;
}
