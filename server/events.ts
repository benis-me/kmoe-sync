// In-process event hub feeding the /api/events SSE stream.
import type { ServerEvent } from '@shared/model';

type Listener = (event: ServerEvent) => void;

export class EventHub {
  private readonly listeners = new Set<Listener>();
  private pendingTasks = new Map<number, ServerEvent>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  get size() { return this.listeners.size; }

  emit(event: ServerEvent) {
    // Progress updates for the same task are coalesced to at most one frame per 300 ms.
    if (event.type === 'task') {
      this.pendingTasks.set(event.task.id, event);
      this.flushTimer ??= setTimeout(() => this.flush(), 300);
      return;
    }
    for (const listener of this.listeners) listener(event);
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const events = [...this.pendingTasks.values()];
    this.pendingTasks.clear();
    for (const event of events) for (const listener of this.listeners) listener(event);
  }
}

/** Server-sent events response: one JSON ServerEvent per `data:` frame, with keep-alive comments. */
export function sseResponse(hub: EventHub, initial: ServerEvent[], signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ServerEvent) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { close(); }
      };
      const close = () => {
        unsubscribe(); clearInterval(keepAlive);
        try { controller.close(); } catch { /* already closed */ }
      };
      controller.enqueue(encoder.encode('retry: 3000\n\n'));
      for (const event of initial) send(event);
      unsubscribe = hub.subscribe(send);
      keepAlive = setInterval(() => { try { controller.enqueue(encoder.encode(': keep-alive\n\n')); } catch { close(); } }, 20_000);
      signal.addEventListener('abort', close, { once: true });
    },
    cancel() { unsubscribe(); clearInterval(keepAlive); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } });
}
