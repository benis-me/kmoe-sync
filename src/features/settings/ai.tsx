// AI: an OpenAI-compatible endpoint (DeepSeek, OpenRouter, or any other), its key and model, whether it goes through the
// network proxy, and a monthly token budget. Tested before saving; used by 匹配判定, 元数据整理 and the assistant.
import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LoaderCircle } from 'lucide-react';
import type { AiProvider, AiSettings, AiSettingsPatch, AiTestResult } from '@shared/model';
import { errorMessage, request } from '@/lib/api';
import { aiSettingsQuery, settingsQuery } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ErrorState } from '@/components/app/feedback';
import { FieldMessage, PasswordInput } from '@/components/app/fields';
import { Dot } from '@/components/app/status';
import { SectionSkeleton, SettingRow } from './common';

const PRESETS: Record<AiProvider, { label: string; baseUrl?: string; useProxy?: boolean; model: string; hint: string }> = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', useProxy: false, model: 'deepseek-flash', hint: '国内可以直连。在 platform.deepseek.com 创建 API Key。' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', useProxy: true, model: 'deepseek/deepseek-v4-flash', hint: '可选很多家的模型；在国外，需要走网络代理。' },
  custom: { label: '自定义', model: '', hint: '任何 OpenAI 兼容的接口，例如自建的 Ollama、LM Studio，或其他云服务。' },
};
const formatTokens = (n: number) => n >= 10_000 ? `${(n / 10_000).toFixed(1).replace(/\.0$/, '')} 万` : n.toLocaleString('zh-CN');

function AiForm({ ai, proxy }: { ai: AiSettings; proxy: string }) {
  const client = useQueryClient();
  const initial = { provider: ai.provider, baseUrl: ai.baseUrl, model: ai.model, useProxy: ai.useProxy, monthlyTokens: String(ai.monthlyTokens || ''), apiKey: '' };
  const initialKey = JSON.stringify(initial);
  const [draft, setDraft] = useState(initial);
  const [base, setBase] = useState(initialKey);
  if (base !== initialKey) { setBase(initialKey); setDraft(initial); }
  const [error, setError] = useState<Partial<Record<'baseUrl' | 'monthlyTokens', string>>>({});
  const [tested, setTested] = useState<{ key: string; result: AiTestResult } | null>(null);
  const dirty = JSON.stringify(draft) !== initialKey;
  const set = <K extends keyof typeof initial>(field: K, value: (typeof initial)[K]) => {
    setDraft(old => ({ ...old, [field]: value }));
    if (field === 'baseUrl' || field === 'monthlyTokens') setError(old => ({ ...old, [field]: undefined }));
  };
  const choose = (provider: AiProvider) => {
    const preset = PRESETS[provider];
    // A preset's model follows the preset; one the user typed stays.
    setDraft(old => ({ ...old, provider, baseUrl: preset.baseUrl ?? old.baseUrl, useProxy: preset.useProxy ?? old.useProxy,
      model: !old.model || old.model === PRESETS[old.provider].model ? preset.model : old.model }));
  };
  const patch = (): AiSettingsPatch | null => {
    const next: typeof error = {};
    const baseUrl = draft.baseUrl.trim(), limit = draft.monthlyTokens.trim();
    if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) next.baseUrl = '接口地址需要以 http:// 或 https:// 开头';
    if (limit && !/^\d+$/.test(limit)) next.monthlyTokens = '请填写整数，留空表示不限';
    setError(next);
    const first = (['baseUrl', 'monthlyTokens'] as const).find(field => next[field]);
    if (first) { document.getElementById(`ai-${first}`)?.focus(); return null; }
    return { provider: draft.provider, baseUrl, model: draft.model.trim(), useProxy: draft.useProxy, monthlyTokens: limit ? Number(limit) : 0, ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}) };
  };
  const testKey = JSON.stringify({ ...draft, monthlyTokens: undefined });

  const test = useMutation({
    mutationFn: (body: AiSettingsPatch) => request('POST /api/ai/test', { body }),
    onSuccess: result => setTested({ key: testKey, result }),
    onError: failure => setTested({ key: testKey, result: { ok: false, message: errorMessage(failure), models: [], json: null } }),
  });
  const save = useMutation({
    mutationFn: (body: AiSettingsPatch) => request('PATCH /api/ai/settings', { body }),
    onSuccess: next => { client.setQueryData(aiSettingsQuery.queryKey, next); toast.success(next.ready ? '已保存，AI 功能可以用了' : '已保存'); },
    onError: failure => toast.error(errorMessage(failure)),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const body = patch();
    if (dirty && body && !save.isPending) save.mutate(body);
  }
  const result = tested?.key === testKey ? tested.result : null;
  const preset = PRESETS[draft.provider];

  return <form noValidate onSubmit={submit} aria-labelledby="ai-title" className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-border">
    <div className="flex flex-col gap-5 p-5 sm:p-6">
      <div className="flex flex-col gap-2">
        <h3 id="ai-title" className="text-[15px] font-semibold tracking-tight">AI 服务</h3>
        <div className="-mx-1 overflow-x-auto px-1 py-1 no-scrollbar">
          <ToggleGroup type="single" variant="segmented" aria-label="服务商" value={draft.provider} onValueChange={value => value && choose(value as AiProvider)}>
            {(Object.keys(PRESETS) as AiProvider[]).map(provider => <ToggleGroupItem key={provider} value={provider} className="px-3">{PRESETS[provider].label}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{preset.hint}</p>
      </div>
      <div className="grid gap-5">
        <Field className="gap-2">
          <FieldLabel htmlFor="ai-baseUrl">接口地址</FieldLabel>
          <Input id="ai-baseUrl" inputMode="url" className="font-mono md:text-[13px]" placeholder="https://api.deepseek.com" autoCapitalize="none" spellCheck={false}
            value={draft.baseUrl} onChange={e => set('baseUrl', e.target.value)} aria-invalid={!!error.baseUrl} aria-describedby={error.baseUrl ? 'ai-baseUrl-error' : undefined} />
          {error.baseUrl && <FieldMessage id="ai-baseUrl-error">{error.baseUrl}</FieldMessage>}
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor="ai-model">模型</FieldLabel>
          <Input id="ai-model" list="ai-models" className="font-mono md:text-[13px]" placeholder={preset.model || '模型名'} autoCapitalize="none" spellCheck={false}
            value={draft.model} onChange={e => set('model', e.target.value)} aria-describedby="ai-model-hint" />
          <datalist id="ai-models">{result?.models.map(model => <option key={model} value={model} />)}</datalist>
          <p id="ai-model-hint" className="text-xs text-muted-foreground">{result?.models.length ? `可以从 ${result.models.length} 个模型里选` : '点「测试」可以列出这个接口提供的模型。'}</p>
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor="ai-key">API Key</FieldLabel>
          <PasswordInput id="ai-key" autoComplete="off" className="font-mono" placeholder={ai.hasKey ? '已保存，留空则不修改' : 'sk-…'}
            value={draft.apiKey} onChange={e => set('apiKey', e.target.value)} aria-describedby="ai-key-hint" />
          <p id="ai-key-hint" className="text-xs text-muted-foreground">加密保存在 NAS 上，不会再显示出来。</p>
        </Field>
      </div>
    </div>
    <SettingRow label="走网络代理" htmlFor="ai-proxy" className="border-t sm:px-6"
      description={proxy ? <>通过 <span className="font-mono">{proxy}</span> 访问 AI 服务。国外的服务需要打开。</> : <>还没有设置代理，可以在<Link to="/settings/$section" params={{ section: 'network' }} className="mx-0.5 text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">网络代理</Link>里填写。</>}>
      <Switch id="ai-proxy" checked={draft.useProxy} onCheckedChange={useProxy => set('useProxy', useProxy)} />
    </SettingRow>
    <SettingRow label="每月上限" htmlFor="ai-monthlyTokens" className="border-t sm:px-6"
      description={<span id="ai-limit-hint">本月已用 {formatTokens(ai.usage.tokens)} token。到上限后 AI 功能暂停到下个月，留空表示不限。{error.monthlyTokens && <span className="text-destructive"> {error.monthlyTokens}</span>}</span>}>
      <Input id="ai-monthlyTokens" inputMode="numeric" className="w-36 text-right tabular-nums" placeholder="不限" aria-describedby="ai-limit-hint" aria-invalid={!!error.monthlyTokens}
        value={draft.monthlyTokens} onChange={e => set('monthlyTokens', e.target.value.replace(/[^\d]/g, ''))} />
    </SettingRow>
    {result && <div role="status" className="flex items-start gap-2 border-t px-5 py-3.5 text-xs sm:px-6">
      <Dot tone={result.ok ? 'success' : 'warning'} className="mt-1.5 size-1.5 shrink-0" />
      <span className={result.ok ? 'text-foreground/80' : 'break-words text-warning'}>{result.message}</span>
    </div>}
    <div className="flex flex-wrap items-center gap-2 border-t bg-muted/35 px-5 py-3.5 sm:px-6">
      <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        {dirty ? <><span aria-hidden className="size-1.5 rounded-full bg-warning" />有未保存的更改</> : ai.ready ? <><Dot tone="success" className="size-1.5" />已可以使用</> : '填好地址、模型和 Key 后保存'}
      </span>
      <Button type="button" variant="outline" aria-disabled={test.isPending} onClick={() => { const body = patch(); if (body && !test.isPending) test.mutate(body); }}>
        {test.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}测试
      </Button>
      <Button type="submit" aria-disabled={!dirty || save.isPending}>{save.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}保存</Button>
    </div>
  </form>;
}

export function AiSection() {
  const ai = useQuery(aiSettingsQuery);
  const { data: proxy = '' } = useQuery({ ...settingsQuery, select: settings => settings.proxy });
  if (ai.error) return <ErrorState error={ai.error} onRetry={() => void ai.refetch()} />;
  if (!ai.data) return <SectionSkeleton />;
  return <>
    <AiForm ai={ai.data} proxy={proxy} />
    <div className="flex flex-col gap-2 px-1 text-xs leading-relaxed text-muted-foreground">
      <p>用在三个地方：书库的「AI 判定」（从候选里挑出对的漫画和 Bangumi 条目）、「AI 整理」（把简介和标签整理好再写入 Komga，写入前你可以逐个确认），以及右下角的 AI 助手（查询、订阅、下载，改动前都会问你）。</p>
      <p>只会发送书名、文件名、简介和候选信息；Kmoe 登录信息、密码和各种密钥不会发出去。</p>
      <p>DeepSeek 和 OpenRouter 会关掉模型的「思考」：这些任务用不上，关掉更快也更省 token。</p>
    </div>
  </>;
}
