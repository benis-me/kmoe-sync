import type { QueryClient, QueryKey } from '@tanstack/react-query';

export type SettingChange<T, P> = P | ((current: T) => P);

/** One server resource, shared by every hook instance. TanStack owns the request queue. */
export function createSettingMutation<T, P>(queryKey: QueryKey, send: (patch: P) => Promise<T>, apply: (current: T, patch: P) => T) {
  const confirmed = new WeakMap<QueryClient, { value: T | undefined }>();
  const mutationKey = ['save', ...queryKey];
  const resolve = (change: SettingChange<T, P>, current: T | undefined): P => {
    if (typeof change !== 'function') return change;
    if (current === undefined) throw new Error('设置尚未加载，请刷新后重试');
    return (change as (current: T) => P)(current);
  };

  return (client: QueryClient) => {
    const pending = (settled?: symbol) => client.getMutationCache().findAll({ mutationKey, exact: true, status: 'pending' })
      .filter(mutation => settled === undefined || mutation.state.context !== settled)
      .sort((a, b) => a.mutationId - b.mutationId);
    const publish = (settled?: symbol) => {
      const remaining = pending(settled);
      const value = remaining.reduce((current, mutation) => current === undefined ? current
        : apply(current, resolve(mutation.state.variables as SettingChange<T, P>, current)), confirmed.get(client)?.value);
      client.setQueryData<T>(queryKey, value);
      return remaining.length;
    };

    return {
      mutationKey,
      scope: { id: queryKey.join(':') },
      mutationFn: (change: SettingChange<T, P>) => send(resolve(change, confirmed.get(client)?.value)),
      onMutate: async () => {
        await client.cancelQueries({ queryKey });
        if (!confirmed.has(client)) confirmed.set(client, { value: client.getQueryData<T>(queryKey) });
        publish();
        return Symbol();
      },
      onSettled: async (data: T | undefined, error: Error | null, _change: SettingChange<T, P>, context: symbol | undefined) => {
        await client.cancelQueries({ queryKey });
        const base = confirmed.get(client);
        if (base && data !== undefined) base.value = data;
        // Roll back to confirmed data, never to another request's optimistic snapshot.
        if (publish(context) === 0) {
          confirmed.delete(client);
          // A failed response may have reached the server; reconcile once the queue is empty.
          if (error) await client.invalidateQueries({ queryKey, refetchType: 'all' });
        }
      },
    };
  };
}
