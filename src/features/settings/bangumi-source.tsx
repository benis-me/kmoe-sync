// Bangumi 数据来源: the online API or the offline Bangumi Archive dump (for networks where bgm.tv is blocked), the access
// token (saved with the card's button), and the offline data's download / import state (live over SSE). The proxy lives in
// 设置 → 网络代理; this card only shows it.
import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CloudDownload, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import type { BangumiArchiveStatus, BangumiSource, MetadataSettings } from '@shared/model';
import { errorMessage, request } from '@/lib/api';
import { MB, formatMB, fromNow, percent } from '@/lib/format';
import { metadataSettingsQuery, settingsQuery } from '@/lib/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Progress } from '@/components/ui/progress';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ConfirmAction, Notice } from '@/components/app/feedback';
import { PasswordInput } from '@/components/app/fields';
import { Dot } from '@/components/app/status';
import { bangumiBlocked } from '@/features/library/state';
import { usePatchMetadata } from './common';

const SOURCES: Record<BangumiSource, { label: string; hint: string; blocked: string }> = {
  auto: {
    label: '自动（推荐）', hint: '能连上 Bangumi 时在线查询，连不上时用离线数据。',
    blocked: '现在连不上 bgm.tv，离线数据也还没准备好：下载离线数据，或者在「网络代理」中设置代理。',
  },
  online: {
    label: '在线 API', hint: '每次向 bgm.tv 查询，数据最新；需要 NAS 能访问 Bangumi，可以在「网络代理」中设置代理。',
    blocked: '现在连不上 bgm.tv，在线查询会失败：在「网络代理」中设置代理后测试一下，或者改用「自动」。',
  },
  archive: {
    label: '离线数据', hint: '使用 Bangumi 每周导出的数据，匹配和写入都在 NAS 本地完成，不需要访问 bgm.tv，但没有封面图。',
    blocked: '离线数据还没准备好：先在下面下载，完成之前无法匹配 Bangumi。',
  },
};
/** 12.3 万个 · 8,420 个 */
const countText = (n: number) => n >= 10_000 ? `${(n / 10_000).toFixed(1).replace(/\.0$/, '')} 万个` : `${n.toLocaleString('zh-CN')} 个`;
/** 9月22日 (with the year when it is not this year). */
const dayText = (iso: string) => {
  const date = new Date(iso);
  return date.toLocaleDateString('zh-CN', { year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' });
};

const BADGES: Record<BangumiArchiveStatus['state'], { label: string; variant: 'muted' | 'seal' | 'success' | 'destructive' }> = {
  none: { label: '未下载', variant: 'muted' }, downloading: { label: '下载中', variant: 'seal' }, importing: { label: '导入中', variant: 'seal' },
  ready: { label: '已就绪', variant: 'success' }, error: { label: '出错了', variant: 'destructive' },
};

/** The offline dump: what is imported, the running download / import, and the buttons that start one. */
function ArchivePanel({ archive }: { archive: BangumiArchiveStatus }) {
  const client = useQueryClient();
  const update = useMutation({
    mutationFn: (force: boolean) => request('POST /api/bangumi/archive/update', { body: { force } }),
    onSuccess: (next, force) => {
      client.setQueryData(metadataSettingsQuery.queryKey, old => old && { ...old, bangumi: { ...old.bangumi, archive: next } });
      if (!force && next.state === 'ready') toast.success('离线数据已经是最新的', { description: next.dumpDate ? `${dayText(next.dumpDate)}导出` : undefined });
    },
  });
  const { state, progress } = archive;
  const busy = state === 'downloading' || state === 'importing';
  const share = progress?.total ? percent(progress.done, progress.total) : null;
  const badge = BADGES[state];
  const run = (force: boolean) => { if (!update.isPending && !busy) update.mutate(force); };
  const spinning = (force: boolean) => update.isPending && update.variables === force;

  return <section aria-labelledby="archive-title" className="flex flex-col gap-3 border-t px-5 py-4 sm:px-6">
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h4 id="archive-title" className="text-sm font-medium">离线数据</h4>
        <p className="text-xs leading-relaxed text-muted-foreground">Bangumi 每周在 GitHub 发布的全站导出，只导入其中的漫画和书籍。</p>
      </div>
      <Badge variant={badge.variant} className="shrink-0">{busy && <LoaderCircle className="animate-spin" />}{badge.label}</Badge>
    </div>

    {state === 'ready' && <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs tabular-nums">
      <dt className="text-muted-foreground">数据</dt>
      <dd className="truncate" title={archive.dump ?? undefined}>{archive.dumpDate ? `${dayText(archive.dumpDate)}导出` : archive.dump} · {countText(archive.subjects)}漫画 / 书籍条目</dd>
      <dt className="text-muted-foreground">导入</dt>
      <dd>{archive.importedAt ? fromNow(archive.importedAt) : '—'}{archive.checkedAt && <span className="text-muted-foreground"> · {fromNow(archive.checkedAt)}检查过更新</span>}</dd>
    </dl>}

    {busy && <div className="flex flex-col gap-1.5">
      <Progress value={share} active className="h-1" aria-label={state === 'downloading' ? '下载进度' : '导入进度'} />
      <p className="flex justify-between gap-3 text-xs text-muted-foreground tabular-nums">
        <span className="truncate">{state === 'downloading'
          ? progress?.total ? `下载 ${formatMB(progress.done / MB)} / ${formatMB(progress.total / MB)}` : '正在连接 GitHub…'
          : progress?.total ? `导入中 · 已处理 ${formatMB(progress.done / MB)} / ${formatMB(progress.total / MB)} 数据` : '准备导入…'}</span>
        {share !== null && <span className="shrink-0">{Math.floor(share)}%</span>}
      </p>
      {archive.dump && <p className="truncate font-mono text-[11px] text-muted-foreground">{archive.dump}</p>}
    </div>}

    {state === 'none' && <p className="text-xs leading-relaxed text-foreground/80">NAS 连不上 bgm.tv 时，匹配条目和写入元数据都靠它完成。</p>}
    {state === 'error' && <p role="alert" className="text-xs leading-relaxed break-words text-destructive">{archive.error ?? '下载或导入失败'}</p>}

    {!busy && <div className="flex flex-wrap items-center gap-2">
      {state === 'ready' ? <>
        <Button type="button" variant="outline" size="sm" aria-disabled={update.isPending} onClick={() => run(false)}>
          {spinning(false) ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}检查更新
        </Button>
        <ConfirmAction title="重新导入离线数据？" description="会重新读取当前的导出文件，需要几分钟。" action="重新导入" variant="default" onConfirm={() => run(true)}>
          <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" aria-disabled={update.isPending}>
            {spinning(true) && <LoaderCircle data-icon="inline-start" className="animate-spin" />}重新导入
          </Button>
        </ConfirmAction>
      </> : <Button type="button" variant="outline" size="sm" aria-disabled={update.isPending} onClick={() => run(false)}>
        {spinning(false) ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : state === 'error' ? <RotateCcw data-icon="inline-start" /> : <CloudDownload data-icon="inline-start" />}
        {state === 'error' ? '重试' : '下载离线数据（约 440 MB）'}
      </Button>}
    </div>}
  </section>;
}

type Check = { state: 'idle' } | { state: 'testing' } | { state: 'ok' | 'down'; text: string; detail?: string };
/** Reachability of bgm.tv: calm by default (offline data may be doing the work), the reason in small print. */
function OnlineStatus({ id, check }: { id: string; check: Check }) {
  return <div id={id} role="status" className="flex min-w-0 flex-col gap-0.5 text-xs">
    <span className="flex items-center gap-1.5">
      {check.state === 'testing' ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        : <Dot tone={check.state === 'ok' ? 'success' : check.state === 'down' ? 'warning' : 'muted'} className="size-1.5" />}
      <span className={check.state === 'down' ? 'text-warning' : check.state === 'ok' ? 'text-foreground/80' : 'text-muted-foreground'}>
        {check.state === 'idle' ? '还没有检查过' : check.state === 'testing' ? '正在测试…' : check.text}
      </span>
    </span>
    {check.state === 'down' && check.detail && <span className="pl-3 break-words text-muted-foreground">{check.detail}</span>}
  </div>;
}

export function BangumiSourceCard({ bangumi }: { bangumi: MetadataSettings['bangumi'] }) {
  const client = useQueryClient();
  const patch = usePatchMetadata();
  const { data: proxy = '' } = useQuery({ ...settingsQuery, select: settings => settings.proxy });
  const initial = { source: bangumi.source, token: '' };
  const initialKey = JSON.stringify(initial);
  const [draft, setDraft] = useState(initial);
  const [base, setBase] = useState(initialKey);
  // Saved here or elsewhere: start from the saved values again (live archive updates do not touch these).
  if (base !== initialKey) { setBase(initialKey); setDraft(initial); }
  const [tested, setTested] = useState<{ proxy: string; check: Check } | null>(null);
  const dirty = JSON.stringify(draft) !== initialKey;
  const set = <K extends keyof typeof initial>(field: K, value: (typeof initial)[K]) => setDraft(old => ({ ...old, [field]: value }));

  const test = useMutation({
    mutationFn: () => request('POST /api/bangumi/online/test', { body: {} }),
    onMutate: () => setTested({ proxy, check: { state: 'testing' } }),
    onSuccess: result => {
      setTested({ proxy, check: { state: result.reachable ? 'ok' : 'down', text: result.message } });
      // The server remembers the check (and it drives the hints elsewhere).
      void client.invalidateQueries({ queryKey: metadataSettingsQuery.queryKey });
    },
    onError: error => setTested({ proxy, check: { state: 'down', text: errorMessage(error) } }),
  });
  const { online } = bangumi;
  const when = online.checkedAt ? ` · ${fromNow(online.checkedAt)}检查` : '';
  const stored: Check = online.reachable === null ? { state: 'idle' }
    : online.reachable ? { state: 'ok', text: `可以访问 bgm.tv${when}` } : { state: 'down', text: `无法访问 bgm.tv${when}`, detail: online.error ?? undefined };
  // A test made before the proxy changed no longer applies.
  const check = tested?.proxy === proxy ? tested.check : stored;
  const blocked = bangumiBlocked({ ...bangumi, source: draft.source });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty || patch.isPending) return;
    patch.mutate({ bangumi: { source: draft.source, ...(draft.token ? { token: draft.token } : {}) } }, { onSuccess: () => void toast.success('已保存 Bangumi 数据来源') });
  }

  return <form id="bangumi-source" noValidate onSubmit={submit} aria-labelledby="bangumi-source-title" className="scroll-mt-20 overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-border">
    <div className="flex flex-col gap-4 p-5 sm:p-6">
      <div className="flex flex-col gap-1">
        <h3 id="bangumi-source-title" className="text-[15px] font-semibold tracking-tight">Bangumi 数据来源</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">匹配条目、读取简介和标签时，从哪里取 Bangumi 的数据。</p>
      </div>
      <div className="flex flex-col gap-2">
        <div className="-mx-1 overflow-x-auto px-1 py-1 no-scrollbar">
          <ToggleGroup type="single" variant="segmented" aria-label="数据来源" value={draft.source} onValueChange={value => value && set('source', value as BangumiSource)}>
            {(Object.keys(SOURCES) as BangumiSource[]).map(source => <ToggleGroupItem key={source} value={source} className="px-3">{SOURCES[source].label}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>
        <p className="text-xs leading-relaxed text-foreground/80">{SOURCES[draft.source].hint}</p>
      </div>
      {blocked && <Notice tone="warning" live={false}>{SOURCES[draft.source].blocked}</Notice>}
    </div>

    <section aria-labelledby="bangumi-online-title" className="flex flex-col gap-4 border-t px-5 py-4 sm:px-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h4 id="bangumi-online-title" className="text-sm font-medium">在线 API</h4>
          <OnlineStatus id="bangumi-online" check={check} />
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0" aria-disabled={test.isPending} aria-describedby="bangumi-online"
          onClick={() => { if (!test.isPending) test.mutate(); }}>
          {test.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}测试在线访问
        </Button>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">代理</span>
          <p className="min-w-0 truncate font-mono text-[13px] text-foreground/80">{proxy || '直连（未设置代理）'}</p>
          <p className="text-xs text-muted-foreground">
            在线查询和离线数据的下载都使用<Link to="/settings/$section" params={{ section: 'network' }} className="mx-0.5 text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">网络代理</Link>里的设置。
          </p>
        </div>
        <Field className="gap-2">
          <FieldLabel htmlFor="bangumi-token">令牌（可选）</FieldLabel>
          <div className="flex items-center gap-2">
            <PasswordInput id="bangumi-token" autoComplete="off" className="font-mono" placeholder={bangumi.hasToken ? '已保存，留空则不修改' : '匹配 NSFW 条目时才需要'}
              value={draft.token} onChange={e => set('token', e.target.value)} aria-describedby="bangumi-token-hint" />
            {bangumi.hasToken && <ConfirmAction title="清除 Bangumi 令牌？" description="之后搜索和匹配不会包含 NSFW 条目。" action="清除"
              onConfirm={() => patch.mutate({ bangumi: { token: '' } }, { onSuccess: () => void toast.success('已清除 Bangumi 令牌') })}>
              <Button type="button" variant="ghost" size="sm" className="shrink-0 text-muted-foreground hover:text-destructive">清除</Button>
            </ConfirmAction>}
          </div>
          <p id="bangumi-token-hint" className="text-xs text-muted-foreground">在 next.bgm.tv/demo/access-token 生成，只用于在线查询。</p>
        </Field>
      </div>
    </section>

    <ArchivePanel archive={bangumi.archive} />

    <div className="flex flex-wrap items-center gap-2 border-t bg-muted/35 px-5 py-3.5 sm:px-6">
      <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">{dirty && <><span aria-hidden className="size-1.5 rounded-full bg-warning" />有未保存的更改</>}</span>
      <Button type="submit" aria-disabled={!dirty || patch.isPending}>{patch.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}保存</Button>
    </div>
  </form>;
}
