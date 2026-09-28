// The in-app assistant: a streamed chat whose tools are the MCP tools, run through the same handlers and validation.
// Read-only tools run at once; tools that change something wait for the user's OK (the page asks, then sends the answer
// back together with the conversation, which the browser keeps).
import { z } from 'zod';
import { ChatRequest, type ChatEvent, type ChatMessage, type ChatToolCall } from '@shared/model';
import type { App } from '../app';
import { TOOLS, type Call } from '../api/mcp';
import { AppError, errorResponse } from '../http/errors';
import { errorMessage } from '../lib/retry';
import type { ToolSpec } from './client';

/** Tools that only read: they run without asking. */
const READ_ONLY = new Set(['search_comics', 'get_comic', 'list_shelf', 'list_downloads', 'library_check', 'library_status', 'get_status', 'get_diagnostics']);
const LABELS: Record<string, string> = {
  search_comics: '搜索 Kmoe', get_comic: '查看漫画', list_shelf: '查看书架', subscribe: '订阅', unsubscribe: '取消订阅', check_updates: '检查更新',
  download: '加入下载队列', list_downloads: '查看下载任务', library_check: '核对书库文件', library_status: '查看书库', scan_library: '扫描书库并匹配 Kmoe',
  sync_metadata: '处理元数据', get_status: '查看服务状态', set_queue: '暂停或继续下载', get_diagnostics: '收集诊断信息',
};
const MAX_STEPS = 8, MAX_HISTORY = 60, MAX_RESULT = 12_000;
const HAN = /\p{Script=Han}/u;

const SYSTEM = `你是 Kmoe Sync 的助手，始终用简体中文。Kmoe Sync 是自托管在 NAS 上的服务：订阅 Kmoe（Kindle 漫画站）上的漫画、按卷下载到书库，并把 Bangumi 的元数据写入 Komga。
- 先用工具查到真实数据再回答，不要编造漫画、卷数、状态或结果。需要查时直接调用工具，调用前不要先说“我来查一下”之类的话。
- 漫画用 key（Kmoe 详情页 /c/<key>.htm 中的那段）指代；不知道 key 时先用 search_comics 或 list_shelf 查。
- 订阅、下载、扫描、同步、暂停队列这类会改变东西的操作，调用工具后由用户在页面上确认；直接调用即可，不要先问“要不要”。用户没同意就不要再发起同样的操作。
- 排查问题时先调用 get_diagnostics。Kmoe 限制访问频率时服务会自动暂停并等待，这是正常的自我保护。
- 回答用 Markdown 排版：先给结论，要点用列表，多项对比用表格，关键数字和结论加粗；不要把普通文字放进代码块。
- 提到漫画时写成链接 [《书名》](/comics/<key>)。提到页面时也写成链接：[书架](/)、[发现](/discover)、[书库整理](/library)（?view=todo 只看待处理的；按阶段筛选可组合：?kmoe=pending|suggested|unmatched|matched|ignored、?bangumi=none|suggested|unmatched|matched、?komga=pending|not_found|error|synced）、[下载](/downloads)、[设置](/settings/<section>)（section：account、storage、automation、notifications、network、ai、metadata、api、security、about）。
- 简洁具体，不要重复工具返回的原始数据；提到选项时用界面上的中文名（补齐缺失、仅追新、单行本、番外、连载话），不要说 backfill、future 这类参数名。`;

/** Where the user is, so "这部" and "这里" mean something; a comic page also names the comic. */
function pageNote(app: App, page: string | undefined): string {
  if (!page) return '';
  const key = /^\/comics\/([^/?#]+)/.exec(page)?.[1];
  let title: string | undefined;
  if (key) {
    try { title = app.comics.find(app.comics.resolve(decodeURIComponent(key)))?.title; } catch { /* not a known comic */ }
  }
  return `\n- 用户正在看的页面：${page}${title ? `，漫画《${title}》（key：${decodeURIComponent(key!)}）` : ''}。问题里的“这部”“这里”指这个页面。`;
}

const SPECS: ToolSpec[] = Object.entries(TOOLS).map(([name, tool]) => {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(tool.input) as Record<string, unknown>;
  return { type: 'function', function: { name, description: tool.description, parameters } };
});

function argsOf(call: ChatToolCall): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(call.function.arguments || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

/** What a tool call does, for the page: "加入下载队列 《葬送的芙莉蓮》 3 项". */
function labelOf(app: App, call: ChatToolCall): string {
  const args = argsOf(call), name = call.function.name;
  let title: string | null = null;
  if (typeof args.key === 'string') {
    try { title = app.comics.find(app.comics.resolve(args.key))?.title ?? args.key; } catch { title = args.key; }
  }
  const extra = name === 'download' && Array.isArray(args.itemIds) ? `${args.itemIds.length} 项`
    : name === 'subscribe' ? (args.strategy === 'future' ? '（仅追新）' : args.strategy === 'backfill' ? '（补齐缺失）' : '')
    : name === 'set_queue' ? (args.paused ? '暂停' : '继续')
    : name === 'search_comics' && typeof args.query === 'string' ? `「${args.query}」` : '';
  return [LABELS[name] ?? name, title && `《${title}》`, extra].filter(Boolean).join(' ');
}

async function runTool(app: App, call: Call, tool: ChatToolCall): Promise<{ ok: boolean; content: string }> {
  const spec = TOOLS[tool.function.name];
  if (!spec) return { ok: false, content: `没有这个工具：${tool.function.name}` };
  const parsed = spec.input.safeParse(argsOf(tool));
  if (!parsed.success) return { ok: false, content: `参数无效：${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('；')}` };
  try {
    const text = JSON.stringify(await spec.run(parsed.data, call, app) ?? null);
    return { ok: true, content: text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}…（结果太长，已截断）` : text };
  } catch (error) {
    const message = error instanceof AppError ? error.message
      : await errorResponse(error).json().then((body: { error?: { message?: string } }) => body.error?.message ?? errorMessage(error)).catch(() => errorMessage(error));
    return { ok: false, content: `出错：${message}` };
  }
}

/**
 * Every tool call must be answered right after it (the API requires it). Calls the user never decided on (they typed a
 * new message instead) count as declined; only the calls of a final assistant turn stay open for the decisions.
 */
export function repair(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    out.push(message);
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    let next = i + 1;
    const answered = new Set<string>();
    for (; next < messages.length && messages[next]!.role === 'tool'; next++) {
      answered.add(messages[next]!.tool_call_id ?? '');
      out.push(messages[next]!);
    }
    if (next < messages.length) {
      for (const call of message.tool_calls) if (!answered.has(call.id)) out.push({ role: 'tool', tool_call_id: call.id, content: '用户没有确认，操作未执行' });
    }
    i = next - 1;
  }
  return out;
}

/** Tool calls of the final assistant turn that still wait for the user's decision. */
function unanswered(messages: ChatMessage[]): ChatToolCall[] {
  const index = messages.findLastIndex(message => message.role === 'assistant');
  const calls = messages[index]?.tool_calls ?? [];
  const answered = new Set(messages.slice(index + 1).map(message => message.tool_call_id));
  return calls.filter(call => !answered.has(call.id));
}

/** Keeps the last MAX_HISTORY messages, starting at a user turn so no tool result loses its call. */
function trim(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_HISTORY) return messages;
  let start = messages.length - MAX_HISTORY;
  while (start < messages.length - 1 && messages[start]!.role !== 'user') start++;
  return messages.slice(start);
}

/** POST /api/ai/chat: newline-delimited ChatEvent JSON; ends with the updated conversation and `done`. */
export async function chatResponse(req: Request, app: App, call: Call): Promise<Response> {
  let body: ChatRequest;
  try { body = ChatRequest.parse(await req.json()); } catch { throw new AppError(400, 'invalid_request', '对话内容格式不对，请清空对话后重试'); }
  // Not set up or over budget: a plain JSON error before anything streams.
  const client = app.ai.client();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatEvent) => { try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch { /* the page went away */ } };
      const messages = repair(trim(body.messages)), system = SYSTEM + pageNote(app, body.page);
      const execute = async (tool: ChatToolCall) => {
        const label = labelOf(app, tool);
        send({ type: 'tool', id: tool.id, name: tool.function.name, label, status: 'running' });
        const result = await runTool(app, call, tool);
        send({ type: 'tool', id: tool.id, name: tool.function.name, label, status: result.ok ? 'done' : 'error' });
        messages.push({ role: 'tool', tool_call_id: tool.id, content: result.content });
      };
      try {
        for (const tool of unanswered(messages)) {
          if (body.decisions?.[tool.id] === true) await execute(tool);
          else {
            send({ type: 'tool', id: tool.id, name: tool.function.name, label: labelOf(app, tool), status: 'rejected' });
            messages.push({ role: 'tool', tool_call_id: tool.id, content: '用户没有同意，操作已取消' });
          }
        }
        for (let step = 0; step < MAX_STEPS && !req.signal.aborted; step++) {
          // Text streams once it has some Chinese in it: some models announce their tool calls in English whatever the
          // prompt says ("I'll check…"), and that is dropped. An answer with no Chinese at all still shows at the end.
          let text = '', held: string | null = '', calls: ChatToolCall[] = [];
          for await (const part of client.stream([{ role: 'system', content: system }, ...messages], SPECS, req.signal)) {
            if (part.type === 'tools') { calls = part.calls; continue; }
            text += part.text;
            if (held === null) send({ type: 'text', text: part.text });
            else if (HAN.test(held += part.text)) { send({ type: 'text', text: held }); held = null; }
          }
          if (held && calls.length) text = '';
          else if (held) send({ type: 'text', text: held });
          messages.push({ role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
          if (!calls.length) break;
          for (const tool of calls) if (READ_ONLY.has(tool.function.name)) await execute(tool);
          const writes = calls.filter(tool => !READ_ONLY.has(tool.function.name));
          if (writes.length) {
            send({ type: 'confirm', calls: writes.map(tool => ({ id: tool.id, name: tool.function.name, label: labelOf(app, tool) })) });
            break;
          }
        }
      } catch (error) {
        if (!req.signal.aborted) send({ type: 'error', message: errorMessage(error) });
      }
      send({ type: 'messages', messages });
      send({ type: 'done' });
      try { controller.close(); } catch { /* already closed */ }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}
