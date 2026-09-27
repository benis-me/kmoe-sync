// 元数据: the Bangumi subject of this comic's folder and its Komga series, with the picker and a sync button.
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowUpRight, Check, LoaderCircle, RefreshCw, Settings2, Sparkles, Tags } from 'lucide-react';
import { cn } from 'cn';
import type { ComicDetail, LibraryFolder, MetadataSettings } from '@shared/model';
import { request } from '@/lib/api';
import { fromNow } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardFooter } from '@/components/ui/card';
import { Cover } from '@/components/app/cover';
import { Dot } from '@/components/app/status';
import { BangumiDialog, BangumiUnavailable } from '@/features/library/pickers';
import { applyFolder, bestOf, percentOf } from '@/features/library/state';

const SOURCES = { auto: '自动匹配', manual: '手动选择', komga: '来自 Komga 的 Bangumi 链接', ai: 'AI 判定' } as const;
const link = 'rounded-sm font-medium text-foreground/80 underline decoration-foreground/25 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring';

function Shell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return <Card id="metadata" className="scroll-mt-20 gap-0 py-0">
    <div className="flex flex-col gap-0.5 px-5 pt-5">
      <h2 className="text-[15px] font-semibold tracking-tight">元数据</h2>
      <p className="text-xs leading-relaxed text-muted-foreground">Bangumi 的简介和标签，同步到 Komga。</p>
    </div>
    <div className="flex flex-col gap-4 px-5 pt-4 pb-5">{children}</div>
    {footer && <CardFooter className="flex-wrap gap-2 px-5 py-3.5">{footer}</CardFooter>}
  </Card>;
}

export function MetadataCard({ detail, settings }: { detail: ComicDetail; settings: MetadataSettings | undefined }) {
  const client = useQueryClient();
  const [picking, setPicking] = useState(false);
  const { folder, metadata } = detail;
  const folderId = folder?.folderId ?? null;
  const done = (next: LibraryFolder) => applyFolder(client, next);
  const sync = useMutation({
    mutationFn: () => request('POST /api/library/folders/:id/sync', { params: { id: folderId! } }),
    onSuccess: next => {
      done(next);
      const { state, error } = next.metadata.komga;
      if (state === 'error') toast.error('同步到 Komga 失败', { description: error ?? undefined });
      else if (state === 'not_found') toast.warning('Komga 里没有找到这个系列', { description: '先让 Komga 扫描书库，再同步。' });
      else toast.success('已同步到 Komga');
    },
  });
  const choose = useMutation({
    mutationFn: (body: { subject: string } | { auto: true }) => request('POST /api/library/folders/:id/bangumi', { params: { id: folderId! }, body }),
    onSuccess: next => {
      done(next);
      const { state, subject } = next.metadata.bangumi;
      if (state === 'matched' && subject) toast.success(`已选择「${subject.nameCn || subject.name}」`);
      else if (state === 'suggested') toast.info('找到几个可能的条目，请确认');
      else toast.warning('Bangumi 上没有找到这部漫画', { description: '可以手动搜索，或粘贴 bgm.tv 链接。' });
    },
  });

  if (!settings) return null;
  if (!settings.enabled) return <Shell>
    <p className="text-sm leading-relaxed text-muted-foreground">还没有开启 Komga 元数据。开启后，这部漫画的简介、标签和单册信息会自动写入 Komga。</p>
    <Button variant="outline" size="sm" className="self-start" asChild><Link to="/settings/$section" params={{ section: 'metadata' }}><Settings2 data-icon="inline-start" />设置 Komga 元数据</Link></Button>
  </Shell>;
  if (!metadata) return <Shell>
    <p className="text-sm leading-relaxed text-muted-foreground">文件夹还不存在：下载后即可同步元数据。</p>
  </Shell>;

  const { bangumi, komga } = metadata;
  const subject = bangumi.subject;
  const best = bestOf(bangumi.candidates);
  const editable = folderId !== null;
  const busy = choose.isPending;
  const canSync = editable && komga.state !== 'disabled' && bangumi.state === 'matched';

  return <Shell footer={<>
    <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" disabled={!editable} onClick={() => setPicking(true)}>
      <Tags data-icon="inline-start" />{subject ? '更换条目…' : '选择条目…'}
    </Button>
    <Button variant="outline" size="sm" className="ml-auto" disabled={!canSync} aria-disabled={sync.isPending} onClick={() => { if (!sync.isPending) sync.mutate(); }}>
      {sync.isPending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}同步到 Komga
    </Button>
  </>}>
    {bangumi.state === 'matched' && subject ? <div className="flex gap-3.5">
      <Cover src={subject.cover} title={subject.nameCn || subject.name} className="w-14 rounded-md" />
      <div className="flex min-w-0 flex-col gap-0.5 pt-0.5">
        <a href={subject.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 rounded-sm font-medium outline-none hover:underline hover:decoration-foreground/30 hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring">
          <span className="truncate">{subject.nameCn || subject.name}</span><ArrowUpRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </a>
        {subject.nameCn && subject.name !== subject.nameCn && <span className="truncate text-xs text-muted-foreground">{subject.name}</span>}
        <span className="truncate text-xs text-muted-foreground tabular-nums">{[subject.platform, subject.date?.slice(0, 4), subject.volumes && `${subject.volumes} 卷`].filter(Boolean).join(' · ')}</span>
        {bangumi.source && <span className="text-xs text-muted-foreground">{SOURCES[bangumi.source]}</span>}
      </div>
    </div>
      : bangumi.state === 'suggested' && best ? <div className="flex flex-col gap-2.5">
        <p className="text-sm">Bangumi 上找到 {bangumi.candidates.length} 个可能的条目，请确认。</p>
        <div className="flex items-center gap-3 rounded-xl bg-muted/45 p-2.5 ring-1 ring-border">
          <Cover src={best.cover} title={best.nameCn || best.name} className="w-9 rounded-md" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{best.nameCn || best.name}</span>
            <span className="truncate text-xs text-muted-foreground tabular-nums">{[best.date?.slice(0, 4), `匹配 ${percentOf(best.score)}`].filter(Boolean).join(' · ')}</span>
          </span>
          <Button variant="outline" size="xs" disabled={!editable} aria-disabled={busy} onClick={() => { if (!busy) choose.mutate({ subject: String(best.id) }); }}>
            {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Check data-icon="inline-start" />}确认
          </Button>
        </div>
        {bangumi.candidates.length > 1 && <button type="button" disabled={!editable} className={cn(link, 'self-start text-xs')} onClick={() => setPicking(true)}>其他 {bangumi.candidates.length - 1} 个候选…</button>}
      </div>
      : <div className="flex flex-col items-start gap-2.5">
        <p className="text-sm text-muted-foreground">{bangumi.state === 'unmatched' ? 'Bangumi 上没有找到这部漫画。' : '还没有匹配 Bangumi 条目。'}</p>
        <BangumiUnavailable />
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" disabled={!editable} aria-disabled={busy} onClick={() => { if (!busy) choose.mutate({ auto: true }); }}>
            {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Sparkles data-icon="inline-start" />}自动匹配
          </Button>
          <Button variant="ghost" size="sm" disabled={!editable} onClick={() => setPicking(true)}>手动选择…</Button>
        </div>
      </div>}

    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t pt-3.5 text-xs">
      <dt className="text-muted-foreground">Komga</dt>
      <dd className="flex min-w-0 flex-col gap-1">
        {komga.state === 'disabled' ? <span className="text-muted-foreground">这个存储位置没有对应的 Komga 库 · <Link to="/settings/$section" params={{ section: 'metadata' }} className={link}>去设置</Link></span>
          : komga.state === 'error' ? <span className="flex items-start gap-1.5 text-destructive"><Dot tone="destructive" className="mt-1 size-1.5" /><span className="min-w-0 break-words">同步失败：{komga.error ?? '未知错误'}</span></span>
          : komga.state === 'not_found' ? <span className="flex items-center gap-1.5 text-warning"><Dot tone="warning" className="size-1.5" />Komga 里还没有这个系列，先让 Komga 扫描书库</span>
          : komga.state === 'pending' ? <span className="flex items-center gap-1.5 text-muted-foreground"><Dot tone="muted" className="size-1.5" />{bangumi.state === 'matched' ? '待同步' : '选好 Bangumi 条目后同步'}</span>
          : <span className="flex items-center gap-1.5"><Dot tone={komga.dirty ? 'muted' : 'success'} className="size-1.5" />
            <span>{komga.dirty ? '有更新待同步' : '已同步'}{komga.syncedAt && <span className="text-muted-foreground tabular-nums"> · {fromNow(komga.syncedAt)}</span>}</span>
          </span>}
        {komga.seriesUrl && <a href={komga.seriesUrl} target="_blank" rel="noreferrer" className={cn(link, 'flex w-fit items-center gap-1')}>在 Komga 中打开<ArrowUpRight aria-hidden className="size-3" /></a>}
      </dd>
      {!editable && <>
        <dt className="sr-only">提示</dt>
        <dd className="col-span-2 text-muted-foreground">在<Link to="/library" search={{ targetId: folder?.targetId }} className={link}>书库整理</Link>里扫描这个存储位置后，就能选择条目和同步。</dd>
      </>}
    </dl>
    {picking && folderId !== null && <BangumiDialog folderId={folderId} label={folder?.path ?? detail.comic.title} query={detail.comic.title} bangumi={bangumi} onClose={() => setPicking(false)} />}
  </Shell>;
}
