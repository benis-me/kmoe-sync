// Desktop sidebar (name, the 宽屏 and light/dark switches, five destinations, the download queue and the Kmoe account) and the phone top bar + tab bar.
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronsLeftRight, ChevronsRightLeft, Compass, Download, FolderSync, Library, Moon, Settings, Sun, WifiOff } from 'lucide-react';
import { cn } from 'cn';
import { statusQuery } from '@/lib/queries';
import { useTheme } from '@/lib/theme';
import { useLayout } from '@/stores/layout';
import { Button } from '@/components/ui/button';
import { Indicator } from '@/components/ui/indicator';
import { Skeleton } from '@/components/ui/skeleton';
import { Dot, MockBadge, QueueLine, QuotaBar, kmoeLabel, kmoeTone, quotaText } from './status';

const EXACT = { exact: true, includeSearch: false } as const;
const PREFIX = { includeSearch: false } as const;

function RunningBadge({ className }: { className?: string }) {
  const { data: running = 0 } = useQuery({ ...statusQuery, select: status => status.queue.counts.running + status.queue.counts.queued });
  if (!running) return null;
  return <>
    <span key={running} aria-hidden className={cn('grid h-5 min-w-5 animate-pop place-items-center rounded-full bg-seal-soft px-1.5 text-[11px] font-semibold text-seal tabular-nums', className)}>{running}</span>
    <span className="sr-only">，{running} 个任务进行中或等待</span>
  </>;
}

const sideItem = 'relative z-10 flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:text-foreground not-aria-[current=page]:hover:bg-sidebar-accent/70';

function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const label = theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
  return <Button variant="ghost" size="icon-sm" className="-my-1.5 text-muted-foreground" aria-label={label} title={label} onClick={toggle}>
    {theme === 'dark' ? <Sun /> : <Moon />}
  </Button>;
}

function WideToggle() {
  const wide = useLayout(state => state.wide);
  const toggle = useLayout(state => state.toggleWide);
  const label = wide ? '退出宽屏模式' : '切换到宽屏模式';
  return <Button variant="ghost" size="icon-sm" className="-my-1.5 text-muted-foreground" aria-label={label} title={label} onClick={toggle}>
    {wide ? <ChevronsRightLeft /> : <ChevronsLeftRight />}
  </Button>;
}

export function Sidebar({ connected }: { connected: boolean }) {
  return <div className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-sidebar md:flex">
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-32 tone tone-fade-b" />
    <div className="relative flex items-center justify-between pt-7 pr-4 pb-6 pl-6">
      <span className="flex items-center gap-2.5 text-[15px] leading-tight font-semibold tracking-tight">
        <img src="/icon.svg" alt="" className="size-6 rounded-[6px] dark:ring-1 dark:ring-white/12" />Kmoe Sync
      </span>
      <div className="flex"><WideToggle /><ThemeToggle /></div>
    </div>
    <nav aria-label="主导航" className="relative flex flex-col gap-0.5 px-3">
      <Link to="/" activeOptions={EXACT} className={sideItem}><Library className="size-4 shrink-0" />书架</Link>
      <Link to="/discover" activeOptions={PREFIX} className={sideItem}><Compass className="size-4 shrink-0" />发现</Link>
      <Link to="/downloads" activeOptions={PREFIX} className={sideItem}><Download className="size-4 shrink-0" />下载<RunningBadge className="ml-auto" /></Link>
      <Link to="/library" activeOptions={PREFIX} className={sideItem}><FolderSync className="size-4 shrink-0" />书库整理</Link>
      <Link to="/settings" activeOptions={PREFIX} className={sideItem}><Settings className="size-4 shrink-0" />设置</Link>
      <Indicator className="rounded-lg bg-card shadow-soft ring-1 ring-border before:absolute before:inset-y-2.5 before:left-0 before:w-[3px] before:rounded-full before:bg-seal" />
    </nav>
    <SidebarStatus connected={connected} />
  </div>;
}

const statusRow = 'flex min-h-10 items-center gap-2.5 px-3 text-[13px] outline-none transition-colors duration-150 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

function SidebarStatus({ connected }: { connected: boolean }) {
  const { data: status } = useQuery(statusQuery);
  return <section aria-label="服务状态" className="mt-auto flex flex-col gap-2 p-3">
    {/* The queue changes all the time: its own card, one line of fixed height, so nothing around it moves. */}
    {!status ? <Skeleton className="h-11 rounded-xl" /> : <Link to="/downloads" className={cn(statusRow, 'h-11 rounded-xl bg-card/70 ring-1 ring-border')}>
      <QueueLine queue={status.queue} />
    </Link>}
    {!status ? <Skeleton className="h-[82px] rounded-xl" /> : <div className="flex flex-col divide-y overflow-hidden rounded-xl bg-card/70 ring-1 ring-border">
      <Link to="/settings/$section" params={{ section: 'account' }} className={statusRow}>
        <Dot tone={kmoeTone(status.kmoe)} />
        <span className="truncate">{kmoeLabel(status.kmoe)}</span>
        {status.kmoe.mirror && <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{status.kmoe.mirror}</span>}
      </Link>
      {status.kmoe.state !== 'none' && <Link to="/settings/$section" params={{ section: 'account' }} className={cn(statusRow, 'flex-col items-stretch justify-center gap-1.5 py-2.5')}>
        <span className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">额度</span>
          <span className="tabular-nums">{quotaText(status.kmoe)}</span>
        </span>
        <QuotaBar kmoe={status.kmoe} />
      </Link>}
    </div>}
    {!connected && <p role="status" className="flex items-center gap-2 px-3 text-xs text-warning"><WifiOff className="size-3.5 shrink-0" />实时更新已断开，正在重连…</p>}
    <p className="flex items-center gap-2 px-3 text-[11px] text-muted-foreground empty:hidden"><MockBadge /></p>
  </section>;
}

/**
 * Phone header: the page's name, then the page's own actions (portalled into `actions`), or else the queue while it runs.
 * The sidebar is hidden on phones, so a lost live connection shows here: until it is back, the numbers here are old.
 */
export function TopBar({ title, actions, connected }: { title: string; actions: (element: HTMLDivElement | null) => void; connected: boolean }) {
  const { data: status } = useQuery(statusQuery);
  return <header className="group/top sticky top-0 z-30 flex h-13 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur-md md:hidden">
    <span className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight">{title}</span>
    <MockBadge />
    {!connected ? <span role="status" className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-card px-3 text-xs text-warning shadow-soft ring-1 ring-border">
      <WifiOff className="size-3.5 shrink-0" />重连中
    </span>
    : status && (status.queue.paused || status.queue.counts.running > 0) && <Link to="/downloads" className="flex h-8 max-w-44 min-w-0 items-center rounded-full bg-card px-3 text-xs shadow-soft ring-1 ring-border outline-none group-has-[[data-actions]:not(:empty)]/top:hidden focus-visible:ring-2 focus-visible:ring-ring">
      <QueueLine queue={{ ...status.queue, speed: 0 }} className="gap-1.5 [&_svg]:size-3.5" />
    </Link>}
    <div ref={actions} data-actions className="flex shrink-0 items-center gap-2 empty:hidden" />
  </header>;
}

const tabItem = 'relative z-10 flex flex-col items-center justify-center gap-1 rounded-lg text-[11px] font-medium text-muted-foreground outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=page]:text-foreground';

export function TabBar() {
  return <nav aria-label="主导航" className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden">
    <div className="relative grid h-15 grid-cols-5">
      <Link to="/" activeOptions={EXACT} className={tabItem}><Library className="size-5" />书架</Link>
      <Link to="/discover" activeOptions={PREFIX} className={tabItem}><Compass className="size-5" />发现</Link>
      <Link to="/downloads" activeOptions={PREFIX} className={tabItem}>
        <span className="relative"><Download className="size-5" /><RunningBadge className="absolute -top-1.5 left-3.5 h-4 min-w-4 px-1 text-[10px]" /></span>下载
      </Link>
      <Link to="/library" activeOptions={PREFIX} className={tabItem}><FolderSync className="size-5" />书库整理</Link>
      <Link to="/settings" activeOptions={PREFIX} className={tabItem}><Settings className="size-5" />设置</Link>
      <Indicator axis="x" className="h-0.5 before:absolute before:inset-y-0 before:left-1/2 before:w-8 before:-translate-x-1/2 before:rounded-full before:bg-seal" />
    </div>
  </nav>;
}
