// 漫画页: header, destination bar, the chapter grid with its sticky action bar, and the subscription card.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, getRouteApi, useCanGoBack, useRouter } from '@tanstack/react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useInView } from 'motion/react';
import { toast } from 'sonner';
import { ArrowLeft, Compass } from 'lucide-react';
import { cn } from 'cn';
import type { ComicDetail, Format, Line, Target } from '@shared/model';
import { joinPath } from '@shared/naming';
import { ApiError, request } from '@/lib/api';
import { formatMB } from '@/lib/format';
import { comicQuery, metadataSettingsQuery, settingsQuery, statusQuery, targetsQuery, tasksQuery } from '@/lib/queries';
import { useSelection } from '@/lib/selection';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DirectoryBrowser, type BrowseTarget } from '@/components/app/directory-browser';
import { EmptyState, ErrorState, Loading } from '@/components/app/feedback';
import { Page } from '@/components/app/page';
import { ActionBar, type ComicProgress } from '@/features/comic/action-bar';
import { Chapters } from '@/features/comic/chapters';
import { DestinationBar, folderDisplay, resolveDirectory } from '@/features/comic/destination';
import { ComicHeader } from '@/features/comic/header';
import { isSelectable } from '@/features/comic/logic';
import { MetadataCard } from '@/features/comic/metadata';
import { SubscriptionCard } from '@/features/comic/subscription';
import { parentOf } from '@/features/library/state';
import { hostOf } from '@/features/settings/target-editor';

const route = getRouteApi('/_app/comics/$key');

/** A path picked in the folder browser (from the target's filesystem root) as a path inside the target. */
function inTarget(target: Target, picked: string) {
  const base = target.path === '/' ? '' : target.path;
  if (base && picked !== base && !picked.startsWith(`${base}/`)) throw new Error(`请选择「${target.path}」里的文件夹`);
  const path = picked.slice(base.length) || '/';
  if (path === '/') throw new Error('请选择放着这部漫画的文件夹，而不是存储位置的根目录');
  return path;
}

function useBack() {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  return () => canGoBack ? router.history.back() : void router.navigate({ to: '/' });
}

/** Phone top bar: back, and the title once the big one has scrolled away. */
function TopBar({ title, showTitle }: { title: string; showTitle: boolean }) {
  const back = useBack();
  return <div className="sticky top-0 z-30 flex h-13 items-center gap-1 border-b bg-background/85 px-2 backdrop-blur-md md:hidden">
    <Button variant="ghost" size="icon" aria-label="返回" onClick={back}><ArrowLeft /></Button>
    <span aria-hidden={!showTitle} className={cn('min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight transition-opacity duration-200', showTitle ? 'opacity-100' : 'opacity-0')}>{title}</span>
  </div>;
}

export function ComicPage() {
  const { key } = route.useParams();
  const view = route.useSearch();
  const detail = useQuery(comicQuery(key, view));
  const back = useBack();

  if (!detail.data) return <>
    <TopBar title="" showTitle={false} />
    <Page>
      {detail.error ? detail.error instanceof ApiError && detail.error.status === 404
        ? <EmptyState icon={<Compass />} title="没有找到这部漫画" description="链接可能已失效，或者 Kmoe 上已经下架。">
          <Button variant="outline" asChild><Link to="/discover">去发现</Link></Button>
        </EmptyState>
        : <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        : <Loading label="正在读取漫画…">
          <div className="flex flex-col gap-8">
            <div className="flex gap-6 md:gap-8"><Skeleton className="aspect-[3/4] w-24 rounded-xl sm:w-32 md:w-40" /><div className="flex flex-1 flex-col gap-3 pt-1"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-4 w-1/3" /><Skeleton className="h-5 w-48" /><Skeleton className="h-4 w-full max-w-lg" /></div></div>
            <Skeleton className="h-11 rounded-xl" />
            <div className="grid grid-cols-[repeat(auto-fill,minmax(172px,1fr))] gap-2 max-sm:grid-cols-2">{Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="h-[62px] rounded-xl" style={{ opacity: 1 - i * 0.06 }} />)}</div>
          </div>
        </Loading>}
      {detail.error && <Button variant="ghost" size="sm" className="self-start text-muted-foreground max-md:hidden" onClick={back}><ArrowLeft data-icon="inline-start" />返回</Button>}
    </Page>
  </>;
  return <ComicView key={key} detail={detail.data} loadingView={detail.isPlaceholderData} />;
}

function ComicView({ detail, loadingView }: { detail: ComicDetail; loadingView: boolean }) {
  const client = useQueryClient();
  const navigate = route.useNavigate();
  const search = route.useSearch();
  const back = useBack();
  const key = detail.comic.key;
  const title = useRef<HTMLHeadingElement>(null);
  const titleInView = useInView(title, { initial: true });
  useEffect(() => { document.title = `${detail.comic.title} · Kmoe Sync`; }, [detail.comic.title]);
  const targets = useQuery(targetsQuery);
  const settings = useQuery(settingsQuery);
  const metadata = useQuery(metadataSettingsQuery);
  const { data: status } = useQuery(statusQuery);
  const tasks = useInfiniteQuery(tasksQuery({ comicKey: key, status: 'running' }));
  const [selection, setSelection] = useSelection(key);
  const [line, setLine] = useState<Line | null>(null);
  const [browse, setBrowse] = useState<BrowseTarget | null>(null);

  const { targetId, format } = detail.view;
  const target = targets.data?.find(t => t.id === targetId);
  const kmoe = status?.kmoe;
  const effectiveLine: Line = line ?? detail.subscription?.line ?? settings.data?.defaultLine ?? 0;
  const running = useMemo(() => new Map((tasks.data?.pages.flatMap(page => page.tasks) ?? [])
    .filter(task => task.targetId === targetId && task.format === format).map(task => [task.itemId, task])), [tasks.data, targetId, format]);
  const chosen = detail.items.filter(item => selection.has(item.id) && isSelectable(detail.states[item.id]?.state));
  const sizeMB = chosen.reduce((sum, item) => sum + (item.sizeMB[format] ?? 0), 0);
  const queued = Object.values(detail.states).filter(info => info.state === 'queued').length;
  const progress: ComicProgress | null = running.size || queued
    ? { current: [...running.values()].sort((a, b) => (b.total ? b.loaded / b.total : 0) - (a.total ? a.loaded / a.total : 0))[0], running: running.size, queued, speed: [...running.values()].reduce((sum, task) => sum + task.speed, 0) }
    : null;
  const folder = detail.folder?.targetId === targetId ? detail.folder : null;
  const directory = folder && target && status ? folderDisplay(target, status.libraryRoot, folder.path)
    : detail.library?.targetId === targetId && detail.library.format === format ? detail.library.directory
    : target && status ? resolveDirectory(target, status.libraryRoot, detail.comic, detail.items[0]?.name ?? '卷 01', format) : '';
  const mirror = kmoe?.mirror ?? settings.data?.preferredMirror ?? 'kxo.moe';
  const reason = !kmoe ? '正在读取状态' : kmoe.state === 'none' ? '请先登录 Kmoe' : kmoe.state === 'expired' ? 'Kmoe 登录已失效'
    : !target ? '请先添加存储位置' : !chosen.length ? '请选择章节' : kmoe.remainingMB !== null && sizeMB > kmoe.remainingMB ? '超出剩余额度' : '';

  const setView = (next: { targetId?: number; format?: Format }) => void navigate({ search: old => ({ ...old, ...next }), replace: true, resetScroll: false });
  const refresh = useMutation({
    mutationFn: () => request('POST /api/comics/:key/refresh', { params: { key }, query: search }),
    onSuccess: data => { client.setQueryData(comicQuery(key, search).queryKey, data); toast.success('已从 Kmoe 刷新'); },
  });
  const libraryCheck = useMutation({
    mutationFn: () => request('POST /api/comics/:key/library-check', { params: { key }, body: { targetId: targetId!, format } }),
    onSuccess: check => {
      client.setQueryData(comicQuery(key, search).queryKey, old => old && { ...old, library: check });
      void client.invalidateQueries({ queryKey: ['comic', key] });
      const missing = check.chapters.filter(c => c.status === 'missing').length;
      toast.success('书库检查完成', { description: missing ? `${missing} 项不在书库中` : '所有章节都已在书库中' });
    },
  });
  // The folder changed: the item states now come from another directory, and the library and shelf follow.
  const folderChanged = (next: ComicDetail) => {
    client.setQueryData(comicQuery(key, search).queryKey, next);
    for (const queryKey of [['comic', key], ['library'], ['shelf']]) void client.invalidateQueries({ queryKey });
  };
  const downloadedIn = (next: ComicDetail) => Object.values(next.states).filter(info => info.state === 'downloaded').length;
  const mapFolder = (opener: HTMLElement) => {
    if (!target || !status) return;
    const current = folder ? parentOf(folder.path) ?? '/' : '/';
    setBrowse({
      ref: { targetId: target.id }, name: target.name, opener, path: joinPath(target.path, current),
      root: target.kind === 'local' ? `书库根目录 ${status.libraryRoot}` : hostOf(target.url) || 'WebDAV',
      title: '对应已有文件夹', description: `打开「${target.name}」里放着这部漫画的文件夹。文件不会被移动或改名。`, action: '对应到此文件夹',
      apply: async picked => {
        const next = await request('PUT /api/comics/:key/folder', { params: { key }, body: { targetId: target.id, path: inTarget(target, picked) } });
        folderChanged(next);
        const found = downloadedIn(next);
        toast.success('已对应到现有文件夹', { description: found ? `找到 ${found} 项已下载，之后的新卷也会下载到这里。` : '之后的新卷会下载到这里。' });
      },
    });
  };
  const resetFolder = useMutation({
    mutationFn: () => request('DELETE /api/comics/:key/folder', { params: { key }, query: { targetId: targetId! } }),
    onSuccess: next => { folderChanged(next); toast.success('已恢复为命名规则文件夹', { description: '之后的下载按存储位置的命名规则保存。' }); },
  });
  const start = useMutation({
    mutationFn: (itemIds: string[]) => request('POST /api/tasks', { body: { comicKey: key, itemIds, format, targetId: target!.id, line: effectiveLine } }),
    onSuccess: (result, itemIds) => {
      // Only the submitted items: more may have been picked while the request was in flight.
      setSelection(old => new Set([...old].filter(id => !itemIds.includes(id))));
      toast.success(result.created ? `已加入 ${result.created} 项下载` : '没有需要下载的章节', {
        description: [result.created ? `约 ${formatMB(result.sizeMB)}` : '', result.skipped ? `跳过 ${result.skipped} 项已存在或已在队列中` : ''].filter(Boolean).join('，') || undefined,
        action: result.created ? { label: '查看', onClick: () => void navigate({ to: '/downloads' }) } : undefined,
      });
      for (const queryKey of [['comic', key], ['tasks'], ['status'], ['shelf']]) void client.invalidateQueries({ queryKey });
    },
  });

  return <>
    <TopBar title={detail.comic.title} showTitle={!titleInView} />
    <Page>
      <Button variant="ghost" size="sm" className="-mt-4 -ml-2 self-start text-muted-foreground max-md:hidden" onClick={back}><ArrowLeft data-icon="inline-start" />返回</Button>
      <ComicHeader detail={detail} titleRef={title} kmoeUrl={`https://${mirror}/c/${key}.htm`} refreshing={refresh.isPending} onRefresh={() => refresh.mutate()} />
      <div className="grid grid-cols-1 items-start gap-x-8 gap-y-8 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <DestinationBar targets={targets.data ?? []} target={target} directory={directory} mapped={!!folder?.mapped} format={format} line={effectiveLine} vip={!!kmoe?.vip}
            resetting={resetFolder.isPending} onTarget={id => setView({ targetId: id })} onFormat={next => setView({ format: next })} onLine={setLine}
            onMapFolder={mapFolder} onResetFolder={() => resetFolder.mutate()} />
          {detail.items.length
            ? <Chapters comicKey={key} items={detail.items} states={detail.states} format={format} running={running} dimmed={loadingView}
              library={detail.library?.targetId === targetId && detail.library.format === format ? detail.library : null}
              checking={libraryCheck.isPending} onCheck={() => { if (targetId !== null) libraryCheck.mutate(); }} />
            : <EmptyState icon={<Compass />} title="还没有可下载的章节" description="Kmoe 上暂时没有这部漫画的卷或话。订阅后，一有更新就会自动下载。" className="min-h-56 border" />}
          <ActionBar count={chosen.length} sizeMB={sizeMB} remainingMB={kmoe?.state === 'active' ? kmoe.remainingMB : null} reserveMB={settings.data?.quotaReserveMB}
            reason={reason} busy={start.isPending} progress={progress}
            onClear={() => setSelection(() => new Set())} onStart={() => start.mutate(chosen.map(item => item.id))} />
        </div>
        {/* Not sticky: with two cards the column can be taller than the window. */}
        <aside className="flex flex-col gap-4">
          {targets.data && settings.data
            ? <SubscriptionCard detail={detail} targets={targets.data} settings={settings.data} vip={!!kmoe?.vip} remainingMB={kmoe?.state === 'active' ? kmoe.remainingMB : null} />
            : <Skeleton className="h-96 rounded-2xl" />}
          <MetadataCard detail={detail} settings={metadata.data} />
        </aside>
      </div>
    </Page>
    {browse && <DirectoryBrowser key={browse.path} target={browse} onClose={() => setBrowse(null)} />}
  </>;
}
