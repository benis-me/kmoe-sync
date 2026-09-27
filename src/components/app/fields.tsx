import { useState, type ComponentProps } from 'react';
import { toast } from 'sonner';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';

/** Password field with a show/hide toggle. */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  const [reveal, setReveal] = useState(false);
  return <InputGroup className={className}>
    <InputGroupInput type={reveal ? 'text' : 'password'} spellCheck={false} autoCapitalize="none" {...props} />
    <InputGroupAddon align="inline-end">
      <InputGroupButton size="icon-xs" aria-label={reveal ? '隐藏密码' : '显示密码'} aria-pressed={reveal} onClick={() => setReveal(value => !value)}>
        {reveal ? <EyeOff /> : <Eye />}
      </InputGroupButton>
    </InputGroupAddon>
  </InputGroup>;
}

/** Inline error under a field; referenced by the field's aria-describedby. */
export function FieldMessage({ id, children }: { id: string; children?: string }) {
  if (!children) return null;
  return <p id={id} role="alert" className="animate-rise text-xs text-destructive">{children}</p>;
}

/** Clipboard API where available; a NAS served over plain http has none, so fall back to a selection copy. */
async function copyText(text: string) {
  if (navigator.clipboard && isSecureContext) return navigator.clipboard.writeText(text);
  const area = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
  area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('复制失败，请手动选择文本复制');
}

export function CopyButton({ text, label, size = 'icon-sm' }: { text: string; label: string; size?: 'icon-xs' | 'icon-sm' }) {
  const [done, setDone] = useState(false);
  return <Button type="button" variant="ghost" size={size} className="shrink-0 text-muted-foreground" aria-label={done ? '已复制' : label} title={done ? '已复制' : label}
    onClick={() => copyText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, error => void toast.error((error as Error).message))}>
    {done ? <Check className="animate-pop text-success" /> : <Copy />}
  </Button>;
}
