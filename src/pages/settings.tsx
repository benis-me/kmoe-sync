// 设置: sections in three groups (a side list on desktop, a scrollable strip on phones) and the section content.
import { useEffect, useRef } from 'react';
import { Link, Outlet, getRouteApi, useLocation } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { Bell, Globe, HardDrive, Info, ListChecks, Plug, ShieldCheck, Sparkles, Tags, Timer, UserRound } from 'lucide-react';
import { Indicator } from '@/components/ui/indicator';
import { Page } from '@/components/app/page';
import { AboutSection } from '@/features/settings/about';
import { AccountSection } from '@/features/settings/account';
import { AiSection } from '@/features/settings/ai';
import { ApiSection } from '@/features/settings/api-token';
import { AutomationSection } from '@/features/settings/automation';
import { MetadataSection } from '@/features/settings/metadata';
import { NetworkSection } from '@/features/settings/network';
import { NotificationsSection } from '@/features/settings/notifications';
import { SecuritySection } from '@/features/settings/security';
import { SourcesSection } from '@/features/settings/sources';
import { StorageSection } from '@/features/settings/storage';

const GROUPS = [
  { title: '基本', sections: [
    { id: 'account', title: 'Kmoe 账号', icon: UserRound, content: AccountSection },
    { id: 'storage', title: '存储位置', icon: HardDrive, content: StorageSection },
    { id: 'automation', title: '下载与更新', icon: Timer, content: AutomationSection },
    { id: 'notifications', title: '通知', icon: Bell, content: NotificationsSection },
  ] },
  { title: '集成', sections: [
    { id: 'metadata', title: 'Komga 元数据', icon: Tags, content: MetadataSection },
    { id: 'sources', title: 'Bangumi 书单', icon: ListChecks, content: SourcesSection },
    { id: 'ai', title: 'AI', icon: Sparkles, content: AiSection },
    { id: 'api', title: 'API 与 MCP', icon: Plug, content: ApiSection },
  ] },
  { title: '系统', sections: [
    { id: 'network', title: '网络代理', icon: Globe, content: NetworkSection },
    { id: 'security', title: '安全', icon: ShieldCheck, content: SecuritySection },
    { id: 'about', title: '关于', icon: Info, content: AboutSection },
  ] },
] as const;
type Section = (typeof GROUPS)[number]['sections'][number];
const SECTIONS = GROUPS.flatMap((group): readonly Section[] => group.sections);
type SectionId = Section['id'];
export const isSection = (id: string): id is SectionId => SECTIONS.some(section => section.id === id);

const item = 'relative z-10 flex shrink-0 items-center gap-2.5 rounded-lg text-sm font-medium whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:text-foreground';

export function SettingsLayout() {
  const nav = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // Phones: keep the current section visible in the scrolling strip (sideways only, never moving the page).
  useEffect(() => {
    const active = nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav.current && active) nav.current.scrollTo({ left: active.offsetLeft - 16 });
  }, [pathname]);
  return <Page>
    <h1 className="sr-only">设置</h1>
    <div className="grid grid-cols-1 items-start gap-x-10 gap-y-5 md:grid-cols-[184px_minmax(0,1fr)]">
      <nav ref={nav} aria-label="设置分区" className="relative -mx-4 flex gap-5 overflow-x-auto border-b px-4 py-0.5 no-scrollbar max-md:edge-fade-x md:sticky md:top-9 md:mx-0 md:flex-col md:gap-0 md:overflow-visible md:border-b-0 md:px-0 md:py-0">
        {/* Headings and links stay direct children of the nav: the indicator follows the current link among them. */}
        {GROUPS.map((group, index) => [
          <span key={group.title} className="px-3 pt-5 pb-1.5 text-xs font-medium text-muted-foreground first:pt-0 max-md:hidden">{group.title}</span>,
          index > 0 && <span key={`${group.title}-rule`} aria-hidden className="my-3 w-px shrink-0 bg-border md:hidden" />,
          ...group.sections.map(section => <Link key={section.id} to="/settings/$section" params={{ section: section.id }}
            className={`${item} h-10 md:h-9 md:px-3 md:not-aria-[current=page]:hover:bg-accent/60`}>
            <section.icon className="size-4 shrink-0 max-md:hidden" />{section.title}
          </Link>),
        ])}
        <Indicator axis="x" className="top-auto -bottom-px h-0.5 rounded-full bg-seal md:hidden" />
        <Indicator className="rounded-lg bg-accent max-md:hidden" />
      </nav>
      <Outlet />
    </div>
  </Page>;
}

const route = getRouteApi('/_app/settings/$section');

export function SettingsSectionPage() {
  const { section } = route.useParams();
  const meta = SECTIONS.find(s => s.id === section) ?? SECTIONS[0]!;
  const Content = meta.content;
  return <motion.section key={meta.id} aria-labelledby="section-title" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
    className="flex min-w-0 flex-col gap-6">
    <h2 id="section-title" className="text-[22px] leading-tight md:text-[26px] font-semibold tracking-tight">{meta.title}</h2>
    <Content />
  </motion.section>;
}
