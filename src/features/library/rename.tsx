// 整理文件名: the book files of linked folders that the naming rule names differently, the old name over the new one,
// each kept or left out; the AI reads files whose names do not say which volume they are. Renaming runs as a library job.
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LoaderCircle, Sparkles } from 'lucide-react';
import type { RenameFile, RenameFolder, Target } from '@shared/model';
import { errorMessage, request } from '@/lib/api';
import { aiSettingsQuery } from '@/lib/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorState, Loading, Notice } from '@/components/app/feedback';
import { refocus, useClosable, type ReturnFocus } from './pickers';
import { applyJob, percentOf } from './state';

/** AI readings at least this sure start out kept, as a sure AI match is linked without asking. */
const SURE = 0.85;
/** The user's own picks in one folder: file name → keep. */
type Picks = ReadonlyMap<string, boolean>;
const kept = (file: RenameFile, picks: Picks | undefined) => !!file.to && (picks?.get(file.name) ?? (file.source !== 'ai' || (file.confidence ?? 0) >= SURE));

const FileRow = ({ file, checked, onChange }: { file: RenameFile; checked: boolean; onChange: (keep: boolean) => void }) => file.to
  ? <li>
    <label className="flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent/60">
      <Checkbox aria-label={`把「${file.name}」改成「${file.to}」`} checked={checked} onCheckedChange={value => onChange(value === true)} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs text-muted-foreground line-through decoration-muted-foreground/40" title={file.name}>{file.name}</span>
        <span className="truncate text-[13px]" title={file.to}>{file.to}</span>
        {file.note && <span className="text-xs text-muted-foreground">{file.note}</span>}
      </span>
      {file.source === 'ai' && <Badge variant="muted" className="mt-0.5 shrink-0 tabular-nums" title="AI 识别的，请核对">AI {percentOf(file.confidence ?? 0)}</Badge>}
    </label>
  </li>
  : <li className="flex min-w-0 flex-col py-1.5 pr-2 pl-[38px]">
    <span className="truncate text-[13px] text-muted-foreground" title={file.name}>{file.name}</span>
    <span className="text-xs text-warning">{file.note}</span>
  </li>;

const FolderSection = memo(function FolderSection({ folder, picks, onPick }: { folder: RenameFolder; picks: Picks | undefined; onPick: (folderId: number, names: string[], keep: boolean) => void }) {
  const renames = folder.files.filter(file => file.to);
  const count = renames.filter(file => kept(file, picks)).length;
  // Off screen, a folder costs no layout: a whole library can be hundreds of folders.
  return <section aria-label={folder.title} className="border-b py-3 [contain-intrinsic-size:auto_120px] [content-visibility:auto] last:border-b-0">
    <div className="flex min-w-0 items-center gap-3 px-2">
      {renames.length ? <Checkbox aria-label={`${folder.title}：全部改名`} checked={count === renames.length ? true : count ? 'indeterminate' : false}
        onCheckedChange={() => onPick(folder.folderId, renames.map(file => file.name), count < renames.length)} /> : <span className="size-[18px] shrink-0" />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{folder.title}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={folder.path}>{folder.path}</span>
      </span>
      {folder.named > 0 && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{folder.named} 个已符合</span>}
    </div>
    {folder.error ? <p className="mt-1.5 pl-[38px] text-xs text-warning">{folder.error}</p>
      : <ul className="mt-1.5 flex flex-col pl-[22px]">
        {folder.files.map(file => <FileRow key={file.name} file={file} checked={kept(file, picks)} onChange={keep => onPick(folder.folderId, [file.name], keep)} />)}
      </ul>}
  </section>;
});

/** `folderIds`: only these folders (a folder's own menu); else every linked folder of the target. */
export function RenameDialog({ target, folderIds, onClose, returnFocus }: { target: Target; folderIds?: number[]; onClose: () => void } & ReturnFocus) {
  const client = useQueryClient();
  const { open, close } = useClosable(onClose);
  const preview = useQuery({
    queryKey: ['rename', target.id, folderIds?.join(',') ?? 'all'],
    queryFn: ({ signal }) => request('POST /api/library/rename/preview', { body: { targetId: target.id, folderIds }, signal }),
    // The plan stays as read while the user picks; the dialog reads it again when opened again.
    staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, retry: false,
  });
  const { data: aiReady = false } = useQuery({ ...aiSettingsQuery, select: settings => settings.ready });
  const [read, setRead] = useState<ReadonlyMap<number, RenameFolder>>(() => new Map());
  const [picks, setPicks] = useState<ReadonlyMap<number, Picks>>(() => new Map());
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  const reader = useRef<AbortController | null>(null);
  useEffect(() => () => reader.current?.abort(), []);

  const folders = (preview.data?.folders ?? []).map(folder => read.get(folder.folderId) ?? folder);
  const files = folders.flatMap(folder => folder.files);
  const renames = folders.flatMap(folder => folder.files.filter(file => kept(file, picks.get(folder.folderId))).map(file => ({ folderId: folder.folderId, name: file.name, to: file.to! })));
  const unknown = folders.filter(folder => folder.files.some(file => !file.item));
  const count = { renames: files.filter(file => file.to).length, unknown: files.filter(file => !file.item).length, blocked: files.filter(file => file.item && !file.to).length };

  // Stable, so a pick redraws only its own folder.
  const pick = useCallback((folderId: number, names: string[], keep: boolean) => setPicks(old => {
    const own = new Map(old.get(folderId));
    for (const name of names) own.set(name, keep);
    return new Map(old).set(folderId, own);
  }), []);

  async function readWithAi() {
    const controller = new AbortController();
    reader.current = controller;
    setReading({ done: 0, total: unknown.length });
    let found = 0;
    for (const [index, { folderId }] of unknown.entries()) {
      try {
        const folder = await request('POST /api/library/rename/ai', { body: { folderId }, signal: controller.signal });
        found += folder.files.filter(file => file.source === 'ai').length;
        setRead(old => new Map(old).set(folderId, folder));
      } catch (error) {
        if (controller.signal.aborted) return;
        // Mostly the AI itself (setup, budget, endpoint): the other folders would fail the same way.
        toast.error('AI 识别没有完成', { description: errorMessage(error) });
        break;
      }
      setReading({ done: index + 1, total: unknown.length });
    }
    setReading(null);
    toast.success(found ? `AI 认出了 ${found} 个文件` : 'AI 也没有认出来', { description: found ? '比较有把握的已经勾选，其余的请核对后再勾选。' : '这些文件可以手动改名。' });
  }

  const start = useMutation({
    mutationFn: () => request('POST /api/library/rename', { body: { targetId: target.id, renames } }),
    onSuccess: job => { applyJob(client, job); close(); },
    onError: error => toast.error('没有开始改名', { description: errorMessage(error) }),
  });

  return <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
    <DialogContent className="flex max-h-[min(860px,calc(100dvh-32px))] flex-col gap-4 sm:max-w-3xl" onCloseAutoFocus={refocus(returnFocus)}>
      <DialogHeader className="pr-8">
        <DialogTitle>整理文件名</DialogTitle>
        <DialogDescription>
          按「{target.name}」的命名规则{preview.data && <>（<span className="font-mono text-[12px] text-foreground">{preview.data.rule}</span>）</>}给已关联漫画的文件改名。只改文件名，文件留在原来的文件夹里，不会覆盖已有的文件。
        </DialogDescription>
      </DialogHeader>
      {preview.error ? <ErrorState error={preview.error} onRetry={() => void preview.refetch()} className="min-h-40" />
        : !preview.data ? <Loading label="正在读取文件夹…"><div className="h-40" /></Loading>
        : <>
          {preview.data.komga && !preview.data.komga.hashFiles && <Notice tone="warning" live={false}>
            Komga 书库「{preview.data.komga.name}」没有开启「计算文件哈希」：改名后 Komga 会把这些文件当成新书，阅读进度会丢失。建议先在 Komga 的书库设置里开启。
          </Notice>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p role="status" className="min-w-0 flex-1 text-sm text-muted-foreground tabular-nums">
              {[`${count.renames} 个文件可以改名`, preview.data.named ? `${preview.data.named} 个已符合规则` : '', count.unknown ? `${count.unknown} 个认不出` : '', count.blocked ? `${count.blocked} 个不能改` : ''].filter(Boolean).join(' · ')}
            </p>
            {aiReady && count.unknown > 0 && <Button variant="outline" size="sm" aria-disabled={!!reading} onClick={() => { if (!reading) void readWithAi(); }}>
              {reading ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Sparkles data-icon="inline-start" />}
              {reading ? `AI 正在识别 ${reading.done} / ${reading.total} 部` : `让 AI 识别 ${count.unknown} 个文件`}
            </Button>}
            {!aiReady && count.unknown > 0 && <Button variant="link" size="sm" className="text-muted-foreground" asChild>
              <Link to="/settings/$section" params={{ section: 'ai' }}>设置 AI 后可以让 AI 识别</Link>
            </Button>}
          </div>
          {folders.length ? <div className="-mx-1 flex-1 overflow-y-auto overscroll-contain px-1">
            {folders.map(folder => <FolderSection key={folder.folderId} folder={folder} picks={picks.get(folder.folderId)} onPick={pick} />)}
          </div> : <p className="py-10 text-center text-sm text-muted-foreground">文件名都符合命名规则，没有要改的。</p>}
        </>}
      <DialogFooter>
        <Button variant="ghost" onClick={close}>关闭</Button>
        {count.renames > 0 && <Button aria-disabled={!renames.length || start.isPending} onClick={() => { if (renames.length && !start.isPending) start.mutate(); }}>
          {start.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}改名 {renames.length} 个文件
        </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
