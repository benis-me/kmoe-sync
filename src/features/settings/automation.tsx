// 下载与更新: check interval, concurrency, automatic retries, quota reserve, and defaults. Every control saves at once.
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useLocation } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Minus, Plus } from 'lucide-react';
import { cn } from 'cn';
import type { Format, Line, Settings } from '@shared/model';
import { formatMB } from '@/lib/format';
import { settingsQuery, statusQuery, targetsQuery } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ErrorState } from '@/components/app/feedback';
import { SaveHint, SectionSkeleton, SettingRow, usePatchSettings } from './common';

const INTERVALS = [[1, '每小时'], [3, '每 3 小时'], [6, '每 6 小时'], [12, '每 12 小时'], [24, '每天'], [48, '每 2 天'], [72, '每 3 天'], [168, '每周']] as const;
const RETRIES = { min: 1, max: 10 };

/** WAI-ARIA spinbutton: arrows step, Home/End jump; the −/+ buttons are for the pointer. */
function RetryStepper({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (value: number) => void }) {
  const set = (next: number) => { const clamped = Math.min(RETRIES.max, Math.max(RETRIES.min, next)); if (clamped !== value) onChange(clamped); };
  function onKeyDown(e: KeyboardEvent) {
    if (disabled) return;
    const delta = ({ ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 } as Record<string, number>)[e.key];
    if (delta) set(value + delta);
    else if (e.key === 'Home') set(RETRIES.min);
    else if (e.key === 'End') set(RETRIES.max);
    else return;
    e.preventDefault();
  }
  return <div className="flex items-center gap-1.5">
    <Button type="button" variant="outline" size="icon-sm" tabIndex={-1} aria-label="少重试一次" disabled={disabled || value <= RETRIES.min} onClick={() => set(value - 1)}><Minus /></Button>
    <span role="spinbutton" tabIndex={disabled ? -1 : 0} aria-labelledby="retry-label" aria-disabled={disabled}
      aria-valuemin={RETRIES.min} aria-valuemax={RETRIES.max} aria-valuenow={value} aria-valuetext={`${value} 次`} onKeyDown={onKeyDown}
      className="grid h-8 min-w-12 place-items-center rounded-lg px-2 text-sm font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span key={value} className="animate-tick">{value} 次</span>
    </span>
    <Button type="button" variant="outline" size="icon-sm" tabIndex={-1} aria-label="多重试一次" disabled={disabled || value >= RETRIES.max} onClick={() => set(value + 1)}><Plus /></Button>
  </div>;
}

/** Typed, so it saves on blur or Enter rather than on every keystroke. */
function ReserveInput({ value, onSave }: { value: number; onSave: (mb: number) => void }) {
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) { setShown(value); setText(String(value)); }
  const parsed = Number(text);
  const invalid = text.trim() === '' || !Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000;
  const commit = () => { if (invalid) setText(String(value)); else if (Math.round(parsed) !== value) onSave(Math.round(parsed)); };
  return <InputGroup className="w-36">
    <InputGroupInput id="reserve" inputMode="numeric" className="text-right tabular-nums" value={text} aria-invalid={invalid} aria-describedby="reserve-hint"
      onChange={e => setText(e.target.value.replace(/[^\d]/g, ''))} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
    <InputGroupAddon align="inline-end" className="pr-3 text-xs">MB</InputGroupAddon>
  </InputGroup>;
}

export function AutomationSection() {
  const settings = useQuery(settingsQuery);
  const targets = useQuery(targetsQuery);
  const { data: status } = useQuery(statusQuery);
  const patch = usePatchSettings();
  const { hash } = useLocation();
  const ready = !!settings.data && !!targets.data;
  // Arriving from "调整保留额度": go straight to the field.
  useEffect(() => { if (ready && hash === 'reserve') document.getElementById('reserve')?.focus(); }, [ready, hash]);
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  if (!settings.data || !targets.data) return <SectionSkeleton />;
  const s = settings.data;
  const save = (next: Partial<Settings>) => patch.mutate(next);
  const remaining = status?.kmoe.state === 'active' ? status.kmoe.remainingMB : null;

  return <>
    <div className="-mt-3 flex justify-end"><SaveHint pending={patch.isPending} saved={patch.isSuccess} /></div>
    <Card className="gap-0 divide-y py-0">
      <SettingRow label="检查更新" htmlFor="check-interval">
        <Select value={String(s.checkIntervalHours)} onValueChange={value => save({ checkIntervalHours: Number(value) })}>
          <SelectTrigger id="check-interval" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent position="popper"><SelectGroup>{INTERVALS.map(([hours, label]) => <SelectItem key={hours} value={String(hours)}>{label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label="同时下载" labelId="concurrency-label">
        <ToggleGroup type="single" variant="segmented" aria-labelledby="concurrency-label" value={String(s.concurrency)} onValueChange={value => value && save({ concurrency: Number(value) })}>
          {[1, 2, 3, 4].map(n => <ToggleGroupItem key={n} value={String(n)} className="w-10 tabular-nums">{n}</ToggleGroupItem>)}
        </ToggleGroup>
      </SettingRow>
      <SettingRow label="失败自动重试" htmlFor="auto-retry" description="登录、额度、同名文件等错误不会重试。">
        <Switch id="auto-retry" checked={s.autoRetry} onCheckedChange={autoRetry => save({ autoRetry })} />
      </SettingRow>
      <SettingRow label="最多重试" labelId="retry-label" className={cn('transition-opacity duration-200', !s.autoRetry && 'opacity-50')}>
        <RetryStepper value={s.maxRetries} disabled={!s.autoRetry} onChange={maxRetries => save({ maxRetries })} />
      </SettingRow>
      <SettingRow label="保留额度" htmlFor="reserve" description={<span id="reserve-hint">剩余额度低于这个值时暂停队列{remaining !== null && `，当前剩余 ${formatMB(remaining)}`}。</span>}>
        <ReserveInput value={s.quotaReserveMB} onSave={quotaReserveMB => save({ quotaReserveMB })} />
      </SettingRow>
    </Card>

    <Card className="gap-0 divide-y py-0">
      <div className="px-5 pt-4 pb-3">
        <h3 className="text-[15px] font-semibold tracking-tight">默认值</h3>
      </div>
      <SettingRow label="格式" labelId="default-format-label">
        <ToggleGroup type="single" variant="segmented" aria-labelledby="default-format-label" value={s.defaultFormat} onValueChange={value => value && save({ defaultFormat: value as Format })}>
          <ToggleGroupItem value="epub" className="px-3.5">EPUB</ToggleGroupItem>
          <ToggleGroupItem value="mobi" className="px-3.5">MOBI</ToggleGroupItem>
        </ToggleGroup>
      </SettingRow>
      <SettingRow label="线路" labelId="default-line-label" description={status?.kmoe.vip ? undefined : '线路二仅 Kmoe VIP 可用。'}>
        <ToggleGroup type="single" variant="segmented" aria-labelledby="default-line-label" value={String(s.defaultLine)} onValueChange={value => value && save({ defaultLine: Number(value) as Line })}>
          <ToggleGroupItem value="0" className="px-3.5">线路一</ToggleGroupItem>
          <ToggleGroupItem value="1" className="px-3.5" disabled={!status?.kmoe.vip && s.defaultLine !== 1}>线路二</ToggleGroupItem>
        </ToggleGroup>
      </SettingRow>
      <SettingRow label="存储位置" htmlFor="default-target">
        <Select value={s.defaultTargetId !== null ? String(s.defaultTargetId) : ''} onValueChange={value => save({ defaultTargetId: Number(value) })}>
          <SelectTrigger id="default-target" className="w-44"><SelectValue placeholder="选择存储位置" /></SelectTrigger>
          <SelectContent position="popper"><SelectGroup>{targets.data.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </SettingRow>
    </Card>
  </>;
}
