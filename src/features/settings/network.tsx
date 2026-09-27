// 网络代理: one HTTP proxy for every connection that leaves the LAN (a NAS container does not get the NAS's own proxy
// setting). Kmoe goes direct unless switched on; LAN addresses always do. Saved with the card's button, tested before.
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LoaderCircle } from 'lucide-react';
import type { NetworkCheck, Settings } from '@shared/model';
import { errorMessage, request } from '@/lib/api';
import { metadataSettingsQuery, settingsQuery } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ErrorState } from '@/components/app/feedback';
import { FieldMessage } from '@/components/app/fields';
import { Dot } from '@/components/app/status';
import { SectionSkeleton, SettingRow, usePatchSettings } from './common';

/** host:port with an optional http(s):// — the server has the last word (no SOCKS, no credentials, no path). */
const PROXY = /^(https?:\/\/)?[^\s/@]+\/?$/i;

function ProxyForm({ settings }: { settings: Settings }) {
  const client = useQueryClient();
  const patch = usePatchSettings();
  const initial = { proxy: settings.proxy, proxyKmoe: settings.proxyKmoe };
  const initialKey = JSON.stringify(initial);
  const [draft, setDraft] = useState(initial);
  const [base, setBase] = useState(initialKey);
  if (base !== initialKey) { setBase(initialKey); setDraft(initial); }
  const [error, setError] = useState('');
  const [checks, setChecks] = useState<{ key: string; results: NetworkCheck[] } | null>(null);
  const dirty = JSON.stringify(draft) !== initialKey;
  const proxy = draft.proxy.trim();
  const key = JSON.stringify({ proxy, kmoe: draft.proxyKmoe });

  const test = useMutation({
    mutationFn: () => request('POST /api/network/test', { body: { proxy, kmoe: draft.proxyKmoe } }),
    onSuccess: results => { setChecks({ key, results }); void client.invalidateQueries({ queryKey: metadataSettingsQuery.queryKey }); },
    onError: failure => setError(errorMessage(failure)),
  });
  const valid = () => {
    if (!proxy || (PROXY.test(proxy) && !/^socks/i.test(proxy))) return true;
    setError('代理地址填写 http:// 加主机和端口，例如 http://192.168.1.2:7890');
    document.getElementById('proxy')?.focus();
    return false;
  };
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty || patch.isPending || !valid()) return;
    patch.mutate({ proxy, proxyKmoe: draft.proxyKmoe }, {
      onSuccess: () => {
        toast.success(proxy ? '已保存代理' : '已改为直连');
        void client.invalidateQueries({ queryKey: metadataSettingsQuery.queryKey });
      },
    });
  }
  const shown = checks?.key === key ? checks.results : null;
  const via = ['Bangumi 在线查询与书单', '离线数据下载（GitHub）', '通知推送', ...(draft.proxyKmoe ? ['Kmoe'] : [])];

  return <form noValidate onSubmit={submit} aria-labelledby="proxy-title" className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-border">
    <div className="flex flex-col gap-4 p-5 sm:p-6">
      <h3 id="proxy-title" className="sr-only">代理</h3>
      <Field className="gap-2">
        <FieldLabel htmlFor="proxy">代理地址</FieldLabel>
        <Input id="proxy" inputMode="url" className="font-mono md:text-[13px]" placeholder="http://192.168.1.2:7890" autoCapitalize="none" spellCheck={false}
          value={draft.proxy} aria-invalid={!!error} aria-describedby={error ? 'proxy-error' : 'proxy-hint'}
          onChange={e => { setDraft(old => ({ ...old, proxy: e.target.value })); setError(''); }} />
        {error ? <FieldMessage id="proxy-error">{error}</FieldMessage>
          : <p id="proxy-hint" className="text-xs leading-relaxed text-muted-foreground">
            HTTP 代理（Clash、Surge 等的 HTTP 端口），留空表示直连。填 NAS 或电脑的局域网地址——容器里的 127.0.0.1 指的是容器自己。群晖等系统设置里的代理不会传给 Docker 容器，需要在这里填写。
          </p>}
      </Field>
    </div>
    <SettingRow label="Kmoe 也走代理" htmlFor="proxy-kmoe" className="border-t sm:px-6"
      description="一般直连即可。打开后 Kmoe 的页面和下载都经过代理，会占用代理的流量。">
      <Switch id="proxy-kmoe" checked={draft.proxyKmoe} onCheckedChange={proxyKmoe => setDraft(old => ({ ...old, proxyKmoe }))} />
    </SettingRow>
    <div className="flex flex-col gap-3 border-t px-5 py-4 sm:px-6">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {proxy ? `经过代理：${via.join('、')}。` : '现在所有连接都是直连。'}局域网地址（Komga、局域网里的 Webhook）始终直连。
      </p>
      {shown && <ul role="status" aria-label="测试结果" className="flex flex-col gap-1.5 text-xs">
        {shown.map(check => <li key={check.name} className="flex min-w-0 items-start gap-2">
          <Dot tone={check.ok ? 'success' : 'warning'} className="mt-1.5 size-1.5 shrink-0" />
          <span className="shrink-0 font-medium text-foreground/90">{check.name}</span>
          <span className={check.ok ? 'text-muted-foreground' : 'break-words text-warning'}>{check.message}</span>
        </li>)}
      </ul>}
    </div>
    <div className="flex flex-wrap items-center gap-2 border-t bg-muted/35 px-5 py-3.5 sm:px-6">
      <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">{dirty && <><span aria-hidden className="size-1.5 rounded-full bg-warning" />有未保存的更改</>}</span>
      <Button type="button" variant="outline" aria-disabled={test.isPending} onClick={() => { if (!test.isPending && valid()) test.mutate(); }}>
        {test.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}测试连接
      </Button>
      <Button type="submit" aria-disabled={!dirty || patch.isPending}>{patch.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}保存</Button>
    </div>
  </form>;
}

export function NetworkSection() {
  const settings = useQuery(settingsQuery);
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  if (!settings.data) return <SectionSkeleton />;
  return <ProxyForm settings={settings.data} />;
}
