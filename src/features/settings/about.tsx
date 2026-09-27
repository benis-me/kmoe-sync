// 关于: the version and where the server runs (runtime, user, paths, database), then one line per settings section with a
// link to it — the things to check first when something behaves oddly.
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { formatBytes } from '@shared/naming';
import { fromNow } from '@/lib/format';
import { aboutQuery, aiSettingsQuery, metadataSettingsQuery, settingsQuery, statusQuery, targetsQuery } from '@/lib/queries';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/app/feedback';
import { SectionSkeleton } from './common';

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-3">
    <dt className="text-sm text-muted-foreground">{label}</dt>
    <dd className={mono ? 'min-w-0 font-mono text-[13px] break-all' : 'min-w-0 text-sm'}>{children}</dd>
  </div>;
}

function Section({ section, label, value }: { section: string; label: string; value: ReactNode }) {
  return <li>
    <Link to="/settings/$section" params={{ section }} className="flex items-center gap-4 px-5 py-3 outline-none transition-colors duration-150 hover:bg-accent/60 focus-visible:bg-accent/60">
      <span className="w-24 shrink-0 self-start text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-sm break-words">{value}</span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  </li>;
}

/** "3 天 4 小时" since the server started. */
function uptime(since: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
}
const SOURCES = { auto: '自动（在线优先，连不上用离线数据）', online: '在线 API', archive: '离线数据' } as const;

export function AboutSection() {
  const about = useQuery(aboutQuery);
  const { data: status } = useQuery(statusQuery);
  const { data: settings } = useQuery(settingsQuery);
  const { data: meta } = useQuery(metadataSettingsQuery);
  const { data: ai } = useQuery(aiSettingsQuery);
  const { data: targets } = useQuery(targetsQuery);
  if (about.error) return <ErrorState error={about.error} onRetry={() => void about.refetch()} />;
  if (!about.data) return <SectionSkeleton />;
  const a = about.data, fallback = '…';
  const target = targets?.find(t => t.id === settings?.defaultTargetId) ?? targets?.find(t => t.isDefault);
  const channels = settings?.notifications.filter(channel => channel.enabled).length ?? 0;
  const kmoe = status?.kmoe;

  return <>
    <Card className="gap-0 py-0">
      <dl className="divide-y">
        <Row label="版本">Kmoe Sync v{a.version}</Row>
        <Row label="已运行">{uptime(a.startedAt)}<span className="text-muted-foreground">（{fromNow(a.startedAt)}启动）</span></Row>
        <Row label="运行环境">Bun {a.runtime.bun} · {a.runtime.platform}/{a.runtime.arch} · {a.runtime.timezone}</Row>
        <Row label="运行用户">{a.user ? <>UID {a.user.uid} / GID {a.user.gid}<span className="text-muted-foreground">（书库文件以这个用户写入）</span></> : '—'}</Row>
        <Row label="数据目录" mono>{a.paths.data}<span className="font-sans text-muted-foreground">（数据库 {formatBytes(a.databaseBytes)}）</span></Row>
        <Row label="书库根目录" mono>{a.paths.library}</Row>
        <Row label="数据">{a.counts.comics} 部漫画 · {a.counts.subscriptions} 个订阅 · {a.counts.folders} 个书库文件夹 · {a.counts.tasks} 个下载任务</Row>
      </dl>
    </Card>

    <Card className="gap-0 py-0">
      <div className="border-b px-5 pt-4 pb-3">
        <h3 className="text-[15px] font-semibold tracking-tight">设置概况</h3>
        <p className="text-xs text-muted-foreground">点一行可以去修改。</p>
      </div>
      <ul className="divide-y">
        <Section section="account" label="Kmoe 账号" value={!kmoe ? fallback : kmoe.state === 'active' ? `${kmoe.email ?? '已登录'} · ${kmoe.mirror ?? ''}${kmoe.vip ? ' · VIP' : ''}` : kmoe.state === 'expired' ? '登录已失效' : '未登录'} />
        <Section section="storage" label="存储位置" value={!targets ? fallback : targets.length ? `${targets.length} 个${target ? ` · 默认「${target.name}」` : ''}` : '还没有添加'} />
        <Section section="automation" label="下载与更新" value={!settings ? fallback : `每 ${settings.checkIntervalHours} 小时检查更新 · 同时下载 ${settings.concurrency} 个 · 默认 ${settings.defaultFormat.toUpperCase()}`} />
        <Section section="notifications" label="通知" value={!settings ? fallback : settings.notifications.length ? `${channels} 个渠道开启（共 ${settings.notifications.length} 个）` : '没有设置'} />
        <Section section="metadata" label="Komga 元数据" value={!meta ? fallback : meta.enabled ? `已开启 · ${meta.komga.url || '还没连接 Komga'} · Bangumi：${SOURCES[meta.bangumi.source]}` : '未开启'} />
        <Section section="ai" label="AI" value={!ai ? fallback : ai.ready ? `${ai.model} · 本月已用 ${ai.usage.tokens.toLocaleString('zh-CN')} token` : '未设置'} />
        <Section section="api" label="API 与 MCP" value={!settings ? fallback : settings.apiToken ? '已生成 API 令牌' : '未生成令牌'} />
        <Section section="network" label="网络代理" value={!settings ? fallback : settings.proxy ? `${settings.proxy}${settings.proxyKmoe ? '（Kmoe 也走代理）' : '（Kmoe 直连）'}` : '直连，没有代理'} />
      </ul>
    </Card>
  </>;
}
