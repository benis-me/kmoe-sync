// Compact status pieces shared by the sidebar, the phone top bar and the shelf.
import { CircleAlert, CircleCheck, Clock, LoaderCircle, Pause } from 'lucide-react';
import { cn } from 'cn';
import type { KmoeAccount, PauseReason, QueueState } from '@shared/model';
import { formatMB, formatSpeed } from '@/lib/format';
import { mockScenario } from '@/mock';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export const PAUSE_LABELS: Record<PauseReason, string> = { manual: '手动暂停', quota: '额度不足', auth: 'Kmoe 登录失效', network: '网络中断', throttled: 'Kmoe 限流' };

/** Minutes until Kmoe lets this service make requests again, or null when it is not throttled. */
export function throttledMinutes(kmoe: KmoeAccount): number | null {
  const left = kmoe.throttledUntil ? Date.parse(kmoe.throttledUntil) - Date.now() : 0;
  return left > 0 ? Math.max(1, Math.ceil(left / 60_000)) : null;
}

export function Dot({ tone, className }: { tone: 'success' | 'warning' | 'destructive' | 'muted' | 'seal' | 'ink'; className?: string }) {
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', {
    success: 'bg-success', warning: 'bg-warning', destructive: 'bg-destructive', muted: 'bg-muted-foreground/45', seal: 'bg-seal', ink: 'bg-foreground/70',
  }[tone], className)} />;
}

export function kmoeLabel(kmoe: KmoeAccount) {
  const throttled = kmoe.state === 'active' ? throttledMinutes(kmoe) : null;
  if (throttled) return `Kmoe 限流中 · ${throttled} 分钟`;
  return kmoe.state === 'active' ? 'Kmoe 已连接' : kmoe.state === 'expired' ? 'Kmoe 登录失效' : '未登录 Kmoe';
}
export const kmoeTone = (kmoe: KmoeAccount) => kmoe.state === 'active' ? (throttledMinutes(kmoe) ? 'warning' : 'success') : kmoe.state === 'expired' ? 'destructive' : 'muted';

/** What the download queue is doing right now: icon, label, and a detail (speed or pause reason) on the right. */
export function QueueLine({ queue, className }: { queue: QueueState; className?: string }) {
  const { running, queued, failed } = queue.counts;
  const [Icon, tone, label, detail] = queue.paused ? [Pause, 'text-warning', '队列已暂停', PAUSE_LABELS[queue.reason ?? 'manual']] as const
    : running ? [LoaderCircle, 'animate-spin text-seal', `下载中 ${running}${queued ? ` · 等待 ${queued}` : ''}`, queue.speed > 0 ? formatSpeed(queue.speed) : ''] as const
    : queued ? [Clock, 'text-muted-foreground', `等待 ${queued}`, ''] as const
    : failed ? [CircleAlert, 'text-destructive', `${failed} 个任务失败`, ''] as const
    : [CircleCheck, 'text-muted-foreground', '队列空闲', ''] as const;
  return <span className={cn('flex min-w-0 flex-1 items-center gap-2.5', className)}>
    <Icon className={cn('size-4 shrink-0', tone)} />
    <span className="truncate tabular-nums">{label}</span>
    {detail && <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{detail}</span>}
  </span>;
}

/** Remaining quota as a thin bar in one calm ink colour: the length tells how much is left; low quota is named in words where it matters. */
export function QuotaBar({ kmoe, className }: { kmoe: KmoeAccount; className?: string }) {
  const total = (kmoe.free?.totalMB ?? 0) + (kmoe.vipQuota?.totalMB ?? 0);
  const remaining = kmoe.remainingMB ?? 0;
  return <span aria-hidden className={cn('relative block h-1 overflow-hidden rounded-full bg-foreground/8', className)}>
    <span className="absolute inset-y-0 left-0 rounded-full bg-foreground/70 transition-[width] duration-700 ease-out-strong"
      style={{ width: `${total > 0 ? Math.min(100, remaining / total * 100) : 0}%` }} />
  </span>;
}

export const quotaText = (kmoe: KmoeAccount) => kmoe.remainingMB === null ? '额度未知' : `剩余 ${formatMB(kmoe.remainingMB)}`;

export function MockBadge({ className }: { className?: string }) {
  if (!mockScenario()) return null;
  return <Tooltip>
    <TooltipTrigger asChild>
      <span tabIndex={0} className={cn('inline-flex h-5 shrink-0 cursor-default items-center rounded-full bg-seal-soft px-2 text-[11px] font-medium text-seal outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}>演示数据</span>
    </TooltipTrigger>
    <TooltipContent className="max-w-60">浏览器内的模拟数据，不会连接服务器或下载文件。地址加上 ?mock=off 可退出。</TooltipContent>
  </Tooltip>;
}
