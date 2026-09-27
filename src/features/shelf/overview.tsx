// The shelf's status strip and the first-run guide.
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, Check, ChevronRight, CircleAlert, CircleCheck, Clock, Gauge, LoaderCircle, Pause, RefreshCw, type LucideIcon } from 'lucide-react';
import { cn } from 'cn';
import type { Status } from '@shared/model';
import { request } from '@/lib/api';
import { formatMB, formatSpeed, fromNow } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { PAUSE_LABELS, QuotaBar } from '@/components/app/status';

type Tone = 'muted' | 'seal' | 'warning' | 'destructive';
const TONES: Record<Tone, string> = { muted: 'bg-muted text-muted-foreground', seal: 'bg-seal-soft text-seal', warning: 'bg-warning-soft text-warning', destructive: 'bg-destructive/10 text-destructive' };
// Each cell is a size container: from 11rem it adds a detail at the trailing edge, from 17rem an icon; phones keep name and value.
const cell = '@container flex min-w-0 items-center gap-3.5 px-3.5 py-3 sm:px-5 sm:py-4';
const link = 'outline-none transition-colors duration-150 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

function Cell({ icon: Icon, tone = 'muted', spin, label, value, valueTone, detail, to }: {
  icon: LucideIcon; tone?: Tone; spin?: boolean; label: string; value: ReactNode; valueTone?: string; detail?: ReactNode; to?: boolean;
}) {
  return <>
    <span aria-hidden className={cn('hidden size-9 shrink-0 place-items-center rounded-[10px] @min-[17rem]:grid', TONES[tone])}><Icon className={cn('size-4.5', spin && 'animate-spin')} /></span>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex items-center gap-0.5 text-xs text-muted-foreground">{label}{to && <ChevronRight aria-hidden className="size-3 opacity-60" />}</span>
      <span className={cn('truncate text-[15px] leading-6 font-semibold tracking-tight tabular-nums', valueTone)}>{value}</span>
    </span>
    {detail && <span className="hidden shrink-0 flex-col items-end gap-1.5 text-xs text-muted-foreground tabular-nums @min-[11rem]:flex">{detail}</span>}
  </>;
}

/** Checks every subscription for new chapters now; spins while a check runs, and waits when nothing is subscribed. */
export function CheckAllButton({ status, subscribed, variant = 'outline', size = 'xs', className, children }: {
  status: Status; subscribed: number; variant?: 'outline' | 'ghost'; size?: 'xs' | 'icon-sm'; className?: string; children?: ReactNode;
}) {
  const check = useMutation({
    mutationFn: () => request('POST /api/checks/run'),
    onSuccess: ({ queued }) => void toast.success(queued ? `正在检查 ${queued} 部追更中的漫画` : '还没有追更中的漫画', { description: queued ? '发现新章节后会自动加入下载队列。' : undefined }),
  });
  const checking = status.checking || check.isPending;
  return <Button variant={variant} size={size} className={className} aria-label="立即检查全部" aria-disabled={checking || !subscribed}
    onClick={() => { if (!checking && subscribed) check.mutate(); }}>
    <RefreshCw className={cn(checking && 'animate-spin')} />{children}
  </Button>;
}

export function StatusStrip({ status, reserveMB, subscribed }: { status: Status; reserveMB?: number; subscribed: number }) {
  const now = useNow();
  const { queue, kmoe, checking } = status;
  const { running, queued, failed, completed } = queue.counts;
  const history = completed > 0 ? `已完成 ${completed}` : undefined;
  const low = kmoe.remainingMB !== null && reserveMB !== undefined && kmoe.remainingMB < reserveMB;

  return <section aria-label="概览" className="grid grid-cols-3 divide-x overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-border">
    <Link to="/downloads" className={cn(cell, link)}>
      {queue.paused ? <Cell to icon={Pause} tone="warning" label="下载队列" value="已暂停" valueTone="text-warning" detail={PAUSE_LABELS[queue.reason ?? 'manual']} />
        : running ? <Cell to icon={LoaderCircle} spin tone="seal" label="下载队列" value={`下载中 ${running}`}
          detail={<>{queue.speed > 0 && <span>{formatSpeed(queue.speed)}</span>}{queued > 0 && <span>等待 {queued}</span>}</>} />
        : queued ? <Cell to icon={Clock} label="下载队列" value={`等待 ${queued}`} detail={history} />
        : failed ? <Cell to icon={CircleAlert} tone="destructive" label="下载队列" value={`${failed} 个失败`} valueTone="text-destructive" detail={history} />
        : <Cell to icon={CircleCheck} label="下载队列" value="空闲" detail={history} />}
    </Link>
    <Link to="/settings/$section" params={{ section: 'account' }} className={cn(cell, link)}>
      <Cell to icon={Gauge} tone={kmoe.state === 'expired' ? 'destructive' : low ? 'warning' : 'muted'} label="Kmoe 额度"
        value={kmoe.state === 'none' ? '未登录' : kmoe.state === 'expired' ? '登录失效' : kmoe.remainingMB === null ? '未知' : formatMB(kmoe.remainingMB)}
        valueTone={kmoe.state === 'expired' ? 'text-destructive' : low ? 'text-warning' : undefined}
        detail={kmoe.state === 'active' && kmoe.remainingMB !== null
          ? <><QuotaBar kmoe={kmoe} className="w-20" />{reserveMB !== undefined && <span>保留 {formatMB(reserveMB)}</span>}</>
          : kmoe.state === 'none' ? '登录后才能下载' : kmoe.state === 'expired' ? '重新登录后继续' : undefined} />
    </Link>
    <div className={cell}>
      <Cell icon={checking ? LoaderCircle : CalendarClock} spin={checking} tone={checking ? 'seal' : 'muted'} label="下次检查"
        value={<span aria-live="polite">{checking ? '检查中…' : status.nextCheckAt ? fromNow(status.nextCheckAt, now) : subscribed ? '未安排' : '—'}</span>} />
      {/* Phones have this button in the top bar; narrow cells show it as an icon, wide ones with its name. */}
      <CheckAllButton status={status} subscribed={subscribed} className="size-7 px-0 max-md:hidden @min-[11rem]:w-auto @min-[11rem]:px-2">
        <span className="hidden @min-[11rem]:inline">立即检查</span>
      </CheckAllButton>
    </div>
  </section>;
}

function Step({ index, done, title, description, action }: { index: number; done: boolean; title: string; description: string; action: ReactNode }) {
  return <li className="flex min-w-0 flex-1 gap-3.5 px-5 py-4">
    <span aria-hidden className={cn('grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums ring-1',
      done ? 'bg-success-soft text-success ring-success/25' : 'bg-card text-foreground ring-border')}>
      {done ? <Check className="size-3.5" strokeWidth={2.5} /> : index}
    </span>
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <span className={cn('font-medium', done && 'text-muted-foreground line-through decoration-foreground/25')}>{title}<span className="sr-only">{done ? '（已完成）' : ''}</span></span>
      <span className="text-xs leading-relaxed text-muted-foreground">{description}</span>
      {!done && action}
    </div>
  </li>;
}

/** First run: three steps from nothing to the first comic, plus the extension import. */
export function Onboarding({ status }: { status: Status }) {
  const kmoe = status.kmoe.state === 'active';
  return <section aria-labelledby="onboarding-title" className="relative overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-border">
    <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-72 tone [mask-image:linear-gradient(to_left,black,transparent)]" />
    <div className="relative flex flex-col gap-1 px-5 pt-5">
      <h2 id="onboarding-title" className="text-[15px] font-semibold tracking-tight">三步开始</h2>
      <p className="text-xs text-muted-foreground">书架还是空的。登录 Kmoe、确认保存位置，再去找第一部漫画。</p>
    </div>
    <ol className="relative flex flex-col divide-y md:flex-row md:divide-x md:divide-y-0">
      <Step index={1} done={kmoe} title="登录 Kmoe" description="用于搜索和下载，密码只用一次，不会保存。"
        action={<Button size="xs" variant="outline" asChild><Link to="/settings/$section" params={{ section: 'account' }}>去登录<ChevronRight data-icon="inline-end" /></Link></Button>} />
      <Step index={2} done={status.targets > 0} title="确认保存位置" description="默认已有「本地书库」，也可以添加 WebDAV。"
        action={<Button size="xs" variant="outline" asChild><Link to="/settings/$section" params={{ section: 'storage' }}>存储位置<ChevronRight data-icon="inline-end" /></Link></Button>} />
      <Step index={3} done={false} title="找一部漫画" description="搜索书名，或粘贴 Kmoe 漫画页链接。"
        action={<Button size="xs" variant="outline" asChild><Link to="/discover">去发现<ChevronRight data-icon="inline-end" /></Link></Button>} />
    </ol>
    <p className="relative border-t bg-muted/35 px-5 py-3 text-xs text-muted-foreground">
      用过浏览器扩展？<Link to="/settings/$section" params={{ section: 'storage' }} hash="import" className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">导入扩展配置</Link>，WebDAV 书库和命名规则一次迁移。
    </p>
  </section>;
}
