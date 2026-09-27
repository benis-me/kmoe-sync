// First run (create the administrator password) and sign-in.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { getRouteApi, useRouter } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { endpoints } from '@shared/api';
import type { AuthState } from '@shared/model';
import { errorMessage, request, setCsrf } from '@/lib/api';
import { fieldErrors, type FieldErrors } from '@/lib/forms';
import { authQuery } from '@/lib/queries';
import { mockScenario } from '@/mock';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { FieldMessage, PasswordInput } from '@/components/app/fields';
import { MockBadge } from '@/components/app/status';

function AuthCard({ title, description, children, onSubmit }: { title: string; description: ReactNode; children: ReactNode; onSubmit: (e: FormEvent<HTMLFormElement>) => void }) {
  useEffect(() => { document.title = `${title} · Kmoe Sync`; }, [title]);
  return <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10 text-sm">
    <div aria-hidden className="pointer-events-none absolute -top-24 -left-24 size-96 rounded-full tone [mask-image:radial-gradient(circle,black_20%,transparent_70%)]" />
    <form noValidate onSubmit={onSubmit} className="relative flex w-full max-w-sm animate-rise flex-col gap-6 rounded-2xl bg-card p-6 shadow-panel ring-1 ring-foreground/8 sm:p-8">
      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <img src="/icon.svg" alt="" className="size-5 rounded-[5px] dark:ring-1 dark:ring-white/12" />Kmoe Sync<MockBadge />
        </span>
        <h1 className="text-[22px] leading-tight font-semibold tracking-tight">{title}</h1>
        <p className="text-sm leading-relaxed text-pretty text-muted-foreground">{description}</p>
      </div>
      {children}
    </form>
  </main>;
}

function useSignedIn() {
  const client = useQueryClient();
  return (state: AuthState) => {
    setCsrf(state.csrf);
    client.setQueryData(authQuery.queryKey, state);
  };
}

export function SetupPage() {
  const router = useRouter();
  const signedIn = useSignedIn();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const setup = useMutation({
    mutationFn: () => request('POST /api/auth/setup', { body: { password } }),
    onSuccess: state => { signedIn(state); void router.navigate({ to: '/' }); },
    onError: error => setErrors({ password: errorMessage(error) }),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (setup.isPending) return;
    const parsed = endpoints['POST /api/auth/setup'].body.safeParse({ password });
    const next: FieldErrors = parsed.success ? {} : fieldErrors(parsed.error);
    if (!next.password && confirm !== password) next.confirm = '两次输入的密码不一致';
    setErrors(next);
    if (next.password) document.getElementById('setup-password')?.focus();
    else if (next.confirm) document.getElementById('setup-confirm')?.focus();
    else setup.mutate();
  }
  return <AuthCard title="设置管理员密码" description="Kmoe Sync 只有一个管理员。这个密码用来登录管理页面，至少 8 位。" onSubmit={submit}>
    <div className="flex flex-col gap-4">
      <Field className="gap-2">
        <FieldLabel htmlFor="setup-password">密码</FieldLabel>
        <PasswordInput id="setup-password" autoFocus autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}
          aria-invalid={!!errors.password} aria-describedby={errors.password ? 'setup-password-error' : undefined} />
        <FieldMessage id="setup-password-error">{errors.password}</FieldMessage>
      </Field>
      <Field className="gap-2">
        <FieldLabel htmlFor="setup-confirm">再输入一次</FieldLabel>
        <PasswordInput id="setup-confirm" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)}
          aria-invalid={!!errors.confirm} aria-describedby={errors.confirm ? 'setup-confirm-error' : undefined} />
        <FieldMessage id="setup-confirm-error">{errors.confirm}</FieldMessage>
      </Field>
    </div>
    <Button type="submit" variant="seal" size="lg" className="w-full" aria-disabled={setup.isPending}>
      {setup.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}创建并进入
    </Button>
    <p className="text-xs leading-relaxed text-pretty text-muted-foreground">用过浏览器扩展 Kmoe Sync？进入后可以在「设置 › 存储位置」导入扩展配置，WebDAV 书库和命名规则一次迁移。</p>
  </AuthCard>;
}

const loginRoute = getRouteApi('/login');

export function LoginPage() {
  const router = useRouter();
  const signedIn = useSignedIn();
  const { redirect } = loginRoute.useSearch();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const login = useMutation({
    mutationFn: () => request('POST /api/auth/login', { body: { password } }),
    onSuccess: state => {
      signedIn(state);
      // Only paths inside this app, never another origin.
      router.history.push(redirect?.startsWith('/') && !redirect.startsWith('//') ? redirect : '/');
    },
    onError: e => { setError(errorMessage(e)); document.getElementById('login-password')?.focus(); },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (login.isPending) return;
    if (!password) { setError('请输入密码'); document.getElementById('login-password')?.focus(); return; }
    setError('');
    login.mutate();
  }
  return <AuthCard title="登录" description={(import.meta.env.DEV || import.meta.env.MODE === 'demo') && mockScenario() ? <>演示数据的管理员密码是 <code className="font-mono text-foreground">demo1234</code>。</> : '输入管理员密码。'} onSubmit={submit}>
    <Field className="gap-2">
      <FieldLabel htmlFor="login-password">管理员密码</FieldLabel>
      <PasswordInput id="login-password" autoFocus autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}
        aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined} />
      <FieldMessage id="login-error">{error}</FieldMessage>
    </Field>
    <Button type="submit" variant="seal" size="lg" className="w-full" aria-disabled={login.isPending}>
      {login.isPending && <LoaderCircle data-icon="inline-start" className="animate-spin" />}登录
    </Button>
  </AuthCard>;
}
