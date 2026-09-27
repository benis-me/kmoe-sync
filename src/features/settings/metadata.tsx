// Komga 元数据: Bangumi metadata written to Komga. The switch and the options save at once;
// the Komga connection (address, credentials, library per storage target) and the Bangumi source card save with their buttons.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { HardDrive, LoaderCircle, Server } from 'lucide-react';
import type { KomgaLibrary, MetadataOptions, MetadataSettings, Target } from '@shared/model';
import { errorMessage, request } from '@/lib/api';
import { metadataSettingsQuery, targetsQuery } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ConfirmAction, ErrorState } from '@/components/app/feedback';
import { FieldMessage, PasswordInput } from '@/components/app/fields';
import { BangumiSourceCard } from './bangumi-source';
import { SaveHint, SectionSkeleton, SettingRow, usePatchMetadata } from './common';
import { ConnectionStatus, type Connection } from './target-editor';

type Draft = { url: string; auth: 'apiKey' | 'basic'; username: string; secret: string; libraries: Record<number, string> };
const draftOf = (s: MetadataSettings): Draft => ({
  url: s.komga.url, auth: s.komga.auth, username: s.komga.username, secret: '',
  libraries: Object.fromEntries(s.komga.libraries.map(l => [l.targetId, l.libraryId])),
});

function ConnectionCard({ settings, targets }: { settings: MetadataSettings; targets: Target[] }) {
  const patch = usePatchMetadata();
  const initial = draftOf(settings);
  const initialKey = JSON.stringify(initial);
  const [draft, setDraft] = useState(initial);
  const [base, setBase] = useState(initialKey);
  if (base !== initialKey) { setBase(initialKey); setDraft(initial); }
  const [errors, setErrors] = useState<Partial<Record<'url' | 'username' | 'secret', string>>>({});
  const [connection, setConnection] = useState<Connection>({ state: 'idle' });
  const [libraries, setLibraries] = useState<KomgaLibrary[] | null>(null);
  const attempt = useRef(0);
  const dirty = JSON.stringify(draft) !== initialKey;
  const basic = draft.auth === 'basic';
  // A stored secret belongs to the saved auth mode: switching modes needs a new one.
  const keeps = settings.komga.hasSecret && draft.auth === settings.komga.auth;
  const secretLabel = basic ? '密码' : 'API Key';

  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => {
    setDraft(old => ({ ...old, [field]: value }));
    setErrors(old => ({ ...old, [field]: undefined }));
    if (field === 'url' || field === 'auth' || field === 'username' || field === 'secret') { attempt.current++; setConnection({ state: 'idle' }); }
  };
  const komgaDraft = () => ({ url: draft.url.trim(), auth: draft.auth, username: draft.username.trim(), ...(draft.secret ? { secret: draft.secret } : {}) });
  const test = useMutation({
    mutationFn: () => request('POST /api/metadata/komga/test', { body: komgaDraft() }),
    onMutate: () => { setConnection({ state: 'testing' }); return ++attempt.current; },
    onSuccess: (result, _, run) => {
      if (run !== attempt.current) return;
      setConnection({ state: result.ok ? 'ok' : 'error', message: result.message });
      if (result.ok) setLibraries(result.libraries);
    },
    onError: (error, _, run) => { if (run === attempt.current) setConnection({ state: 'error', message: errorMessage(error) }); },
  });
  // Already configured: read the Komga libraries once, so the mapping below shows their names.
  const tested = useRef(false);
  useEffect(() => {
    if (tested.current || !settings.komga.url || !settings.komga.hasSecret) return;
    tested.current = true;
    test.mutate();
  }, [settings.komga.url, settings.komga.hasSecret, test.mutate]);

  function validate() {
    const next: typeof errors = {};
    const url = draft.url.trim();
    if (url && !/^https?:\/\/[^/\s]+/i.test(url)) next.url = '地址需要以 http:// 或 https:// 开头';
    if (url && basic && !draft.username.trim()) next.username = '请填写 Komga 用户名';
    if (url && !draft.secret && !keeps) next.secret = settings.komga.hasSecret ? `切换认证方式后需要重新填写${secretLabel}` : `请填写${secretLabel}`;
    setErrors(next);
    const first = (['url', 'username', 'secret'] as const).find(field => next[field]);
    if (first) document.getElementById(`komga-${first}`)?.focus();
    return !first;
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty || patch.isPending || !validate()) return;
    const mapped = targets.flatMap(t => draft.libraries[t.id] ? [{ targetId: t.id, libraryId: draft.libraries[t.id]! }] : []);
    patch.mutate({ komga: { ...komgaDraft(), libraries: mapped } }, { onSuccess: () => void toast.success('已保存 Komga 连接') });
  }
  const clearSecret = () => patch.mutate({ komga: { secret: '' } }, { onSuccess: () => void toast.success('已清除') });
  const error = (field: keyof typeof errors) => errors[field] ? { 'aria-invalid': true, 'aria-describedby': `komga-${field}-error` } : {};

  return <form noValidate onSubmit={submit} aria-label="Komga 连接" className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-border">
    <div className="flex flex-col gap-6 p-5 sm:p-6">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">Komga 连接</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">Kmoe Sync 通过 Komga 的接口写入元数据，不会改动书库里的文件。</p>
      </div>
      <Field className="gap-2">
        <FieldLabel htmlFor="komga-url">Komga 地址</FieldLabel>
        <Input id="komga-url" inputMode="url" className="font-mono md:text-[13px]" placeholder="http://nas.local:25600" autoCapitalize="none" spellCheck={false}
          value={draft.url} onChange={e => set('url', e.target.value)} {...error('url')} />
        <FieldMessage id="komga-url-error">{errors.url}</FieldMessage>
      </Field>
      <div className="flex flex-col gap-2">
        <span id="komga-auth-label" className="text-sm leading-snug font-medium">认证方式</span>
        <ToggleGroup type="single" variant="segmented" aria-labelledby="komga-auth-label" value={draft.auth} onValueChange={value => value && set('auth', value as Draft['auth'])}>
          <ToggleGroupItem value="apiKey" className="px-3.5">API Key</ToggleGroupItem>
          <ToggleGroupItem value="basic" className="px-3.5">账号密码</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        {basic && <Field className="gap-2">
          <FieldLabel htmlFor="komga-username">用户名</FieldLabel>
          <Input id="komga-username" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Komga 登录邮箱" value={draft.username} onChange={e => set('username', e.target.value)} {...error('username')} />
          <FieldMessage id="komga-username-error">{errors.username}</FieldMessage>
        </Field>}
        <Field className={basic ? 'gap-2' : 'gap-2 sm:col-span-2'}>
          <FieldLabel htmlFor="komga-secret">{secretLabel}</FieldLabel>
          <div className="flex items-center gap-2">
            <PasswordInput id="komga-secret" autoComplete="new-password" className="font-mono" placeholder={keeps ? '已保存，留空则不修改' : basic ? '' : 'Komga › 账户设置 › API Key'}
              value={draft.secret} onChange={e => set('secret', e.target.value)} {...error('secret')} />
            {settings.komga.hasSecret && <ConfirmAction title={`清除已保存的${settings.komga.auth === 'basic' ? '密码' : ' API Key'}？`} description="清除后无法连接 Komga，直到重新填写。" action="清除"
              onConfirm={clearSecret}>
              <Button type="button" variant="ghost" size="sm" className="shrink-0 text-muted-foreground hover:text-destructive">清除</Button>
            </ConfirmAction>}
          </div>
          <FieldMessage id="komga-secret-error">{errors.secret}</FieldMessage>
        </Field>
      </div>
      <ConnectionStatus id="komga-status" connection={connection} />

      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">对应的 Komga 库</span>
          <p className="text-xs leading-relaxed text-muted-foreground">Komga 里显示同一个目录的库。没有对应的存储位置不会同步。</p>
        </div>
        <ul className="flex flex-col divide-y rounded-xl ring-1 ring-border">
          {targets.map(target => {
            const value = draft.libraries[target.id] ?? '';
            const unknown = value && !libraries?.some(l => l.id === value);
            return <li key={target.id} className="flex items-center gap-3 px-3.5 py-2.5 max-sm:flex-wrap">
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">{target.kind === 'local' ? <HardDrive className="size-3.5" /> : <Server className="size-3.5" />}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <label htmlFor={`komga-library-${target.id}`} className="truncate text-sm">{target.name}</label>
                <span className="truncate font-mono text-[11px] text-muted-foreground">{target.path}</span>
              </span>
              <Select value={value || 'none'} disabled={!libraries && !value} onValueChange={next => setDraft(old => ({ ...old, libraries: { ...old.libraries, [target.id]: next === 'none' ? '' : next } }))}>
                <SelectTrigger id={`komga-library-${target.id}`} className="w-48 max-sm:w-full"><SelectValue placeholder="先测试连接" /></SelectTrigger>
                <SelectContent position="popper" align="end">
                  <SelectGroup>
                    <SelectItem value="none">不同步</SelectItem>
                    {unknown && <SelectItem value={value}>已保存的库</SelectItem>}
                    {libraries?.map(library => <SelectItem key={library.id} value={library.id}>{library.name}<span className="font-mono text-[11px] text-muted-foreground">{library.root}</span></SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </li>;
          })}
        </ul>
        {!libraries && <p className="text-xs text-muted-foreground">测试连接后可以从 Komga 的库里选择。</p>}
      </div>

    </div>
    <div className="flex flex-wrap items-center gap-2 border-t bg-muted/35 px-5 py-3.5 sm:px-6">
      <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">{dirty && <><span aria-hidden className="size-1.5 rounded-full bg-warning" />有未保存的更改</>}</span>
      <Button type="button" variant="outline" aria-disabled={test.isPending || !draft.url.trim()} aria-describedby="komga-status"
        onClick={() => { if (!test.isPending && draft.url.trim() && validate()) test.mutate(); }}>
        {test.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}测试连接
      </Button>
      <Button type="submit" aria-disabled={!dirty || patch.isPending}>{patch.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}保存</Button>
    </div>
  </form>;
}

/** Typed, so it saves on blur or Enter rather than on every keystroke. */
function TagLimit({ value, onSave }: { value: number; onSave: (limit: number) => void }) {
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) { setShown(value); setText(String(value)); }
  const parsed = Number(text);
  const invalid = text.trim() === '' || !Number.isInteger(parsed) || parsed < 0 || parsed > 30;
  const commit = () => { if (invalid) setText(String(value)); else if (parsed !== value) onSave(parsed); };
  return <InputGroup className="w-20">
    <InputGroupInput id="meta-tags" inputMode="numeric" className="pr-3 text-right tabular-nums" value={text} aria-invalid={invalid}
      onChange={e => setText(e.target.value.replace(/[^\d]/g, ''))} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
  </InputGroup>;
}

function OptionsCard({ options, bangumi }: { options: MetadataOptions; bangumi: MetadataSettings['bangumi'] }) {
  // Offline data has no cover images: covers are only replaced when the online API answers.
  const noCovers = bangumi.source === 'archive' || (bangumi.source === 'auto' && bangumi.online.reachable === false);
  const patch = usePatchMetadata();
  const save = (next: Partial<MetadataOptions>) => patch.mutate({ options: next });
  return <Card className="gap-0 divide-y py-0">
    <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[15px] font-semibold tracking-tight">写入内容</h3>
        <p className="text-xs text-muted-foreground">简介、状态、出版社和标签总会写入；下面这些可以调整。</p>
      </div>
      <SaveHint pending={patch.isPending} saved={patch.isSuccess} />
    </div>
    <SettingRow label="标题语言" labelId="meta-title-label" description="系列标题用 Bangumi 的中文名（没有时用原名），或一律用原名。">
      <ToggleGroup type="single" variant="segmented" aria-labelledby="meta-title-label" value={options.titleLanguage} onValueChange={value => value && save({ titleLanguage: value as MetadataOptions['titleLanguage'] })}>
        <ToggleGroupItem value="cn" className="px-3.5">中文名</ToggleGroupItem>
        <ToggleGroupItem value="original" className="px-3.5">原名</ToggleGroupItem>
      </ToggleGroup>
    </SettingRow>
    <SettingRow label="写入单册信息" htmlFor="meta-books" description="每一卷的卷号、发售日期、ISBN 和作者。">
      <Switch id="meta-books" checked={options.books} onCheckedChange={books => save({ books })} />
    </SettingRow>
    <SettingRow label="封面" labelId="meta-posters-label" description={noCovers ? '用 Bangumi 的封面替换 Komga 里的封面。离线数据没有封面图，只在在线查询时替换。' : '用 Bangumi 的封面替换 Komga 里的封面。'}>
      <ToggleGroup type="single" variant="segmented" aria-labelledby="meta-posters-label" value={options.posters} onValueChange={value => value && save({ posters: value as MetadataOptions['posters'] })}>
        <ToggleGroupItem value="off" className="px-3">不替换</ToggleGroupItem>
        <ToggleGroupItem value="series" className="px-3">仅系列</ToggleGroupItem>
        <ToggleGroupItem value="all" className="px-3">系列和单册</ToggleGroupItem>
      </ToggleGroup>
    </SettingRow>
    <SettingRow label="锁定已写入字段" htmlFor="meta-lock" description="Komga 自己刷新元数据时，保留这里写入的内容。">
      <Switch id="meta-lock" checked={options.lock} onCheckedChange={lock => save({ lock })} />
    </SettingRow>
    <SettingRow label="下载后自动同步" htmlFor="meta-auto" description="新卷下载完成或导入文件夹后，自动匹配 Bangumi 并写入 Komga。">
      <Switch id="meta-auto" checked={options.autoSync} onCheckedChange={autoSync => save({ autoSync })} />
    </SettingRow>
    <SettingRow label="标签数量" htmlFor="meta-tags" description="最多写入几个 Bangumi 标签（按标注人数），0 表示不写标签。">
      <TagLimit value={options.tagLimit} onSave={tagLimit => save({ tagLimit })} />
    </SettingRow>
  </Card>;
}

export function MetadataSection() {
  const settings = useQuery(metadataSettingsQuery);
  const targets = useQuery(targetsQuery);
  const patch = usePatchMetadata();
  const { hash } = useLocation();
  const ready = !!settings.data && !!targets.data;
  // Arriving from a 「数据来源」 hint (书库, 漫画页): go straight to the card.
  useEffect(() => { if (ready && hash === 'bangumi-source') document.getElementById('bangumi-source')?.scrollIntoView({ block: 'start' }); }, [ready, hash]);
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  if (!settings.data || !targets.data) return <SectionSkeleton />;
  const s = settings.data;
  return <>
    <Card className="gap-0 py-0">
      <SettingRow label="启用 Komga 元数据" htmlFor="metadata-enabled" description="把 Bangumi 的简介、标签和单册信息写入 Komga，可以代替 BangumiKomga。关闭时不会匹配 Bangumi，也不会改动 Komga。">
        <Switch id="metadata-enabled" checked={s.enabled} onCheckedChange={enabled => patch.mutate({ enabled }, { onSuccess: next => void toast.success(next.enabled ? '已开启 Komga 元数据' : '已关闭 Komga 元数据') })} />
      </SettingRow>
      {s.enabled && (!s.komga.url || !s.komga.libraries.length) && <p className="border-t px-5 py-3 text-xs text-warning">
        {!s.komga.url ? '填写并保存下面的 Komga 地址后才会同步。' : '还没有为存储位置选择对应的 Komga 库。'}
      </p>}
    </Card>
    <ConnectionCard settings={s} targets={targets.data} />
    <BangumiSourceCard bangumi={s.bangumi} />
    <OptionsCard options={s.options} bangumi={s.bangumi} />
  </>;
}
