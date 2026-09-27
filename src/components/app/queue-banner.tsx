import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Hourglass, LoaderCircle, Pause, Sparkles, WifiOff } from 'lucide-react';
import type { Status } from '@shared/model';
import { request } from '@/lib/api';
import { formatMB } from '@/lib/format';
import { aiSettingsQuery, statusQuery } from '@/lib/queries';
import { useAssistant } from '@/stores/assistant';
import { throttledMinutes } from '@/components/app/status';
import { Button } from '@/components/ui/button';

/** The queue is paused: say why and offer the one action that resumes it. */
export function QueueBanner({ status, reserveMB }: { status: Status; reserveMB?: number }) {
  const client = useQueryClient();
  const { data: aiReady } = useQuery({ ...aiSettingsQuery, select: settings => settings.ready });
  const askAi = useAssistant(state => state.show);
  const resume = useMutation({
    mutationFn: () => request('POST /api/queue/resume'),
    onSuccess: queue => client.setQueryData(statusQuery.queryKey, old => old && { ...old, queue }),
  });
  if (!status.queue.paused) return null;
  const reason = status.queue.reason ?? 'manual';
  const copy = {
    manual: { title: '下载队列已暂停', detail: '暂停期间不会开始新的下载，正在进行的会继续完成。' },
    quota: {
      title: '额度不足，队列已暂停',
      detail: `剩余 ${status.kmoe.remainingMB === null ? '未知' : formatMB(status.kmoe.remainingMB)}${reserveMB !== undefined ? `，低于保留的 ${formatMB(reserveMB)}` : ''}。额度重置后会自动继续。`,
    },
    auth: { title: 'Kmoe 登录已失效，队列已暂停', detail: '重新登录 Kmoe 后，队列会自动继续。' },
    network: { title: '网络中断，队列已暂停', detail: '连不上 Kmoe 或下载服务器。网络恢复后会自动继续（每隔几分钟重试一次）。' },
    throttled: {
      title: 'Kmoe 限制了访问频率，队列已暂停',
      detail: `Kmoe 暂时把请求转到了别的网站。${(() => { const minutes = throttledMinutes(status.kmoe); return minutes ? `约 ${minutes} 分钟后` : '稍后'; })()}会自动继续，期间不会再请求 Kmoe。`,
    },
  }[reason];
  return <div role="status" className="flex animate-rise flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-warning/25 bg-warning-soft px-4 py-3">
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-card/70 text-warning">{reason === 'network' ? <WifiOff className="size-4" /> : reason === 'throttled' ? <Hourglass className="size-4" /> : <Pause className="size-4" />}</span>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="font-medium">{copy.title}</span>
      <span className="text-xs text-foreground/75">{copy.detail}</span>
    </div>
    {(reason === 'manual' || reason === 'network') && <Button variant="outline" size="sm" aria-disabled={resume.isPending} onClick={() => { if (!resume.isPending) resume.mutate(); }}>
      {resume.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}{reason === 'network' ? '立即重试' : '继续队列'}
    </Button>}
    {reason === 'quota' && <Button variant="outline" size="sm" asChild><Link to="/settings/$section" params={{ section: 'automation' }} hash="reserve">调整保留额度</Link></Button>}
    {reason === 'auth' && <Button variant="outline" size="sm" asChild><Link to="/settings/$section" params={{ section: 'account' }}>重新登录 Kmoe</Link></Button>}
    {aiReady && reason !== 'manual' && <Button variant="ghost" size="sm" onClick={() => askAi(`下载队列暂停了（${copy.title}），帮我看看是怎么回事、该怎么处理`)}>
      <Sparkles data-icon="inline-start" className="text-seal" />问问 AI
    </Button>}
  </div>;
}
