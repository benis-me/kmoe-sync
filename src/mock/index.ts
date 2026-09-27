// Demo mode (dev server, or `vite build --mode demo`): ?mock[=setup|fresh|full|paused|expired|network] (remembered for the tab) serves the whole API in the browser.
// ?mock=off leaves it. The implementation is loaded only when demo mode is on.
import { setEventSourceFactory, setTransport } from '@/lib/api';
import type { Scenario } from './data';

const KEY = 'kmoesync:mock';
const SCENARIOS: Scenario[] = ['setup', 'fresh', 'full', 'paused', 'expired', 'network'];
let active: Scenario | null = null;

export const mockScenario = () => active;

function requested(): Scenario | null {
  const params = new URLSearchParams(location.search);
  if (params.has('mock')) {
    const value = params.get('mock') ?? '';
    params.delete('mock');
    const search = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
    if (value === 'off') sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, SCENARIOS.includes(value as Scenario) ? value : 'full');
  }
  const stored = sessionStorage.getItem(KEY) as Scenario | null;
  return stored ?? (import.meta.env.MODE === 'demo' ? 'full' : null);
}

export async function installMock() {
  // Constant-folded, so production builds drop the demo entirely; `vite build --mode demo` keeps it (static demo site).
  if (import.meta.env.DEV || import.meta.env.MODE === 'demo') {
    active = requested();
    if (!active) return;
    const { createMockServer } = await import('./server');
    const server = createMockServer(active);
    setTransport(server.transport);
    setEventSourceFactory(server.eventSource);
  }
}
