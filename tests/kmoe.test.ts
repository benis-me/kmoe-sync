import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { KmoeClient, kmoeBudget, kmoeThrottle, persistKmoeThrottle, resetKmoeThrottle, type ThrottleState } from '../server/kmoe/client';
import { KmoeError } from '../server/kmoe/errors';
import { proxied } from '../server/lib/proxy';
import { javascriptCalls, keyFromUrl, parseAccount, parseDetailPage, parseDownloadLink, parseSearchPage, parseVolumeData } from '../server/kmoe/parser';
import { KmoeSite } from '../server/kmoe/site';
import { FAKE_PASSWORD, startFakeKmoe } from './fake-kmoe';

const TRUSTED = ['kzo.moe', 'mox.moe', '127.0.0.1'];
const code = async (promise: Promise<unknown>) => { try { await promise; return 'ok'; } catch (error) { return error instanceof KmoeError ? error.code : String(error); } };

describe('parsers (real page fixtures)', () => {
  it('reads the live detail page: numeric book id differs from the page key', async () => {
    const detail = await parseDetailPage(readFileSync('tests/fixtures/detail-kzo.html', 'utf8'), '8a3dbd', 'https://kzo.moe');
    expect(detail).toMatchObject({ key: '8a3dbd', bookId: '31352', title: '渣女沒渣報', authors: ['岸川瑞樹'], status: '連載', language: '繁體', dataHash: '179049020818a3dbd00000000000004b61da' });
    expect(detail.cover).toStartWith('https://kmimg.moex.ink/cover/');
    expect(detail.description).toStartWith('在中學時代時');
  });
  it('maps the live volume JSON by index: [7] pages, [9] MOBI MB, [11] EPUB MB', () => {
    const items = parseVolumeData(JSON.parse(readFileSync('tests/fixtures/data-book-kzo.json', 'utf8')));
    expect(items).toHaveLength(20);
    expect(items[0]).toEqual({ id: '1001', type: 'volume', name: '卷 01', order: 1, pages: 177, mobiMB: 67.2, epubMB: 33.3 });
    expect(items.find(item => item.id === '3005')).toMatchObject({ type: 'serial', name: '話 005-015', pages: 289, epubMB: 53.3 });
  });
  it('decodes the HTML entities in volume names', () => {
    const row = ['2001', '', '', '番外篇', '1', '第 7.8 卷 - 娜娜&amp;小八粉絲手冊', '', '120', '', '10', '', '12'];
    expect(parseVolumeData({ volcount: 1, voldata: [row] })[0]!.name).toBe('第 7.8 卷 - 娜娜&小八粉絲手冊');
  });
  it('treats the anonymous empty sentinel as a session problem, never as "no volumes"', async () => {
    expect(await code(Promise.resolve().then(() => parseVolumeData({ msgid: 0, hash: '', bookkey: '', bookname: '', volcount: 0, voldata: [] })))).toBe('login_required');
    expect(await code(Promise.resolve().then(() => parseVolumeData({ volcount: 2, voldata: [] })))).toBe('site_changed');
  });
  it('parses JavaScript call arguments with escapes and concatenation, skipping declarations', () => {
    const source = `function disp_divinfo( a, b ) {}\n obj.disp_divinfo("x");\n disp_divinfo( "a\\"b", 'c' + "d", 12, "\\u4e2d" );`;
    expect(javascriptCalls(source, 'disp_divinfo')).toEqual([['a"b', 'cd', '12', '中']]);
  });
  it('resolves comic keys from any mirror, desktop or mobile, and rejects other hosts', () => {
    expect(keyFromUrl('https://kzo.moe/c/8a3dbd.htm', TRUSTED)).toBe('8a3dbd');
    expect(keyFromUrl('https://m.mox.moe/m/c/50076.htm', TRUSTED)).toBe('50076');
    expect(keyFromUrl('8a3dbd', TRUSTED)).toBe('8a3dbd');
    expect(keyFromUrl('https://evil.test/c/8a3dbd.htm', TRUSTED)).toBeNull();
    expect(keyFromUrl('https://kzo.moe/list.php?s=x', TRUSTED)).toBeNull();
  });
  it('classifies download-link answers', async () => {
    expect(parseDownloadLink({ code: 200, url: 'https://dl.kmoe8.com/a.epub', name: 'a.epub' })).toEqual({ url: 'https://dl.kmoe8.com/a.epub', name: 'a.epub' });
    expect(await code(Promise.resolve().then(() => parseDownloadLink({ code: 'e403', msg: '額度不足' })))).toBe('quota_exhausted');
    expect(await code(Promise.resolve().then(() => parseDownloadLink({ code: '400', msg: '請先登錄' })))).toBe('login_required');
    expect(await code(Promise.resolve().then(() => parseDownloadLink({ code: '400', msg: '<b>等級Lv3以上才可下載</b>' })))).toBe('refused');
    expect(await code(Promise.resolve().then(() => parseDownloadLink({ code: 200, url: 'javascript:alert(1)' })))).toBe('refused');
  });
  it('reads level, VIP and both quotas from the profile page', () => {
    const account = parseAccount('<p>Lv2 每月額度 : 10240 M</p><p>本月已用免費額度 : 2048.5 M</p><p>Lv2 額度 : 每月 5 日</p><p>VIP 每月額度 : 40960 M</p><p>本月已經用VIP額度 : 100 M</p><p>VIP 額度 : 每月 10 日</p><script>var is_vip = parseInt( "1" ); var user_level = parseInt( "2" );</script>');
    expect(account).toEqual({ level: 2, vip: true, free: { totalMB: 10240, usedMB: 2048.5, resetDay: 5 }, vipQuota: { totalMB: 40960, usedMB: 100, resetDay: 10 } });
  });
  it('refuses search pages without the expected structure', async () => {
    expect(await code(Promise.resolve().then(() => parseSearchPage('<html>maintenance</html>', 1, 'https://kzo.moe', TRUSTED)))).toBe('site_changed');
  });
});

describe('site operations against the fake mirror', () => {
  let fake: ReturnType<typeof startFakeKmoe>;
  beforeAll(() => { fake = startFakeKmoe({ port: 0 }); });
  afterAll(() => fake.stop());
  const site = () => new KmoeSite(new KmoeClient({ origin: fake.origin, interval: 0 }), TRUSTED);

  it('within a minute (here 400 ms) only so many requests go out; the next waits until the oldest leaves the window', async () => {
    const saved = { ...kmoeBudget };
    Object.assign(kmoeBudget, { perMinute: 3, windowMs: 400 });
    try {
      const client = new KmoeClient({ origin: fake.origin, interval: 1 });
      const started = Date.now();
      const times: number[] = [];
      for (let i = 0; i < 4; i++) { await client.get('/'); times.push(Date.now() - started); }
      expect(times[2]!).toBeLessThan(300);
      expect(times[3]!).toBeGreaterThanOrEqual(390);
    } finally { Object.assign(kmoeBudget, saved); }
  });

  it('a redirect to a search engine is Kmoe throttling: every request pauses until the cooldown ends', async () => {
    resetKmoeThrottle(1 / 6000); // 30 min → 300 ms
    try {
      const s = site();
      await s.login('reader@example.com', FAKE_PASSWORD);
      const before = await (await fetch(`${fake.origin}/__fake/state`)).json() as { searches: number };
      await fetch(`${fake.origin}/__fake/control`, { method: 'POST', body: JSON.stringify({ deflect: 1 }) });
      const first = await s.search('*').catch((error: KmoeError) => error);
      expect(first).toBeInstanceOf(KmoeError);
      expect(first).toMatchObject({ code: 'rate_limited', retryable: true });
      expect((first as KmoeError).message).toContain('www.google.com');
      expect(kmoeThrottle()?.host).toBe('www.google.com');
      // During the cooldown nothing reaches Kmoe.
      expect(await code(s.search('*'))).toBe('rate_limited');
      expect(((await (await fetch(`${fake.origin}/__fake/state`)).json()) as { searches: number }).searches).toBe(before.searches + 1);
      await Bun.sleep(350);
      expect(kmoeThrottle()).toBeNull();
      expect((await s.search('*')).hits.length).toBe(2);
      // A second block within four hours doubles the cooldown.
      await fetch(`${fake.origin}/__fake/control`, { method: 'POST', body: JSON.stringify({ deflect: 1 }) });
      await s.search('*').catch(() => undefined);
      expect(kmoeThrottle()!.until - Date.now()).toBeGreaterThan(350);
    } finally { resetKmoeThrottle(); }
  });

  it('a cooldown is saved when it starts and restored after a restart', async () => {
    resetKmoeThrottle(1 / 6000);
    const saved: ThrottleState[] = [];
    try {
      persistKmoeThrottle(null, state => saved.push(state));
      const s = site();
      await s.login('reader@example.com', FAKE_PASSWORD);
      await fetch(`${fake.origin}/__fake/control`, { method: 'POST', body: JSON.stringify({ deflect: 1 }) });
      await s.search('*').catch(() => undefined);
      expect(saved).toMatchObject([{ strikes: 1, host: 'www.google.com' }]);
      resetKmoeThrottle(); // the restart
      expect(kmoeThrottle()).toBeNull();
      persistKmoeThrottle({ ...saved[0]!, until: Date.now() + 60_000 }, () => {});
      expect(await code(s.search('*'))).toBe('rate_limited');
    } finally { resetKmoeThrottle(); persistKmoeThrottle(null, () => {}); }
  });

  it('rejects a wrong password with a clear code and logs in with the right one', async () => {
    expect(await code(site().login('reader@example.com', 'wrong'))).toBe('invalid_credentials');
    const s = site();
    const account = await s.login('reader@example.com', FAKE_PASSWORD);
    expect(account).toMatchObject({ level: 2, vip: true, free: { totalMB: 10240, resetDay: 5 } });
    expect(Object.keys(s.client.cookieJar())).toContain('VLIBSID');
  });
  it('searches (with pagination), opens a comic with its volumes, and gets a download link', async () => {
    const s = site();
    await s.login('reader@example.com', FAKE_PASSWORD);
    const first = await s.search('*');
    expect(first.hits.map(hit => hit.key)).toEqual(['8a3dbd', 'f7e2c9']);
    expect(first.totalPages).toBe(3);
    expect((await s.search('*', 2)).hits.map(hit => hit.key)).toEqual(['b1c4a0', 'c9d0e1']);
    const { detail, items } = await s.comic('8a3dbd');
    expect(detail.bookId).toBe('31352');
    expect(items.map(item => item.id)).toEqual(['1001', '1002', '3005', '3016', '3021']);
    const link = await s.downloadLink({ key: '8a3dbd', bookId: '31352', itemId: '1001', format: 'epub', line: 0 });
    expect(link.url).toContain('/file/31352/1001.epub');
  });
  it('detail pages work anonymously, but search and downloads need the session', async () => {
    const s = site();
    expect((await s.comic('f7e2c9')).items).toHaveLength(13);
    expect(await code(s.search('芙莉蓮'))).toBe('login_required');
    expect(await code(s.downloadLink({ key: 'f7e2c9', bookId: '50076', itemId: '2001', format: 'epub', line: 0 }))).toBe('login_required');
    expect(await code(s.account())).toBe('login_required');
  });
  it('reports an expired session and exhausted quota distinctly', async () => {
    const s = site();
    await s.login('reader@example.com', FAKE_PASSWORD);
    fake.control.quotaExhausted = true;
    expect(await code(s.downloadLink({ key: '8a3dbd', bookId: '31352', itemId: '1001', format: 'epub', line: 0 }))).toBe('quota_exhausted');
    fake.control.quotaExhausted = false;
    fake.control.expired = true;
    expect(await code(s.account())).toBe('login_required');
    fake.control.expired = false;
  });
});

describe('dropped connections', () => {
  // Closes the first `drop` connections as soon as a request arrives (what Bun reports as "The socket connection was
  // closed unexpectedly"), answers the rest.
  const state = { drop: 0, connections: 0 };
  const server = createServer(socket => {
    state.connections++;
    socket.on('error', () => {});
    socket.once('data', () => {
      if (state.drop > 0) { state.drop--; socket.destroy(); return; }
      socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
  });
  const delays = KmoeClient.retryDelays;
  let origin = '';
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    KmoeClient.retryDelays = [1, 1];
  });
  afterAll(() => { server.close(); KmoeClient.retryDelays = delays; });

  it('sends a GET again when its connection broke off, but never the login POST', async () => {
    const client = new KmoeClient({ origin, interval: 0 });
    Object.assign(state, { drop: 2, connections: 0 });
    expect((await client.get('/')).text).toBe('ok');
    expect(state.connections).toBe(3);
    Object.assign(state, { drop: 3, connections: 0 });
    expect(await client.get('/').catch((error: unknown) => error)).toMatchObject({ code: 'network', message: `无法连接 ${new URL(origin).host}（连接被重置）` });
    expect(state.connections).toBe(3);
    Object.assign(state, { drop: 1, connections: 0 });
    expect(await code(client.post('/login_act.php', { form: { email: 'reader@example.com', passwd: 'secret' } }))).toBe('network');
    expect(state.connections).toBe(1);
  });
});

describe('through a proxy', () => {
  it('a proxy that is down is named as the problem, not Kmoe; Kmoe unreachable behind it is a response', async () => {
    const dead = createServer();
    await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', resolve));
    const port = (dead.address() as AddressInfo).port;
    dead.close();
    const client = new KmoeClient({ origin: 'https://kzo.example', interval: 0, fetch: proxied(fetch, () => `http://127.0.0.1:${port}`) });
    expect(await client.get('/').catch((error: unknown) => error)).toMatchObject({ code: 'network', message: '无法连接 kzo.example（代理不可达）' });
    // The proxy is up and answers for a site it cannot reach: that is not the proxy's fault.
    const gateway = createServer(socket => socket.once('data', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')));
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const response = await proxied(fetch, () => `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`)('http://kzo.example/');
    expect(response.status).toBe(502);
    gateway.close();
  });
});
