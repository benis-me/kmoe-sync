// 书库整理 filters: one menu per stage (Kmoe, Bangumi, Komga) that narrows the list to a status, each option with its count.
import { ChevronDown } from 'lucide-react';
import { cn } from 'cn';
import { STAGES, optionOf, type Stage } from '@shared/folder-status';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dot } from '@/components/app/status';

const ALL = 'all';
const Count = ({ n }: { n: number }) => <span className="ml-auto pl-6 text-xs text-muted-foreground tabular-nums">{n}</span>;

/** `counts`: folders per status among those the other filters leave; an empty status can't be picked. */
export function StageMenu({ stage, value, counts, onChange }: { stage: Stage; value: string | undefined; counts: Record<string, number>; onChange: (value: string | undefined) => void }) {
  const { label, options } = STAGES[stage];
  const current = optionOf(stage, value);
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild>
      <Button variant="outline" className={cn('shrink-0 max-sm:h-8 max-sm:gap-1 max-sm:px-2.5 max-sm:text-[13px]', current && 'border-seal/45 bg-seal-soft text-seal hover:border-seal/60 hover:bg-seal-soft aria-expanded:bg-seal-soft')}>
        <span className={cn(current && 'text-seal/75')}>{label}</span>{current && <span className="font-medium">{current.label}</span>}
        <ChevronDown data-icon="inline-end" className={current ? 'text-seal/70' : 'text-muted-foreground'} />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="min-w-48">
      <DropdownMenuRadioGroup value={value ?? ALL} onValueChange={next => onChange(next === ALL ? undefined : next)}>
        <DropdownMenuRadioItem value={ALL}>全部</DropdownMenuRadioItem>
        <DropdownMenuSeparator />
        {options.map(option => <DropdownMenuRadioItem key={option.value} value={option.value} disabled={!counts[option.value] && option.value !== value}>
          <Dot tone={option.tone} className="size-1.5" />{option.label}<Count n={counts[option.value] ?? 0} />
        </DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
