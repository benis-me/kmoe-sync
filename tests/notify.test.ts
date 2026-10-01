// Push notifications open where they are about: the link reaches every kind of channel.
import { expect, test } from 'bun:test';
import type { Channel } from '@shared/model';
import { openDatabase } from '../server/db';
import { EventHub } from '../server/events';
import { deliver, Notifier } from '../server/notify';
import { ActivityLog } from '../server/services/activity';

const base = { id: 'c1', name: '手机', enabled: true, events: ['download_done' as const] };
const url = 'http://komga.lan/series/s1';

function capture() {
  const sent: { to: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ to: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response('{}');
  }) as typeof fetch;
  return { sent, fetchImpl };
}

test('Bark and webhooks get the link as a field, Telegram at the end of the text', async () => {
  const { sent, fetchImpl } = capture();
  const message = { event: 'download_done' as const, title: '《迷宮飯》下载了 1 个文件', detail: '卷 03', url };
  await deliver({ ...base, kind: 'bark', server: 'https://api.day.app', key: 'k' } satisfies Channel, message, fetchImpl);
  await deliver({ ...base, kind: 'webhook', url: 'http://nas.lan/hook' } satisfies Channel, message, fetchImpl);
  await deliver({ ...base, kind: 'telegram', token: 't', chatId: '1' } satisfies Channel, message, fetchImpl);
  expect(sent.map(entry => entry.body.url ?? entry.body.text)).toEqual([url, url, `《迷宮飯》下载了 1 个文件\n卷 03\n${url}`]);
});

test('an activity entry passes its link on to the notification', async () => {
  const { sent, fetchImpl } = capture();
  const log = new ActivityLog(openDatabase('', ':memory:'), new EventHub(), new Notifier(() => [{ ...base, kind: 'webhook', url: 'http://nas.lan/hook' }], fetchImpl));
  log.add({ kind: 'download_done', level: 'success', title: '《迷宮飯》下载了 1 个文件', detail: '卷 03', url });
  await Bun.sleep(10);
  expect(sent).toMatchObject([{ to: 'http://nas.lan/hook', body: { event: 'download_done', url } }]);
});
