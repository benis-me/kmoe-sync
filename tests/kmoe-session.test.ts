import { afterEach, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { createSealer } from '../server/lib/crypto';
import { resetKmoeThrottle } from '../server/kmoe/client';
import { KmoeError } from '../server/kmoe/errors';
import { KmoeService } from '../server/services/kmoe';
import { FAKE_PASSWORD, startFakeKmoe } from './fake-kmoe';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); resetKmoeThrottle(); });
const loginError = () => new KmoeError('login_required', '当前页面要求登录');

async function setup() {
  resetKmoeThrottle();
  const fake = startFakeKmoe({ port: 0 });
  const db = openDatabase(tmpdir(), ':memory:');
  cleanup.push(() => { db.close(); fake.stop(); });
  const routes = new Map<string, (url: URL, init?: RequestInit) => Response | Promise<Response>>();
  const net = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return routes.get(url.pathname)?.(url, init) ?? fetch(input, init);
  }) as typeof fetch;
  const svc = new KmoeService(db, createSealer(Buffer.alloc(32, 9)), [fake.origin], () => fake.origin, net);
  await svc.login('reader@example.com', FAKE_PASSWORD, undefined, true);
  let expired = 0;
  svc.setHooks({ expired() { expired++; }, restored() {} });
  return { fake, db, routes, svc, expired: () => expired };
}

it('does not probe or expire the account for an explicit content restriction', async () => {
  const { svc, routes, expired } = await setup();
  let probes = 0;
  routes.set('/my.php', () => { probes++; return new Response('', { status: 503 }); });
  await expect(svc.withSession(async () => { throw new KmoeError('content_blocked', '内容受限'); })).rejects.toMatchObject({ code: 'content_blocked' });
  expect(svc.account().state).toBe('active');
  expect(expired()).toBe(0);
  expect(probes).toBe(0);
});

it('reports a restricted operation when the profile still accepts the session', async () => {
  const { svc, expired } = await setup();
  await expect(svc.withSession(async () => { throw loginError(); })).rejects.toMatchObject({ code: 'content_blocked', retryable: false });
  expect(svc.account().state).toBe('active');
  expect(expired()).toBe(0);
});

it('checks ambiguous empty volumes and recovers a genuinely expired session', async () => {
  const { svc, routes, fake, db, expired } = await setup();
  routes.set('/data_book.php', () => Response.json({ bookname: '', volcount: 0, voldata: [] }));
  await expect(svc.withSession(site => site.comic('8a3dbd'))).rejects.toMatchObject({ code: 'content_blocked' });
  expect(svc.account().state).toBe('active');
  fake.control.expired = true;
  await expect(svc.withSession(site => site.comic('8a3dbd'))).rejects.toMatchObject({ code: 'login_required' });
  expect(svc.account()).toMatchObject({ state: 'expired', remember: true });
  expect(db.query<{ cookies: Uint8Array | null }, []>('SELECT cookies FROM kmoe_account WHERE id = 1').get()!.cookies).not.toBeNull();
  expect(expired()).toBe(1);
  fake.control.expired = false;
  expect(await svc.autoLogin()).toEqual({ outcome: 'ok' });
  expect(svc.account().state).toBe('active');
});

it.each(['login', 'logout'] as const)('ignores an old failed profile probe after a new %s', async action => {
  const { svc, routes, expired } = await setup();
  const entered = Promise.withResolvers<void>(), response = Promise.withResolvers<Response>();
  routes.set('/my.php', () => { routes.delete('/my.php'); entered.resolve(); return response.promise; });
  const pending = svc.withSession(async () => { throw loginError(); }).catch(error => error);
  await entered.promise;
  if (action === 'login') await svc.login('new@example.com', FAKE_PASSWORD);
  else svc.logout();
  const cookies = action === 'login' ? svc.site().client.cookieJar() : null;
  response.resolve(new Response('<html>登录页</html>'));
  expect(await pending).toMatchObject({ code: 'refused', retryable: true });
  expect(svc.account().state).toBe(action === 'login' ? 'active' : 'none');
  if (cookies) expect(svc.site().client.cookieJar()).toEqual(cookies);
  expect(expired()).toBe(0);
});

it('saves a rotated cookie even when an overlapping unchanged request finishes first', async () => {
  const { svc, routes } = await setup();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  routes.set('/rotate', () => new Response('ok', { headers: { 'Set-Cookie': 'rotation=new; Path=/' } }));
  const pending = svc.withSession(async site => { entered.resolve(); await release.promise; await site.client.get('/rotate'); });
  await entered.promise;
  // The earlier completion has a later persistence timestamp than the still-running operation's start.
  await Bun.sleep(5);
  await svc.withSession(async () => {});
  release.resolve();
  await pending;
  expect(svc.site().client.cookieJar().rotation).toBe('new');
});

it('keeps the latest cookie response even when operations finish in the opposite order', async () => {
  const { svc, routes } = await setup();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  routes.set('/first', () => new Response('ok', { headers: { 'Set-Cookie': 'rotation=first; Path=/' } }));
  routes.set('/last', () => new Response('ok', { headers: { 'Set-Cookie': 'rotation=last; Path=/' } }));
  const pending = svc.withSession(async site => { await site.client.get('/first'); entered.resolve(); await release.promise; });
  await entered.promise;
  await svc.withSession(site => site.client.get('/last'));
  release.resolve();
  await pending;
  expect(svc.site().client.cookieJar().rotation).toBe('last');
});

it('ignores late cookie responses from the session a new login replaced', async () => {
  const { svc, routes } = await setup();
  const entered = Promise.withResolvers<void>(), response = Promise.withResolvers<Response>();
  routes.set('/late-cookie', () => { entered.resolve(); return response.promise; });
  const pending = svc.withSession(site => site.client.get('/late-cookie'));
  await entered.promise;
  await svc.login('new@example.com', FAKE_PASSWORD);
  const cookies = svc.site().client.cookieJar();
  response.resolve(new Response('ok', { headers: { 'Set-Cookie': 'VLIBSID=obsolete; Path=/' } }));
  await pending;
  expect(svc.site().client.cookieJar()).toEqual(cookies);
});

it('persists cookie deletion without removing unrelated cookies', async () => {
  const { svc, routes } = await setup();
  const session = svc.site().client.cookieJar().VLIBSID;
  routes.set('/cookie', () => new Response('ok', { headers: { 'Set-Cookie': 'temporary=present; Path=/' } }));
  await svc.withSession(site => site.client.get('/cookie'));
  expect(svc.site().client.cookieJar().temporary).toBe('present');
  routes.set('/cookie', () => new Response('ok', { headers: { 'Set-Cookie': 'temporary=deleted; Max-Age=0; Path=/' } }));
  await svc.withSession(site => site.client.get('/cookie'));
  expect(svc.site().client.cookieJar().temporary).toBeUndefined();
  expect(svc.site().client.cookieJar().VLIBSID).toBe(session);
});

it('propagates profile verification failures without expiring the account', async () => {
  const { svc, routes, expired } = await setup();
  routes.set('/my.php', () => new Response('', { status: 503 }));
  await expect(svc.withSession(async () => { throw loginError(); })).rejects.toMatchObject({ code: 'network', retryable: true });
  expect(svc.account().state).toBe('active');
  expect(expired()).toBe(0);
});

it('retains charges settled while a profile refresh was in flight', async () => {
  const { svc, routes } = await setup();
  const before = svc.account().remainingMB!;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  routes.set('/my.php', async (url, init) => {
    routes.delete('/my.php');
    const response = await fetch(url, init);
    entered.resolve();
    await release.promise;
    return response;
  });
  const pending = svc.refresh();
  await entered.promise;
  svc.recordUsage(1);
  expect(svc.account().remainingMB).toBe(before - 1);
  release.resolve();
  expect((await pending).remainingMB).toBe(before - 1);
  // A later profile is authoritative for all charges made before its request.
  expect((await svc.refresh()).remainingMB).toBe(before);
});

it('does not overwrite a new login with an old successful profile refresh', async () => {
  const { svc, routes } = await setup();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  routes.set('/my.php', async (url, init) => {
    routes.delete('/my.php');
    const response = await fetch(url, init);
    entered.resolve();
    await release.promise;
    return response;
  });
  const pending = svc.refresh().catch(error => error);
  await entered.promise;
  await svc.login('new@example.com', FAKE_PASSWORD);
  const cookies = svc.site().client.cookieJar();
  release.resolve();
  expect(await pending).toMatchObject({ code: 'refused', retryable: true });
  expect(svc.account()).toMatchObject({ state: 'active', email: 'new@example.com', error: null });
  expect(svc.site().client.cookieJar()).toEqual(cookies);
});
