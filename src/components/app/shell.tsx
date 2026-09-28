import { useEffect, useRef, useState } from 'react';
import { Outlet, useMatches } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { cn } from 'cn';
import { useMediaQuery } from '@/lib/hooks';
import { connectLive } from '@/lib/queries';
import { useAssistant } from '@/stores/assistant';
import { Assistant } from '@/features/assistant/assistant';
import { Sidebar, TabBar, TopBar } from './navigation';
import { TopBarActions } from './page';

/** Signed-in layout: navigation, one live event stream for the whole app, and the page with its entrance. */
export function Shell() {
  const client = useQueryClient();
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    // Only report a lost stream after a few seconds, so a quick reconnect never flashes a warning.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = connectLive(client, live => {
      clearTimeout(timer);
      if (live) setConnected(true); else timer = setTimeout(() => setConnected(false), 3000);
    });
    return () => { clearTimeout(timer); stop(); };
  }, [client]);

  const matches = useMatches();
  const page = matches[2];
  const fullscreen = matches.some(match => match.staticData.fullscreen);
  const title = matches.findLast(match => match.staticData.title)?.staticData.title ?? 'Kmoe Sync';
  // The comic page names the tab itself (it knows the comic's title).
  useEffect(() => { if (!fullscreen) document.title = `${title} · Kmoe Sync`; }, [title, fullscreen]);

  // A new page (not a filter or tab change) moves focus to the content, as a full page load would.
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    main.current?.focus({ preventScroll: true });
  }, [page?.pathname]);

  // On phones the assistant covers the whole page: what is behind it leaves the tab order and the accessibility tree.
  const phone = !useMediaQuery('(min-width: 768px)');
  const covered = useAssistant(state => state.open) && phone;
  return <div className="min-h-dvh text-sm">
    <div inert={covered} className="contents">
      <a href="#main" className="sr-only rounded-lg bg-card px-3 py-2 font-medium shadow-float ring-1 ring-border focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50">跳到内容</a>
      <Sidebar connected={connected} />
      {!fullscreen && <TopBar title={title} actions={setActions} />}
      <main ref={main} id="main" tabIndex={-1} className={cn('outline-none md:pl-60', !fullscreen && 'max-md:pb-[calc(60px+env(safe-area-inset-bottom))]')}>
        <motion.div key={page?.pathname} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}>
          <TopBarActions.Provider value={actions}><Outlet /></TopBarActions.Provider>
        </motion.div>
      </main>
      {!fullscreen && <TabBar />}
    </div>
    <Assistant hideButton={fullscreen} />
  </div>;
}
