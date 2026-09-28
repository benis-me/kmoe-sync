import { Check, CircleAlert, Info, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { Toaster as Sonner, toast } from 'sonner';
import { useMediaQuery } from '@/lib/hooks';

const icon = 'grid size-5 place-items-center rounded-full [&>svg]:size-3.5';

// Errors stay until closed: a failure should not be gone before it is read. Sonner has no per-type duration.
const error = toast.error;
toast.error = (message, data) => error(message, { duration: Infinity, ...data });

/** Sonner, dressed as the extension's toasts. Phones: from the top, clear of the tab and action bars. */
export function Toaster() {
  const phone = useMediaQuery('(max-width: 767.98px)');
  return <Sonner
    position={phone ? 'top-center' : 'bottom-right'}
    offset={{ bottom: 'calc(var(--bottom-inset, 0px) + 20px)', right: 20 }}
    mobileOffset={{ top: 'calc(env(safe-area-inset-top) + 60px)', left: 12, right: 12 }}
    visibleToasts={3}
    duration={6000}
    gap={8}
    containerAriaLabel="通知"
    icons={{
      success: <span className={`${icon} bg-success-soft text-success`}><Check strokeWidth={2.5} /></span>,
      error: <span className={`${icon} bg-destructive/12 text-destructive`}><CircleAlert strokeWidth={2.5} /></span>,
      warning: <span className={`${icon} bg-warning-soft text-warning`}><TriangleAlert strokeWidth={2.5} /></span>,
      info: <span className={`${icon} bg-muted text-muted-foreground`}><Info strokeWidth={2.5} /></span>,
      loading: <span className={`${icon} text-muted-foreground`}><LoaderCircle className="animate-spin" /></span>,
      close: <X className="size-3.5" />,
    }}
    toastOptions={{
      unstyled: true,
      closeButton: true,
      classNames: {
        toast: 'group/toast flex w-full items-start gap-3 rounded-xl border bg-popover py-3 pr-10 pl-3.5 text-sm text-popover-foreground shadow-float',
        icon: 'mt-px shrink-0',
        content: 'flex min-w-0 flex-1 flex-col gap-0.5 py-px',
        title: 'leading-snug font-medium break-words',
        description: 'text-xs leading-relaxed text-muted-foreground break-words',
        actionButton: 'mt-0.5 h-7 shrink-0 rounded-md border bg-card px-2.5 text-xs font-medium shadow-soft transition-colors duration-150 hover:bg-accent',
        cancelButton: 'mt-0.5 h-7 shrink-0 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent',
        closeButton: 'absolute top-2.5 right-2.5 grid size-6 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
      },
    }}
  />;
}
