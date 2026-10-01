// Push notifications: generic webhook, Bark (iOS) and Telegram. Failures are logged, never thrown into the caller.
// fetchImpl is the proxied fetch (Telegram is often blocked; LAN webhooks still go direct).
import type { Channel, NotifyEvent } from '@shared/model';

export interface Message { event: NotifyEvent; title: string; detail?: string | null; url?: string | null }

export async function deliver(channel: Channel, message: Message, fetchImpl: typeof fetch = fetch, signal = AbortSignal.timeout(10_000)): Promise<void> {
  const body = message.detail ? `${message.detail}` : '';
  let response: Response;
  if (channel.kind === 'webhook') {
    response = await fetchImpl(channel.url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'kmoesync', event: message.event, title: message.title, detail: message.detail ?? null, url: message.url ?? null, time: new Date().toISOString() }) });
  } else if (channel.kind === 'bark') {
    response = await fetchImpl(`${channel.server.replace(/\/+$/, '')}/${encodeURIComponent(channel.key)}`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: message.title, body: body || message.title, group: 'Kmoe Sync', ...(message.url ? { url: message.url } : {}) }) });
  } else {
    response = await fetchImpl(`https://api.telegram.org/bot${channel.token}/sendMessage`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: channel.chatId, text: [message.title, body, message.url].filter(Boolean).join('\n'), disable_web_page_preview: true }) });
  }
  if (!response.ok) throw new Error(`${channel.name}：HTTP ${response.status}`);
}

export class Notifier {
  constructor(private readonly channels: () => Channel[], private readonly fetchImpl: typeof fetch = fetch) {}

  send(message: Message) {
    for (const channel of this.channels()) {
      if (!channel.enabled || !channel.events.includes(message.event)) continue;
      void deliver(channel, message, this.fetchImpl).catch(error => console.warn(`[notify] ${channel.name} failed:`, error instanceof Error ? error.message : error));
    }
  }
}
