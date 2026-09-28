// 安全: change the administrator password, sign out.
import { useState, type FormEvent } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LoaderCircle, LogOut } from 'lucide-react';
import { endpoints } from '@shared/api';
import { errorMessage, request, setCsrf } from '@/lib/api';
import { fieldErrors, type FieldErrors } from '@/lib/forms';
import { authQuery } from '@/lib/queries';
import { Button } from '@/components/ui/button';
import { Card, CardFooter } from '@/components/ui/card';
import { Field, FieldLabel } from '@/components/ui/field';
import { FieldMessage, PasswordInput } from '@/components/app/fields';

function PasswordCard() {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const change = useMutation({
    mutationFn: () => request('POST /api/auth/password', { body: { current: form.current, next: form.next } }),
    onSuccess: () => { setForm({ current: '', next: '', confirm: '' }); toast.success('管理员密码已修改'); },
    onError: error => { setErrors({ current: errorMessage(error) }); document.getElementById('password-current')?.focus(); },
  });
  const set = (field: keyof typeof form, value: string) => { setForm(old => ({ ...old, [field]: value })); setErrors(old => ({ ...old, [field]: undefined })); };
  function submit(e: FormEvent) {
    e.preventDefault();
    if (change.isPending) return;
    const parsed = endpoints['POST /api/auth/password'].body.safeParse({ current: form.current, next: form.next });
    const next: FieldErrors = parsed.success ? {} : fieldErrors(parsed.error);
    if (!form.current) next.current = '请输入当前密码';
    if (!next.next && form.confirm !== form.next) next.confirm = '两次输入的新密码不一致';
    setErrors(next);
    const first = (['current', 'next', 'confirm'] as const).find(field => next[field]);
    if (first) document.getElementById(`password-${first}`)?.focus();
    else change.mutate();
  }
  const field = (name: keyof typeof form, label: string, autoComplete: string) => <Field className="gap-2">
    <FieldLabel htmlFor={`password-${name}`}>{label}</FieldLabel>
    <PasswordInput id={`password-${name}`} autoComplete={autoComplete} value={form[name]} onChange={e => set(name, e.target.value)}
      aria-invalid={!!errors[name]} aria-describedby={errors[name] ? `password-${name}-error` : undefined} />
    <FieldMessage id={`password-${name}-error`}>{errors[name]}</FieldMessage>
  </Field>;
  return <form noValidate onSubmit={submit}>
    <Card className="gap-0 py-0">
      <div className="flex flex-col gap-5 p-5 sm:p-6">
        <div className="flex flex-col gap-1">
          <h3 className="text-[15px] font-semibold tracking-tight">管理员密码</h3>
          <p className="text-xs text-muted-foreground">登录这个管理页面用的密码，至少 8 位。</p>
        </div>
        {field('current', '当前密码', 'current-password')}
        <div className="grid gap-5 sm:grid-cols-2">
          {field('next', '新密码', 'new-password')}
          {field('confirm', '再输入一次', 'new-password')}
        </div>
      </div>
      <CardFooter className="justify-end px-5 py-3.5 sm:px-6">
        <Button type="submit" aria-disabled={change.isPending}>{change.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}修改密码</Button>
      </CardFooter>
    </Card>
  </form>;
}

function SignOutCard() {
  const router = useRouter();
  const client = useQueryClient();
  const logout = useMutation({
    mutationFn: () => request('POST /api/auth/logout'),
    onSuccess: state => {
      setCsrf(state.csrf);
      client.removeQueries({ predicate: query => query.queryKey[0] !== 'auth' });
      client.setQueryData(authQuery.queryKey, state);
      void router.navigate({ to: '/login' });
    },
  });
  return <Card className="flex-row items-center gap-4 px-5 py-4 sm:px-6">
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <h3 className="text-[15px] font-semibold tracking-tight">退出管理页面</h3>
      <p className="text-xs text-muted-foreground">下载和追更会在服务器上继续进行。</p>
    </div>
    <Button variant="outline" size="sm" aria-disabled={logout.isPending} onClick={() => { if (!logout.isPending) logout.mutate(); }}>
      {logout.isPending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <LogOut data-icon="inline-start" />}退出
    </Button>
  </Card>;
}

export function SecuritySection() {
  return <>
    <PasswordCard />
    <SignOutCard />
  </>;
}
