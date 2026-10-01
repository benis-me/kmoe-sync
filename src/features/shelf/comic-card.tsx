import { memo, type CSSProperties } from 'react';
import { Link } from '@tanstack/react-router';
import { Tags } from 'lucide-react';
import { cn } from 'cn';
import type { ShelfEntry } from '@shared/model';
import { percent } from '@/lib/format';
import { Cover } from '@/components/app/cover';
import { Dot } from '@/components/app/status';

/** Cover-wall card: cover with the new-chapter count, title, author, download progress and one status line. */
export const ComicCard = memo(function ComicCard({ entry, index }: { entry: ShelfEntry; index: number }) {
  const { comic, subscription, counts } = entry;
  const complete = counts.items > 0 && counts.downloaded >= counts.items;
  const state = subscription ? subscription.enabled ? { tone: 'ink' as const, text: '追更中' } : { tone: 'muted' as const, text: '追更已暂停' }
    : complete ? { tone: 'muted' as const, text: '已全部下载' } : { tone: 'muted' as const, text: '未订阅' };
  // Metadata needing attention: a quiet mark, not a status of its own.
  const meta = entry.metadata;
  const flag = meta?.komga === 'error' ? { tone: 'text-destructive', label: 'Komga 同步失败' }
    : meta?.bangumi === 'suggested' ? { tone: 'text-warning', label: 'Bangumi 条目待确认' }
    : meta?.bangumi === 'unmatched' ? { tone: 'text-muted-foreground', label: 'Bangumi 上没有找到' } : null;
  return <Link to="/comics/$key" params={{ key: comic.key }} style={{ '--i': index } as CSSProperties}
    className="group/card stagger flex min-w-0 flex-col gap-2.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background">
    <div className="relative">
      <Cover src={comic.cover} title={comic.title} className="w-full rounded-xl transition-[translate,box-shadow] duration-200 ease-out-strong group-hover/card:-translate-y-0.5 group-hover/card:shadow-float" />
      {counts.new > 0 && <span className="absolute top-2 right-2 rounded-full bg-seal px-1.5 py-px text-[11px] font-semibold text-seal-foreground shadow-soft tabular-nums">新 {counts.new}</span>}
    </div>
    <div className="flex min-w-0 flex-col gap-1.5 px-0.5">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm leading-5 font-medium">{comic.title}</span>
        <span className="truncate text-xs text-muted-foreground">{comic.authors.join(' / ') || '作者未知'}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="sr-only">已下载 {counts.downloaded} 项，共 {counts.items} 项</span>
        <span aria-hidden className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/8">
          <span className="block h-full rounded-full bg-foreground/55" style={{ width: `${percent(counts.downloaded, counts.items)}%` }} />
        </span>
        <span aria-hidden className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{counts.downloaded}/{counts.items}</span>
      </div>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Dot tone={state.tone} className="size-1.5" />
        <span className="truncate">
          {state.text}
          {counts.failed > 0 ? <span className="text-destructive"> · 失败 {counts.failed}</span>
            : counts.queued > 0 && <span className="text-foreground/80"> · 下载 {counts.queued}</span>}
        </span>
        {flag && <span title={flag.label} className={cn('ml-auto shrink-0', flag.tone)}><Tags aria-hidden className="size-3" /><span className="sr-only">，{flag.label}</span></span>}
      </span>
    </div>
  </Link>;
});
