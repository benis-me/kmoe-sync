// A fake OpenAI-compatible endpoint (DeepSeek / OpenRouter shape) for tests: /v1/models and /v1/chat/completions, plain,
// in JSON mode, or streamed with tool calls. `state.reply` answers each request; tests swap it. Only "Bearer sk-test" works.
export interface FakeReply { text?: string; tools?: { name: string; args: Record<string, unknown> }[] }
export type FakeRequest = {
  model: string; stream?: boolean; response_format?: unknown; tools?: unknown[];
  messages: { role: string; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[];
};

export function startFakeAi() {
  const state = {
    requests: [] as FakeRequest[],
    /** Refuse JSON mode with a 400, like endpoints without response_format. */
    noJsonMode: false,
    reply: (_request: FakeRequest): FakeReply => ({ text: '好的' }),
  };
  let calls = 0;
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get('authorization') !== 'Bearer sk-test') return Response.json({ error: { message: 'invalid api key' } }, { status: 401 });
      if (url.pathname === '/v1/models') return Response.json({ object: 'list', data: [{ id: 'fake-chat' }, { id: 'fake-reasoner' }] });
      if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') return new Response('not found', { status: 404 });
      const request = await req.json() as FakeRequest;
      state.requests.push(request);
      if (request.response_format && state.noJsonMode) return Response.json({ error: { message: 'response_format is not supported' } }, { status: 400 });
      const reply = state.reply(request);
      if (!request.stream) return Response.json({ choices: [{ message: { role: 'assistant', content: reply.text ?? '' } }], usage: { total_tokens: 100 } });
      const chunks: unknown[] = [];
      for (const piece of (reply.text ?? '').match(/[\s\S]{1,4}/gu) ?? []) chunks.push({ choices: [{ delta: { content: piece } }] });
      reply.tools?.forEach((tool, index) => {
        const args = JSON.stringify(tool.args), id = `call_${++calls}`;
        // Name first, then the arguments in pieces, as real endpoints stream them.
        chunks.push({ choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { name: tool.name, arguments: '' } }] } }] });
        chunks.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(0, 5) } }] } }] });
        chunks.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(5) } }] } }] });
      });
      chunks.push({ choices: [], usage: { total_tokens: 50 } });
      const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}: keep-alive\n\ndata: [DONE]\n\n`;
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  return { state, origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** The system prompt and the last message of a request (to decide what to answer). */
export const promptOf = (request: FakeRequest) => ({ system: request.messages[0]?.role === 'system' ? request.messages[0].content ?? '' : '', last: request.messages.at(-1)! });
