import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from 'cn';
import { useMediaQuery } from '@/lib/hooks';

/** Where a page's header actions go on phones: the top bar, at the end of the row with the page's name (set by the shell). */
export const TopBarActions = createContext<HTMLElement | null>(null);

/** Page column. On phones the top bar already names the page, so the heading block is for screen readers only. */
// The bottom padding keeps the end of a page clear of the floating AI 助手 button. Every page starts at the same left
// edge (not centred), so switching pages never shifts the content sideways; narrower pages leave room on the right.
export function Page({ children, className, width = 'default' }: { children: ReactNode; className?: string; width?: 'default' | 'wide' }) {
  return <div className={cn(
    'flex w-full flex-col gap-6 px-4 pt-4 pb-16 md:gap-8 md:px-8 md:pt-9 md:pb-20 lg:px-10',
    width === 'wide' ? 'max-w-7xl' : 'max-w-6xl',
    className,
  )}>{children}</div>;
}

export function PageHeader({ title, description, children, className }: { title: string; description?: ReactNode; children?: ReactNode; className?: string }) {
  const topBar = useContext(TopBarActions);
  const phone = !useMediaQuery('(min-width: 768px)');
  return <header className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-3 max-md:sr-only', className)}>
    <div className="flex min-w-0 flex-col gap-1">
      <h1 className="text-[26px] leading-tight font-semibold tracking-tight">{title}</h1>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
    {children && (phone ? topBar && createPortal(children, topBar) : <div className="flex flex-wrap items-center gap-2">{children}</div>)}
  </header>;
}

/** Title + one-line description for a group inside a page or card. */
export function SectionHeading({ id, title, description, children, className }: { id?: string; title: ReactNode; description?: ReactNode; children?: ReactNode; className?: string }) {
  return <div className={cn('flex items-start justify-between gap-4', className)}>
    <div className="flex min-w-0 flex-col gap-0.5">
      <h2 id={id} className="text-[15px] leading-snug font-semibold tracking-tight">{title}</h2>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
    {children}
  </div>;
}
