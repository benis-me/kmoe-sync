import { useState, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import { cn } from 'cn';
import { followedTypes, type ComicDetail } from '@shared/model';
import { fromNow } from '@/lib/format';
import { aiSettingsQuery } from '@/lib/queries';
import { useAssistant } from '@/stores/assistant';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Cover } from '@/components/app/cover';
import { Dot } from '@/components/app/status';

/** Cover, title, authors and status; the description and actions sit beside the cover on wide screens, below it on phones. */
export function ComicHeader({ detail, kmoeUrl, refreshing, onRefresh, titleRef }: {
  detail: ComicDetail; kmoeUrl: string; refreshing: boolean; onRefresh: () => void; titleRef: RefObject<HTMLHeadingElement | null>;
}) {
  const { comic, subscription, items } = detail;
  const [expanded, setExpanded] = useState(false);
  // New items of the kinds followed, counted like the shelf.
  const followed = followedTypes(subscription?.types, items.filter(item => detail.states[item.id]?.state === 'downloaded').map(item => item.type));
  const fresh = items.filter(item => item.isNew && followed.includes(item.type)).length;
  const long = (comic.description?.length ?? 0) > 90;
  const { data: aiReady = false } = useQuery({ ...aiSettingsQuery, select: settings => settings.ready });
  const askAi = useAssistant(state => state.show);
  return <header className="relative grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-4 sm:gap-x-6 md:gap-x-8 md:gap-y-3">
    <div aria-hidden className="pointer-events-none absolute -top-10 -left-12 h-56 w-96 tone [mask-image:radial-gradient(ellipse_at_top_left,black_10%,transparent_65%)] max-md:hidden" />
    <Cover src={comic.cover} title={comic.title} className="relative w-24 rounded-xl shadow-float sm:w-32 md:row-span-3 md:w-40" />
    <div className="relative flex min-w-0 flex-col gap-3 self-center md:self-start md:pt-1">
      <div className="flex flex-col gap-1.5">
        <h1 ref={titleRef} className="text-[21px] leading-tight font-semibold tracking-tight text-balance sm:text-[26px] md:text-[28px]">{comic.title}</h1>
        <p className="text-sm text-muted-foreground">{comic.authors.join(' / ') || '作者未知'}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {comic.status && <Badge variant="muted">{comic.status}</Badge>}
        {comic.latest && <Badge variant="outline" className="text-muted-foreground">最新 {comic.latest}</Badge>}
        <a href="#subscription" className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Badge variant="outline" className={cn(!subscription?.enabled && 'text-muted-foreground')}>
            <Dot tone={subscription?.enabled ? 'ink' : 'muted'} className="size-1.5" />
            {subscription ? subscription.enabled ? '追更中' : '追更已暂停' : '未订阅'}
          </Badge>
        </a>
        {fresh > 0 && <Badge variant="seal">新 {fresh}</Badge>}
      </div>
    </div>
    {comic.description && <div className="relative col-span-2 max-w-2xl text-sm leading-relaxed text-foreground/80 md:col-span-1 md:col-start-2">
      <p className={cn(!expanded && 'line-clamp-2 md:line-clamp-3')}>{comic.description}</p>
      {long && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}
        className="mt-1 rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{expanded ? '收起' : '展开'}</button>}
    </div>}
    <div className="relative col-span-2 flex flex-wrap items-center gap-2 self-end md:col-span-1 md:col-start-2">
      <Button variant="outline" size="sm" asChild>
        <a href={kmoeUrl} target="_blank" rel="noreferrer"><ExternalLink data-icon="inline-start" />在 Kmoe 打开</a>
      </Button>
      <Button variant="ghost" size="sm" className="text-muted-foreground" aria-disabled={refreshing} onClick={() => { if (!refreshing) onRefresh(); }}>
        {refreshing ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
        {refreshing ? '正在刷新…' : <>刷新<span className="text-muted-foreground max-sm:hidden"> · {fromNow(comic.fetchedAt)}获取</span></>}
      </Button>
      {/* The floating AI 助手 button is not shown on this full-screen page. */}
      {aiReady && <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => askAi()}><Sparkles data-icon="inline-start" />问 AI</Button>}
    </div>
  </header>;
}
