// 导入浏览器扩展配置 (in 存储位置): an extension export (JSON) brings its WebDAV servers in as storage targets, and its naming rule.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CircleAlert, FileJson, LoaderCircle, Upload, X } from 'lucide-react';
import { formatBytes } from '@shared/naming';
import { errorMessage, request } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardFooter } from '@/components/ui/card';

const MAX_SIZE = 2 * 1024 * 1024;
type Staged = { file: File; config?: unknown; summary?: string; error?: string };

/** What an extension export would bring in: 「2 个 WebDAV 服务器 · 含命名规则」. Throws when it isn't one. */
function summarize(config: unknown) {
  const root = config && typeof config === 'object' ? config as Record<string, unknown> : {};
  const data = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;
  if (!('webdavServers' in data) && !('downloadRule' in data)) throw new Error('这不是浏览器扩展导出的配置文件');
  const parts: string[] = [];
  if (Array.isArray(data.webdavServers)) parts.push(`${data.webdavServers.length} 个 WebDAV 服务器`);
  if (typeof data.downloadRule === 'string') parts.push('含命名规则');
  return parts.join(' · ') || '没有可导入的内容';
}

export function ExtensionImport() {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const zone = useRef<HTMLButtonElement>(null);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [drag, setDrag] = useState(false);
  const run = useMutation({
    mutationFn: (config: unknown) => request('POST /api/import/extension', { body: { config } }),
    onSuccess: result => {
      unstage();
      for (const queryKey of [['targets'], ['status'], ['settings']]) void client.invalidateQueries({ queryKey });
      toast.success(result.targets ? `已导入 ${result.targets} 个存储位置` : '没有新的存储位置', { description: result.rule ? '命名规则已一并导入。' : undefined });
    },
  });

  // A file dropped just outside the zone would make the browser open it and leave the page.
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files') || (e.target as Element | null)?.closest?.('[data-dropzone]')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => { window.removeEventListener('dragover', block); window.removeEventListener('drop', block); };
  }, []);

  async function stage(file: File | undefined) {
    if (!file) return;
    setStaged({ file });
    // Only the latest pick may land, even if an earlier file parses later.
    const land = (next: Staged) => setStaged(old => old?.file === file ? next : old);
    try {
      if (file.size > MAX_SIZE) throw new Error('配置文件不能超过 2 MB');
      const config: unknown = JSON.parse((await file.text()).replace(/^﻿/, ''));
      land({ file, config, summary: summarize(config) });
    } catch (e) {
      land({ file, error: e instanceof SyntaxError ? '不是有效的 JSON 文件' : errorMessage(e) });
    }
  }
  function unstage() { setStaged(null); zone.current?.focus(); }

  return <Card id="import" className="scroll-mt-20 gap-0 py-0">
    <div className="flex flex-col gap-4 p-5 sm:p-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold tracking-tight">导入浏览器扩展配置</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">在扩展的「导出 / 导入」里导出 JSON，拖到这里。WebDAV 服务器会变成存储位置，命名规则一并迁移；导出时包含了密码的话，密码也会导入。</p>
      </div>
      <input ref={input} aria-label="配置文件" type="file" hidden accept=".json,application/json" onChange={e => { void stage(e.target.files?.[0]); e.target.value = ''; }} />
      <div data-dropzone className="flex flex-col gap-2"
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false); }}
        onDrop={e => { e.preventDefault(); setDrag(false); void stage(e.dataTransfer.files[0]); }}>
        <button ref={zone} type="button" data-drag={drag || undefined} onClick={() => input.current?.click()}
          className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-input bg-muted/25 px-4 py-6 text-center outline-none transition-[background-color,border-color] duration-150 hover:border-ring/50 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring data-drag:border-seal data-drag:bg-seal-soft/60">
          <span className="grid size-10 place-items-center rounded-xl bg-card text-muted-foreground shadow-soft ring-1 ring-border transition-[translate,color] duration-200 ease-out-strong in-data-drag:-translate-y-0.5 in-data-drag:text-seal">
            <Upload className="size-4" />
          </span>
          <span className="text-sm font-medium">{staged ? '更换文件' : '拖入配置文件，或点击选择'}</span>
          <span className="text-xs text-muted-foreground">JSON 格式，最大 2 MB</span>
        </button>
        {staged && <div className="flex animate-rise items-center gap-3 rounded-xl border bg-card p-2.5 pl-3 shadow-soft">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><FileJson className="size-4" /></span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5" aria-live="polite">
            <span className="truncate text-sm font-medium" title={staged.file.name}>{staged.file.name}</span>
            {staged.error
              ? <span className="flex items-center gap-1 text-xs text-destructive"><CircleAlert className="size-3.5 shrink-0" />{staged.error}</span>
              : <span className="text-xs text-muted-foreground tabular-nums">{formatBytes(staged.file.size)} · {staged.summary ?? '正在读取…'}</span>}
          </div>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`移除 ${staged.file.name}`} onClick={unstage}><X /></Button>
        </div>}
      </div>
    </div>
    <CardFooter className="justify-end px-5 py-3.5 sm:px-6">
      <Button disabled={!staged?.config} aria-disabled={run.isPending} onClick={() => { if (staged?.config && !run.isPending) run.mutate(staged.config); }}>
        {run.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}导入
      </Button>
    </CardFooter>
  </Card>;
}
