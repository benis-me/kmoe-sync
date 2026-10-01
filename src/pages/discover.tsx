// 发现: search Kmoe or paste a link (the Bangumi tab lives in ./bangumi).
import { useState, type CSSProperties, type FormEvent } from 'react';
import { Link, Outlet, getRouteApi, useLocation } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { ArrowRight, ChevronLeft, ChevronRight, KeyRound, Link2, LoaderCircle, Search, SearchX } from 'lucide-react';
import type { ComicSummary } from '@shared/model';
import { errorMessage, request } from '@/lib/api';
import { searchQuery, statusQuery } from '@/lib/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Indicator } from '@/components/ui/indicator';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Cover } from '@/components/app/cover';
import { EmptyState, ErrorState, Loading } from '@/components/app/feedback';
import { FieldMessage } from '@/components/app/fields';
import { Page, PageHeader } from '@/components/app/page';

const tab = 'relative z-10 flex h-10 items-center px-1 text-sm font-medium text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:text-foreground';

export function DiscoverLayout() {
  const { pathname } = useLocation();
  return <Page>
    <PageHeader title="发现" />
    <nav aria-label="发现" className="relative -mt-1 flex gap-6 border-b md:-mt-3">
      <Link to="/discover" activeOptions={{ exact: true, includeSearch: false }} className={tab}>搜索</Link>
      <Link to="/discover/bangumi" activeOptions={{ includeSearch: false }} className={tab}>Bangumi 书单</Link>
      <Indicator axis="x" className="top-auto -bottom-px h-0.5 rounded-full bg-seal" />
    </nav>
    <motion.div key={pathname} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }} className="-mt-1 flex flex-col gap-6">
      <Outlet />
    </motion.div>
  </Page>;
}

/** Any Kmoe page URL (desktop or mobile, any mirror); plain words are a search. */
const looksLikeLink = (text: string) => /^https?:\/\//i.test(text) || /\/c\/\w+/.test(text) || /\.htm\b/i.test(text);

function ResultCard({ comic, index }: { comic: ComicSummary; index: number }) {
  return <Link to="/comics/$key" params={{ key: comic.key }} style={{ '--i': index } as CSSProperties}
    className="group/card stagger flex min-w-0 flex-col gap-2.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background">
    <div className="relative">
      <Cover src={comic.cover} title={comic.title} className="w-full rounded-xl transition-[translate,box-shadow] duration-200 ease-out-strong group-hover/card:-translate-y-0.5 group-hover/card:shadow-float" />
      {comic.tracked && <Badge variant="secondary" className="absolute top-2 left-2 bg-card/90 shadow-soft backdrop-blur-sm">已在书架</Badge>}
    </div>
    <div className="flex min-w-0 flex-col px-0.5">
      <span className="truncate text-sm leading-5 font-medium">{comic.title}</span>
      <span className="truncate text-xs text-muted-foreground">{comic.authors.join(' / ') || '作者未知'}</span>
      {comic.latest && <span className="truncate text-[11px] text-muted-foreground tabular-nums">最新 {comic.latest}</span>}
    </div>
  </Link>;
}

const searchRoute = getRouteApi('/_app/discover/');

export function SearchPage() {
  const { q = '', page = 1 } = searchRoute.useSearch();
  const navigate = searchRoute.useNavigate();
  const [text, setText] = useState(q);
  const [shown, setShown] = useState(q);
  // Back/forward to another search puts its words back in the box.
  if (shown !== q) { setShown(q); setText(q); }
  const [error, setError] = useState('');
  const { data: kmoe } = useQuery({ ...statusQuery, select: status => status.kmoe.state });
  const results = useQuery({ ...searchQuery(q, page), enabled: !!q && kmoe === 'active' });
  const resolve = useMutation({
    mutationFn: (input: string) => request('POST /api/resolve', { body: { input } }),
    onSuccess: ({ key }) => void navigate({ to: '/comics/$key', params: { key } }),
    onError: e => setError(errorMessage(e)),
  });
  const link = looksLikeLink(text.trim());

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    setError('');
    if (!value) { document.getElementById('discover-search')?.focus(); return; }
    if (link) { if (!resolve.isPending) resolve.mutate(value); }
    else void navigate({ search: { q: value } });
  }
  const data = results.data;

  return <>
    <form role="search" onSubmit={submit} className="flex max-w-2xl flex-col gap-2">
      <InputGroup className="h-12 rounded-xl">
        <InputGroupAddon className="pl-4">{link ? <Link2 className="size-5" /> : <Search className="size-5" />}</InputGroupAddon>
        <InputGroupInput id="discover-search" type="search" autoFocus={!q} aria-label="搜索 Kmoe 或粘贴漫画链接" placeholder="书名、作者，或粘贴 Kmoe 漫画链接"
          className="text-base md:text-[15px]" value={text} onChange={e => { setText(e.target.value); setError(''); }}
          aria-invalid={!!error} aria-describedby={error ? 'discover-error' : link ? 'discover-hint' : undefined} />
        <InputGroupAddon align="inline-end" className="pr-2">
          <InputGroupButton type="submit" variant="default" size="sm" className="h-8 rounded-lg px-3.5" aria-disabled={resolve.isPending}>
            {resolve.isPending ? <LoaderCircle className="animate-spin" /> : link ? <ArrowRight /> : null}{link ? '打开' : '搜索'}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {error ? <FieldMessage id="discover-error">{error}</FieldMessage>
        : link && <p id="discover-hint" className="px-1 text-xs text-muted-foreground">识别为 Kmoe 链接，会直接打开漫画页。</p>}
    </form>

    {kmoe && kmoe !== 'active' ? <EmptyState icon={<KeyRound />} title={kmoe === 'expired' ? 'Kmoe 登录已失效' : '搜索需要先登录 Kmoe'}
      description="登录后就能搜索 Kmoe。粘贴漫画链接不受影响，可以直接打开。" className="border">
      <Button asChild><Link to="/settings/$section" params={{ section: 'account' }}>{kmoe === 'expired' ? '重新登录' : '登录 Kmoe'}</Link></Button>
    </EmptyState>
      : !q ? <EmptyState icon={<Search />} title="搜索 Kmoe" className="min-h-64" />
      : results.error ? <ErrorState error={results.error} onRetry={() => void results.refetch()} title="搜索失败" />
      : !data ? <Loading label="正在搜索…">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-5 gap-y-7 max-sm:grid-cols-3 max-sm:gap-x-3">
          {Array.from({ length: 12 }, (_, i) => <div key={i} className="flex flex-col gap-2.5"><Skeleton className="aspect-[3/4] rounded-xl" /><Skeleton className="h-3.5 w-4/5" /><Skeleton className="h-3 w-1/2" /></div>)}
        </div>
      </Loading>
      : !data.results.length ? <EmptyState icon={<SearchX />} title={`没有找到「${data.query}」`} description="换个写法试试：繁体、简体或日文原名，或者只搜作者名。" className="border" />
      : <section aria-label="搜索结果" className="flex flex-col gap-5">
        <p role="status" className="text-xs text-muted-foreground tabular-nums">「{data.query}」的结果{data.totalPages > 1 && ` · 第 ${data.page} / ${data.totalPages} 页`}</p>
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-5 gap-y-7 max-sm:grid-cols-3 max-sm:gap-x-3 max-sm:gap-y-5">
          {data.results.map((comic, i) => <li key={comic.key} className="min-w-0"><ResultCard comic={comic} index={i} /></li>)}
        </ul>
        {data.totalPages > 1 && <nav aria-label="分页" className="flex items-center justify-center gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => void navigate({ search: { q, page: page - 1 } })}><ChevronLeft data-icon="inline-start" />上一页</Button>
          <span className="px-2 text-xs text-muted-foreground tabular-nums">{page} / {data.totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= data.totalPages} onClick={() => void navigate({ search: { q, page: page + 1 } })}>下一页<ChevronRight data-icon="inline-end" /></Button>
        </nav>}
      </section>}
  </>;
}
