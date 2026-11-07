import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { createSettingMutation, type SettingChange } from '@/lib/setting-mutations';
import { receiveDraft, saveDraft, type SettingsDraft } from '@/features/settings/use-settings-draft';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(done => setTimeout(done, 0));
  }
  throw new Error('mutation did not settle');
}

const queryKey = ['settings'];
type Value = { format: string; concurrency: number };
const initial: Value = { format: 'epub', concurrency: 1 };
const merge = (value: Value, patch: Partial<Value>) => ({ ...value, ...patch });

describe('serialized settings saves', () => {
  for (const failures of [[], [0], [2], [0, 2], [0, 1, 2]]) {
    test(`rapid edits to the same and different fields, failures: ${failures.join(',') || 'none'}`, async () => {
      let server = { ...initial };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryDefaults(queryKey, { queryFn: async () => server });
      client.setQueryData(queryKey, server);
      const gates = [deferred(), deferred(), deferred()];
      const calls: Partial<Value>[] = [];
      let active = 0;
      const options = createSettingMutation(queryKey, async (patch: Partial<Value>) => {
        const index = calls.length;
        calls.push(patch);
        expect(++active).toBe(1);
        await gates[index]!.promise;
        active--;
        if (failures.includes(index)) throw new Error('save failed');
        server = merge(server, patch);
        return server;
      }, merge);
      const patches = [{ format: 'mobi' }, { concurrency: 3 }, { format: 'epub' }];
      // Separate options instances model independent cards using the same hook.
      const mutations = patches.map(() => client.getMutationCache().build(client, options(client)));
      const saves = mutations.map((mutation, i) => mutation.execute(patches[i]!).catch(() => undefined));
      await until(() => calls.length === 1);
      expect(client.getQueryData<Value>(queryKey)).toEqual({ format: 'epub', concurrency: 3 });
      expect(mutations[1]!.state.isPaused).toBe(true);
      for (let i = 0; i < patches.length; i++) {
        gates[i]!.resolve();
        await saves[i];
        if (i < patches.length - 1) await until(() => calls.length === i + 2);
        const expected = patches.slice(i + 1).reduce(merge, server);
        expect(client.getQueryData<Value>(queryKey)).toEqual(expected);
      }
      expect(calls).toEqual(patches);
      expect(client.getQueryData<Value>(queryKey)).toEqual(server);
      client.clear();
    });
  }

  test('a failed tail reads the server even if the response was lost after saving', async () => {
    let server = { ...initial };
    const client = new QueryClient();
    client.setQueryDefaults(queryKey, { queryFn: async () => server });
    client.setQueryData(queryKey, server);
    const options = createSettingMutation(queryKey, async (patch: Partial<Value>): Promise<Value> => {
      server = merge(server, patch);
      throw new Error('connection lost after commit');
    }, merge);
    await client.getMutationCache().build(client, options(client)).execute({ format: 'mobi' }).catch(() => undefined);
    expect(client.getQueryData<Value>(queryKey)).toEqual(server);
    expect(server.format).toBe('mobi');
    client.clear();
  });

  test('a failed reconciliation retains confirmed cache data for the existing form', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryDefaults(queryKey, { queryFn: async () => { throw new Error('offline'); } });
    client.setQueryData(queryKey, initial);
    const options = createSettingMutation(queryKey, async (_patch: Partial<Value>): Promise<Value> => { throw new Error('offline'); }, merge);
    await client.getMutationCache().build(client, options(client)).execute({ format: 'mobi' }).catch(() => undefined);
    expect(client.getQueryData<Value>(queryKey)).toEqual(initial);
    expect(client.getQueryState(queryKey)?.status).toBe('error');
    client.clear();
  });

  test('nested metadata patches keep newer optimistic options after a failure', async () => {
    type Metadata = { enabled: boolean; options: { language: string; books: boolean } };
    type Patch = { enabled?: boolean; options?: Partial<Metadata['options']> };
    const key = ['metadata-settings'];
    let server: Metadata = { enabled: false, options: { language: 'cn', books: true } };
    const apply = (value: Metadata, patch: Patch) => ({ ...value, enabled: patch.enabled ?? value.enabled, options: { ...value.options, ...patch.options } });
    const client = new QueryClient();
    client.setQueryData(key, server);
    const gates = [deferred(), deferred(), deferred()];
    let calls = 0;
    const options = createSettingMutation(key, async (patch: Patch) => {
      const index = calls++;
      await gates[index]!.promise;
      if (index === 0) throw new Error('save failed');
      server = apply(server, patch);
      return server;
    }, apply);
    const patches: Patch[] = [{ options: { language: 'original' } }, { enabled: true }, { options: { books: false } }];
    const saves = patches.map(patch => client.getMutationCache().build(client, options(client)).execute(patch).catch(() => undefined));
    await until(() => calls === 1);
    gates[0]!.resolve();
    await saves[0];
    expect(client.getQueryData<Metadata>(key)).toEqual({ enabled: true, options: { language: 'cn', books: false } });
    gates[1]!.resolve();
    await saves[1];
    expect(client.getQueryData<Metadata>(key)).toEqual({ enabled: true, options: { language: 'cn', books: false } });
    gates[2]!.resolve();
    await saves[2];
    expect(client.getQueryData<Metadata>(key)).toEqual(server);
    client.clear();
  });

  test('channel updates derive lists from confirmed settings, excluding earlier failed changes', async () => {
    type Channels = { notifications: { id: string; name: string; enabled: boolean }[] };
    const first = deferred(), second = deferred();
    let server: Channels = { notifications: [{ id: 'a', name: 'A', enabled: true }, { id: 'b', name: 'B', enabled: true }] };
    const client = new QueryClient();
    client.setQueryData(queryKey, server);
    const calls: Channels[] = [];
    const options = createSettingMutation(queryKey, async (patch: Channels) => {
      const index = calls.length;
      calls.push(patch);
      await (index === 0 ? first : second).promise;
      if (index === 0) throw new Error('save failed');
      server = patch;
      return server;
    }, (_current: Channels, patch: Channels) => patch);
    const change = (id: string, fields: Partial<Channels['notifications'][number]>): SettingChange<Channels, Channels> => current => ({
      notifications: current.notifications.map(channel => channel.id === id ? { ...channel, ...fields } : channel),
    });
    const a = client.getMutationCache().build(client, options(client)).execute(change('a', { enabled: false })).catch(() => undefined);
    const b = client.getMutationCache().build(client, options(client)).execute(change('b', { name: 'renamed' }));
    await until(() => calls.length === 1);
    first.resolve();
    await a;
    await until(() => calls.length === 2);
    expect(calls[1]!.notifications).toEqual([{ id: 'a', name: 'A', enabled: true }, { id: 'b', name: 'renamed', enabled: true }]);
    second.resolve();
    await b;
    expect(client.getQueryData<Channels>(queryKey)).toEqual(server);
    client.clear();
  });

  test('a cancelled read cannot restore stale settings over queued optimistic writes', async () => {
    const read = deferred(), save = deferred();
    const client = new QueryClient();
    client.setQueryData(queryKey, initial);
    const fetch = client.fetchQuery({ queryKey, queryFn: async () => { await read.promise; return initial; } }).catch(() => undefined);
    let started = false;
    const options = createSettingMutation(queryKey, async (patch: Partial<Value>) => { started = true; await save.promise; return merge(initial, patch); }, merge);
    const pending = client.getMutationCache().build(client, options(client)).execute({ format: 'mobi' });
    await until(() => started);
    read.resolve();
    await fetch;
    expect(client.getQueryData<Value>(queryKey)).toEqual({ format: 'mobi', concurrency: 1 });
    save.resolve();
    await pending;
    client.clear();
  });
});

const form = { url: 'https://example.test', key: '' };
const state = (): SettingsDraft<typeof form> => ({ base: form, draft: form, remote: JSON.stringify(form) });

test('dirty drafts survive optimistic updates, rollbacks and background refetches', () => {
  const draft = { url: 'https://draft.test', key: 'unsaved-secret' };
  const edited = { ...state(), draft };
  const optimistic = receiveDraft(edited, draft);
  expect(optimistic.draft).toBe(draft);
  expect(optimistic.base).toBe(form);
  const failed = receiveDraft(optimistic, form);
  expect(failed.draft).toBe(draft);
  expect(failed.base).toBe(form);
  const remote = receiveDraft(failed, { ...form, url: 'https://elsewhere.test' });
  expect(remote.draft).toBe(draft);
});

test('successful credential-only saves clear the draft without needing a changed server view', () => {
  const submitted = { ...form, key: 'submitted-secret' };
  const saved = saveDraft({ ...state(), draft: submitted }, submitted, form);
  expect(saved.draft).toEqual(form);
  expect(saved.draft).toEqual(saved.base);
  expect(receiveDraft(saved, form)).toBe(saved);
});

test('success preserves edits made while saving, and pristine forms follow remote changes', () => {
  const submitted = { ...form, key: 'submitted-secret' };
  const current = { ...submitted, url: 'https://newer-draft.test' };
  const saved = saveDraft({ ...state(), draft: current }, submitted, form);
  expect(saved.draft).toEqual({ url: 'https://newer-draft.test', key: '' });
  expect(saved.base).toEqual(form);
  const refreshed = { ...form, url: 'https://saved.test' };
  expect(receiveDraft(state(), refreshed).draft).toBe(refreshed);
});
