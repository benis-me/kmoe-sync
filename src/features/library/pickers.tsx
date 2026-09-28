// Dialogs that link a folder: 关联 Kmoe 漫画 (candidates, Kmoe search, pasted link) and 选择 Bangumi 条目
// (candidates, Bangumi search, pasted bgm.tv link or id). The Bangumi one is also used on the comic page.
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, Link2, LoaderCircle, Search, Sparkles, TriangleAlert, Unlink } from 'lucide-react';
import { cn } from 'cn';
import type { BangumiSubject, FolderMetadata, LibraryFolder } from '@shared/model';
import { errorMessage, request } from '@/lib/api';
import { metadataSettingsQuery, searchQuery, statusQuery } from '@/lib/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Cover } from '@/components/app/cover';
import { EmptyState, ErrorState, Loading } from '@/components/app/feedback';
import { FieldMessage } from '@/components/app/fields';
import { applyFolder, bangumiBlocked, bestOf, needsKmoeLogin, percentOf } from './state';

/** Mounted open; closes itself, then tells the parent (after the exit animation). */
export function useClosable(onClose: () => void) {
  const [open, setOpen] = useState(true);
  return { open, close: () => { setOpen(false); setTimeout(onClose, 200); } };
}
/** Opened from code (a row, a menu): Radix has no trigger to return focus to, so the caller names one. */
export type ReturnFocus = { returnFocus?: () => HTMLElement | null | undefined };
export const refocus = (returnFocus: ReturnFocus['returnFocus']) => (e: Event) => { const el = returnFocus?.(); if (el) { e.preventDefault(); el.focus(); } };

/** One choice in a list: a native radio (`name` groups a list), so the list is one Tab stop and arrow keys move the choice. Double-click uses it at once. */
export function Option({ name, checked, cover, title, meta, score, badge, onPick, onChoose }: {
  name: string; checked: boolean; cover: string | null; title: string; meta: string; score?: number; badge?: string; onPick: () => void; onChoose: () => void;
}) {
  return <label onDoubleClick={onChoose}
    className="flex w-full cursor-pointer items-center gap-3 rounded-lg p-2 text-left transition-colors duration-150 hover:bg-accent has-checked:bg-seal-soft/70 has-checked:ring-1 has-checked:ring-seal/30 has-focus-visible:ring-2 has-focus-visible:ring-ring">
    <input type="radio" name={name} checked={checked} onChange={onPick} className="sr-only" />
    <Cover src={cover} title={title} className="w-9 rounded-md" />
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium">{title}</span>
        {badge && <Badge variant="muted" className="h-4.5 px-1.5 text-[11px]">{badge}</Badge>}
      </span>
      <span className="truncate text-xs text-muted-foreground">{meta || '—'}</span>
    </span>
    {score !== undefined && <span className={cn('shrink-0 text-xs tabular-nums', score >= 0.9 ? 'font-medium text-foreground' : 'text-muted-foreground')}>{percentOf(score)}</span>}
    <span aria-hidden className={cn('grid size-4 shrink-0 place-items-center rounded-full border border-muted-foreground/60', checked && 'border-seal bg-seal')}>
      {checked && <span className="size-1.5 rounded-full bg-seal-foreground" />}
    </span>
  </label>;
}

const GroupLabel = ({ children }: { children: ReactNode }) => <p className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground first:pt-1">{children}</p>;
const ListSkeleton = ({ label }: { label: string }) => <Loading label={label}><div className="flex flex-col gap-1 p-1">{[0, 1, 2].map(i => <Skeleton key={i} className="h-14 rounded-lg" />)}</div></Loading>;

function SearchBox({ label, placeholder, value, onChange, onSubmit }: { label: string; placeholder: string; value: string; onChange: (value: string) => void; onSubmit: () => void }) {
  return <form role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit(); }}>
    <InputGroup>
      <InputGroupAddon><Search /></InputGroupAddon>
      <InputGroupInput aria-label={label} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} />
      <InputGroupAddon align="inline-end"><InputGroupButton type="submit">搜索</InputGroupButton></InputGroupAddon>
    </InputGroup>
  </form>;
}

/** Paste a link (or an id) and use it directly. */
function PasteBox({ id, label, placeholder, busy, error, onSubmit }: { id: string; label: string; placeholder: string; busy: boolean; error: string; onSubmit: (value: string) => void }) {
  const [text, setText] = useState('');
  return <form className="flex flex-col gap-1.5" onSubmit={e => { e.preventDefault(); if (text.trim() && !busy) onSubmit(text.trim()); }}>
    <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
    <InputGroup>
      <InputGroupAddon><Link2 /></InputGroupAddon>
      <InputGroupInput id={id} className="font-mono md:text-[13px]" placeholder={placeholder} spellCheck={false} autoCapitalize="none" value={text} onChange={e => setText(e.target.value)}
        aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
      <InputGroupAddon align="inline-end"><InputGroupButton type="submit" aria-disabled={!text.trim() || busy}>使用</InputGroupButton></InputGroupAddon>
    </InputGroup>
    <FieldMessage id={`${id}-error`}>{error}</FieldMessage>
  </form>;
}

/** Link a folder to a Kmoe comic: a candidate, a search result, or a pasted link. */
export function LinkKmoeDialog({ folder, onClose, returnFocus }: { folder: LibraryFolder; onClose: () => void } & ReturnFocus) {
  const client = useQueryClient();
  const { open, close } = useClosable(onClose);
  const { kmoe } = folder;
  const initial = folder.hint ?? folder.name;
  const [text, setText] = useState(initial);
  const [query, setQuery] = useState(initial);
  const [picked, setPicked] = useState<string | null>(kmoe.comic?.key ?? kmoe.ai?.pick ?? bestOf(kmoe.candidates)?.key ?? null);
  const [error, setError] = useState<{ from: 'pick' | 'paste'; message: string } | null>(null);
  const { data: login } = useQuery({ ...statusQuery, select: status => status.kmoe.state });
  const results = useQuery({ ...searchQuery(query, 1), enabled: !!query && login === 'active' });
  const link = useMutation({
    mutationFn: ({ comic }: { comic: string; from: 'pick' | 'paste' }) => request('POST /api/library/folders/:id/kmoe', { params: { id: folder.id }, body: { comic } }),
    onMutate: () => setError(null),
    onSuccess: next => {
      applyFolder(client, next);
      toast.success(`已关联《${next.kmoe.comic?.title ?? next.name}》`, { description: '已加入书架，文件夹里已有的卷算作已下载。' });
      close();
    },
    onError: (e, { from }) => setError({ from, message: errorMessage(e) }),
  });
  const choose = (key: string) => { if (!link.isPending) link.mutate({ comic: key, from: 'pick' }); };
  const candidates = kmoe.candidates;
  const found = (results.data?.results ?? []).filter(comic => !candidates.some(c => c.key === comic.key));

  return <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
    <DialogContent className="flex max-h-[min(700px,calc(100dvh-32px))] flex-col gap-4 sm:max-w-lg" onCloseAutoFocus={refocus(returnFocus)}>
      <DialogHeader className="pr-8">
        <DialogTitle>关联 Kmoe 漫画</DialogTitle>
        <DialogDescription className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-xs" title={folder.path}>{folder.path}</span>
          <span>{folder.books} 本{kmoe.comic ? ` · 当前关联《${kmoe.comic.title}》` : ''}。选中正确的一部，再点「关联」。</span>
          {kmoe.ai && !kmoe.comic && <span className="text-seal">AI（把握 {percentOf(kmoe.ai.confidence)}）：{kmoe.ai.reason}</span>}
        </DialogDescription>
      </DialogHeader>
      <SearchBox label="搜索 Kmoe" placeholder="书名或作者" value={text} onChange={setText} onSubmit={() => setQuery(text.trim())} />
      <div role="radiogroup" aria-label="Kmoe 漫画" aria-busy={results.isFetching} className="min-h-40 flex-1 overflow-y-auto overscroll-contain rounded-xl bg-card p-1 ring-1 ring-border">
        {candidates.length > 0 && <>
          <GroupLabel>建议</GroupLabel>
          {candidates.map(c => <Option name={`kmoe-${folder.id}`} key={c.key} checked={picked === c.key} cover={c.cover} title={c.title} score={c.score} badge={kmoe.ai?.pick === c.key ? 'AI 推荐' : undefined}
            meta={[c.authors.join(' / '), c.latest && `最新 ${c.latest}`].filter(Boolean).join(' · ')} onPick={() => setPicked(c.key)} onChoose={() => choose(c.key)} />)}
        </>}
        {query && <GroupLabel>「{query}」的搜索结果</GroupLabel>}
        {login && login !== 'active' ? <EmptyState icon={<KeyRound />} title="搜索需要先登录 Kmoe" description="也可以在下面粘贴 Kmoe 漫画链接直接关联。" className="min-h-40 p-4">
          <Button size="sm" variant="outline" asChild><Link to="/settings/$section" params={{ section: 'account' }}>登录 Kmoe</Link></Button>
        </EmptyState>
          : !query ? null
          : results.error ? needsKmoeLogin(results.error)
            ? <EmptyState icon={<KeyRound />} title="Kmoe 登录已失效" description={errorMessage(results.error)} className="min-h-40 p-4" />
            : <ErrorState error={results.error} onRetry={() => void results.refetch()} className="min-h-40 p-4" />
          : !results.data ? <ListSkeleton label="正在搜索…" />
          : !found.length ? <p className="px-2 py-6 text-center text-xs text-muted-foreground">{results.data.results.length ? '搜索结果都在上面的建议里。' : '没有找到，换个写法试试：简体、繁体或作者名。'}</p>
          : found.map(comic => <Option name={`kmoe-${folder.id}`} key={comic.key} checked={picked === comic.key} cover={comic.cover} title={comic.title} badge={comic.tracked ? '已在书架' : undefined}
            meta={[comic.authors.join(' / '), comic.latest && `最新 ${comic.latest}`].filter(Boolean).join(' · ')} onPick={() => setPicked(comic.key)} onChoose={() => choose(comic.key)} />)}
      </div>
      <PasteBox id={`kmoe-link-${folder.id}`} label="或粘贴 Kmoe 漫画链接" placeholder="https://kxo.moe/c/12345.htm" busy={link.isPending}
        error={error?.from === 'paste' ? error.message : ''} onSubmit={value => link.mutate({ comic: value, from: 'paste' })} />
      {error?.from === 'pick' && <FieldMessage id="kmoe-link-error">{error.message}</FieldMessage>}
      <DialogFooter>
        <Button variant="outline" onClick={close}>取消</Button>
        <Button aria-disabled={!picked || link.isPending} onClick={() => { if (picked) choose(picked); }}>
          {link.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}关联
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** Bangumi cannot be queried with the chosen source: one quiet line and the way to fix it. */
export function BangumiUnavailable({ className }: { className?: string }) {
  const { data: reason } = useQuery({ ...metadataSettingsQuery, select: settings => bangumiBlocked(settings.bangumi) });
  if (!reason) return null;
  return <p role="status" className={cn('flex items-start gap-1.5 text-xs leading-relaxed text-warning', className)}>
    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
    <span>{reason}，搜索和自动匹配会失败。<Link to="/settings/$section" params={{ section: 'metadata' }} hash="bangumi-source"
      className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">设置数据来源</Link></span>
  </p>;
}

const subjectMeta = (subject: BangumiSubject) =>
  [subject.nameCn && subject.name !== subject.nameCn ? subject.name : '', subject.platform, subject.date?.slice(0, 7), subject.volumes ? `${subject.volumes} 卷` : '', subject.authors.slice(0, 2).join(' / ')]
    .filter(Boolean).join(' · ');

type BangumiAction = { kind: 'subject'; subject: string; from: 'pick' | 'paste' } | { kind: 'auto' } | { kind: 'remove' };

/** Choose the folder's Bangumi subject: a candidate, a search result, a pasted bgm.tv link or id; or re-run / clear the match. */
export function BangumiDialog({ folderId, label, query: initial, bangumi, onClose, returnFocus }: {
  folderId: number; label: string; query: string; bangumi: FolderMetadata['bangumi']; onClose: () => void;
} & ReturnFocus) {
  const client = useQueryClient();
  const { open, close } = useClosable(onClose);
  const [text, setText] = useState(initial);
  const [query, setQuery] = useState(initial);
  const aiPick = bangumi.ai?.pick ? Number(bangumi.ai.pick) : null;
  const [picked, setPicked] = useState<number | null>(bangumi.subject?.id ?? aiPick ?? bestOf(bangumi.candidates)?.id ?? null);
  const [error, setError] = useState<{ from: 'pick' | 'paste'; message: string } | null>(null);
  const results = useQuery({
    queryKey: ['bangumi-search', query],
    queryFn: ({ signal }) => request('GET /api/bangumi/search', { query: { q: query }, signal }),
    enabled: !!query, staleTime: 5 * 60_000,
  });
  const act = useMutation({
    mutationFn: (action: BangumiAction) => action.kind === 'remove'
      ? request('DELETE /api/library/folders/:id/bangumi', { params: { id: folderId } })
      : request('POST /api/library/folders/:id/bangumi', { params: { id: folderId }, body: action.kind === 'auto' ? { auto: true } : { subject: action.subject } }),
    onMutate: () => setError(null),
    onSuccess: (folder: LibraryFolder, action) => {
      applyFolder(client, folder);
      const { state, subject, candidates } = folder.metadata.bangumi;
      const name = subject ? subject.nameCn || subject.name : '';
      const komga = folder.metadata.komga.state !== 'disabled';
      if (action.kind === 'remove') toast.success('已取消 Bangumi 匹配');
      else if (state === 'matched') toast.success(`已选择「${name}」`, { description: komga ? '同步后写入 Komga。' : undefined });
      else if (state === 'suggested') toast.info(`找到 ${candidates.length} 个可能的条目`, { description: '在书库里点「待确认」选一个。' });
      else toast.warning('Bangumi 上没有找到这部漫画', { description: '可以搜索别的写法，或粘贴 bgm.tv 链接。' });
      close();
    },
    onError: (e, action) => setError({ from: action.kind === 'subject' ? action.from : 'pick', message: errorMessage(e) }),
  });
  const choose = (id: number) => { if (!act.isPending) act.mutate({ kind: 'subject', subject: String(id), from: 'pick' }); };
  const current = bangumi.subject;
  const found = (results.data ?? []).filter(s => !bangumi.candidates.some(c => c.id === s.id));
  const pending = act.isPending ? act.variables.kind : null;

  return <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
    <DialogContent className="flex max-h-[min(720px,calc(100dvh-32px))] flex-col gap-4 sm:max-w-lg" onCloseAutoFocus={refocus(returnFocus)}>
      <DialogHeader className="pr-8">
        <DialogTitle>选择 Bangumi 条目</DialogTitle>
        <DialogDescription className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate" title={label}>{label}</span>
          <span>{current ? `当前：${current.nameCn || current.name}` : '元数据（简介、标签、单册信息）从这个条目读取。'}</span>
          {bangumi.ai && bangumi.state !== 'matched' && <span className="text-seal">AI（把握 {percentOf(bangumi.ai.confidence)}）：{bangumi.ai.reason}</span>}
        </DialogDescription>
      </DialogHeader>
      <BangumiUnavailable className="-mt-1" />
      <SearchBox label="搜索 Bangumi" placeholder="中文名或原名" value={text} onChange={setText} onSubmit={() => setQuery(text.trim())} />
      <div role="radiogroup" aria-label="Bangumi 条目" aria-busy={results.isFetching} className="min-h-40 flex-1 overflow-y-auto overscroll-contain rounded-xl bg-card p-1 ring-1 ring-border">
        {current && !bangumi.candidates.some(c => c.id === current.id) && <>
          <GroupLabel>当前</GroupLabel>
          <Option name={`bangumi-${folderId}`} checked={picked === current.id} cover={current.cover} title={current.nameCn || current.name} meta={subjectMeta(current)} onPick={() => setPicked(current.id)} onChoose={() => choose(current.id)} />
        </>}
        {bangumi.candidates.length > 0 && <>
          <GroupLabel>候选</GroupLabel>
          {bangumi.candidates.map(c => <Option name={`bangumi-${folderId}`} key={c.id} checked={picked === c.id} cover={c.cover} title={c.nameCn || c.name} meta={subjectMeta(c)} score={c.score}
            badge={aiPick === c.id ? 'AI 推荐' : c.series ? undefined : '单册'} onPick={() => setPicked(c.id)} onChoose={() => choose(c.id)} />)}
        </>}
        {query && <GroupLabel>「{query}」的搜索结果</GroupLabel>}
        {!query ? null
          : results.error ? <ErrorState error={results.error} onRetry={() => void results.refetch()} className="min-h-40 p-4" />
          : !results.data ? <ListSkeleton label="正在搜索 Bangumi…" />
          : !found.length ? <p className="px-2 py-6 text-center text-xs text-muted-foreground">{results.data.length ? '搜索结果都在上面。' : '没有找到，试试原名或只搜关键字。'}</p>
          : found.map(s => <Option name={`bangumi-${folderId}`} key={s.id} checked={picked === s.id} cover={s.cover} title={s.nameCn || s.name} meta={subjectMeta(s)} badge={s.series ? undefined : '单册'}
            onPick={() => setPicked(s.id)} onChoose={() => choose(s.id)} />)}
      </div>
      <PasteBox id={`bangumi-link-${folderId}`} label="或粘贴 bgm.tv 链接 / 条目 ID" placeholder="https://bgm.tv/subject/12345" busy={act.isPending}
        error={error?.from === 'paste' ? error.message : ''} onSubmit={value => act.mutate({ kind: 'subject', subject: value, from: 'paste' })} />
      {error?.from === 'pick' && <FieldMessage id="bangumi-pick-error">{error.message}</FieldMessage>}
      <DialogFooter className="sm:items-center">
        <div className="flex flex-wrap gap-1 sm:mr-auto">
          <Button variant="ghost" size="sm" className="text-muted-foreground" aria-disabled={act.isPending} onClick={() => { if (!act.isPending) act.mutate({ kind: 'auto' }); }}>
            {pending === 'auto' ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Sparkles data-icon="inline-start" />}自动匹配
          </Button>
          {current && <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" aria-disabled={act.isPending} onClick={() => { if (!act.isPending) act.mutate({ kind: 'remove' }); }}>
            {pending === 'remove' ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Unlink data-icon="inline-start" />}取消匹配
          </Button>}
        </div>
        <Button variant="outline" onClick={close}>取消</Button>
        <Button aria-disabled={!picked || act.isPending} onClick={() => { if (picked) choose(picked); }}>
          {pending === 'subject' && <LoaderCircle data-icon="inline-start" className="animate-spin" />}使用此条目
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
