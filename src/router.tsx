// Code-based route tree. The auth gate reads GET /api/auth/state once (cached) and routes to setup, login or the app.
import { Link, Outlet, createRootRouteWithContext, createRoute, createRouter, redirect, useRouter } from '@tanstack/react-router';
import { QueryCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { FileQuestion, LoaderCircle } from 'lucide-react';
import { KOMGA_STATUSES } from '@shared/folder-status';
import { BangumiState, Format, KmoeLinkState, TaskStatus } from '@shared/model';
import { ApiError, errorMessage } from '@/lib/api';
import { authQuery } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState } from '@/components/app/feedback';
import { Shell } from '@/components/app/shell';
import { SetupPage, LoginPage } from '@/pages/auth';
import { ShelfPage } from '@/pages/shelf';
import { DiscoverLayout, SearchPage } from '@/pages/discover';
import { BangumiPage } from '@/pages/bangumi';
import { ComicPage } from '@/pages/comic';
import { LibraryPage } from '@/pages/library';
import { DownloadsPage } from '@/pages/downloads';
import { SettingsLayout, SettingsSectionPage, isSection } from '@/pages/settings';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2 },
    mutations: { onError: error => void toast.error(errorMessage(error)) },
  },
  // A 401 on any read while signed in means the session ended elsewhere: back to the login page.
  queryCache: new QueryCache({
    onError: error => {
      if (!(error instanceof ApiError) || error.status !== 401 || !queryClient.getQueryData(authQuery.queryKey)?.authenticated) return;
      queryClient.setQueryData(authQuery.queryKey, old => old && { ...old, authenticated: false, csrf: null });
      void router.navigate({ to: '/login', search: { redirect: router.state.location.href } });
    },
  }),
});

const optional = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
  errorComponent: function RootError({ error }) {
    const router = useRouter();
    return <main className="grid min-h-dvh place-items-center p-6 text-sm"><ErrorState error={error} onRetry={() => void router.invalidate()} /></main>;
  },
  notFoundComponent: () => <main className="grid min-h-dvh place-items-center p-6 text-sm">
    <EmptyState icon={<FileQuestion />} title="页面不存在" description="地址可能有误，或者这个页面已经移走了。">
      <Button variant="outline" asChild><Link to="/">回到书架</Link></Button>
    </EmptyState>
  </main>,
});

const auth = (client: QueryClient) => client.ensureQueryData(authQuery);

const setupRoute = createRoute({
  getParentRoute: () => rootRoute, path: 'setup', component: SetupPage,
  beforeLoad: async ({ context }) => {
    const state = await auth(context.queryClient);
    if (!state.setupRequired) throw redirect({ to: state.authenticated ? '/' : '/login' });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute, path: 'login', component: LoginPage,
  validateSearch: z.object({ redirect: optional(z.string()) }),
  beforeLoad: async ({ context }) => {
    const state = await auth(context.queryClient);
    if (state.setupRequired) throw redirect({ to: '/setup' });
    if (state.authenticated) throw redirect({ to: '/' });
  },
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute, id: '_app', component: Shell,
  beforeLoad: async ({ context, location }) => {
    const state = await auth(context.queryClient);
    if (state.setupRequired) throw redirect({ to: '/setup' });
    if (!state.authenticated) throw redirect({ to: '/login', search: { redirect: location.href } });
  },
});

const shelfRoute = createRoute({
  getParentRoute: () => appRoute, path: '/', component: ShelfPage, staticData: { title: '书架' },
  validateSearch: z.object({ filter: optional(z.enum(['tracking', 'updates', 'failed'])) }),
});

const discoverRoute = createRoute({ getParentRoute: () => appRoute, path: 'discover', component: DiscoverLayout, staticData: { title: '发现' } });
const searchRoute = createRoute({
  getParentRoute: () => discoverRoute, path: '/', component: SearchPage,
  validateSearch: z.object({ q: optional(z.string()), page: optional(z.coerce.number().int().min(1)) }),
});
const bangumiRoute = createRoute({
  getParentRoute: () => discoverRoute, path: 'bangumi', component: BangumiPage,
  validateSearch: z.object({ source: optional(z.coerce.number().int()), match: optional(z.enum(['matched', 'dismissed'])) }),
});

const libraryRoute = createRoute({
  getParentRoute: () => appRoute, path: 'library', component: LibraryPage, staticData: { title: '书库整理' },
  validateSearch: z.object({
    targetId: optional(z.coerce.number().int()), view: optional(z.enum(['todo'])),
    kmoe: optional(KmoeLinkState), bangumi: optional(BangumiState), komga: optional(z.enum(KOMGA_STATUSES)),
  }),
});

const comicRoute = createRoute({
  getParentRoute: () => appRoute, path: 'comics/$key', component: ComicPage, staticData: { fullscreen: true },
  validateSearch: z.object({ targetId: optional(z.coerce.number().int()), format: optional(Format) }),
});

const downloadsRoute = createRoute({
  getParentRoute: () => appRoute, path: 'downloads', component: DownloadsPage, staticData: { title: '下载' },
  validateSearch: z.object({ status: optional(TaskStatus.exclude(['cancelled'])) }),
});

const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: 'settings', component: SettingsLayout, staticData: { title: '设置' } });
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute, path: '/',
  beforeLoad: () => { throw redirect({ to: '/settings/$section', params: { section: 'account' }, replace: true }); },
});
const sectionRoute = createRoute({
  getParentRoute: () => settingsRoute, path: '$section', component: SettingsSectionPage,
  beforeLoad: ({ params }) => { if (!isSection(params.section)) throw redirect({ to: '/settings/$section', params: { section: 'account' }, replace: true }); },
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  appRoute.addChildren([
    shelfRoute,
    discoverRoute.addChildren([searchRoute, bangumiRoute]),
    libraryRoute,
    comicRoute,
    downloadsRoute,
    settingsRoute.addChildren([settingsIndexRoute, sectionRoute]),
  ]),
]);

export const router = createRouter({
  routeTree,
  context: { queryClient },
  scrollRestoration: true,
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  defaultPendingMs: 300,
  defaultPendingComponent: () => <div role="status" className="grid min-h-dvh place-items-center text-sm text-muted-foreground">
    <span className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" />正在连接…</span>
  </div>,
});

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
  interface StaticDataRouteOption { title?: string; fullscreen?: boolean }
}
