// AI 助手: a panel on the right (full screen on phones) that talks to POST /api/ai/chat, with the page the user is on as
// context. This tab keeps the conversation. Answers render as Markdown with the tools they used in the order they ran;
// actions that change something come back as a card to confirm or cancel.
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Check, CircleSlash, LoaderCircle, RotateCcw, SquarePen, Sparkles, Square, TriangleAlert, X } from 'lucide-react';
import { cn } from 'cn';
import type { ChatEvent, ChatMessage } from '@shared/model';
import { errorMessage, postStream } from '@/lib/api';
import { aiSettingsQuery } from '@/lib/queries';
import { useAssistant } from '@/stores/assistant';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { CopyButton } from '@/components/app/fields';

// Markdown is its own chunk, fetched when the panel opens.
const loadMarkdown = () => import('./markdown');
const Markdown = lazy(loadMarkdown);

type Mark = { label: string; status: 'running' | 'done' | 'error' | 'rejected' };
type Pending = { id: string; name: string; label: string }[];
/** An answer as it happened: what was said, and the tools run in between. */
type Part = { kind: 'text'; text: string } | { kind: 'tool'; id: string };
interface Conversation { messages: ChatMessage[]; marks: Record<string, Mark> }
const KEY = 'kmoesync.assistant';
const EMPTY: Conversation = { messages: [], marks: {} };

/** Questions to start with, for the page the user is on. */
function suggestionsFor(page: string): string[] {
  if (page.startsWith('/comics/')) return ['这部漫画还缺哪些卷？', '帮我订阅这部漫画', '这部漫画在书库里的文件都对得上吗？'];
  if (page.startsWith('/library')) return ['书库里还有哪些文件夹没匹配上？', '哪些文件夹还没同步到 Komga？', '诊断一下书库有没有问题'];
  if (page.startsWith('/downloads')) return ['最近有下载失败的吗？为什么？', '下载队列现在是什么状态？', '这个月的额度还够用吗？'];
  return ['诊断一下现在有没有问题', '这周有哪些漫画更新了？', '书库里还有哪些文件夹没匹配上？', '书架上哪些漫画还缺卷？'];
}

function load(): Conversation {
  try { const raw = sessionStorage.getItem(KEY); return raw ? { ...EMPTY, ...JSON.parse(raw) as Conversation } : EMPTY; } catch { return EMPTY; }
}
function save(value: Conversation) { try { sessionStorage.setItem(KEY, JSON.stringify(value)); } catch { /* not kept (private mode) */ } }

/** The conversation as turns: a question, then everything said and run to answer it. */
function turnsOf(messages: ChatMessage[]): { question: string; parts: Part[] }[] {
  const turns: { question: string; parts: Part[] }[] = [];
  for (const message of messages) {
    if (message.role === 'user') turns.push({ question: message.content ?? '', parts: [] });
    else if (message.role === 'assistant' && turns.length) {
      const { parts } = turns.at(-1)!;
      if (message.content) parts.push({ kind: 'text', text: message.content });
      for (const call of message.tool_calls ?? []) parts.push({ kind: 'tool', id: call.id });
    }
  }
  return turns;
}
const textOf = (parts: Part[]) => parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n\n');

function ToolMark({ mark }: { mark: Mark }) {
  const icon = mark.status === 'running' ? <LoaderCircle className="size-3 animate-spin" /> : mark.status === 'done' ? <Check className="size-3 text-success" />
    : mark.status === 'rejected' ? <CircleSlash className="size-3" /> : <TriangleAlert className="size-3 text-warning" />;
  return <li className={cn('flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground', mark.status === 'rejected' && 'line-through decoration-muted-foreground/50')}>
    {icon}<span className="truncate">{mark.label}{mark.status === 'running' && '…'}{mark.status === 'error' && '（出错）'}{mark.status === 'rejected' && '（已取消）'}</span>
  </li>;
}

/** What was said and run for one question, in order; tools in a row share one list. */
function Answer({ parts, marks, onNavigate }: { parts: Part[]; marks: Record<string, Mark>; onNavigate: () => void }) {
  const blocks: ({ kind: 'text'; text: string } | { kind: 'tools'; ids: string[] })[] = [];
  for (const part of parts) {
    const last = blocks.at(-1);
    if (part.kind === 'text') blocks.push(part);
    else if (last?.kind === 'tools') last.ids.push(part.id);
    else blocks.push({ kind: 'tools', ids: [part.id] });
  }
  return blocks.map((block, index) => block.kind === 'text'
    ? <Suspense key={index} fallback={<p className="text-[13px] leading-relaxed break-words whitespace-pre-wrap">{block.text}</p>}>
      <Markdown text={block.text} onNavigate={onNavigate} />
    </Suspense>
    : <ul key={index} aria-label="用到的工具" className="flex flex-col gap-1">{block.ids.flatMap(id => marks[id] ? [<ToolMark key={id} mark={marks[id]} />] : [])}</ul>);
}

function Thinking({ label }: { label?: string }) {
  return <span role="status" className="flex h-4 items-center gap-2 text-xs text-muted-foreground">
    <span aria-hidden className="flex gap-1">
      {[0, 1, 2].map(i => <span key={i} className="size-1 animate-pulse rounded-full bg-seal/70" style={{ animationDelay: `${i * 180}ms` }} />)}
    </span>
    {label ?? <span className="sr-only">正在回答</span>}
  </span>;
}

function Panel({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const { data: ai } = useQuery(aiSettingsQuery);
  const { ask, asked } = useAssistant();
  const page = useRouterState({ select: state => state.location.href });
  const [conversation, setConversation] = useState<Conversation>(load);
  const [live, setLive] = useState<Part[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = live !== null;

  const send = useCallback(async (base: ChatMessage[], decisions?: Record<string, boolean>) => {
    if (abort.current) return;
    const marks = { ...conversation.marks };
    // Calls already in the conversation (run after a confirmation) update their mark where it is.
    const known = new Set(base.flatMap(message => message.tool_calls?.map(call => call.id) ?? []));
    const parts: Part[] = [];
    setConversation({ messages: base, marks });
    setPending(null);
    setError(null);
    setLive([]);
    const controller = new AbortController();
    abort.current = controller;
    let final: ChatMessage[] | null = null;
    try {
      const response = await postStream('/api/ai/chat', { messages: base, decisions, page }, controller.signal);
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line) as ChatEvent;
          if (event.type === 'text') {
            const last = parts.at(-1);
            if (last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + event.text };
            else parts.push({ kind: 'text', text: event.text });
            setLive([...parts]);
          } else if (event.type === 'tool') {
            marks[event.id] = { label: event.label, status: event.status };
            setConversation(old => ({ ...old, marks: { ...marks } }));
            if (!known.has(event.id) && !parts.some(part => part.kind === 'tool' && part.id === event.id)) {
              parts.push({ kind: 'tool', id: event.id });
              setLive([...parts]);
            }
          } else if (event.type === 'confirm') setPending(event.calls);
          else if (event.type === 'messages') final = event.messages;
          else if (event.type === 'error') setError(event.message);
        }
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    }
    // Stopped half way: keep what was said, but not a turn the server never finished.
    const said = textOf(parts);
    const messages = final ?? (said ? [...base, { role: 'assistant' as const, content: `${said}（已停止）` }] : base);
    const next = { messages, marks };
    setConversation(next);
    save(next);
    setLive(null);
    abort.current = null;
    // Actions may have changed the queue, the shelf or the library.
    for (const queryKey of [['status'], ['shelf'], ['library'], ['tasks'], ['comic']]) void client.invalidateQueries({ queryKey });
  }, [conversation, client, page]);
  const question = (text: string) => void send([...conversation.messages, { role: 'user', content: text }]);

  // A question from a 「问问 AI」 button elsewhere.
  useEffect(() => {
    if (!ask || !ai?.ready || abort.current) return;
    asked();
    void send([...conversation.messages, { role: 'user', content: ask }]);
  }, [ask, ai?.ready, asked, send, conversation.messages]);
  useEffect(() => { input.current?.focus(); void loadMarkdown(); }, []);
  // Follow the answer while it streams, unless the user scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [conversation, live, pending, error]);

  // Closing stops the answer (not an unmount cleanup: StrictMode's trial unmount would cut the first question off).
  const close = () => { abort.current?.abort(); onClose(); };
  // On a phone the panel covers the page a link opens.
  const followLink = () => { if (window.matchMedia('(max-width: 767px)').matches) close(); };
  function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy || !ai?.ready) return;
    setDraft('');
    question(text);
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
  };
  const decide = (approve: boolean) => { if (pending) void send(conversation.messages, Object.fromEntries(pending.map(call => [call.id, approve]))); };
  // Ask the last question again (a failed or unhelpful answer).
  const retry = () => {
    const at = conversation.messages.findLastIndex(message => message.role === 'user');
    if (at >= 0) void send(conversation.messages.slice(0, at + 1));
  };
  const reset = () => { abort.current?.abort(); setConversation(EMPTY); save(EMPTY); setPending(null); setError(null); setLive(null); input.current?.focus(); };

  const turns = turnsOf(conversation.messages);
  return <aside role="dialog" aria-modal="false" aria-labelledby="assistant-title" onKeyDown={e => { if (e.key === 'Escape') close(); }}
    className="fixed inset-0 z-50 flex animate-rise flex-col bg-background md:inset-auto md:top-4 md:right-4 md:bottom-4 md:w-[440px] md:overflow-hidden md:rounded-2xl md:bg-card md:shadow-panel md:ring-1 md:ring-border">
    <header className="flex items-center gap-2 border-b px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
      <Sparkles aria-hidden className="size-4 text-seal" />
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 id="assistant-title" className="text-sm font-semibold">AI 助手</h2>
        {ai?.ready && <span className="truncate font-mono text-[11px] text-muted-foreground">{ai.model}</span>}
      </div>
      {conversation.messages.length > 0 && <Button variant="ghost" size="icon-sm" aria-label="新对话" title="新对话" onClick={reset}><SquarePen /></Button>}
      <Button variant="ghost" size="icon-sm" aria-label="关闭 AI 助手" onClick={close}><X /></Button>
    </header>

    <div ref={scroller} className="flex flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-4 py-4">
      {!ai ? null : !ai.ready ? <div className="m-auto flex max-w-72 flex-col items-center gap-3 text-center">
        <Sparkles aria-hidden className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">还没有设置 AI。填好接口地址、模型和 API Key 后，就可以在这里查询书库、订阅和下载。</p>
        <Button variant="outline" size="sm" asChild><Link to="/settings/$section" params={{ section: 'ai' }} onClick={close}>去设置 AI</Link></Button>
      </div> : !turns.length ? <div className="mt-auto flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">可以问书库、订阅和下载的事，也可以让它帮你订阅、补齐缺的卷；会改动东西的操作都会先问你。</p>
        <ul className="flex flex-col gap-1.5">
          {suggestionsFor(page).map(text => <li key={text}><button type="button" onClick={() => question(text)}
            className="w-full rounded-xl border px-3 py-2 text-left text-[13px] outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">{text}</button></li>)}
        </ul>
      </div> : turns.map((turn, index) => {
        const last = index === turns.length - 1, running = last && busy;
        const parts = running ? [...turn.parts, ...live] : turn.parts;
        const tail = parts.at(-1), text = textOf(parts);
        return <section key={index} aria-label={turn.question} className="flex flex-col gap-3">
          <p className="ml-8 self-end rounded-2xl rounded-br-md bg-seal-soft px-3.5 py-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap">{turn.question}</p>
          <Answer parts={parts} marks={conversation.marks} onNavigate={followLink} />
          {running && !(tail?.kind === 'tool' && conversation.marks[tail.id]?.status === 'running') && <Thinking label={tail?.kind === 'text' ? undefined : '思考中'} />}
          {!running && text && <div className="-mt-1.5 -ml-1.5 flex items-center">
            <CopyButton text={text} label="复制回答" size="icon-xs" />
            {last && !pending && !error && <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="重新回答" title="重新回答" onClick={retry}><RotateCcw /></Button>}
          </div>}
        </section>;
      })}
      {pending && !busy && <div role="group" aria-label="需要确认的操作" className="-mt-3 flex flex-col gap-3 rounded-xl border border-seal/30 bg-seal-soft/60 p-3">
        <span className="text-xs font-medium">要执行这些操作吗？</span>
        <ul className="flex flex-col gap-1 text-[13px]">{pending.map(call => <li key={call.id} className="flex items-center gap-2"><span aria-hidden className="size-1.5 shrink-0 rounded-full bg-seal" />{call.label}</li>)}</ul>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => decide(true)}>确认执行</Button>
          <Button size="sm" variant="ghost" onClick={() => decide(false)}>取消</Button>
        </div>
      </div>}
      {error && !busy && <div role="alert" className="-mt-3 flex items-start gap-1.5 text-xs text-warning">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words">{error}</span>
        <Button variant="outline" size="xs" className="-my-0.5 shrink-0" onClick={retry}><RotateCcw data-icon="inline-start" />重试</Button>
      </div>}
    </div>

    <form onSubmit={submit} className="flex items-end gap-2 border-t px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <Textarea ref={input} rows={1} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown} disabled={!ai?.ready}
        placeholder={pending ? '或者直接说别的…' : '问点什么，例如「这周有什么更新」'} aria-label="发给 AI 助手"
        className="max-h-36 min-h-9 flex-1 resize-none field-sizing-content md:text-[13px]" />
      {busy ? <Button type="button" size="icon" variant="outline" aria-label="停止" onClick={() => abort.current?.abort()}><Square className="size-3.5" /></Button>
        : <Button type="submit" size="icon" aria-label="发送" aria-disabled={!draft.trim() || !ai?.ready}><ArrowUp /></Button>}
    </form>
  </aside>;
}

/** The floating button (bottom right, above the phone tab bar; not on full-screen pages) and the panel it opens. */
export function Assistant({ hideButton = false }: { hideButton?: boolean }) {
  const { open, show, hide } = useAssistant();
  if (open) return <Panel onClose={hide} />;
  if (hideButton) return null;
  // Phones: a 48px circle 16px above the tab bar. Wider screens: a pill with its name, less padding on the icon side.
  return <Button variant="outline" onClick={() => show()} aria-label="打开 AI 助手"
    className="fixed right-4 bottom-[calc(76px+env(safe-area-inset-bottom))] z-40 size-12 rounded-full bg-card p-0 shadow-float md:right-6 md:bottom-6 md:h-10 md:w-auto md:pr-3.5 md:pl-3">
    <Sparkles className="size-5 text-seal md:size-4" /><span className="max-md:sr-only">AI 助手</span>
  </Button>;
}
