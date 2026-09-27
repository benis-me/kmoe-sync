// Naming rule field: token chips insert at the caret, presets, and a live path preview (same rules as the extension).
import { Fragment, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, FileText, Folder } from 'lucide-react';
import { cn } from 'cn';
import { DEFAULT_RULE, RULE_SAMPLE, renderRule } from '@shared/naming';
import { errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const TOKEN_GROUPS = [
  { label: '书籍', tokens: [['{title}', '标题'], ['{author}', '全部作者'], ['{author$0}', '首位作者'], ['{bookname}', '卷 / 话名']] },
  { label: '文件', tokens: [['{filename}', '原文件名'], ['{ext}', '扩展名']] },
  { label: '日期', tokens: [['{year}', '年'], ['{month}', '月'], ['{day}', '日'], ['{hour}', '时'], ['{min}', '分']] },
] as const;
const PRESETS = [['默认', DEFAULT_RULE], ['按作者', '{author$0}/{title}/{bookname}'], ['按月份', '{year}-{month}/{title}/{filename}']] as const;

function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return <div role="group" aria-label={label} className="grid gap-2 sm:grid-cols-[40px_minmax(0,1fr)] sm:items-start">
    <span aria-hidden className="text-xs leading-7 text-muted-foreground">{label}</span>
    <div className="flex flex-wrap gap-1.5">{children}</div>
  </div>;
}

/** `base` is where the path starts (e.g. /library/Kindle or nas.local/Comics), shown as the preview's first crumb. */
export function RuleEditor({ id, value, onChange, base }: { id: string; value: string; onChange: (rule: string) => void; base: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [lastPreview, setLastPreview] = useState('');
  let preview = '', error = '';
  try { preview = renderRule(value, RULE_SAMPLE); } catch (e) { error = errorMessage(e); }
  if (preview && preview !== lastPreview) setLastPreview(preview); // keep the last valid preview while the rule is broken
  const segments = (preview || lastPreview).split('/').filter(Boolean);

  /** Insert at the caret and keep typing where the token ended. */
  function insert(token: string) {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setRangeText(token, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, 'end');
    onChange(el.value);
  }

  return <div className="flex flex-col gap-4">
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">命名规则</label>
      <Input ref={input} id={id} className="font-mono md:text-[13px]" spellCheck={false} autoCapitalize="none" autoComplete="off" placeholder={DEFAULT_RULE}
        aria-invalid={!!error} aria-describedby={`${id}-hint`} value={value} onChange={e => onChange(e.target.value)} />
      <p id={`${id}-hint`} className={cn('flex items-center gap-1.5 text-xs', error ? 'animate-rise text-destructive' : 'text-muted-foreground')}>
        {error ? <><CircleAlert className="size-3.5 shrink-0" />{error}</> : '用 / 分隔文件夹；没有 {ext} 时会自动补上扩展名。和浏览器扩展的规则通用。'}
      </p>
    </div>
    <div className="flex flex-col gap-2.5">
      <ChipRow label="常用">
        {PRESETS.map(([label, template]) => <Button key={label} type="button" variant="outline" size="xs" title={template} aria-pressed={value === template}
          className="aria-pressed:border-seal/35 aria-pressed:bg-seal-soft aria-pressed:text-seal" onClick={() => onChange(template)}>{label}</Button>)}
      </ChipRow>
      {TOKEN_GROUPS.map(group => <ChipRow key={group.label} label={group.label}>
        {group.tokens.map(([token, description]) => <Button key={token} type="button" variant="outline" size="xs" aria-label={`插入 ${token}（${description}）`}
          onMouseDown={e => e.preventDefault()} onClick={() => insert(token)}>
          <span className="font-mono">{token}</span><span className="font-normal text-muted-foreground">{description}</span>
        </Button>)}
      </ChipRow>)}
    </div>
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">预览</span>
        <span className="text-xs text-muted-foreground">以《{RULE_SAMPLE.title}》{RULE_SAMPLE.bookname} 为例</span>
      </div>
      <div role="group" aria-label="路径预览" className={cn('flex min-h-12 flex-wrap items-center gap-1 rounded-xl border border-dashed bg-muted/35 px-3 py-2.5 font-mono text-xs transition-opacity duration-150', error && 'opacity-45')}>
        <span className="max-w-full truncate px-1 text-muted-foreground" title={base}>{base}</span>
        {segments.map((segment, i) => <Fragment key={i}>
          <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-card px-2 py-1 shadow-soft ring-1 ring-border">
            {i === segments.length - 1 ? <FileText className="size-3.5 shrink-0 text-muted-foreground" /> : <Folder className="size-3.5 shrink-0 text-muted-foreground" />}
            <span className="break-all">{segment}</span>
          </span>
        </Fragment>)}
      </div>
    </div>
  </div>;
}
