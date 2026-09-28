// One line saying where downloads go (target › directory · format · line); expands into the controls that change it,
// including mapping the comic to a folder that already exists on the target.
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, FolderInput, HardDrive, LoaderCircle, Settings2, Undo2 } from 'lucide-react';
import type { Format, Line, Target } from '@shared/model';
import { joinPath, renderRule } from '@shared/naming';
import { FORMAT_LABELS, LINE_LABELS, middleTruncate } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldLabel, FieldTitle } from '@/components/ui/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

/** The folder a chapter of this comic lands in, from the target's naming rule. */
export function resolveDirectory(target: Target, libraryRoot: string, comic: { title: string; authors: string[] }, sample: string, format: Format) {
  try {
    const file = joinPath(target.path, renderRule(target.rule, { title: comic.title, filename: `[Kmoe][${comic.title}]${sample.replace(/\s/g, '')}`, bookname: sample, author: comic.authors, ext: format }));
    const directory = file.slice(0, file.lastIndexOf('/') + 1);
    return target.kind === 'local' ? joinPath(libraryRoot, directory) + '/' : directory;
  } catch {
    return target.path;
  }
}

/** A folder path relative to the target, as the user knows it (absolute under the library root for local targets). */
export function folderDisplay(target: Target, libraryRoot: string, path: string) {
  const inTarget = joinPath(target.path, path);
  return `${target.kind === 'local' ? joinPath(libraryRoot, inTarget) : inTarget}/`;
}

export function DestinationBar({ targets, target, directory, mapped, format, line, vip, resetting, onTarget, onFormat, onLine, onMapFolder, onResetFolder }: {
  targets: Target[];
  target: Target | undefined;
  directory: string;
  /** The comic uses an existing folder instead of the naming rule's. */
  mapped: boolean;
  format: Format;
  line: Line;
  vip: boolean;
  resetting: boolean;
  onTarget: (id: number) => void;
  onFormat: (format: Format) => void;
  onLine: (line: Line) => void;
  onMapFolder: (opener: HTMLElement) => void;
  onResetFolder: () => void;
}) {
  const [open, setOpen] = useState(false);
  return <Collapsible open={open} onOpenChange={setOpen} className="overflow-hidden rounded-xl bg-muted/45 ring-1 ring-border">
    <CollapsibleTrigger asChild>
      <button type="button" className="group/dest flex h-11 w-full min-w-0 items-center gap-2 px-4 text-left outline-none transition-colors duration-150 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <span className="sr-only">保存位置：</span>
        <HardDrive aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        {target ? <>
          <span className="max-w-36 shrink-0 truncate font-medium">{target.name}</span>
          <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />
          <span title={directory} className="min-w-0 truncate font-mono text-[13px]">{middleTruncate(directory, 48)}</span>
          {mapped && <Badge variant="success" className="max-md:hidden">已对应现有文件夹</Badge>}
          <span className="shrink-0 text-muted-foreground max-sm:hidden">· {FORMAT_LABELS[format]} · {LINE_LABELS[line]}</span>
        </> : <span className="text-muted-foreground">还没有存储位置</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-xs font-medium text-muted-foreground transition-colors duration-150 group-hover/dest:text-foreground">
          {open ? '收起' : '更改'}
          <ChevronDown aria-hidden className="size-3.5 transition-transform duration-250 ease-out-strong group-data-[state=open]/dest:rotate-180" />
        </span>
      </button>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div className="@container border-t border-border/60 bg-card/50 px-4 pt-4 pb-4">
        <div className="grid gap-x-5 gap-y-4 @xl:grid-cols-[minmax(0,1fr)_auto_auto]">
          <Field className="gap-2">
            <FieldLabel htmlFor="view-target">存储位置</FieldLabel>
            <Select value={target ? String(target.id) : ''} onValueChange={value => onTarget(Number(value))}>
              <SelectTrigger id="view-target" className="w-full"><SelectValue placeholder="选择存储位置" /></SelectTrigger>
              <SelectContent position="popper">
                <SelectGroup>{targets.map(t => <SelectItem key={t.id} value={String(t.id)}>
                  {t.name}<span className="text-xs text-muted-foreground">{t.kind === 'local' ? '本地' : 'WebDAV'}{t.isDefault ? ' · 默认' : ''}</span>
                </SelectItem>)}</SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field className="gap-2">
            <FieldTitle aria-hidden>格式</FieldTitle>
            <ToggleGroup type="single" variant="segmented" aria-label="文件格式" value={format} onValueChange={value => { if (value) onFormat(value as Format); }}>
              <ToggleGroupItem value="epub" className="flex-1 px-3.5">EPUB</ToggleGroupItem>
              <ToggleGroupItem value="mobi" className="flex-1 px-3.5">MOBI</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field className="gap-2">
            <FieldTitle aria-hidden>线路</FieldTitle>
            <ToggleGroup type="single" variant="segmented" aria-label="下载线路" value={String(line)} onValueChange={value => { if (value) onLine(Number(value) as Line); }}>
              <ToggleGroupItem value="0" className="flex-1 px-3.5">线路一</ToggleGroupItem>
              <ToggleGroupItem value="1" className="flex-1 px-3.5" disabled={!vip} title={vip ? undefined : '线路二仅 VIP 可用'}>线路二</ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </div>
        {target && <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2.5 border-t border-border/60 pt-4">
          <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-sm font-medium">文件夹{mapped && <Badge variant="success" className="md:hidden">已对应现有文件夹</Badge>}</span>
            {/* In full: the bar above cuts it short (on phones, almost always). */}
            {directory && <span className="font-mono text-xs break-all">{directory}</span>}
            <span className="text-xs leading-relaxed text-muted-foreground">{mapped
              ? '下载到这个已有的文件夹；「已下载」按里面的文件计算。'
              : 'NAS 上已经有这部漫画？对应到那个文件夹，已有的卷就不会重复下载。'}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {mapped && <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" aria-disabled={resetting} onClick={() => { if (!resetting) onResetFolder(); }}>
              {resetting ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Undo2 data-icon="inline-start" />}恢复为命名规则文件夹
            </Button>}
            <Button type="button" variant="outline" size="sm" onClick={e => onMapFolder(e.currentTarget)}><FolderInput data-icon="inline-start" />对应已有文件夹…</Button>
          </div>
        </div>}
        <p className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>「已下载 / 缺失」都按这里的位置和格式计算。</span>
          <Link to="/settings/$section" params={{ section: 'storage' }} className="inline-flex items-center gap-1 font-medium text-foreground/80 underline decoration-foreground/25 underline-offset-4 hover:decoration-foreground">
            <Settings2 className="size-3.5" />管理存储位置
          </Link>
        </p>
      </div>
    </CollapsibleContent>
  </Collapsible>;
}
