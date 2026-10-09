import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { CircleAlert, CircleCheck, Gauge, Info, KeyRound, ListChecks, Pause, Play, Sparkles, type LucideIcon } from 'lucide-react';
import { cn } from 'cn';
import type { Activity } from '@shared/model';
import { fromNow } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { activityQuery } from '@/lib/queries';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, Loading } from '@/components/app/feedback';
import { SectionHeading } from '@/components/app/page';

const ICONS: Record<Activity['kind'], LucideIcon> = {
  new_items: Sparkles, download_done: CircleCheck, download_failed: CircleAlert, check_failed: CircleAlert,
  session_expired: KeyRound, session_restored: KeyRound, quota_low: Gauge, queue_paused: Pause, queue_resumed: Play,
  source_synced: ListChecks, info: Info,
};
const TONES: Record<Activity['level'], string> = {
  info: 'bg-muted text-muted-foreground', success: 'bg-muted text-foreground/70', warning: 'bg-warning-soft text-warning', error: 'bg-destructive/10 text-destructive',
};

function Entry({ activity, now }: { activity: Activity; now: number }) {
  const Icon = ICONS[activity.kind];
  const body = <>
    <span aria-hidden className={cn('relative z-10 mt-0.5 grid size-6 shrink-0 place-items-center rounded-full ring-4 ring-background', TONES[activity.level])}><Icon className="size-3.5" /></span>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-[13px] font-medium">{activity.title}</span>
        <time dateTime={activity.createdAt} className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{fromNow(activity.createdAt, now)}</time>
      </span>
      {activity.detail && <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{activity.detail}</span>}
    </span>
  </>;
  const row = 'flex gap-3 rounded-lg px-2 py-2';
  return activity.comicKey
    ? <Link to="/comics/$key" params={{ key: activity.comicKey }} className={cn(row, 'outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring')}>{body}</Link>
    : <div className={row}>{body}</div>;
}

export function ActivityFeed({ className }: { className?: string }) {
  const { data, error, refetch } = useQuery(activityQuery);
  const now = useNow();
  return <section aria-labelledby="activity-title" className={cn('flex flex-col gap-2', className)}>
    <SectionHeading id="activity-title" title="最近动态" className="px-2" />
    {error ? <ErrorState error={error} onRetry={() => void refetch()} className="min-h-48" />
      : !data ? <Loading label="正在读取动态…"><div className="flex flex-col gap-4 px-2 pt-2">{[0, 1, 2, 3, 4].map(i => <div key={i} className="flex gap-3"><Skeleton className="size-6 rounded-full" /><div className="flex flex-1 flex-col gap-1.5"><Skeleton className="h-3.5 w-3/4" /><Skeleton className="h-3 w-1/2" /></div></div>)}</div></Loading>
      : !data.length ? <p className="rounded-xl border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">发现新章节、下载完成或失败时，会记录在这里。</p>
      : <ol className={cn('relative flex flex-col', data.length > 1 && 'before:absolute before:top-4 before:bottom-4 before:left-5 before:w-px before:bg-border')}>
        <AnimatePresence initial={false}>
          {data.slice(0, 12).map(activity => <motion.li key={activity.id} layout="position" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Entry activity={activity} now={now} />
          </motion.li>)}
        </AnimatePresence>
      </ol>}
  </section>;
}
