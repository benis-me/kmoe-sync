// AI features against a fake OpenAI-compatible endpoint: settings and the test button, JSON fallback, the monthly budget,
// judging Kmoe candidates (with the fake Kmoe mirror), and the assistant's chat with its confirmation round trip.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent, ChatMessage, LibraryOverview } from '@shared/model';
import { repair } from '../server/ai/assistant';
import { AiClient, parseJson } from '../server/ai/client';
import { createApp } from '../server/app';
import { promptOf, startFakeAi } from './fake-ai';
import { FAKE_PASSWORD, startFakeKmoe } from './fake-kmoe';

const ai = startFakeAi();
const fake = startFakeKmoe({ port: 0 });
const root = mkdtempSync(join(tmpdir(), 'kmoesync-ai-'));
const library = join(root, 'library');
const app = createApp({
  host: '127.0.0.1', port: 0, dataDir: join(root, 'data'), libraryRoot: library, staticDir: join(root, 'web'),
  mirrors: [fake.origin], secureCookies: false, secret: Buffer.alloc(32, 3), fakeKmoe: true,
}, { fetch, scheduler: false, bulkPaceMs: 20 });
let base = '', cookie = '', csrf = '', targetId = 0;

async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${base}${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) },
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value).slice(0, 400)}`);
    await Bun.sleep(50);
  }
}
const overview = () => api<LibraryOverview>('GET', `/api/library?targetId=${targetId}`).then(r => r.data);
const folderAt = (data: LibraryOverview, path: string) => data.folders.find(folder => folder.path === path)!;
async function chat(messages: ChatMessage[], decisions?: Record<string, boolean>, page?: string): Promise<ChatEvent[]> {
  const response = await fetch(`${base}/api/ai/chat`, { method: 'POST', body: JSON.stringify({ messages, decisions, page }),
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf } });
  expect(response.headers.get('content-type')).toContain('application/x-ndjson');
  return (await response.text()).trim().split('\n').map(line => JSON.parse(line) as ChatEvent);
}
const textOf = (events: ChatEvent[]) => events.flatMap(event => event.type === 'text' ? [event.text] : []).join('');
const messagesOf = (events: ChatEvent[]) => events.flatMap(event => event.type === 'messages' ? [event.messages] : [])[0]!;

beforeAll(async () => {
  base = `http://127.0.0.1:${app.start().port}`;
  csrf = (await api('POST', '/api/auth/setup', { password: 'ai-test-pass' })).data.csrf;
  targetId = (await api('GET', '/api/targets')).data[0].id;
  await api('POST', '/api/kmoe/login', { email: 'reader@example.com', password: FAKE_PASSWORD });
});
afterAll(async () => { await app.stop(); fake.stop(); ai.stop(); rmSync(root, { recursive: true, force: true }); });

describe('replies', () => {
  test('JSON is read from the whole reply, a fence, or prose around it', () => {
    expect(parseJson('{"pick": 1}')).toEqual({ pick: 1 });
    expect(parseJson('```json\n{"pick": 2, "reason": "同名"}\n```')).toEqual({ pick: 2, reason: '同名' });
    expect(parseJson('好的，结果是 {"keywords": ["NANA"]} 。')).toEqual({ keywords: ['NANA'] });
    expect(() => parseJson('不知道')).toThrow('JSON');
  });

  test('DeepSeek and OpenRouter get thinking turned off; a reply spent on thinking says so', async () => {
    const bodies: Record<string, unknown>[] = [];
    let reply: Record<string, unknown> = { choices: [{ message: { content: '{"ok": true}' }, finish_reason: 'stop' }] };
    const stub = (async (_url: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return Response.json(reply); }) as unknown as typeof fetch;
    const client = (baseUrl: string) => new AiClient({ baseUrl, apiKey: 'k', model: 'm' }, stub, () => {});
    await client('https://api.deepseek.com').complete([{ role: 'user', content: 'json' }], { json: true });
    await client('https://openrouter.ai/api/v1').complete([{ role: 'user', content: 'json' }]);
    await client('http://192.168.1.2:11434/v1').complete([{ role: 'user', content: 'json' }]);
    expect(bodies.map(body => [body.thinking, body.reasoning])).toEqual([[{ type: 'disabled' }, undefined], [undefined, { enabled: false }], [undefined, undefined]]);
    reply = { choices: [{ message: { content: '', reasoning_content: '先想想……' }, finish_reason: 'length' }] };
    await expect(client('https://api.deepseek.com').complete([{ role: 'user', content: 'json' }])).rejects.toThrow('思考');
  });

  test('tool calls nobody answered count as declined, except the last turn that waits for a decision', () => {
    const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'set_queue', arguments: '{"paused":true}' } });
    const fixed = repair([
      { role: 'user', content: '暂停下载' }, { role: 'assistant', content: null, tool_calls: [call('a')] },
      { role: 'user', content: '算了，看看书架' }, { role: 'assistant', content: null, tool_calls: [call('b')] },
    ]);
    expect(fixed.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
    expect(fixed[2]).toMatchObject({ tool_call_id: 'a', content: expect.stringContaining('未执行') });
  });
});

describe('settings', () => {
  test('address, model and key make it ready; the key never comes back; the test lists models and checks JSON mode', async () => {
    expect((await api('GET', '/api/ai/settings')).data).toMatchObject({ ready: false, hasKey: false, provider: 'deepseek' });
    expect((await api('POST', '/api/ai/test', { baseUrl: `${ai.origin}/v1`, model: 'fake-chat', apiKey: 'wrong' })).data)
      .toMatchObject({ ok: false, message: expect.stringContaining('API Key') });
    ai.state.reply = () => ({ text: '{"ok": true}' });
    const draft = { provider: 'custom', baseUrl: `${ai.origin}/v1/`, model: 'fake-chat', apiKey: 'sk-test' };
    expect((await api('POST', '/api/ai/test', draft)).data).toMatchObject({ ok: true, json: true, models: ['fake-chat', 'fake-reasoner'] });
    const saved = (await api('PATCH', '/api/ai/settings', draft)).data;
    expect(saved).toMatchObject({ ready: true, hasKey: true, provider: 'custom', baseUrl: `${ai.origin}/v1` });
    expect(JSON.stringify(saved)).not.toContain('sk-test');
    // An endpoint without JSON mode: asked again without it, and the JSON is dug out of the text.
    ai.state.noJsonMode = true;
    ai.state.reply = () => ({ text: '```json\n{"ok": true}\n```' });
    expect((await api('POST', '/api/ai/test', {})).data).toMatchObject({ ok: true, json: true });
    ai.state.noJsonMode = false;
  });

  test('the saved key only goes to the address it was entered for', async () => {
    const elsewhere = 'http://127.0.0.1:1/v1';
    expect((await api('POST', '/api/ai/test', { baseUrl: elsewhere })).data).toMatchObject({ ok: false, message: '请填写 API Key' });
    expect((await api('PATCH', '/api/ai/settings', { baseUrl: elsewhere })).data).toMatchObject({ hasKey: false, ready: false });
    expect((await api('PATCH', '/api/ai/settings', { baseUrl: `${ai.origin}/v1`, apiKey: 'sk-test' })).data).toMatchObject({ hasKey: true, ready: true });
  });

  test('usage is counted per month and the budget stops further calls', async () => {
    const used = (await api('GET', '/api/ai/settings')).data.usage.tokens as number;
    expect(used).toBeGreaterThan(0);
    await api('PATCH', '/api/ai/settings', { monthlyTokens: used });
    expect((await api('POST', '/api/library/ai-match', { targetId, kind: 'kmoe' })).data.error.code).toBe('ai_budget');
    await api('PATCH', '/api/ai/settings', { monthlyTokens: 0 });
  });
});

describe('judging Kmoe candidates', () => {
  test('a confident pick is linked; an unsure one stays a suggestion with the reason; nothing found → other spellings', async () => {
    const book = (folder: string, name: string) => { mkdirSync(join(library, folder), { recursive: true }); writeFileSync(join(library, folder, name), 'PK\x03\x04 book'); };
    book('間諜家家', '間諜家家 01.epub');
    book('娜娜', '娜娜-卷01.epub');
    await api('POST', '/api/library/scan', { targetId, match: true });
    let data = await until(overview, value => !value.job.running);
    expect(folderAt(data, '/間諜家家').kmoe.state).toBe('suggested');
    expect(folderAt(data, '/娜娜').kmoe.state).toBe('unmatched');

    ai.state.reply = request => {
      const { system, last } = promptOf(request);
      if (system.includes('没有找到')) return { text: '{"keywords": ["NANA"]}' };
      if (String(last.content).includes('間諜家家酒')) return { text: '{"pick": 1, "confidence": 0.95, "reason": "文件名少了一个字，是同一部"}' };
      return { text: '{"pick": 1, "confidence": 0.6, "reason": "书名对得上，但作者信息不足"}' };
    };
    expect((await api('POST', '/api/library/ai-match', { targetId, kind: 'kmoe' })).data).toMatchObject({ kind: 'ai', running: true });
    data = await until(overview, value => !value.job.running);
    expect(data.job).toMatchObject({ kind: 'ai', error: null });
    expect(folderAt(data, '/間諜家家').kmoe).toMatchObject({ state: 'matched', comic: { key: 'c9d0e1' }, ai: { pick: 'c9d0e1', confidence: 0.95 } });
    expect(folderAt(data, '/娜娜').kmoe).toMatchObject({ state: 'suggested', candidates: [{ key: '10114' }], ai: { pick: '10114', reason: '书名对得上，但作者信息不足' } });
  }, 30_000);
});

describe('assistant', () => {
  test('read-only tools run at once, the answer streams, and the conversation comes back', async () => {
    // The English announcement before the tool call is not passed on.
    ai.state.reply = request => promptOf(request).last.role === 'user' ? { text: "I'll check the status.", tools: [{ name: 'get_status', args: {} }] } : { text: 'Kmoe 已登录，下载队列空闲。' };
    const events = await chat([{ role: 'user', content: '这部漫画现在状态怎么样？' }], undefined, '/comics/c9d0e1');
    expect(events.flatMap(event => event.type === 'tool' ? [`${event.label}:${event.status}`] : [])).toEqual(['查看服务状态:running', '查看服务状态:done']);
    expect(textOf(events)).toBe('Kmoe 已登录，下载队列空闲。');
    const messages = messagesOf(events);
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(messages[1]!.content).toBeNull();
    expect(JSON.parse(messages[2]!.content!)).toMatchObject({ kmoe: { state: 'active' } });
    expect(ai.state.requests.at(-1)!.tools!.length).toBeGreaterThan(10);
    // The page goes along as context, a comic page with the comic's title.
    expect(promptOf(ai.state.requests.at(-1)!).system).toContain('用户正在看的页面：/comics/c9d0e1，漫画《間諜家家酒'); 
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  test('a tool that changes something waits for the user: declined leaves things alone, approved runs it', async () => {
    ai.state.reply = request => {
      const { last } = promptOf(request);
      if (last.role === 'user') return { text: '好的，', tools: [{ name: 'set_queue', args: { paused: true } }] };
      return { text: String(last.content).includes('没有同意') ? '已取消。' : '下载队列已暂停。' };
    };
    const first = await chat([{ role: 'user', content: '暂停下载' }]);
    const confirm = first.find(event => event.type === 'confirm') as Extract<ChatEvent, { type: 'confirm' }>;
    expect(confirm.calls).toMatchObject([{ name: 'set_queue', label: '暂停或继续下载 暂停' }]);
    const pending = messagesOf(first);
    expect((await api('GET', '/api/status')).data.queue.paused).toBe(false);

    const declined = await chat(pending, { [confirm.calls[0]!.id]: false });
    expect(declined.some(event => event.type === 'tool' && event.status === 'rejected')).toBe(true);
    expect(textOf(declined)).toBe('已取消。');
    expect((await api('GET', '/api/status')).data.queue.paused).toBe(false);

    const approved = await chat(pending, { [confirm.calls[0]!.id]: true });
    expect(textOf(approved)).toBe('下载队列已暂停。');
    expect((await api('GET', '/api/status')).data.queue.paused).toBe(true);
    await api('POST', '/api/queue/resume');
  });

  test('a change is put to the user with what it would do now: how many items and how much, or that every series is rewritten', async () => {
    ai.state.reply = request => {
      if (promptOf(request).last.role !== 'user') return { text: '好了。' };
      return { text: '好的，', tools: [{ name: 'subscribe', args: { key: 'b1c4a0' } }, { name: 'download', args: { key: 'f7e2c9' } }, { name: 'sync_metadata', args: { all: true } }] };
    };
    const events = await chat([{ role: 'user', content: '订阅迷宮飯，下载芙莉蓮缺的卷，再把元数据全部重写一遍' }]);
    const confirm = events.find(event => event.type === 'confirm') as Extract<ChatEvent, { type: 'confirm' }>;
    expect(confirm.calls.map(call => call.label)).toEqual([
      expect.stringMatching(/^订阅 《迷宮飯》 · 补齐缺失 · 将新增 14 项 · 约 [\d.]+ MB$/),
      expect.stringMatching(/^加入下载队列 《葬送的芙莉蓮》 · 全部缺失的单行本 13 项 · 约 [\d.]+ MB$/),
      '处理元数据 · 重写全部系列',
    ]);
  });

  test('without AI set up the chat answers with a plain JSON error', async () => {
    await api('PATCH', '/api/ai/settings', { apiKey: '' });
    const response = await fetch(`${base}/api/ai/chat`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }] }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf } });
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('ai_not_configured');
    const anonymous = await fetch(`${base}/api/ai/chat`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(anonymous.status).toBe(401);
  });
});
