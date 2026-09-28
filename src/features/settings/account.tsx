// Kmoe 账号: sign in (the password used once, or kept sealed to log in again by itself), mirror, level/VIP, quotas, refresh and sign out.
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LoaderCircle, LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { cn } from 'cn';
import { endpoints } from '@shared/api';
import type { KmoeAccount, Quota } from '@shared/model';
import { errorMessage, request } from '@/lib/api';
import { formatMB, fromNow, percent } from '@/lib/format';
import { fieldErrors, type FieldErrors } from '@/lib/forms';
import { mirrorsQuery, settingsQuery, statusQuery } from '@/lib/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardFooter } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ConfirmAction, Notice } from '@/components/app/feedback';
import { FieldMessage, PasswordInput } from '@/components/app/fields';
import { refocus, useClosable } from '@/features/library/pickers';
import { SectionSkeleton, SettingRow, usePatchSettings } from './common';

function useSetAccount() {
  const client = useQueryClient();
  return (kmoe: KmoeAccount) => {
    client.setQueryData(statusQuery.queryKey, old => old && { ...old, kmoe });
    void client.invalidateQueries({ queryKey: statusQuery.queryKey });
  };
}

function MirrorSelect({ id, value, busy, onChange }: { id: string; value: string; busy?: boolean; onChange: (mirror: string) => void }) {
  const { data: mirrors } = useQuery(mirrorsQuery);
  // No preference saved means the server uses its first mirror: show that instead of an empty picker.
  const current = value || mirrors?.[0] || '';
  const options = [...new Set([current, ...(mirrors ?? [])])].filter(Boolean);
  return <Select value={current} onValueChange={mirror => { if (!busy) onChange(mirror); }}>
    <SelectTrigger id={id} aria-disabled={busy || undefined} className="w-full font-mono text-[13px] sm:w-48"><SelectValue placeholder="选择镜像" /></SelectTrigger>
    <SelectContent position="popper"><SelectGroup>{options.map(mirror => <SelectItem key={mirror} value={mirror} className="font-mono text-[13px]">{mirror}</SelectItem>)}</SelectGroup></SelectContent>
  </Select>;
}

function LoginForm({ account, mirror }: { account: KmoeAccount; mirror: string }) {
  const setAccount = useSetAccount();
  const [email, setEmail] = useState(account.email ?? '');
  const [password, setPassword] = useState('');
  const [site, setSite] = useState(mirror);
  const [remember, setRemember] = useState(account.remember);
  const [errors, setErrors] = useState<FieldErrors>({});
  const login = useMutation({
    mutationFn: () => request('POST /api/kmoe/login', { body: { email, password, mirror: site, remember } }),
    onSuccess: kmoe => { setPassword(''); setAccount(kmoe); toast.success('已登录 Kmoe', { description: kmoe.email ?? undefined }); },
    onError: error => { setErrors({ password: errorMessage(error) }); document.getElementById('kmoe-password')?.focus(); },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (login.isPending) return;
    const parsed = endpoints['POST /api/kmoe/login'].body.safeParse({ email, password, mirror: site, remember });
    const next = parsed.success ? {} : fieldErrors(parsed.error);
    setErrors(next);
    if (next.email) document.getElementById('kmoe-email')?.focus();
    else if (next.password) document.getElementById('kmoe-password')?.focus();
    else login.mutate();
  }
  return <form noValidate onSubmit={submit}>
    <Card className="gap-0 py-0">
      <div className="flex flex-col gap-5 p-5 sm:p-6">
        {account.state === 'expired' && <Notice tone="warning">{account.error ?? 'Kmoe 登录已失效'}。重新登录后，暂停的队列会自动继续。</Notice>}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field className="gap-2">
            <FieldLabel htmlFor="kmoe-email">邮箱</FieldLabel>
            <Input id="kmoe-email" type="email" autoComplete="username" inputMode="email" spellCheck={false} value={email} onChange={e => setEmail(e.target.value)}
              aria-invalid={!!errors.email} aria-describedby={errors.email ? 'kmoe-email-error' : undefined} />
            <FieldMessage id="kmoe-email-error">{errors.email}</FieldMessage>
          </Field>
          <Field className="gap-2">
            <FieldLabel htmlFor="kmoe-password">密码</FieldLabel>
            <PasswordInput id="kmoe-password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}
              aria-invalid={!!errors.password} aria-describedby={errors.password ? 'kmoe-password-error' : 'kmoe-password-hint'} />
            <FieldMessage id="kmoe-password-error">{errors.password}</FieldMessage>
          </Field>
        </div>
        <Field className="gap-2">
          <FieldLabel htmlFor="kmoe-mirror">镜像</FieldLabel>
          <MirrorSelect id="kmoe-mirror" value={site} onChange={setSite} />
        </Field>
        <label className="flex items-center gap-2.5 text-sm"><Checkbox checked={remember} onCheckedChange={value => setRemember(value === true)} />记住密码，登录失效时自动重新登录</label>
        <p id="kmoe-password-hint" className="flex items-start gap-2 rounded-xl bg-muted/50 px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-px size-3.5 shrink-0" />{remember
            ? '密码加密保存在这台 NAS 上，只用来在登录失效后自动重新登录；Kmoe 拒绝时会删除它并通知你，退出登录也会删除。'
            : '密码只用于这一次登录，不会保存；服务器只保存加密后的登录会话。'}
        </p>
      </div>
      <CardFooter className="justify-end px-5 py-3.5 sm:px-6">
        <Button type="submit" aria-disabled={login.isPending}>{login.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}登录 Kmoe</Button>
      </CardFooter>
    </Card>
  </form>;
}

function QuotaRow({ label, quota }: { label: string; quota: Quota }) {
  if (quota.totalMB === null) return null;
  const used = quota.usedMB ?? 0, share = percent(used, quota.totalMB);
  return <div className="flex flex-col gap-2 px-5 py-4 sm:px-6">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-muted-foreground tabular-nums">
        已用 <span className="font-medium text-foreground">{formatMB(used)}</span> / {formatMB(quota.totalMB)}
        {quota.resetDay !== null && ` · 每月 ${quota.resetDay} 日重置`}
      </span>
    </div>
    <div role="meter" aria-label={`${label}已用`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share)} className="h-1.5 overflow-hidden rounded-full bg-foreground/8">
      <div className={cn('h-full rounded-full transition-[width] duration-700 ease-out-strong', share > 90 ? 'bg-warning' : 'bg-foreground/55')} style={{ width: `${share}%` }} />
    </div>
  </div>;
}

function AccountCard({ account, reserveMB }: { account: KmoeAccount; reserveMB: number }) {
  const setAccount = useSetAccount();
  const refresh = useMutation({
    mutationFn: () => request('POST /api/kmoe/refresh'),
    onSuccess: kmoe => { setAccount(kmoe); toast.success('已刷新账号信息'); },
  });
  const logout = useMutation({
    mutationFn: () => request('POST /api/kmoe/logout'),
    onSuccess: kmoe => { setAccount(kmoe); toast.success('已退出 Kmoe'); },
  });
  const remaining = account.remainingMB;
  return <Card className="gap-0 py-0">
    <div className="flex items-center gap-4 p-5 sm:p-6">
      <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-full bg-muted text-base font-semibold uppercase ring-1 ring-border tone">{account.email?.[0] ?? 'K'}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{account.email}</span>
          {account.vip && <Badge variant="seal">VIP</Badge>}
        </span>
        <span className="truncate text-xs text-muted-foreground tabular-nums">
          {[account.level !== null && `Lv.${account.level}`, account.mirror, account.checkedAt && `${fromNow(account.checkedAt)}更新`].filter(Boolean).join(' · ')}
        </span>
      </div>
    </div>
    <div className="divide-y border-t">
      {account.free && <QuotaRow label="免费额度" quota={account.free} />}
      {account.vipQuota && <QuotaRow label="VIP 额度" quota={account.vipQuota} />}
      {remaining !== null && <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-4 sm:px-6">
        <span className="text-sm font-medium">合计剩余</span>
        <span className="text-sm tabular-nums">
          <span className={cn('font-semibold', remaining < reserveMB && 'text-warning')}>{formatMB(remaining)}</span>
          <span className="text-xs text-muted-foreground"> · 低于 {formatMB(reserveMB)} 时暂停队列</span>
        </span>
      </div>}
    </div>
    <CardFooter className="flex-wrap gap-2 px-5 py-3.5 sm:px-6">
      <ConfirmAction title="退出 Kmoe 登录？" description="退出后无法下载，追更检查也会暂停，直到重新登录。" action="退出登录" onConfirm={() => logout.mutate()}>
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground hover:text-destructive"><LogOut data-icon="inline-start" />退出登录</Button>
      </ConfirmAction>
      <Button variant="outline" size="sm" className="ml-auto" aria-disabled={refresh.isPending} onClick={() => { if (!refresh.isPending) refresh.mutate(); }}>
        {refresh.isPending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}刷新
      </Button>
    </CardFooter>
  </Card>;
}

/** 自动重新登录: turning it on asks for the password once (a login checks it), turning it off deletes the saved one. */
function AutoLoginRow({ account }: { account: KmoeAccount }) {
  const setAccount = useSetAccount();
  const [asking, setAsking] = useState(false);
  const forget = useMutation({
    mutationFn: () => request('DELETE /api/kmoe/password'),
    onSuccess: kmoe => { setAccount(kmoe); toast.success('已关闭自动重新登录', { description: '保存的密码已删除。' }); },
  });
  return <>
    <SettingRow label="自动重新登录" htmlFor="kmoe-auto-login" description="登录失效时，用加密保存在这台 NAS 上的密码重新登录。Kmoe 拒绝时会删除密码并通知你。">
      <Switch id="kmoe-auto-login" checked={account.remember} aria-disabled={forget.isPending || undefined}
        onCheckedChange={on => { if (forget.isPending) return; if (on) setAsking(true); else forget.mutate(); }} />
    </SettingRow>
    {asking && <RememberDialog account={account} onClose={() => setAsking(false)} />}
  </>;
}

function RememberDialog({ account, onClose }: { account: KmoeAccount; onClose: () => void }) {
  const setAccount = useSetAccount();
  const { open, close } = useClosable(onClose);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const login = useMutation({
    mutationFn: () => request('POST /api/kmoe/login', { body: { email: account.email ?? '', password, mirror: account.mirror ?? undefined, remember: true } }),
    onSuccess: kmoe => { setAccount(kmoe); toast.success('已开启自动重新登录'); close(); },
    onError: failure => { setError(errorMessage(failure)); document.getElementById('remember-password')?.focus(); },
  });
  return <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
    <DialogContent className="sm:max-w-md" onCloseAutoFocus={refocus(() => document.getElementById('kmoe-auto-login'))}>
      <form noValidate className="flex flex-col gap-5" onSubmit={e => {
        e.preventDefault();
        if (password) { if (!login.isPending) login.mutate(); return; }
        setError('请输入密码');
        document.getElementById('remember-password')?.focus();
      }}>
        <DialogHeader>
          <DialogTitle>开启自动重新登录</DialogTitle>
          <DialogDescription>输入 {account.email} 的 Kmoe 密码。会先用它登录一次确认没有输错，再加密保存在这台 NAS 上。</DialogDescription>
        </DialogHeader>
        <Field className="gap-2">
          <FieldLabel htmlFor="remember-password">密码</FieldLabel>
          <PasswordInput id="remember-password" autoComplete="current-password" autoFocus value={password} onChange={e => setPassword(e.target.value)}
            aria-invalid={!!error} aria-describedby={error ? 'remember-password-error' : undefined} />
          <FieldMessage id="remember-password-error">{error ?? undefined}</FieldMessage>
        </Field>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>取消</Button>
          <Button type="submit" aria-disabled={login.isPending}>{login.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}开启</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function AccountSection() {
  const { data: status } = useQuery(statusQuery);
  const settings = useQuery(settingsQuery);
  const patch = usePatchSettings();
  if (!status || !settings.data) return <SectionSkeleton />;
  const account = status.kmoe;
  return <>
    {account.state === 'active' ? <AccountCard account={account} reserveMB={settings.data.quotaReserveMB} /> : <LoginForm account={account} mirror={settings.data.preferredMirror} />}
    {account.state === 'active' && <Card className="gap-0 divide-y py-0">
      <SettingRow label="镜像" htmlFor="preferred-mirror" description="访问 Kmoe 使用的域名，连不上时换一个试试。切换时带上现在的登录，新镜像不认就保持不变。">
        {/* The mirror the session uses; while a switch is being checked, the one it goes to. */}
        <MirrorSelect id="preferred-mirror" value={(patch.isPending && patch.variables?.preferredMirror) || account.mirror || settings.data.preferredMirror} busy={patch.isPending}
          onChange={mirror => patch.mutate({ preferredMirror: mirror }, { onSuccess: () => void toast.success(`已切换到 ${mirror}`, { description: '登录状态一起带过去了，不用重新登录。' }) })} />
      </SettingRow>
      <AutoLoginRow account={account} />
    </Card>}
  </>;
}
