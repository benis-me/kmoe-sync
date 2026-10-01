// Shared feedback: inline notices, confirmations, delayed loading, error and empty states.
import type { ReactNode } from 'react';
import { Check, CircleAlert, CloudOff, RotateCcw, TriangleAlert } from 'lucide-react';
import { cn } from 'cn';
import { ApiError, errorMessage } from '@/lib/api';
import { useDelayed } from '@/lib/hooks';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';

type Tone = 'info' | 'error' | 'success' | 'warning';

export function Notice({ children, tone = 'info', className, live = true }: { children: ReactNode; tone?: Tone; className?: string; live?: boolean }) {
  const Icon = tone === 'error' ? CircleAlert : tone === 'warning' ? TriangleAlert : Check;
  return <Alert role={!live ? undefined : tone === 'error' ? 'alert' : 'status'} variant={tone === 'error' ? 'destructive' : tone === 'success' ? 'success' : 'default'}
    className={cn(tone === 'warning' && 'border-warning/25 bg-warning-soft text-warning *:data-[slot=alert-description]:text-foreground/80', className)}>
    <Icon /><AlertDescription>{children}</AlertDescription>
  </Alert>;
}

/** Asks before an irreversible action. `returnFocus` supplies a target when the trigger itself goes away. */
export function ConfirmAction({ children, title, description, action = '删除', cancel = '取消', variant = 'destructive', extra, onConfirm, returnFocus }: {
  children: ReactNode;
  title: string;
  description?: ReactNode;
  action?: string;
  /** The way out, when 取消 would read like the action itself. */
  cancel?: string;
  variant?: 'destructive' | 'default';
  extra?: ReactNode;
  onConfirm: () => void;
  returnFocus?: () => HTMLElement | null | undefined;
}) {
  return <AlertDialog>
    <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
    <AlertDialogContent onCloseAutoFocus={e => { const target = returnFocus?.(); if (target) { e.preventDefault(); target.focus(); } }}>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
      </AlertDialogHeader>
      {extra}
      <AlertDialogFooter>
        <AlertDialogCancel>{cancel}</AlertDialogCancel>
        <AlertDialogAction variant={variant} onClick={onConfirm}>{action}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

/** Announces loading at once; the skeleton itself appears only after 200 ms. */
export function Loading({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const shown = useDelayed(200);
  return <div role="status" className={className}>
    <span className="sr-only">{label}</span>
    {shown && <div aria-hidden className="animate-in duration-300 fade-in-0">{children}</div>}
  </div>;
}

export function ErrorState({ error, onRetry, title, className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  // No answer at all, or a proxy (NAS reverse proxy, dev server) saying the service behind it is down.
  // Our own server's errors come with a message (code without the http_ prefix): show that instead.
  const gateway = error instanceof ApiError && [502, 503, 504].includes(error.status) && error.code.startsWith('http_');
  const offline = gateway || (error instanceof ApiError && error.code === 'offline');
  return <Empty className={cn('min-h-72', className)}>
    <EmptyHeader>
      <EmptyMedia variant="icon">{offline ? <CloudOff /> : <CircleAlert />}</EmptyMedia>
      <EmptyTitle>{title ?? (offline ? '连不上 Kmoe Sync' : '加载失败')}</EmptyTitle>
      <EmptyDescription>{gateway ? `服务没有响应（HTTP ${(error as ApiError).status}），请确认 Kmoe Sync 正在运行，然后重试。` : errorMessage(error)}</EmptyDescription>
    </EmptyHeader>
    {onRetry && <EmptyContent><Button variant="outline" onClick={onRetry}><RotateCcw data-icon="inline-start" />重试</Button></EmptyContent>}
  </Empty>;
}

export function EmptyState({ icon, title, description, children, className }: { icon: ReactNode; title: string; description?: ReactNode; children?: ReactNode; className?: string }) {
  return <Empty className={cn('min-h-72', className)}>
    <EmptyHeader>
      <EmptyMedia variant="icon">{icon}</EmptyMedia>
      <EmptyTitle>{title}</EmptyTitle>
      {description && <EmptyDescription>{description}</EmptyDescription>}
    </EmptyHeader>
    {children && <EmptyContent className="flex-row flex-wrap justify-center">{children}</EmptyContent>}
  </Empty>;
}
