// 书库 overview: the status strip (counts + the job each column starts), the running job, and the first-run intro.
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, FolderSearch, Link2, LoaderCircle, RefreshCw, ScanSearch, Settings2, Sparkles, Tags, WandSparkles, X } from 'lucide-react';
import { cn } from 'cn';
import type { LibraryJob, LibraryJobKind, LibraryOverview, MetadataSettings, Target } from '@shared/model';
import { fromNow, percent } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ConfirmAction } from '@/components/app/feedback';
import { AI_LABELS, bangumiBlocked, jobLabels } from './state';

/** What the strip can start: the library jobs, and the three AI passes (which all run as the 'ai' job). */
export type JobStart = Exclude<LibraryJobKind, 'ai'> | keyof typeof AI_LABELS;
export type JobControl = { running: LibraryJob | null; starting: JobStart | null; start: (kind: JobStart) => void; /** The AI pass a running 'ai' job is. */ ai: JobStart | null };

function Cell({ label, value, sub, action, tone, className }: { label: string; value: ReactNode; sub: ReactNode; action: ReactNode; tone?: string; className?: string }) {
  return <div className={cn('flex min-w-0 flex-col gap-1 bg-card px-4 pt-3.5 pb-2.5 sm:px-5', className)}>
    <span className="text-xs text-muted-foreground">{label}</span>
    <span className={cn('truncate text-[15px] leading-6 font-semibold tracking-tight tabular-nums', tone)}>{value}</span>
    {/* Wraps instead of truncating (narrow phone cells), and the actions stay on one baseline across the row. */}
    <span className="min-h-4.5 text-xs text-muted-foreground tabular-nums">{sub}</span>
    <div className="mt-auto -ml-2 pt-0.5">{action}</div>
  </div>;
}

// Lines break only between parts, never between a label and its number.
const parts = (...items: [string, number, string?][]) => items.filter(([, n]) => n > 0)
  .map(([label, n, tone], i) => <span key={label} className={tone}>{i > 0 && <span className="text-muted-foreground"> · </span>}<span className="whitespace-nowrap">{label} {n}</span></span>);

/** Starts one kind of job; shows its spinner while it is being started or runs, and waits while another job runs. */
function JobButton({ kind, jobs, icon, children }: { kind: JobStart; jobs: JobControl; icon: ReactNode; children: ReactNode }) {
  const busy = jobs.starting === kind || (kind in AI_LABELS ? jobs.running?.kind === 'ai' && jobs.ai === kind : jobs.running?.kind === kind);
  const blocked = !!jobs.running || !!jobs.starting;
  return <Button variant="ghost" size="xs" className="text-muted-foreground" aria-disabled={blocked}
    title={jobs.running?.kind && !busy ? `${jobLabels(jobs.running.kind, jobs.ai).running}，完成后再试` : undefined}
    onClick={() => { if (!blocked) jobs.start(kind); }}>
    {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : icon}{children}
  </Button>;
}

const settingsLink = (label: string, section: 'account' | 'metadata', hash?: string) => <Button variant="ghost" size="xs" className="text-muted-foreground" asChild>
  <Link to="/settings/$section" params={{ section }} hash={hash}><Settings2 data-icon="inline-start" />{label}</Link>
</Button>;

const Actions = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap items-center">{children}</div>;

/** `metadata` null: the metadata settings could not be read (shown as not enabled). `ai`: AI is set up (设置 → AI). */
export function LibraryStrip({ overview, metadata, kmoeActive, ai, jobs }: { overview: LibraryOverview; metadata: MetadataSettings | null; kmoeActive: boolean; ai: boolean; jobs: JobControl }) {
  const { counts, folders, scannedAt } = overview;
  const { kmoe, bangumi, komga } = counts;
  const metaOn = !!metadata?.enabled;
  const komgaOff = counts.folders > 0 && komga.disabled === counts.folders;
  const toSync = folders.filter(f => f.metadata.komga.state !== 'disabled' && f.metadata.bangumi.state === 'matched' && (f.metadata.komga.dirty || f.metadata.komga.state === 'pending')).length;
  const done = counts.folders ? '全部处理完了' : '—';
  const kmoeSub = parts(['待确认', kmoe.suggested, 'text-warning'], ['未找到', kmoe.unmatched], ['待匹配', kmoe.pending]);
  const bangumiSub = parts(['待确认', bangumi.suggested, 'text-warning'], ['未找到', bangumi.unmatched], ['未匹配', bangumi.none]);
  const komgaSub = parts(['失败', komga.error, 'text-destructive'], ['待同步', toSync], ['未找到系列', komga.not_found]);
  // Bangumi unreachable with the chosen source: say so and point at the source settings instead of a job that would fail.
  const noBangumi = bangumiBlocked(metadata?.bangumi);
  return <section aria-label="书库概览" className={cn('grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-border shadow-soft ring-1 ring-border', metaOn ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
    <Cell label="文件夹" value={`${counts.folders} 个`} sub={`${counts.books} 本 · ${scannedAt ? `${fromNow(scannedAt)}扫描` : '尚未扫描'}`}
      action={<JobButton kind="scan" jobs={jobs} icon={<ScanSearch data-icon="inline-start" />}>{scannedAt ? '重新扫描' : '扫描书库'}</JobButton>} />
    <Cell label="Kmoe" value={`已关联 ${kmoe.matched}`} sub={!kmoeActive ? <span className="text-warning">登录 Kmoe 后才能匹配</span> : kmoeSub.length ? kmoeSub : done}
      action={kmoeActive ? <Actions>
        <JobButton kind="kmoe" jobs={jobs} icon={<Link2 data-icon="inline-start" />}>匹配 Kmoe</JobButton>
        {ai && kmoe.suggested + kmoe.unmatched > 0 && <JobButton kind="ai-kmoe" jobs={jobs} icon={<Sparkles data-icon="inline-start" />}>AI 判定</JobButton>}
      </Actions> : settingsLink('登录 Kmoe', 'account')} />
    {metaOn ? <>
      <Cell label="Bangumi" value={`已匹配 ${bangumi.matched}`} sub={noBangumi ? <span className="text-warning" title={noBangumi}>{noBangumi}</span> : bangumiSub.length ? bangumiSub : done}
        action={noBangumi ? settingsLink('设置数据来源', 'metadata', 'bangumi-source') : <Actions>
          <JobButton kind="bangumi" jobs={jobs} icon={<Tags data-icon="inline-start" />}>匹配 Bangumi</JobButton>
          {ai && bangumi.suggested + bangumi.unmatched > 0 && <JobButton kind="ai-bangumi" jobs={jobs} icon={<Sparkles data-icon="inline-start" />}>AI 判定</JobButton>}
        </Actions>} />
      {komgaOff
        ? <Cell label="Komga" value="未对应" tone="text-muted-foreground" sub="这个存储位置没有对应的 Komga 库" action={settingsLink('去设置', 'metadata')} />
        : <Cell label="Komga" value={`已同步 ${komga.synced}`} sub={komgaSub.length ? komgaSub : counts.folders ? '都是最新的' : '—'}
          action={<Actions>
            <JobButton kind="komga" jobs={jobs} icon={<RefreshCw data-icon="inline-start" />}>同步到 Komga</JobButton>
            {ai && bangumi.matched > 0 && <JobButton kind="ai-polish" jobs={jobs} icon={<WandSparkles data-icon="inline-start" />}>AI 整理</JobButton>}
          </Actions>} />}
    </> : <Cell className="col-span-2 lg:col-span-1" label="元数据" value="未开启" tone="text-muted-foreground" sub="从 Bangumi 补全简介和标签，写入 Komga"
      action={settingsLink('设置 Komga 元数据', 'metadata')} />}
  </section>;
}

/** The running (or just finished) job: what, how far, on which folder, and a way to stop it. */
export function JobBar({ job, target, ai, cancelling, onCancel }: { job: LibraryJob; target: Target | undefined; ai: JobStart | null; cancelling: boolean; onCancel: () => void }) {
  const label = job.kind ? jobLabels(job.kind, ai).running : '正在处理';
  return <div className="flex flex-col gap-2.5 rounded-2xl bg-card px-4 py-3.5 shadow-soft ring-1 ring-border sm:px-5">
    <div className="flex items-center gap-3">
      <LoaderCircle aria-hidden className={cn('size-4 shrink-0 text-seal', job.running && 'animate-spin')} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span role="status" className="truncate font-medium">{label}{target && <span className="font-normal text-muted-foreground"> · {target.name}</span>}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{job.total ? `${job.done} / ${job.total}` : '准备中…'}</span>
        </span>
        <span className="min-h-4 truncate font-mono text-[11px] text-muted-foreground" title={job.current ?? undefined}>{job.current}</span>
      </div>
      <Button variant="outline" size="sm" aria-disabled={cancelling || !job.running} onClick={() => { if (!cancelling && job.running) onCancel(); }}>
        {cancelling ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <X data-icon="inline-start" />}取消
      </Button>
    </div>
    <Progress value={job.total ? percent(job.done, job.total) : null} active={job.running} className="h-1" aria-label={`${label}进度`} />
  </div>;
}

/** Never scanned: what import does (and does not do), and the one button that starts it. */
export function LibraryIntro({ target, kmoeActive, jobs }: { target: Target; kmoeActive: boolean; jobs: JobControl }) {
  const busy = jobs.starting === 'scan';
  const points = ['直接放着 EPUB / MOBI 文件的文件夹，算作一部漫画', '书名完全一致的自动关联，其余由你确认', '关联后出现在书架上，已有的卷算作已下载，新卷也下载到这里', '只读取文件夹，不会移动、改名或删除文件'];
  return <section aria-labelledby="library-intro" className="relative animate-rise overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-border">
    <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-80 tone [mask-image:linear-gradient(to_left,black,transparent)] max-sm:hidden" />
    <div className="relative flex max-w-2xl flex-col items-start gap-5 p-6 md:p-8">
      <span className="grid size-12 place-items-center rounded-2xl bg-card text-muted-foreground shadow-soft ring-1 ring-border"><FolderSearch className="size-6" /></span>
      <div className="flex flex-col gap-1.5">
        <h2 id="library-intro" className="text-lg font-semibold tracking-tight">导入 NAS 上已有的漫画</h2>
        <p className="text-sm leading-relaxed text-pretty text-muted-foreground">扫描「{target.name}」，把里面的漫画文件夹关联到 Kmoe 上的作品。</p>
      </div>
      <ul className="flex flex-col gap-2 text-sm">
        {points.map(point => <li key={point} className="flex items-start gap-2.5"><Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />{point}</li>)}
      </ul>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="seal" size="lg" aria-disabled={!!jobs.running || busy} onClick={() => { if (!jobs.running && !busy) jobs.start('scan'); }}>
          {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <ScanSearch data-icon="inline-start" />}扫描书库
        </Button>
        {!kmoeActive && <span className="text-xs text-muted-foreground">
          还没有登录 Kmoe：可以先扫描，<Link to="/settings/$section" params={{ section: 'account' }} className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">登录</Link>后再匹配。
        </span>}
      </div>
    </div>
  </section>;
}

/** Link every confident suggestion at once (after a confirmation that says what happens). */
export function AcceptSuggestions({ count, pending, onAccept }: { count: number; pending: boolean; onAccept: () => void }) {
  return <div className="flex animate-rise flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-dashed px-4 py-2.5">
    <Sparkles aria-hidden className="size-4 shrink-0 text-seal" />
    <span className="min-w-0 flex-1 text-sm">{count} 个建议的匹配度在 90% 以上，可以一次确认。</span>
    <ConfirmAction title={`接受 ${count} 个建议？`} description="这些文件夹会关联到各自的首选漫画，并出现在书架上。文件不会移动或改名，之后也可以重新匹配。"
      action={`接受 ${count} 个`} variant="default" onConfirm={onAccept}>
      <Button variant="outline" size="sm" aria-disabled={pending}>{pending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}接受 {count} 个建议</Button>
    </ConfirmAction>
  </div>;
}
