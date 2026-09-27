// One storage target: local sub-directory or WebDAV server, naming rule, connection test. Saved targets keep their kind.
import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Folder, LoaderCircle, Star, Trash2, X } from 'lucide-react';
import { cn } from 'cn';
import { TargetInput, type Target, type TargetKind } from '@shared/model';
import { DEFAULT_RULE, NamingError, normalizePath, validateRule } from '@shared/naming';
import { errorMessage, request } from '@/lib/api';
import { fieldErrors, type FieldErrors } from '@/lib/forms';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ConfirmAction } from '@/components/app/feedback';
import { FieldMessage, PasswordInput } from '@/components/app/fields';
import { DirectoryBrowser, type BrowseTarget } from '@/components/app/directory-browser';
import { RuleEditor } from './rule-editor';

type Draft = { kind: TargetKind; name: string; path: string; url: string; username: string; password: string; rule: string };
export type Connection = { state: 'idle' | 'testing' } | { state: 'ok' | 'error'; message: string };

export const hostOf = (url: string | null) => { try { return url ? new URL(url).host : ''; } catch { return ''; } };
const draftOf = (target: Target | null): Draft => target
  ? { kind: target.kind, name: target.name, path: target.path, url: target.url ?? '', username: target.username ?? '', password: '', rule: target.rule }
  : { kind: 'local', name: '', path: '/', url: '', username: '', password: '', rule: DEFAULT_RULE };

/** What the API takes: a blank password means "keep the stored one". */
function inputOf(draft: Draft): TargetInput {
  return draft.kind === 'local'
    ? { kind: 'local', name: draft.name, path: draft.path, rule: draft.rule }
    : { kind: 'webdav', name: draft.name, path: draft.path, url: draft.url.trim(), username: draft.username, rule: draft.rule, ...(draft.password ? { password: draft.password } : {}) };
}

function validate(draft: Draft): FieldErrors {
  const parsed = TargetInput.safeParse(inputOf(draft));
  const errors = parsed.success ? {} : fieldErrors(parsed.error);
  const naming = (check: () => unknown) => { try { check(); return undefined; } catch (e) { return e instanceof NamingError ? e.message : errorMessage(e); } };
  errors.path ??= naming(() => normalizePath(draft.path || '/'));
  errors.rule ??= naming(() => validateRule(draft.rule));
  if (draft.kind === 'webdav' && !/^https?:\/\/[^/\s]+/i.test(draft.url.trim())) errors.url = draft.url.trim() ? '地址需要以 http:// 或 https:// 开头' : '请填写 WebDAV 地址';
  return Object.fromEntries(Object.entries(errors).filter(([, message]) => message));
}

export function ConnectionStatus({ id, connection }: { id: string; connection: Connection }) {
  return <p id={id} role="status" className={cn('flex min-h-5 min-w-0 items-start gap-1.5 text-xs',
    connection.state === 'ok' ? 'text-success' : connection.state === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
    {connection.state === 'idle' && <><span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />还没有测试连接</>}
    {connection.state === 'testing' && <><LoaderCircle className="mt-px size-3.5 shrink-0 animate-spin" />正在连接…</>}
    {connection.state === 'ok' && <><Check className="mt-px size-3.5 shrink-0 animate-pop" strokeWidth={2.5} /><span className="min-w-0 break-words">{connection.message}</span></>}
    {connection.state === 'error' && <><X className="mt-px size-3.5 shrink-0 animate-pop" strokeWidth={2.5} /><span className="min-w-0 break-words">{connection.message}</span></>}
  </p>;
}

export function TargetEditor({ target, libraryRoot, onSaved, onDiscard }: {
  target: Target | null;
  libraryRoot: string;
  onSaved?: (target: Target) => void;
  onDiscard?: () => void;
}) {
  const client = useQueryClient();
  const initial = draftOf(target);
  const initialKey = JSON.stringify(initial);
  const [draft, setDraft] = useState(initial);
  const [base, setBase] = useState(initialKey);
  // The saved target changed (saved here, or elsewhere): start from it again.
  if (base !== initialKey) { setBase(initialKey); setDraft(initial); }
  const [errors, setErrors] = useState<FieldErrors>({});
  const [connection, setConnection] = useState<Connection>({ state: 'idle' });
  const [browse, setBrowse] = useState<BrowseTarget | null>(null);
  const attempt = useRef(0);
  const id = target ? `target-${target.id}` : 'target-new';
  const dirty = !target || JSON.stringify(draft) !== initialKey;
  const webdav = draft.kind === 'webdav';

  const update = <K extends keyof Draft>(field: K, value: Draft[K]) => {
    setDraft(old => ({ ...old, [field]: value }));
    setErrors(old => ({ ...old, [field]: undefined }));
    // Where or how it connects changed: an earlier test result no longer applies.
    if (field !== 'name' && field !== 'rule') { attempt.current++; setConnection({ state: 'idle' }); }
  };
  // Testing and browsing work before the target has a name.
  const probe = { ...draft, name: draft.name.trim() || '未命名' };
  /** Saved and unchanged: refer to it by id; otherwise send the draft (with the id, so the stored password still counts). */
  const ref = () => target && !dirty ? { targetId: target.id } : { targetId: target?.id, draft: inputOf(probe) };
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['targets'] }), client.invalidateQueries({ queryKey: ['status'] }), client.invalidateQueries({ queryKey: ['settings'] })]);

  const save = useMutation({
    mutationFn: () => target ? request('PATCH /api/targets/:id', { params: { id: target.id }, body: inputOf(draft) }) : request('POST /api/targets', { body: inputOf(draft) }),
    onSuccess: saved => { setDraft(draftOf(saved)); void refresh(); toast.success(target ? '已保存' : `已添加「${saved.name}」`); onSaved?.(saved); },
  });
  const test = useMutation({
    mutationFn: () => request('POST /api/targets/test', { body: ref() }),
    onMutate: () => { setConnection({ state: 'testing' }); return ++attempt.current; },
    onSuccess: (result, _, run) => { if (run === attempt.current) setConnection({ state: result.ok ? 'ok' : 'error', message: result.message }); },
    onError: (error, _, run) => { if (run === attempt.current) setConnection({ state: 'error', message: errorMessage(error) }); },
  });
  const remove = useMutation({
    mutationFn: () => request('DELETE /api/targets/:id', { params: { id: target!.id } }),
    onSuccess: () => { void refresh(); toast.success(`已删除「${target!.name}」`, { description: '书库中的文件不受影响。' }); },
  });
  const makeDefault = useMutation({
    mutationFn: () => request('POST /api/targets/:id/default', { params: { id: target!.id } }),
    onSuccess: () => { void refresh(); toast.success(`「${target!.name}」已设为默认`); },
  });

  function check(value = draft) {
    const next = validate(value);
    setErrors(next);
    const first = Object.keys(next)[0];
    if (first) document.getElementById(`${id}-${first}`)?.focus();
    return !first;
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!save.isPending && dirty && check()) save.mutate();
  }
  function openBrowser(opener: HTMLElement) {
    if (!check(probe)) return;
    setBrowse({
      ref: ref(), name: draft.name || '新的存储位置', path: draft.path || '/', opener,
      root: webdav ? hostOf(draft.url) || 'WebDAV' : `书库根目录 ${libraryRoot}`,
      apply: path => update('path', path),
    });
  }
  const error = (field: keyof Draft) => errors[field] ? { 'aria-invalid': true, 'aria-describedby': `${id}-${field}-error` } : {};

  return <form noValidate onSubmit={submit} aria-label={target ? `编辑 ${target.name}` : '新的存储位置'} className="flex flex-col">
    <div className="flex flex-col gap-6 p-5 sm:p-6">
      {/* A saved target keeps its kind (its files live there); the kind shows in the row header. */}
      <div className={cn('grid gap-5', !target && 'sm:grid-cols-[minmax(0,1fr)_auto]')}>
        <Field className="gap-2">
          <FieldLabel htmlFor={`${id}-name`}>名称</FieldLabel>
          <Input id={`${id}-name`} autoFocus={!target} placeholder={webdav ? '例如 NAS 书库' : '例如 本地书库'} value={draft.name} onChange={e => update('name', e.target.value)} {...error('name')} />
          <FieldMessage id={`${id}-name-error`}>{errors.name}</FieldMessage>
        </Field>
        {!target && <Field className="gap-2">
          <span className="text-sm leading-snug font-medium" aria-hidden>类型</span>
          <ToggleGroup type="single" variant="segmented" aria-label="类型" value={draft.kind} onValueChange={value => value && update('kind', value as TargetKind)}>
            <ToggleGroupItem value="local" className="px-3.5">本地目录</ToggleGroupItem>
            <ToggleGroupItem value="webdav" className="px-3.5">WebDAV</ToggleGroupItem>
          </ToggleGroup>
        </Field>}
      </div>

      {webdav && <div className="grid gap-5 sm:grid-cols-2">
        <Field className="gap-2 sm:col-span-2">
          <FieldLabel htmlFor={`${id}-url`}>WebDAV 地址</FieldLabel>
          <Input id={`${id}-url`} inputMode="url" className="font-mono md:text-[13px]" placeholder="https://nas.local:5006/dav" autoCapitalize="none" spellCheck={false}
            value={draft.url} onChange={e => update('url', e.target.value)} {...error('url')} />
          <FieldMessage id={`${id}-url-error`}>{errors.url}</FieldMessage>
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`${id}-username`}>用户名</FieldLabel>
          <Input id={`${id}-username`} autoComplete="off" autoCapitalize="none" spellCheck={false} value={draft.username} onChange={e => update('username', e.target.value)} />
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`${id}-password`}>密码</FieldLabel>
          <PasswordInput id={`${id}-password`} autoComplete="new-password" placeholder={target?.hasPassword ? '已保存，留空则不修改' : ''} value={draft.password} onChange={e => update('password', e.target.value)} />
        </Field>
      </div>}

      <Field className="gap-2">
        <FieldLabel htmlFor={`${id}-path`}>{webdav ? '书库目录' : '子目录'}</FieldLabel>
        <InputGroup>
          {!webdav && <InputGroupAddon className="font-mono text-[13px]">{libraryRoot}</InputGroupAddon>}
          <InputGroupInput id={`${id}-path`} className="font-mono md:text-[13px]" placeholder="/" spellCheck={false} autoCapitalize="none" value={draft.path} onChange={e => update('path', e.target.value)} {...error('path')} />
          <InputGroupAddon align="inline-end">
            <InputGroupButton onClick={e => openBrowser(e.currentTarget)}><Folder data-icon="inline-start" />浏览</InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {errors.path ? <FieldMessage id={`${id}-path-error`}>{errors.path}</FieldMessage>
          : <p className="text-xs text-muted-foreground">{webdav ? '漫画保存在服务器上的这个目录下。' : `NAS 挂载到容器里的书库（${libraryRoot}）下的目录，/ 表示书库根目录。`}</p>}
      </Field>

      <Separator />
      <RuleEditor id={`${id}-rule`} value={draft.rule} onChange={value => update('rule', value)} base={webdav ? `${hostOf(draft.url) || 'WebDAV'}${draft.path === '/' ? '' : draft.path}` : `${libraryRoot}${draft.path === '/' ? '' : draft.path}`} />
      <ConnectionStatus id={`${id}-status`} connection={connection} />
    </div>

    <div className="flex flex-wrap items-center gap-2 border-t bg-muted/35 px-5 py-3.5 sm:px-6">
      {!target ? <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={onDiscard}>放弃</Button>
        : target.isDefault ? <Tooltip>
          <TooltipTrigger asChild><span tabIndex={0} className="-ml-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"><Star className="size-3.5" />默认位置</span></TooltipTrigger>
          <TooltipContent>默认位置不能删除；先把其他位置设为默认。</TooltipContent>
        </Tooltip>
        : <>
          <ConfirmAction title={`删除「${target.name}」？`} description="只删除这个存储位置的设置，书库中的文件不受影响。" onConfirm={() => remove.mutate()}>
            <Button type="button" variant="ghost" size="sm" className="-ml-2 text-destructive hover:bg-destructive/10 hover:text-destructive"><Trash2 data-icon="inline-start" />删除</Button>
          </ConfirmAction>
          <Button type="button" variant="ghost" size="sm" aria-disabled={makeDefault.isPending} onClick={() => { if (!makeDefault.isPending) makeDefault.mutate(); }}><Star data-icon="inline-start" />设为默认</Button>
        </>}
      <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        {dirty ? <><span aria-hidden className="size-1.5 rounded-full bg-warning" />{target ? '有未保存的更改' : '尚未保存'}</> : <><Check className="size-3.5" />已保存</>}
      </span>
      {/* Busy buttons use aria-disabled: the pressed one keeps keyboard focus. */}
      <Button type="button" variant="outline" aria-disabled={test.isPending} aria-describedby={`${id}-status`} onClick={() => { if (!test.isPending && check(probe)) test.mutate(); }}>
        {test.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}测试连接
      </Button>
      <Button type="submit" aria-disabled={save.isPending || !dirty}>{save.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}{target ? '保存' : '添加'}</Button>
    </div>
    {browse && <DirectoryBrowser key={JSON.stringify(browse.ref) + browse.path} target={browse} onClose={() => setBrowse(null)} />}
  </form>;
}
