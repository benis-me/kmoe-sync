import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, LoaderCircle } from 'lucide-react';
import { cn } from 'cn';
import type { MetadataSettingsPatch, SettingsPatch } from '@shared/model';
import { errorMessage, request } from '@/lib/api';
import { metadataSettingsQuery, settingsQuery } from '@/lib/queries';
import { Skeleton } from '@/components/ui/skeleton';
import { Loading } from '@/components/app/feedback';

/** Settings that apply at once: the view updates first and reverts if the save fails. */
export function usePatchSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => request('PATCH /api/settings', { body: patch }),
    onMutate: async patch => {
      await client.cancelQueries({ queryKey: settingsQuery.queryKey });
      const previous = client.getQueryData(settingsQuery.queryKey);
      client.setQueryData(settingsQuery.queryKey, old => old && { ...old, ...patch });
      return { previous };
    },
    onError: (error, _, context) => {
      client.setQueryData(settingsQuery.queryKey, context?.previous);
      toast.error(errorMessage(error));
    },
    onSuccess: (settings, patch) => {
      client.setQueryData(settingsQuery.queryKey, settings);
      void client.invalidateQueries({ queryKey: ['status'] });
      if ('defaultTargetId' in patch) void client.invalidateQueries({ queryKey: ['targets'] });
    },
  });
}

/** Komga 元数据 settings: the switch and the options show the change at once and revert if saving fails. */
export function usePatchMetadata() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: MetadataSettingsPatch) => request('PATCH /api/metadata/settings', { body: patch }),
    onMutate: async patch => {
      await client.cancelQueries({ queryKey: metadataSettingsQuery.queryKey });
      const previous = client.getQueryData(metadataSettingsQuery.queryKey);
      client.setQueryData(metadataSettingsQuery.queryKey, old => old && { ...old, enabled: patch.enabled ?? old.enabled, options: { ...old.options, ...patch.options } });
      return { previous };
    },
    onError: (error, _, context) => { client.setQueryData(metadataSettingsQuery.queryKey, context?.previous); toast.error(errorMessage(error)); },
    onSuccess: next => {
      client.setQueryData(metadataSettingsQuery.queryKey, next);
      // Komga states of folders follow the switch and the library mapping; Bangumi hints follow the source.
      for (const queryKey of [['library'], ['comic'], ['shelf']]) void client.invalidateQueries({ queryKey });
    },
  });
}

/** "正在保存… / 已保存" beside a card title for settings that save themselves (nothing while idle). */
export function SaveHint({ pending, saved }: { pending: boolean; saved: boolean }) {
  return <span role="status" className="flex h-5 items-center gap-1 text-xs text-muted-foreground">
    {pending ? <><LoaderCircle className="size-3.5 animate-spin" />正在保存…</> : saved ? <><Check className="size-3.5 animate-pop text-success" />已保存</> : null}
  </span>;
}

/** A label + description on the left, its control on the right (stacked on phones). */
export function SettingRow({ label, description, htmlFor, labelId, children, className }: {
  label: string; description?: ReactNode; htmlFor?: string; labelId?: string; children: ReactNode; className?: string;
}) {
  return <div className={cn('flex items-center justify-between gap-x-6 gap-y-3 px-5 py-4 max-sm:flex-col max-sm:items-stretch', className)}>
    <div className="flex min-w-0 flex-col gap-0.5">
      {htmlFor ? <label id={labelId} htmlFor={htmlFor} className="text-sm font-medium">{label}</label> : <span id={labelId} className="text-sm font-medium">{label}</span>}
      {description && <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>}
    </div>
    <div className="flex shrink-0 items-center gap-2 max-sm:justify-start">{children}</div>
  </div>;
}

export function SectionSkeleton() {
  return <Loading label="正在读取设置…">
    <div className="flex flex-col gap-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-20 rounded-2xl" style={{ opacity: 1 - i * 0.2 }} />)}</div>
  </Loading>;
}
