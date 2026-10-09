// 通知: channels (Webhook / Bark / Telegram), the events each one receives, and a test message.
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bell, Check, LoaderCircle, Plus, Send, Smartphone, Trash2, Webhook, X, type LucideIcon } from 'lucide-react';
import { cn } from 'cn';
import { Channel, NOTIFY_LABELS, NotifyEvent, type Settings } from '@shared/model';
import { errorMessage, request } from '@/lib/api';
import { fieldErrors, type FieldErrors } from '@/lib/forms';
import { settingsQuery } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Toggle } from '@/components/ui/toggle';
import { ConfirmAction, EmptyState, ErrorState } from '@/components/app/feedback';
import { FieldMessage, PasswordInput } from '@/components/app/fields';
import { SectionSkeleton, usePatchSettings } from './common';

type Kind = Channel['kind'];
const KINDS: Record<Kind, { label: string; icon: LucideIcon }> = { webhook: { label: 'Webhook', icon: Webhook }, bark: { label: 'Bark', icon: Smartphone }, telegram: { label: 'Telegram', icon: Send } };
const DEFAULT_EVENTS: NotifyEvent[] = ['new_items', 'download_failed', 'session_expired', 'quota_low'];

function blank(kind: Kind): Channel {
  const base = { id: crypto.randomUUID(), name: KINDS[kind].label, events: DEFAULT_EVENTS, enabled: true };
  return kind === 'webhook' ? { ...base, kind, url: '' } : kind === 'bark' ? { ...base, kind, server: 'https://api.day.app', key: '' } : { ...base, kind, token: '', chatId: '' };
}

function ChannelCard({ channel, saved, all, onDone }: { channel: Channel; saved: boolean; all: Channel[]; onDone?: () => void }) {
  const patch = usePatchSettings();
  const [draft, setDraft] = useState(channel);
  const [base, setBase] = useState(channel);
  if (base !== channel) { setBase(channel); setDraft(channel); }
  const [errors, setErrors] = useState<FieldErrors>({});
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const dirty = !saved || JSON.stringify(draft) !== JSON.stringify(channel);
  const id = `channel-${channel.id}`;
  const Icon = KINDS[draft.kind].icon;
  const set = (field: string, value: unknown) => { setDraft(old => ({ ...old, [field]: value }) as Channel); setErrors(old => ({ ...old, [field]: undefined })); setResult(null); };
  const list = (next: Channel | null) => all.some(c => c.id === channel.id) ? all.flatMap(c => c.id !== channel.id ? [c] : next ? [next] : []) : next ? [...all, next] : all;
  const test = useMutation({
    mutationFn: (value: Channel) => request('POST /api/notifications/test', { body: value }),
    onMutate: () => setResult(null),
    onSuccess: next => setResult(next),
    onError: error => setResult({ ok: false, message: errorMessage(error) }),
  });

  function valid() {
    const parsed = Channel.safeParse(draft);
    const next = parsed.success ? {} : fieldErrors(parsed.error);
    setErrors(next);
    const first = Object.keys(next)[0];
    if (first) document.getElementById(`${id}-${first}`)?.focus();
    return parsed.success ? parsed.data : null;
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const value = valid();
    if (value && dirty && !patch.isPending) patch.mutate({ notifications: list(value) }, { onSuccess: () => { toast.success(saved ? '已保存' : `已添加「${value.name}」`); onDone?.(); } });
  }
  const field = (name: string, label: string, props: { placeholder?: string; mono?: boolean; secret?: boolean; hint?: string }) => {
    const value = (draft as unknown as Record<string, string>)[name] ?? '';
    const aria = { 'aria-invalid': !!errors[name], 'aria-describedby': errors[name] ? `${id}-${name}-error` : props.hint ? `${id}-${name}-hint` : undefined };
    return <Field className="gap-2">
      <FieldLabel htmlFor={`${id}-${name}`}>{label}</FieldLabel>
      {props.secret
        ? <PasswordInput id={`${id}-${name}`} autoComplete="off" className="font-mono" placeholder={props.placeholder} value={value} onChange={e => set(name, e.target.value)} {...aria} />
        : <Input id={`${id}-${name}`} spellCheck={false} autoCapitalize="none" className={cn(props.mono && 'font-mono md:text-[13px]')} placeholder={props.placeholder} value={value} onChange={e => set(name, e.target.value)} {...aria} />}
      {errors[name] ? <FieldMessage id={`${id}-${name}-error`}>{errors[name]}</FieldMessage> : props.hint && <p id={`${id}-${name}-hint`} className="text-xs text-muted-foreground">{props.hint}</p>}
    </Field>;
  };

  return <form noValidate onSubmit={submit} aria-label={`通知渠道 ${channel.name}`} className={cn('animate-rise overflow-hidden rounded-2xl bg-card shadow-soft ring-1', saved ? 'ring-border' : 'ring-seal/30')}>
    <div className="flex flex-col gap-5 p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"><Icon className="size-4" /></span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{draft.name || KINDS[draft.kind].label}</span>
          <span className="text-xs text-muted-foreground">{KINDS[draft.kind].label}{!saved && ' · 尚未保存'}</span>
        </div>
        {/* The settings update at once (and revert if saving fails), so the switch is not greyed out while it saves. */}
        <Switch aria-label={`启用 ${draft.name}`} checked={saved ? channel.enabled : draft.enabled}
          onCheckedChange={enabled => { if (!saved) set('enabled', enabled); else if (!patch.isPending) patch.mutate({ notifications: list({ ...channel, enabled }) }); }} />
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        {field('name', '名称', {})}
        {draft.kind === 'webhook' && <div className="sm:col-span-2">{field('url', '地址', { mono: true, placeholder: 'https://example.com/hooks/kmoesync', hint: '事件发生时向这个地址发送 JSON 格式的 POST 请求。' })}</div>}
        {draft.kind === 'bark' && <>{field('server', '服务器', { mono: true, placeholder: 'https://api.day.app' })}{field('key', '设备 Key', { secret: true, hint: 'Bark App 首页显示的那串 Key。' })}</>}
        {draft.kind === 'telegram' && <>{field('token', 'Bot 令牌', { secret: true, hint: '@BotFather 发给你的令牌。' })}{field('chatId', 'Chat ID', { mono: true, hint: '接收消息的用户或群组 ID。' })}</>}
      </div>
      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-2.5 text-sm font-medium">推送这些事件</legend>
        <div className="flex flex-wrap gap-1.5">
          {NotifyEvent.options.map(event => <Toggle key={event} variant="outline" size="sm" pressed={draft.events.includes(event)}
            onPressedChange={on => set('events', on ? NotifyEvent.options.filter(e => e === event || draft.events.includes(e)) : draft.events.filter(e => e !== event))}>
            {NOTIFY_LABELS[event]}
          </Toggle>)}
        </div>
      </fieldset>
      {result && <p role="status" className={cn('flex animate-rise items-start gap-1.5 text-xs', result.ok ? 'text-success' : 'text-destructive')}>
        {result.ok ? <Check className="mt-px size-3.5 shrink-0" strokeWidth={2.5} /> : <X className="mt-px size-3.5 shrink-0" strokeWidth={2.5} />}{result.message}
      </p>}
    </div>
    <div className="flex flex-wrap items-center gap-2 border-t bg-muted/35 px-5 py-3.5 sm:px-6">
      {saved ? <ConfirmAction title={`删除「${channel.name}」？`} description="之后不会再向这个渠道推送通知。" onConfirm={() => patch.mutate({ notifications: list(null) }, { onSuccess: () => void toast.success('已删除') })}>
        <Button type="button" variant="ghost" size="sm" className="-ml-2 text-destructive hover:bg-destructive/10 hover:text-destructive"><Trash2 data-icon="inline-start" />删除</Button>
      </ConfirmAction> : <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={onDone}>放弃</Button>}
      <span className="mr-auto text-xs text-muted-foreground">{dirty && saved ? '有未保存的更改' : ''}</span>
      <Button type="button" variant="outline" aria-disabled={test.isPending} onClick={() => { const value = valid(); if (value && !test.isPending) test.mutate(value); }}>
        {test.isPending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Send data-icon="inline-start" />}发送测试
      </Button>
      <Button type="submit" aria-disabled={!dirty || patch.isPending}>{patch.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}{saved ? '保存' : '添加'}</Button>
    </div>
  </form>;
}

function AddButtons({ onAdd }: { onAdd: (kind: Kind) => void }) {
  return <>{(Object.keys(KINDS) as Kind[]).map(kind => {
    const Icon = KINDS[kind].icon;
    return <Button key={kind} variant="outline" size="sm" onClick={() => onAdd(kind)}><Plus data-icon="inline-start" /><Icon className="size-3.5" />{KINDS[kind].label}</Button>;
  })}</>;
}

export function NotificationsSection() {
  const settings = useQuery(settingsQuery);
  const [drafts, setDrafts] = useState<Channel[]>([]);
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  if (!settings.data) return <SectionSkeleton />;
  const channels: Settings['notifications'] = settings.data.notifications;
  const add = (kind: Kind) => setDrafts(old => [...old, blank(kind)]);
  return <>
    {channels.length + drafts.length > 0 && <div className="flex flex-wrap items-center gap-2">
      <span className="mr-auto text-sm text-muted-foreground">添加渠道</span>
      <AddButtons onAdd={add} />
    </div>}
    {!channels.length && !drafts.length ? <EmptyState icon={<Bell />} title="还没有通知渠道" description="添加一个渠道，发现新章节、下载失败或登录失效时就会收到消息。" className="border">
      <AddButtons onAdd={add} />
    </EmptyState> : <div className="flex flex-col gap-4">
      {channels.map(channel => <ChannelCard key={channel.id} channel={channel} saved all={channels} />)}
      {drafts.filter(draft => !channels.some(c => c.id === draft.id)).map(channel => <ChannelCard key={channel.id} channel={channel} saved={false} all={channels} onDone={() => setDrafts(old => old.filter(c => c.id !== channel.id))} />)}
    </div>}
  </>;
}
