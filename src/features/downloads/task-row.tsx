import { memo } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Ban, Check, CircleAlert, Clock, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { cn } from 'cn';
import type { Task } from '@shared/model';
import { request } from '@/lib/api';
import { FORMAT_LABELS, formatDuration, formatSpeed, formatWhen, percent } from '@/lib/format';
import { formatBytes } from '@shared/naming';
import { useNow } from '@/lib/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Cover } from '@/components/app/cover';

const ORIGINS: Record<Task['origin'], string> = { manual: '手动', subscription: '追更', api: 'API' };
const PHASES: Record<NonNullable<Task['phase']>, string> = { resolving: '准备中', downloading: '下载中', uploading: '上传中', verifying: '校验中', waiting: '等待重试' };

function TaskBadge({ task, className }: { task: Task; className?: string }) {
  const waiting = task.status === 'queued' && task.phase === 'waiting';
  const style = waiting ? { variant: 'warning' as const, icon: RotateCcw, label: '等待重试' }
    : {
      queued: { variant: 'muted' as const, icon: Clock, label: '排队中' },
      running: { variant: 'secondary' as const, icon: LoaderCircle, label: task.phase ? PHASES[task.phase] : '下载中' },
      completed: { variant: 'muted' as const, icon: Check, label: '已完成' },
      failed: { variant: 'destructive' as const, icon: CircleAlert, label: '失败' },
      cancelled: { variant: 'muted' as const, icon: Ban, label: '已取消' },
    }[task.status];
  const Icon = style.icon;
  return <Badge variant={style.variant} className={className}><Icon data-icon="inline-start" className={cn(task.status === 'running' && 'animate-spin')} />{style.label}</Badge>;
}

function RetryLine({ task }: { task: Task }) {
  const now = useNow(1000);
  const seconds = task.retryAt ? Math.max(0, Math.ceil((Date.parse(task.retryAt) - now) / 1000)) : 0;
  return <p className="flex min-w-0 items-start gap-1.5 text-xs text-warning">
    <RotateCcw className="mt-px size-3.5 shrink-0" />
    <span className="min-w-0 break-words tabular-nums">{task.error ?? '暂时失败'} · 第 {task.attempt} 次重试 · {seconds > 0 ? `${seconds} 秒后` : '即将开始'}</span>
  </p>;
}

function Transfer({ task }: { task: Task }) {
  const total = task.total ?? 0;
  const eta = task.speed > 0 && total > task.loaded ? formatDuration((total - task.loaded) / task.speed) : '';
  const phase = task.phase === 'uploading' ? `上传到 ${task.targetName}` : task.phase ? PHASES[task.phase] : '下载中';
  return <div className="flex flex-col gap-1.5 pt-1.5">
    <Progress value={percent(task.loaded, total)} active aria-label={`${task.comicTitle} ${task.itemName} 进度`} className="h-1" />
    <p className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground tabular-nums">
      <span className="min-w-0 break-words">{phase}{total > 0 && task.phase !== 'resolving' ? ` · ${formatBytes(task.loaded)} / ${formatBytes(total)}` : ''}</span>
      <span className="shrink-0">{task.speed > 0 && formatSpeed(task.speed)}{eta && ` · 剩余 ${eta}`}</span>
    </p>
  </div>;
}

export const TaskRow = memo(function TaskRow({ task }: { task: Task }) {
  const client = useQueryClient();
  const action = useMutation({
    mutationFn: (kind: 'cancel' | 'retry') => request(kind === 'cancel' ? 'POST /api/tasks/:id/cancel' : 'POST /api/tasks/:id/retry', { params: { id: task.id } }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['tasks'] }); void client.invalidateQueries({ queryKey: ['comic', task.comicKey] }); },
  });
  const active = task.status === 'queued' || task.status === 'running';
  const name = `${task.comicTitle} ${task.itemName}`;
  const meta = [FORMAT_LABELS[task.format], task.targetName, ORIGINS[task.origin],
    task.finishedAt ? formatWhen(task.finishedAt) : task.startedAt ? `开始于 ${formatWhen(task.startedAt)}` : `加入于 ${formatWhen(task.createdAt)}`].join(' · ');
  // Leaving, the row folds its height while it fades, so the rows below slide up into its place instead of jumping.
  return <motion.li layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3.5 overflow-hidden px-4 py-3 sm:gap-x-4">
    <Cover src={task.cover} title={task.comicTitle} className="w-9 rounded-md" />
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="-m-1 truncate p-1 text-sm font-medium">
        <Link to="/comics/$key" params={{ key: task.comicKey }} className="rounded-sm decoration-foreground/30 underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{task.comicTitle}</Link>
        <span className="text-muted-foreground"> · </span>{task.itemName}
      </p>
      <p className="text-xs text-muted-foreground tabular-nums sm:truncate" title={meta}>{meta}</p>
      <TaskBadge task={task} className="mt-1 sm:hidden" />
      {task.status === 'running' && <Transfer task={task} />}
      {task.status === 'queued' && task.phase === 'waiting' && <RetryLine task={task} />}
      {task.status === 'failed' && <p className="flex min-w-0 items-start gap-1.5 text-xs text-destructive">
        <CircleAlert className="mt-px size-3.5 shrink-0" /><span className="min-w-0 break-words">{task.error ?? '下载失败'}{task.attempt > 1 && <span className="text-muted-foreground"> · 已重试 {task.attempt - 1} 次</span>}</span>
      </p>}
      {task.status === 'completed' && task.path && <p className="truncate font-mono text-[11px] text-muted-foreground" title={task.path}>{task.path}</p>}
    </div>
    <div className="-mr-1.5 flex items-center gap-1">
      <TaskBadge task={task} className="mr-1.5 max-sm:hidden" />
      {task.status === 'completed' && task.total ? <span className="mr-1.5 text-xs text-muted-foreground tabular-nums max-sm:hidden">{formatBytes(task.total)}</span> : null}
      {active && <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`取消 ${name}`} aria-disabled={action.isPending}
        onClick={() => { if (!action.isPending) action.mutate('cancel'); }}><X /></Button>}
      {(task.status === 'failed' || task.status === 'cancelled') && <Button variant="outline" size="xs" aria-label={`重试 ${name}`} aria-disabled={action.isPending}
        onClick={() => { if (!action.isPending) action.mutate('retry'); }}>
        {action.isPending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RotateCcw data-icon="inline-start" />}重试
      </Button>}
    </div>
  </motion.li>;
});
