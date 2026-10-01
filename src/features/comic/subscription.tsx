// 追更设置: what to follow, where it goes, and a preview of what saving would queue or cancel right now.
import { useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import { cn } from 'cn';
import { CONTENT_LABELS, type ComicDetail, type ContentType, type Settings, type SubscriptionInput, type Target } from '@shared/model';
import { errorMessage, request } from '@/lib/api';
import { formatMB, fromNow } from '@/lib/format';
import { useDebounced, useNow } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Card, CardFooter } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ConfirmAction } from '@/components/app/feedback';
import { Dot } from '@/components/app/status';

type Draft = Required<SubscriptionInput>;
const TYPES: ContentType[] = ['volume', 'extra', 'serial'];

function Row({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: string }) {
  return <div className="flex flex-col gap-2">
    {htmlFor ? <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">{label}</label> : <span aria-hidden className="text-xs font-medium text-muted-foreground">{label}</span>}
    {children}
    {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
  </div>;
}

export function SubscriptionCard({ detail, targets, settings, vip, remainingMB }: { detail: ComicDetail; targets: Target[]; settings: Settings; vip: boolean; remainingMB: number | null }) {
  const client = useQueryClient();
  const now = useNow();
  const key = detail.comic.key, sub = detail.subscription;
  const present = TYPES.filter(type => detail.items.some(item => item.type === type));
  const saved: Draft = sub
    ? { enabled: sub.enabled, types: sub.types, format: sub.format, targetId: sub.targetId, strategy: sub.strategy, line: sub.line }
    // Where and in which format the page shows the comic: an imported one's folder and file format, else the defaults.
    : { enabled: true, types: present.includes('volume') ? ['volume'] : present.slice(0, 1), format: detail.view.format, targetId: detail.view.targetId ?? targets[0]?.id ?? 0, strategy: 'backfill', line: settings.defaultLine };
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState(saved);
  const [base, setBase] = useState(savedKey);
  // A newer saved subscription (save, another tab) replaces the draft.
  if (base !== savedKey) { setBase(savedKey); setDraft(saved); }
  const dirty = !sub || JSON.stringify(draft) !== savedKey;
  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => setDraft(old => ({ ...old, [field]: value }));

  const input = useDebounced(draft, 350);
  const preview = useQuery({
    queryKey: ['subscription-preview', key, input],
    queryFn: ({ signal }) => request('POST /api/comics/:key/subscription/preview', { params: { key }, body: input, signal }),
    enabled: dirty && input.types.length > 0 && !!input.targetId,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: ['comic', key] }), client.invalidateQueries({ queryKey: ['shelf'] }),
    client.invalidateQueries({ queryKey: ['tasks'] }), client.invalidateQueries({ queryKey: ['status'] }),
  ]);
  const save = useMutation({
    mutationFn: (body: Draft) => request('PUT /api/comics/:key/subscription', { params: { key }, body }),
    onSuccess: (_, body) => {
      const impact = preview.data && dirty ? preview.data : null;
      if (!sub) toast.success(`已订阅《${detail.comic.title}》`, { description: impact?.queue ? `${impact.queue} 项缺失已加入下载队列` : '新章节发布后会自动下载。' });
      else if (body.enabled !== sub.enabled && JSON.stringify({ ...body, enabled: sub.enabled }) === savedKey) toast.success(body.enabled ? '已恢复追更' : '已暂停追更');
      else toast.success('已保存追更设置');
      void refresh();
    },
  });
  const check = useMutation({
    mutationFn: () => request('POST /api/comics/:key/check', { params: { key } }),
    onSuccess: () => void toast.success('正在检查更新', { description: '发现新章节会自动加入下载队列。' }),
  });
  const [cancelPending, setCancelPending] = useState(true);
  const remove = useMutation({
    mutationFn: () => request('DELETE /api/comics/:key/subscription', { params: { key }, query: { cancelPending } }),
    onSuccess: () => { toast.success('已取消订阅'); void refresh(); },
  });

  const impact = preview.data;
  const impactText = !impact ? '' : ([
    impact.queue ? `将新增 ${impact.queue} 个下载任务 · 约 ${formatMB(impact.sizeMB)}` : '',
    impact.cancel ? `将取消 ${impact.cancel} 个等待中的任务` : '',
  ].filter(Boolean).join('，') || (!sub && draft.strategy === 'future' ? '现有章节不会下载，之后发布的新章节会自动下载' : !sub ? '没有需要补齐的章节' : '不会新增或取消任务'))
    + (impact.unknown ? `；另有 ${impact.unknown} 项待确认，不会自动下载` : '');
  const overQuota = !!impact && remainingMB !== null && impact.sizeMB > remainingMB;

  return <Card id="subscription" className="scroll-mt-20 gap-0 py-0">
    <div className="flex items-start gap-3 px-5 pt-5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          追更
          {sub && <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground"><Dot tone={sub.enabled ? 'success' : 'muted'} className="size-1.5" />{sub.enabled ? '进行中' : '已暂停'}</span>}
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">{sub ? '有新卷或新话时自动下载到书库。' : '订阅后，新卷或新话发布时会自动下载。'}</p>
      </div>
      {sub && <Switch aria-label="追更开关" checked={sub.enabled} disabled={save.isPending} onCheckedChange={enabled => save.mutate({ ...saved, enabled })} />}
    </div>

    <div className="flex flex-col gap-5 px-5 pt-5 pb-5">
      <Row label="追踪内容">
        <div role="group" aria-label="追踪内容" className="flex flex-wrap gap-1.5">
          {TYPES.map(type => {
            const count = detail.items.filter(item => item.type === type).length;
            const on = draft.types.includes(type);
            return <Toggle key={type} variant="outline" size="sm" pressed={on}
              className="gap-1.5 px-2.5 data-[state=on]:border-seal/45 data-[state=on]:bg-seal-soft data-[state=on]:text-seal"
              onPressedChange={pressed => set('types', pressed ? TYPES.filter(t => t === type || draft.types.includes(t)) : draft.types.filter(t => t !== type))}>
              {CONTENT_LABELS[type]}<span className="text-[11px] font-normal tabular-nums">{count}</span>
            </Toggle>;
          })}
        </div>
        {!draft.types.length && <p role="alert" className="text-xs text-destructive">至少选择一种内容。</p>}
      </Row>

      <div className="grid grid-cols-2 gap-3">
        <Row label="格式">
          <ToggleGroup type="single" variant="segmented" aria-label="追更格式" className="w-full" value={draft.format} onValueChange={value => value && set('format', value as Draft['format'])}>
            <ToggleGroupItem value="epub" className="flex-1">EPUB</ToggleGroupItem>
            <ToggleGroupItem value="mobi" className="flex-1">MOBI</ToggleGroupItem>
          </ToggleGroup>
        </Row>
        <Row label="线路">
          <ToggleGroup type="single" variant="segmented" aria-label="追更线路" className="w-full" value={String(draft.line)} onValueChange={value => value && set('line', Number(value) as Draft['line'])}>
            <ToggleGroupItem value="0" className="flex-1">线路一</ToggleGroupItem>
            <ToggleGroupItem value="1" className="flex-1" disabled={!vip} title={vip ? undefined : '线路二仅 VIP 可用'}>线路二</ToggleGroupItem>
          </ToggleGroup>
        </Row>
      </div>

      <Row label="存储位置" htmlFor="subscription-target">
        <Select value={String(draft.targetId)} onValueChange={value => set('targetId', Number(value))}>
          <SelectTrigger id="subscription-target" className="w-full"><SelectValue placeholder="选择存储位置" /></SelectTrigger>
          <SelectContent position="popper">
            <SelectGroup>{targets.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}</SelectGroup>
          </SelectContent>
        </Select>
      </Row>

      <Row label={sub ? '缺失章节' : '订阅时'} hint={draft.strategy === 'future' ? '已有的章节保持原样，只下载之后发布的新章节。' : '把现在缺失的章节也一并加入下载队列。'}>
        <ToggleGroup type="single" variant="segmented" aria-label="订阅策略" className="w-full" value={draft.strategy} onValueChange={value => value && set('strategy', value as Draft['strategy'])}>
          <ToggleGroupItem value="backfill" className="flex-1">补齐缺失</ToggleGroupItem>
          <ToggleGroupItem value="future" className="flex-1">仅追新</ToggleGroupItem>
        </ToggleGroup>
      </Row>

      {dirty && !!draft.types.length && <div aria-live="polite" className={cn('flex min-h-11 animate-rise items-center gap-2.5 rounded-xl border border-dashed px-3.5 py-2.5 text-xs leading-relaxed',
        preview.error ? 'border-destructive/30 text-destructive' : 'bg-muted/40 text-foreground/80')}>
        {preview.error ? <><CircleAlert className="size-3.5 shrink-0" />{errorMessage(preview.error)}</>
          : !impact || preview.isFetching ? <><LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" /><span className={cn(!impact && 'text-muted-foreground')}>{impact ? `保存后${impactText}` : '正在计算影响…'}</span></>
          : <span>{sub ? '保存后' : '订阅后'}{impactText}{overQuota && <span className="text-warning">。超出剩余额度 {formatMB(remainingMB)}，额度用完后队列会暂停</span>}</span>}
      </div>}

      {sub && <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">上次检查</dt>
        <dd className="tabular-nums">{sub.lastCheckAt ? fromNow(sub.lastCheckAt, now) : '还没有检查过'}</dd>
        <dt className="text-muted-foreground">下次检查</dt>
        <dd className="tabular-nums">{sub.enabled ? sub.nextCheckAt ? fromNow(sub.nextCheckAt, now) : '等待安排' : '已暂停'}</dd>
        {sub.error && <><dt className="text-destructive">错误</dt><dd className="text-destructive">{sub.error}</dd></>}
      </dl>}
    </div>

    <CardFooter className="flex-wrap gap-2 px-5 py-3.5">
      {sub && <>
        <Button type="button" variant="outline" size="sm" aria-disabled={check.isPending} onClick={() => { if (!check.isPending) check.mutate(); }}>
          {check.isPending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}立即检查
        </Button>
        <ConfirmAction title={`取消订阅《${detail.comic.title}》？`} description="已下载的文件保留在书库中。" action="取消订阅" onConfirm={() => remove.mutate()}
          extra={<label className="flex items-center gap-2.5 text-sm"><Checkbox checked={cancelPending} onCheckedChange={value => setCancelPending(value === true)} />同时取消等待中的追更任务</label>}>
          <Button type="button" variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive">取消订阅</Button>
        </ConfirmAction>
      </>}
      <Button type="button" size="sm" className="ml-auto" aria-disabled={!dirty || !draft.types.length || save.isPending}
        onClick={() => { if (dirty && draft.types.length && !save.isPending) save.mutate(draft); }}>
        {save.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}{sub ? '保存更改' : '订阅'}
      </Button>
    </CardFooter>
  </Card>;
}
