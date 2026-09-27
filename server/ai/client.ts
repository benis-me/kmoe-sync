// A client for an OpenAI-compatible chat endpoint (DeepSeek, OpenRouter, a local server…): plain replies (optionally as
// JSON), streamed replies with tool calls, the model list, and token accounting. Failures come back as readable AppErrors.
import type { ChatMessage, ChatToolCall } from '@shared/model';
import { AppError } from '../http/errors';
import { connectionProblem } from '../metadata/bangumi';

export interface Endpoint { baseUrl: string; apiKey: string; model: string }
export interface ToolSpec { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export type Message = { role: 'system'; content: string } | ChatMessage;
export type StreamPart = { type: 'text'; text: string } | { type: 'tools'; calls: ChatToolCall[] };

/** The model's JSON: the whole reply, else the first {...} in it (models without a JSON mode wrap it in prose or fences). */
export function parseJson(text: string): Record<string, unknown> {
  const attempt = (value: string) => { try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; } };
  const whole = attempt(text.trim());
  if (whole) return whole;
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  const inner = start >= 0 && end > start ? attempt(text.slice(start, end + 1)) : null;
  if (inner) return inner;
  throw new AppError(502, 'ai_bad_reply', 'AI 没有按要求返回 JSON，可以换一个模型再试');
}

/**
 * Thinking off where the endpoint has a switch for it: these short structured tasks do not need it (it costs time and
 * tokens), and with tools DeepSeek would want each turn's reasoning sent back. Dropped again if the endpoint refuses it.
 */
function noThinking(baseUrl: string): Record<string, unknown> {
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch { /* checked when saved */ }
  if (/(^|\.)deepseek\.com$/i.test(host)) return { thinking: { type: 'disabled' } };
  if (/(^|\.)openrouter\.ai$/i.test(host)) return { reasoning: { enabled: false } };
  return {};
}
const THINKING = ['thinking', 'reasoning'];

/** Rough token count when the endpoint reports no usage (Chinese ≈ 1 token per 1–2 characters). */
const estimate = (...texts: string[]) => Math.ceil(texts.reduce((sum, text) => sum + text.length, 0) / 2);

async function failure(response: Response): Promise<AppError> {
  let detail = '';
  try {
    const body = await response.json() as { error?: { message?: string } | string; message?: string };
    detail = (typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? '').trim().slice(0, 200);
  } catch { /* not JSON */ }
  const { status } = response;
  const message = status === 401 || status === 403 ? 'AI 服务拒绝了 API Key，请检查是否填对'
    : status === 402 ? 'AI 服务的账户余额不足'
    : status === 404 ? 'AI 服务返回 404：接口地址或模型名不对'
    : status === 429 ? 'AI 服务限流或额度已用完，请稍后再试'
    : status >= 500 ? `AI 服务暂时不可用（HTTP ${status}）`
    : `AI 服务返回错误（HTTP ${status}）`;
  return new AppError(502, status === 401 || status === 403 ? 'ai_auth' : 'ai_failed', detail ? `${message}：${detail}` : message);
}

export class AiClient {
  private readonly extra: Record<string, unknown>;
  constructor(private readonly endpoint: Endpoint, private readonly fetchImpl: typeof fetch, private readonly onUsage: (tokens: number) => void) {
    this.extra = noThinking(endpoint.baseUrl);
  }

  private url(path: string) {
    const base = this.endpoint.baseUrl.trim().replace(/\/+$/, '');
    return `${base}/${path}`;
  }

  private async send(path: string, init: { method: 'GET' | 'POST'; body?: Record<string, unknown>; signal?: AbortSignal; timeout: number }): Promise<Response> {
    const timeout = AbortSignal.timeout(init.timeout);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method: init.method,
        headers: { Authorization: `Bearer ${this.endpoint.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json', 'X-Title': 'Kmoe Sync' },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new AppError(502, 'ai_unreachable', `无法连接 AI 服务（${connectionProblem(error)}）：检查接口地址；国外的服务需要在「网络代理」里设置代理，并在 AI 设置中打开「走网络代理」`);
    }
    return response;
  }

  /** POST, and on a 400 once more without the optional fields some endpoints do not know (JSON mode, stream usage). */
  private async post(path: string, body: Record<string, unknown>, optional: string[], signal: AbortSignal | undefined, timeout: number): Promise<Response> {
    let response = await this.send(path, { method: 'POST', body, signal, timeout });
    if (response.status === 400 && optional.some(key => key in body)) {
      await response.body?.cancel().catch(() => {});
      const plain = Object.fromEntries(Object.entries(body).filter(([key]) => !optional.includes(key)));
      response = await this.send(path, { method: 'POST', body: plain, signal, timeout });
    }
    if (!response.ok) throw await failure(response);
    return response;
  }

  /** One reply, not streamed. json: ask for a JSON object (the caller parses it with parseJson). */
  async complete(messages: Message[], options: { json?: boolean; maxTokens?: number; signal?: AbortSignal } = {}): Promise<string> {
    const body: Record<string, unknown> = { model: this.endpoint.model, messages, max_tokens: options.maxTokens ?? 1024, stream: false, ...this.extra };
    if (options.json) body.response_format = { type: 'json_object' };
    const response = await this.post('chat/completions', body, ['response_format', ...THINKING], options.signal, 180_000);
    type Choice = { message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }; finish_reason?: string | null };
    const data = await response.json() as { choices?: Choice[]; usage?: { total_tokens?: number } };
    const choice = data.choices?.[0], text = choice?.message?.content ?? '';
    this.onUsage(data.usage?.total_tokens ?? estimate(JSON.stringify(messages), text));
    if (!text.trim()) {
      const thought = choice?.message?.reasoning_content || choice?.message?.reasoning || choice?.finish_reason === 'length';
      throw new AppError(502, 'ai_bad_reply', thought ? 'AI 把长度上限都用在了思考（推理）上，没有给出回答：换一个不带思考的模型，或者关掉它的思考模式再试' : 'AI 返回了空内容，可以换一个模型再试');
    }
    return text;
  }

  /** A streamed reply: text as it arrives, then the tool calls it asked for (if any). */
  async *stream(messages: Message[], tools: ToolSpec[], signal?: AbortSignal): AsyncGenerator<StreamPart> {
    const body: Record<string, unknown> = { model: this.endpoint.model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: 4096, ...this.extra };
    if (tools.length) body.tools = tools;
    const response = await this.post('chat/completions', body, ['stream_options', ...THINKING], signal, 600_000);
    if (!response.body) throw new AppError(502, 'ai_bad_reply', 'AI 服务没有返回内容');
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let buffer = '', text = '', usage = 0;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const consume = (line: string): string | null => {
      if (!line.startsWith('data:')) return null; // SSE comments (": PROCESSING") and blank lines
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return null;
      let chunk: { error?: { message?: string } | string; usage?: { total_tokens?: number }; choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
      try { chunk = JSON.parse(data); } catch { return null; }
      if (chunk.error) throw new AppError(502, 'ai_failed', `AI 服务返回错误：${typeof chunk.error === 'string' ? chunk.error : chunk.error.message ?? '未知错误'}`);
      if (chunk.usage?.total_tokens) usage = chunk.usage.total_tokens;
      const delta = chunk.choices?.[0]?.delta;
      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0, entry = calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (call.id) entry.id = call.id;
        // The name arrives whole (some endpoints repeat it in every chunk); the arguments arrive in pieces.
        if (call.function?.name && !entry.name) entry.name = call.function.name;
        if (call.function?.arguments) entry.arguments += call.function.arguments;
        calls.set(index, entry);
      }
      return delta?.content || null;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
          const piece = consume(buffer.slice(0, newline).trim());
          buffer = buffer.slice(newline + 1);
          if (piece) { text += piece; yield { type: 'text', text: piece }; }
        }
      }
      const last = consume(buffer.trim());
      if (last) { text += last; yield { type: 'text', text: last }; }
    } finally {
      reader.releaseLock();
      this.onUsage(usage || estimate(JSON.stringify(messages), text, [...calls.values()].map(call => call.arguments).join('')));
    }
    if (calls.size) {
      yield { type: 'tools', calls: [...calls].sort(([a], [b]) => a - b).map(([index, call]) => ({
        id: call.id || `call_${index}_${Date.now().toString(36)}`, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' },
      })) };
    }
  }

  /** Model ids the endpoint offers (GET /models); [] when it does not say. */
  async models(signal?: AbortSignal): Promise<string[]> {
    const response = await this.send('models', { method: 'GET', signal, timeout: 20_000 });
    if (!response.ok) throw await failure(response);
    const data = await response.json().catch(() => null) as { data?: { id?: unknown }[] } | null;
    return [...new Set((data?.data ?? []).map(model => model.id).filter((id): id is string => typeof id === 'string'))].sort();
  }
}
