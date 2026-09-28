import { Link } from '@tanstack/react-router';
import { Download, LoaderCircle, X } from 'lucide-react';
import { cn } from 'cn';
import type { Task } from '@shared/model';
import { formatDuration, formatMB, formatSpeed } from '@/lib/format';
import { Button } from '@/components/ui/button';

export type ComicProgress = { current: Task | undefined; running: number; queued: number; speed: number };

/** This comic's transfers right now: 下载中 卷 13 · 43% · 3.4 MB/s · 还有 2 项. */
function progressText({ current, running, queued, speed }: ComicProgress) {
  if (!current) return `${queued} 项等待下载`;
  const share = current.total ? Math.floor(current.loaded / current.total * 100) : 0;
  const phase = current.phase === 'uploading' ? '上传中' : current.phase === 'verifying' ? '校验中' : current.phase === 'resolving' ? '准备中' : '下载中';
  const moving = current.phase === 'downloading' || current.phase === 'uploading';
  const eta = moving && current.total && current.speed > 0 ? formatDuration((current.total - current.loaded) / current.speed) : '';
  const rest = running - 1 + queued;
  return [`${phase} ${current.itemName}`, moving ? `${share}%` : '', speed > 0 ? formatSpeed(speed) : '', eta && `剩余 ${eta}`, rest > 0 ? `还有 ${rest} 项` : ''].filter(Boolean).join(' · ');
}

/** Selection summary, quota, this comic's live progress and the page's one primary action. */
export function ActionBar({ count, sizeMB, remainingMB, reserveMB, reason, busy, progress, onClear, onStart }: {
  count: number;
  sizeMB: number;
  remainingMB: number | null;
  reserveMB: number | undefined;
  reason: string;
  busy: boolean;
  progress: ComicProgress | null;
  onClear: () => void;
  onStart: () => void;
}) {
  const exceeds = remainingMB !== null && sizeMB > remainingMB;
  const belowReserve = !exceeds && remainingMB !== null && reserveMB !== undefined && count > 0 && remainingMB - sizeMB < reserveMB;
  const share = progress?.current?.total ? progress.current.loaded / progress.current.total : 0;
  return <div data-bottom-bar className="sticky bottom-0 z-20 -mx-4 md:bottom-4 md:mx-0">
    <div className="relative overflow-hidden border-t bg-card/95 shadow-float backdrop-blur-md md:rounded-2xl md:border-t-0 md:ring-1 md:ring-border">
      <div aria-hidden className={cn('absolute inset-x-0 top-0 h-0.5 bg-seal/15 transition-opacity duration-300', progress?.current ? 'opacity-100' : 'opacity-0')}>
        <div className="h-full origin-left bg-seal transition-transform duration-1000 ease-linear" style={{ transform: `scaleX(${share})` }} />
      </div>
      {/* The strip grows and shrinks smoothly, so the bar never jumps. */}
      <div className={cn('grid transition-[grid-template-rows] duration-250 ease-out-strong', progress ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden" inert={!progress}>
          <div className="flex h-9 items-center gap-2 border-b border-dashed px-4 text-xs text-muted-foreground md:px-5">
            {progress?.current ? <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin text-seal" /> : <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />}
            <span className="min-w-0 flex-1 truncate tabular-nums">{progress && progressText(progress)}</span>
            <Button variant="link" size="xs" className="-mr-2 shrink-0" asChild><Link to="/downloads">查看</Link></Button>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] md:px-5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex h-7 items-center gap-1.5 text-sm" aria-live="polite">
            {count ? <>
              <span className="font-medium whitespace-nowrap">已选 <span key={count} className="inline-block animate-tick tabular-nums">{count}</span> 项</span>
              <span className="truncate text-muted-foreground tabular-nums">· {formatMB(sizeMB)}</span>
              <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="清除选择" onClick={onClear}><X /></Button>
            </> : <span className="text-muted-foreground">未选择章节</span>}
          </div>
          {/* Phones have no room for the reason beside the button: with chapters picked and no quota line (Kmoe not logged in), it goes here. */}
          {remainingMB !== null ? <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            <div aria-hidden className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-foreground/8">
              <div className={cn('h-full origin-left transition-[transform,background-color] duration-300 ease-out-strong', exceeds ? 'bg-destructive' : belowReserve ? 'bg-warning' : 'bg-seal')}
                style={{ transform: `scaleX(${remainingMB > 0 ? Math.min(1, sizeMB / remainingMB) : 1})` }} />
            </div>
            {exceeds
              ? <span className="truncate font-medium text-destructive">超出额度 {formatMB(sizeMB - remainingMB)}</span>
              : belowReserve ? <span className="truncate text-warning">下载后低于保留额度，队列会暂停</span>
              : <span className="truncate">剩余额度 {formatMB(remainingMB - sizeMB)}</span>}
          </div> : count > 0 && reason && !busy && <span aria-hidden className="truncate text-xs text-muted-foreground sm:hidden">{reason}</span>}
        </div>
        {reason && !busy && <span id="start-reason" className="max-w-40 text-right text-xs text-muted-foreground max-sm:hidden">{reason}</span>}
        {/* aria-disabled, not disabled: it stays focusable (with its reason) and keeps focus while adding. */}
        <Button variant="seal" size="lg" className="shrink-0 sm:min-w-34" aria-disabled={!!reason || busy} aria-describedby={reason ? 'start-reason' : undefined}
          onClick={() => { if (!reason && !busy) onStart(); }}>
          {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Download data-icon="inline-start" />}
          {busy ? '添加中…' : '开始下载'}
        </Button>
      </div>
    </div>
  </div>;
}
