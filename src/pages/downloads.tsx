// 下载: the queue with status filters and counts, live rows, and the bulk actions.
import { Link, getRouteApi } from '@tanstack/react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { Ban, CircleCheck, Compass, Download, LoaderCircle, Pause, RotateCcw, Trash2 } from 'lucide-react';
import type { QueueCounts, TaskStatus } from '@shared/model';
import { request } from '@/lib/api';
import { useMediaQuery } from '@/lib/hooks';
import { settingsQuery, statusQuery, tasksQuery } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ConfirmAction, EmptyState, ErrorState, Loading } from '@/components/app/feedback';
import { Page, PageHeader } from '@/components/app/page';
import { QueueBanner } from '@/components/app/queue-banner';
import { TaskRow } from '@/features/downloads/task-row';

const route = getRouteApi('/_app/downloads');
type Filter = Exclude<TaskStatus, 'cancelled'> | 'all';
const RANK: Record<TaskStatus, number> = { running: 0, queued: 1, failed: 2, completed: 3, cancelled: 3 };
const FILTERS: { value: Filter; label: string; count: (c: QueueCounts) => number; empty: string }[] = [
  { value: 'all', label: '全部', count: c => c.queued + c.running + c.completed + c.failed + c.cancelled, empty: '还没有下载任务' },
  { value: 'running', label: '进行中', count: c => c.running, empty: '没有正在下载的任务' },
  { value: 'queued', label: '等待', count: c => c.queued, empty: '没有等待中的任务' },
  { value: 'failed', label: '失败', count: c => c.failed, empty: '没有失败的任务' },
  { value: 'completed', label: '已完成', count: c => c.completed, empty: '还没有完成的下载' },
];

export function DownloadsPage() {
  const { status: filter = 'all' } = route.useSearch();
  const navigate = route.useNavigate();
  const client = useQueryClient();
  const { data: status } = useQuery(statusQuery);
  const { data: reserve } = useQuery({ ...settingsQuery, select: settings => settings.quotaReserveMB });
  const tasks = useInfiniteQuery(tasksQuery(filter === 'all' ? {} : { status: filter }));
  const counts = status?.queue.counts ?? tasks.data?.pages[0]?.counts;
  // A queue reads top-down: what runs now, what runs next (oldest first), then what needs attention, then history.
  const list = (tasks.data?.pages.flatMap(page => page.tasks) ?? [])
    .sort((a, b) => RANK[a.status] - RANK[b.status] || (RANK[a.status] < 2 ? a.id - b.id : b.id - a.id));

  const after = () => { void client.invalidateQueries({ queryKey: ['tasks'] }); void client.invalidateQueries({ queryKey: ['status'] }); };
  const pause = useMutation({
    mutationFn: () => request('POST /api/queue/pause'),
    onSuccess: state => { client.setQueryData(statusQuery.queryKey, old => old && { ...old, queue: state }); toast.success('队列已暂停', { description: '正在进行的下载会继续完成。' }); },
  });
  const retryFailed = useMutation({
    mutationFn: () => request('POST /api/tasks/retry-failed'),
    onSuccess: ({ retried }) => { toast.success(`已重新加入 ${retried} 个任务`); after(); },
  });
  const cancelQueued = useMutation({
    mutationFn: () => request('POST /api/tasks/cancel-queued'),
    onSuccess: ({ cancelled }) => { toast.success(cancelled ? `已取消 ${cancelled} 个等待中的任务` : '没有等待中的任务'); after(); },
  });
  const clearFinished = useMutation({
    mutationFn: () => request('POST /api/tasks/clear-finished'),
    onSuccess: ({ removed }) => { toast.success(removed ? `已清除 ${removed} 条记录` : '没有可清除的记录'); after(); },
  });
  const current = FILTERS.find(item => item.value === filter)!;
  const paused = !!status?.queue.paused;
  const phone = !useMediaQuery('(min-width: 768px)');

  return <Page>
    <PageHeader title="下载">
      {/* While paused, the banner below explains why and offers the way back. */}
      {/* Phones show these in the top bar, as icons. */}
      {status && !paused && <Button variant={phone ? 'ghost' : 'outline'} size={phone ? 'icon-sm' : 'sm'} aria-label="暂停队列" aria-disabled={pause.isPending} onClick={() => { if (!pause.isPending) pause.mutate(); }}>
        {pause.isPending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Pause data-icon="inline-start" />}{!phone && '暂停队列'}
      </Button>}
      {!!counts?.failed && <Button variant={phone ? 'ghost' : 'outline'} size="sm" aria-disabled={retryFailed.isPending} onClick={() => { if (!retryFailed.isPending) retryFailed.mutate(); }}>
        <RotateCcw data-icon="inline-start" /><span className="max-md:sr-only">重试全部失败</span><span className="text-muted-foreground tabular-nums">{counts.failed}</span>
      </Button>}
      {!!counts?.queued && <ConfirmAction title={`取消全部 ${counts.queued} 个等待中的任务？`} description="正在下载的会继续完成。订阅的卷取消后不会再自动补齐，可以在列表中重试。"
        action="全部取消" cancel="保留" onConfirm={() => cancelQueued.mutate()}>
        <Button variant="ghost" size="sm" className="text-muted-foreground" aria-disabled={cancelQueued.isPending}>
          <Ban data-icon="inline-start" /><span className="max-md:sr-only">取消全部等待</span><span className="tabular-nums">{counts.queued}</span>
        </Button>
      </ConfirmAction>}
      {!!counts?.completed && <ConfirmAction title="清除已完成的记录？" description="只清除列表里的记录，书库中的文件不受影响。" action="清除" onConfirm={() => clearFinished.mutate()}>
        <Button variant="ghost" size={phone ? 'icon-sm' : 'sm'} aria-label="清除已完成" className="text-muted-foreground"><Trash2 data-icon="inline-start" />{!phone && '清除已完成'}</Button>
      </ConfirmAction>}
    </PageHeader>

    {status && <QueueBanner status={status} reserveMB={reserve} />}

    <div className="flex flex-col gap-4">
      <div className="-mx-1 overflow-x-auto px-1 py-1 no-scrollbar edge-fade-x">
        <ToggleGroup type="single" variant="segmented" aria-label="按状态筛选" value={filter}
          onValueChange={value => value && void navigate({ search: { status: value === 'all' ? undefined : value as Exclude<Filter, 'all'> }, replace: true })}>
          {FILTERS.map(item => {
            const count = counts ? item.count(counts) : undefined;
            return <ToggleGroupItem key={item.value} value={item.value} className="px-2.5 sm:px-3" aria-label={count === undefined ? item.label : `${item.label} ${count}`}>
              {item.label}{count !== undefined && <span key={count} className="inline-block min-w-3 animate-tick text-xs text-muted-foreground tabular-nums">{count}</span>}
            </ToggleGroupItem>;
          })}
        </ToggleGroup>
      </div>

      {tasks.error ? <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />
        : !tasks.data ? <Loading label="正在读取下载队列…">
          <div className="flex flex-col divide-y overflow-hidden rounded-2xl bg-card ring-1 ring-border">
            {[0, 1, 2, 3, 4].map(i => <div key={i} className="flex gap-4 px-4 py-3.5" style={{ opacity: 1 - i * 0.15 }}><Skeleton className="h-13 w-10 rounded-md" /><div className="flex flex-1 flex-col gap-2 pt-1"><Skeleton className="h-3.5 w-1/3" /><Skeleton className="h-3 w-1/2" /></div></div>)}
          </div>
        </Loading>
        : !list.length ? filter === 'all'
          ? <EmptyState icon={<Download />} title={current.empty} description="在漫画页选择章节并开始下载，或者订阅追更，任务会出现在这里。" className="border">
            <Button variant="outline" asChild><Link to="/">去书架</Link></Button>
            <Button variant="outline" asChild><Link to="/discover"><Compass data-icon="inline-start" />去发现</Link></Button>
          </EmptyState>
          : <EmptyState icon={<CircleCheck />} title={current.empty} className="border">
            <Button variant="outline" onClick={() => void navigate({ search: {}, replace: true })}>查看全部</Button>
          </EmptyState>
        : <>
          <ul aria-label={`${current.label}的任务`} className="flex flex-col divide-y overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-border">
            <AnimatePresence initial={false}>
              {list.map(task => <TaskRow key={task.id} task={task} />)}
            </AnimatePresence>
          </ul>
          {tasks.hasNextPage && <Button variant="outline" className="self-center" aria-disabled={tasks.isFetchingNextPage} onClick={() => { if (!tasks.isFetchingNextPage) void tasks.fetchNextPage(); }}>
            {tasks.isFetchingNextPage && <LoaderCircle data-icon="inline-start" className="animate-spin" />}加载更多
          </Button>}
        </>}
    </div>
  </Page>;
}
