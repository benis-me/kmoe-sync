// AI 整理: the AI-tidied summary and tags of matched folders next to what Bangumi gives, to use or drop before anything
// goes to Komga (accepted ones are written at the next sync; dropping an accepted one writes Bangumi's back).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LoaderCircle, WandSparkles } from 'lucide-react';
import { cn } from 'cn';
import type { AiPolishItem, MetadataText } from '@shared/model';
import { errorMessage, request } from '@/lib/api';
import { aiPolishQuery, libraryQuery } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorState, Loading } from '@/components/app/feedback';
import { useClosable } from './pickers';

export function PolishBanner({ count, onOpen }: { count: number; onOpen: () => void }) {
  return <div className="flex animate-rise flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-dashed px-4 py-2.5">
    <WandSparkles aria-hidden className="size-4 shrink-0 text-seal" />
    <span className="min-w-0 flex-1 text-sm">AI 整理好了 {count} 部的简介和标签，确认后才会写入 Komga。</span>
    <Button variant="outline" size="sm" onClick={onOpen}>查看并确认</Button>
  </div>;
}

function Version({ label, text, ai }: { label: string; text: MetadataText; ai?: boolean }) {
  return <section aria-label={label} className="flex min-w-0 flex-col gap-2">
    <h4 className={cn('text-xs font-medium', ai ? 'text-seal' : 'text-muted-foreground')}>{label}</h4>
    <p className={cn('line-clamp-[8] text-[13px] leading-relaxed whitespace-pre-line', !ai && 'text-muted-foreground')}>{text.summary || '（没有简介）'}</p>
    {text.genres.length + text.tags.length > 0 && <ul aria-label="类型和标签" className="flex flex-wrap gap-1">
      {text.genres.map(genre => <li key={`g${genre}`} className="rounded-md bg-seal-soft px-1.5 py-0.5 text-[11px] text-seal">{genre}</li>)}
      {text.tags.map(tag => <li key={`t${tag}`} className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{tag}</li>)}
    </ul>}
  </section>;
}

const STATUS: Record<AiPolishItem['status'], string> = { pending: '', accepted: '已采用', rejected: '没有采用' };

export function PolishReview({ targetId, onClose }: { targetId: number; onClose: () => void }) {
  const client = useQueryClient();
  const { open, close } = useClosable(onClose);
  const items = useQuery(aiPolishQuery(targetId));
  const decide = useMutation({
    mutationFn: ({ ids, accept }: { ids: number[]; accept: boolean }) => request('POST /api/library/ai-polish/decide', { body: { folderIds: ids, accept } }),
    onSuccess: ({ updated }, { accept }) => {
      for (const queryKey of [aiPolishQuery(targetId).queryKey, libraryQuery(targetId).queryKey]) void client.invalidateQueries({ queryKey });
      if (updated) toast.success(accept ? `已采用 ${updated} 部` : `已改回 ${updated} 部 Bangumi 原来的版本`, { description: '下次同步到 Komga 时写入。' });
    },
    onError: error => toast.error(errorMessage(error)),
  });
  const list = items.data ?? [];
  const pending = list.filter(item => item.status === 'pending');
  const busy = (id: number) => decide.isPending && decide.variables.ids.includes(id);

  return <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
    <DialogContent className="flex max-h-[min(860px,calc(100dvh-32px))] flex-col gap-4 sm:max-w-3xl">
      <DialogHeader className="pr-8">
        <DialogTitle>AI 整理的简介和标签</DialogTitle>
        <DialogDescription>左边是 Bangumi 原来的，右边是 AI 整理后的。采用的会在下次同步时写入 Komga，之后也可以改回来。</DialogDescription>
      </DialogHeader>
      {items.error ? <ErrorState error={items.error} onRetry={() => void items.refetch()} className="min-h-40" />
        : !items.data ? <Loading label="正在读取…"><div className="h-40" /></Loading>
        : !list.length ? <p className="py-10 text-center text-sm text-muted-foreground">还没有 AI 整理过的漫画。</p>
        : <ul className="-mx-1 flex-1 divide-y overflow-y-auto overscroll-contain px-1">
          {list.map(item => <li key={item.folderId} className="flex flex-col gap-3 py-4 first:pt-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium" title={item.path}>{item.title}</span>
              {STATUS[item.status] && <span className="shrink-0 text-xs text-muted-foreground">{STATUS[item.status]}</span>}
              {item.status !== 'rejected' && <Button variant="ghost" size="xs" className="text-muted-foreground" aria-disabled={busy(item.folderId)}
                onClick={() => { if (!busy(item.folderId)) decide.mutate({ ids: [item.folderId], accept: false }); }}>{item.status === 'accepted' ? '改回原来的' : '不用'}</Button>}
              {item.status !== 'accepted' && <Button variant="outline" size="xs" aria-disabled={busy(item.folderId)}
                onClick={() => { if (!busy(item.folderId)) decide.mutate({ ids: [item.folderId], accept: true }); }}>
                {busy(item.folderId) && decide.variables?.accept && <LoaderCircle data-icon="inline-start" className="animate-spin" />}采用
              </Button>}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Version label="原来" text={item.original} />
              <Version label="AI 整理后" text={item.polished} ai />
            </div>
          </li>)}
        </ul>}
      <DialogFooter>
        <Button variant="ghost" onClick={close}>关闭</Button>
        {pending.length > 0 && <Button aria-disabled={decide.isPending} onClick={() => { if (!decide.isPending) decide.mutate({ ids: pending.map(item => item.folderId), accept: true }); }}>
          {decide.isPending && pending.length > 1 && <LoaderCircle data-icon="inline-start" className="animate-spin" />}全部采用（{pending.length}）
        </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
