// 存储位置: the list of targets (one opens at a time into its editor), and importing the browser extension's configuration.
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, HardDrive, Plus, Server } from 'lucide-react';
import type { Target } from '@shared/model';
import { targetsQuery, statusQuery } from '@/lib/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ErrorState } from '@/components/app/feedback';
import { SectionSkeleton } from './common';
import { ExtensionImport } from './extension-import';
import { TargetEditor, hostOf } from './target-editor';

function Summary({ target, libraryRoot }: { target: Target; libraryRoot: string }) {
  const where = target.kind === 'local' ? `${libraryRoot}${target.path === '/' ? '' : target.path}` : `${hostOf(target.url)}${target.path}`;
  return <span className="truncate font-mono text-xs text-muted-foreground">{where} · {target.rule}</span>;
}

export function StorageSection() {
  const targets = useQuery(targetsQuery);
  const { data: status } = useQuery(statusQuery);
  const [open, setOpen] = useState<number | 'new' | null>(null);
  if (targets.error) return <ErrorState error={targets.error} onRetry={() => void targets.refetch()} />;
  if (!targets.data || !status) return <SectionSkeleton />;
  const root = status.libraryRoot;
  const add = () => {
    flushSync(() => setOpen('new'));
    document.getElementById('target-new-name')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  return <>
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground tabular-nums">{targets.data.length} 个存储位置</p>
      <Button variant="outline" size="sm" aria-disabled={open === 'new'} onClick={() => { if (open !== 'new') add(); }}><Plus data-icon="inline-start" />新建存储位置</Button>
    </div>
    <ul className="flex flex-col gap-3">
      {targets.data.map(target => <li key={target.id}>
        <Collapsible open={open === target.id} onOpenChange={next => setOpen(next ? target.id : null)} className="overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-border">
          <CollapsibleTrigger className="group/row flex w-full items-center gap-3.5 px-5 py-4 text-left outline-none transition-colors duration-150 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
              {target.kind === 'local' ? <HardDrive className="size-4" /> : <Server className="size-4" />}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{target.name}</span>
                <Badge variant="muted" className="shrink-0">{target.kind === 'local' ? '本地' : 'WebDAV'}</Badge>
                {target.isDefault && <Badge variant="secondary" className="shrink-0">默认</Badge>}
              </span>
              <Summary target={target} libraryRoot={root} />
            </span>
            <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform duration-250 ease-out-strong group-data-[state=open]/row:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t"><TargetEditor target={target} libraryRoot={root} /></div>
          </CollapsibleContent>
        </Collapsible>
      </li>)}
      {open === 'new' && <li className="animate-rise overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-seal/30">
        <div className="flex items-center gap-3.5 border-b px-5 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-seal-soft text-seal"><Plus className="size-4" /></span>
          <span className="font-medium">新的存储位置</span>
        </div>
        <TargetEditor target={null} libraryRoot={root} onSaved={saved => setOpen(saved.id)} onDiscard={() => setOpen(null)} />
      </li>}
    </ul>
    <ExtensionImport />
  </>;
}
