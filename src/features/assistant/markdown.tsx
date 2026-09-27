// The assistant's answers as Markdown: GFM lists, tables, code and links; raw HTML is never rendered. Links to app pages
// stay in the app, others open in a new tab; only the app's own images show. Loaded with the panel (see vite.config.ts).
import type { MouseEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import remarkGfm from 'remark-gfm';

const inApp = (href: string) => href.startsWith('/') && !href.startsWith('//');
// CJK-friendly emphasis: "**结论。**后文" is bold (plain CommonMark leaves the asterisks there).
const plugins = [remarkGfm, remarkCjkFriendly];
const LIST = 'flex flex-col gap-1 pl-5 marker:text-muted-foreground';

const components: Components = {
  h1: ({ children }) => <h3 className="mt-1 text-[14px] font-semibold tracking-tight">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-1 text-[14px] font-semibold tracking-tight">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-1 font-semibold">{children}</h4>,
  h4: ({ children }) => <h4 className="mt-1 font-semibold">{children}</h4>,
  h5: ({ children }) => <h4 className="mt-1 font-semibold">{children}</h4>,
  h6: ({ children }) => <h4 className="mt-1 font-semibold">{children}</h4>,
  ul: ({ children }) => <ul className={`list-disc ${LIST}`}>{children}</ul>,
  ol: ({ start, children }) => <ol start={start} className={`list-decimal ${LIST}`}>{children}</ol>,
  li: ({ children }) => <li className="pl-0.5 [&>ol]:mt-1 [&>p+p]:mt-1.5 [&>ul]:mt-1">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  blockquote: ({ children }) => <blockquote className="flex flex-col gap-2 border-l-2 border-seal/40 pl-3 text-muted-foreground">{children}</blockquote>,
  hr: () => <hr className="my-1 border-border" />,
  a: ({ href = '', children }) => href
    ? <a href={href} className="font-medium text-seal underline decoration-seal/30 underline-offset-2 transition-colors duration-150 hover:decoration-seal"
      {...(inApp(href) ? {} : { target: '_blank', rel: 'noreferrer' })}>{children}</a>
    : <span>{children}</span>,
  img: ({ src, alt }) => typeof src === 'string' && inApp(src) ? <img src={src} alt={alt ?? ''} loading="lazy" className="max-h-48 rounded-md" /> : null,
  pre: ({ children }) => <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-[12px] leading-normal [&_code]:bg-transparent [&_code]:p-0">{children}</pre>,
  code: ({ children }) => <code className="rounded-[4px] bg-muted px-1 py-px font-mono text-[12px]">{children}</code>,
  table: ({ children }) => <div className="overflow-x-auto rounded-lg ring-1 ring-border"><table className="w-full border-collapse text-[12px]">{children}</table></div>,
  th: ({ style, children }) => <th style={style} className="bg-muted/50 px-2.5 py-1.5 text-left font-medium whitespace-nowrap">{children}</th>,
  td: ({ style, children }) => <td style={style} className="border-t px-2.5 py-1.5 align-top">{children}</td>,
};

export default function Markdown({ text, onNavigate }: { text: string; onNavigate?: () => void }) {
  const navigate = useNavigate();
  // App links navigate in place (a modified click still opens a new tab).
  function click(e: MouseEvent<HTMLDivElement>) {
    const href = (e.target as Element).closest('a')?.getAttribute('href') ?? '';
    if (!inApp(href) || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void navigate({ href });
    onNavigate?.();
  }
  return <div className="flex min-w-0 flex-col gap-2 text-[13px] leading-relaxed break-words" onClick={click}>
    <ReactMarkdown remarkPlugins={plugins} components={components}>{text}</ReactMarkdown>
  </div>;
}
