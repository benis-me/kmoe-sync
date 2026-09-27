// Bangumi 书单: Bangumi users whose lists are synced, which statuses to read, how often.
import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, ListChecks, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { cn } from 'cn';
import { BANGUMI_LABELS, BangumiType, SourceInput, type Source } from '@shared/model';
import { request } from '@/lib/api';
import { fromNow } from '@/lib/format';
import { fieldErrors, type FieldErrors } from '@/lib/forms';
import { sourcesQuery } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Toggle } from '@/components/ui/toggle';
import { ConfirmAction, EmptyState, ErrorState } from '@/components/app/feedback';
import { FieldMessage } from '@/components/app/fields';
import { SectionSkeleton } from './common';

const INTERVALS = [[6, '每 6 小时'], [12, '每 12 小时'], [24, '每天'], [72, '每 3 天'], [168, '每周']] as const;
const BLANK: SourceInput = { name: '我的 Bangumi', username: '', types: ['wish', 'doing'], enabled: true, intervalHours: 24 };
const inputOf = (source: Source): SourceInput => ({ name: source.name, username: source.username, types: source.types, enabled: source.enabled, intervalHours: source.intervalHours });

function SourceCard({ source, onDone }: { source: Source | null; onDone?: () => void }) {
  const client = useQueryClient();
  const initial = source ? inputOf(source) : BLANK;
  const initialKey = JSON.stringify(initial);
  const [draft, setDraft] = useState(initial);
  const [base, setBase] = useState(initialKey);
  if (base !== initialKey) { setBase(initialKey); setDraft(initial); }
  const [errors, setErrors] = useState<FieldErrors>({});
  const dirty = !source || JSON.stringify(draft) !== initialKey;
  const id = source ? `source-${source.id}` : 'source-new';
  const set = <K extends keyof SourceInput>(field: K, value: SourceInput[K]) => { setDraft(old => ({ ...old, [field]: value })); setErrors(old => ({ ...old, [field]: undefined })); };
  const refresh = () => client.invalidateQueries({ queryKey: ['sources'] });

  const save = useMutation({
    mutationFn: (body: SourceInput) => source ? request('PATCH /api/sources/:id', { params: { id: source.id }, body }) : request('POST /api/sources', { body }),
    onSuccess: saved => { void refresh(); toast.success(source ? '已保存' : `已添加「${saved.name}」`, { description: source ? undefined : '正在第一次同步，稍后到发现页查看。' }); onDone?.(); },
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => request('PATCH /api/sources/:id', { params: { id: source!.id }, body: { enabled } }),
    onSuccess: () => void refresh(),
  });
  const sync = useMutation({
    mutationFn: () => request('POST /api/sources/:id/sync', { params: { id: source!.id } }),
    onSuccess: next => { void refresh(); if (next.error) toast.error(next.error); else toast.success('已同步', { description: `${next.pendingCount} 个条目待匹配` }); },
  });
  const remove = useMutation({
    mutationFn: () => request('DELETE /api/sources/:id', { params: { id: source!.id } }),
    onSuccess: () => { void refresh(); toast.success('已删除书单'); },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = SourceInput.safeParse(draft);
    const next = parsed.success ? {} : fieldErrors(parsed.error);
    setErrors(next);
    const first = Object.keys(next)[0];
    if (first) document.getElementById(`${id}-${first}`)?.focus();
    else if (parsed.success && dirty && !save.isPending) save.mutate(parsed.data);
  }

  return <form noValidate onSubmit={submit} aria-label={source ? `书单 ${source.name}` : '新的书单'} className={cn('animate-rise overflow-hidden rounded-2xl bg-card shadow-soft ring-1', source ? 'ring-border' : 'ring-seal/30')}>
    <div className="flex flex-col gap-5 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"><ListChecks className="size-4" /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium">{draft.name || 'Bangumi'}</span>
          {source ? <span className="text-xs text-muted-foreground tabular-nums">
            {source.itemCount} 个条目 · {source.pendingCount} 个待匹配 · {source.lastSyncAt ? `${fromNow(source.lastSyncAt)}同步` : '尚未同步'}
          </span> : <span className="text-xs text-muted-foreground">尚未保存</span>}
          {source?.error && <span role="alert" className="text-xs text-destructive">{source.error}</span>}
        </div>
        {source && <Switch aria-label={`同步 ${source.name}`} checked={source.enabled} disabled={toggle.isPending} onCheckedChange={enabled => toggle.mutate(enabled)} />}
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field className="gap-2">
          <FieldLabel htmlFor={`${id}-name`}>名称</FieldLabel>
          <Input id={`${id}-name`} value={draft.name} onChange={e => set('name', e.target.value)} aria-invalid={!!errors.name} aria-describedby={errors.name ? `${id}-name-error` : undefined} />
          <FieldMessage id={`${id}-name-error`}>{errors.name}</FieldMessage>
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`${id}-username`}>Bangumi 用户名</FieldLabel>
          <Input id={`${id}-username`} autoFocus={!source} spellCheck={false} autoCapitalize="none" className="font-mono md:text-[13px]" placeholder="bgm.tv/user/ 后面的部分"
            value={draft.username} onChange={e => set('username', e.target.value)} aria-invalid={!!errors.username} aria-describedby={errors.username ? `${id}-username-error` : undefined} />
          <FieldMessage id={`${id}-username-error`}>{errors.username}</FieldMessage>
        </Field>
      </div>
      <fieldset className="flex flex-col">
        <legend className="mb-2.5 text-sm font-medium">读取这些状态</legend>
        <div className="flex flex-wrap gap-1.5">
          {BangumiType.options.map(type => <Toggle key={type} variant="outline" size="sm" pressed={draft.types.includes(type)}
            className="data-[state=on]:border-seal/45 data-[state=on]:bg-seal-soft data-[state=on]:text-seal"
            onPressedChange={on => set('types', on ? BangumiType.options.filter(t => t === type || draft.types.includes(t)) : draft.types.filter(t => t !== type))}>
            {BANGUMI_LABELS[type]}
          </Toggle>)}
        </div>
        {errors.types && <p role="alert" className="mt-2 text-xs text-destructive">{errors.types}</p>}
      </fieldset>
      <Field className="gap-2">
        <FieldLabel htmlFor={`${id}-interval`}>同步周期</FieldLabel>
        <Select value={String(draft.intervalHours)} onValueChange={value => set('intervalHours', Number(value))}>
          <SelectTrigger id={`${id}-interval`} className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent position="popper"><SelectGroup>{INTERVALS.map(([hours, label]) => <SelectItem key={hours} value={String(hours)}>{label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </Field>
    </div>
    <div className="flex flex-wrap items-center gap-2 border-t bg-muted/35 px-5 py-3.5 sm:px-6">
      {source ? <ConfirmAction title={`删除「${source.name}」？`} description="同步来的条目和匹配记录会一起删除，已订阅的漫画不受影响。" onConfirm={() => remove.mutate()}>
        <Button type="button" variant="ghost" size="sm" className="-ml-2 text-destructive hover:bg-destructive/10 hover:text-destructive"><Trash2 data-icon="inline-start" />删除</Button>
      </ConfirmAction> : <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={onDone}>放弃</Button>}
      {source && <Button type="button" variant="ghost" size="sm" asChild><Link to="/discover/bangumi" search={{ source: source.id }}>查看条目<ChevronRight data-icon="inline-end" /></Link></Button>}
      <span className="mr-auto" />
      {source && <Button type="button" variant="outline" aria-disabled={sync.isPending} onClick={() => { if (!sync.isPending) sync.mutate(); }}>
        {sync.isPending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}立即同步
      </Button>}
      <Button type="submit" aria-disabled={!dirty || save.isPending}>{save.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}{source ? '保存' : '添加'}</Button>
    </div>
  </form>;
}

export function SourcesSection() {
  const sources = useQuery(sourcesQuery);
  const [adding, setAdding] = useState(false);
  if (sources.error) return <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />;
  if (!sources.data) return <SectionSkeleton />;
  return <>
    {(sources.data.length > 0 || adding) && <div className="flex items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">同步到的条目在「发现 › Bangumi 书单」里匹配。</p>
      <Button variant="outline" size="sm" aria-disabled={adding} onClick={() => setAdding(true)}><Plus data-icon="inline-start" />添加书单</Button>
    </div>}
    {!sources.data.length && !adding ? <EmptyState icon={<ListChecks />} title="还没有同步 Bangumi 书单" description="填写 Bangumi 用户名，想看、在看的条目会同步过来，方便在 Kmoe 上找到对应的漫画。" className="border">
      <Button onClick={() => setAdding(true)}><Plus data-icon="inline-start" />添加书单</Button>
    </EmptyState> : <div className="flex flex-col gap-4">
      {sources.data.map(source => <SourceCard key={source.id} source={source} />)}
      {adding && <SourceCard source={null} onDone={() => setAdding(false)} />}
    </div>}
  </>;
}
