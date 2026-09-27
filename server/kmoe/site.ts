// High-level Kmoe operations on one mirror session. Everything the service needs from the site goes through here.
import type { Format, Line } from '@shared/model';
import { jsonOf, type KmoeClient, type KmoeResponse } from './client';
import { KmoeError, siteChanged } from './errors';
import { COMIC_KEY, PROFILE_SENTINELS, parseAccount, parseDetailPage, parseDownloadLink, parseSearchPage, parseVolumeData, plainText, type AccountInfo, type DetailPage, type RemoteItem, type SearchPage } from './parser';

const LOGIN_CODES: Record<string, [KmoeError['code'], string]> = {
  e400: ['invalid_credentials', 'Kmoe 邮箱或密码错误'],
  e402: ['account_disabled', 'Kmoe 账号已停用'],
  e401: ['login_challenge', 'Kmoe 拒绝了这次登录，请先在浏览器登录一次网站后再试'],
  e403: ['login_challenge', 'Kmoe 登录验证已过期，请稍后再试'],
};

export class KmoeSite {
  constructor(readonly client: KmoeClient, private readonly trustedHosts: readonly string[]) {}

  private requireSession(response: KmoeResponse, what: string) {
    if (response.url.pathname.endsWith('/login.php')) throw new KmoeError('login_required', `${what}需要登录 Kmoe`);
  }

  /** Posts the password exactly once; never retried or replayed on another mirror. */
  async login(email: string, password: string): Promise<AccountInfo> {
    const page = await this.client.get('/login.php');
    const endpoint = /['"](\/login_act\.php)['"]/.exec(page.text)?.[1] ?? /<form[^>]+action=['"](\/login_do\.php)['"]/i.exec(page.text)?.[1];
    if (!endpoint) throw siteChanged('登录页');
    const response = await this.client.post(endpoint, { form: { email, passwd: password, keepalive: 'on' }, xhrFrom: '/login.php', referer: '/login.php', accept: 'json' });
    const data = jsonOf(response, '登录') as { msgid?: unknown; msg?: unknown };
    const code = String(data.msgid ?? '');
    if (code !== 'm100') {
      const known = LOGIN_CODES[code];
      if (known) throw new KmoeError(known[0], known[1]);
      throw new KmoeError('refused', plainText(String(data.msg ?? '')).slice(0, 200) || `Kmoe 登录失败（${code || '未知响应'}）`);
    }
    if (!this.client.hasSession()) throw new KmoeError('login_required', 'Kmoe 登录后没有返回会话');
    return this.account();
  }

  /** Validates the session and reads level / VIP / quota from the profile page. */
  async account(): Promise<AccountInfo> {
    const response = await this.client.get('/my.php');
    this.requireSession(response, '账号信息');
    if (!PROFILE_SENTINELS.some(sentinel => response.text.includes(sentinel))) throw new KmoeError('login_required', 'Kmoe 登录已失效，请重新登录');
    return parseAccount(response.text);
  }

  async search(query: string, page = 1): Promise<SearchPage> {
    const path = page > 1 ? `/l/${encodeURIComponent(query)},all,all,sortpoint,all,all,none/${page}.htm` : '/list.php';
    const response = await this.client.get(path, { query: page > 1 ? undefined : { s: query } });
    this.requireSession(response, '搜索');
    return parseSearchPage(response.text, page, this.client.origin, this.trustedHosts);
  }

  /** Detail page + volume list. The data_book hash is bound to this client's session, so both requests share it. */
  async comic(key: string): Promise<{ detail: DetailPage; items: RemoteItem[] }> {
    if (!COMIC_KEY.test(key)) throw new KmoeError('not_found', '漫画标识无效');
    const path = `/c/${key}.htm`;
    const page = await this.client.get(path);
    if (page.url.pathname !== path) {
      this.requireSession(page, '打开漫画');
      throw new KmoeError('not_found', '在 Kmoe 上找不到这部漫画');
    }
    const detail = await parseDetailPage(page.text, key, this.client.origin);
    const volumes = await this.client.get('/data_book.php', { query: { h: detail.dataHash }, xhrFrom: path, referer: path, accept: 'json' });
    return { detail, items: parseVolumeData(jsonOf(volumes, '章节数据')) };
  }

  async downloadLink(input: { key: string; bookId: string; itemId: string; format: Format; line: Line }): Promise<{ url: string; name: string }> {
    const response = await this.client.get('/getdownurl.php', {
      query: { b: input.bookId, v: input.itemId, mobi: input.format === 'mobi' ? 1 : 2, vip: input.line, json: 1 },
      xhrFrom: `/c/${input.key}.htm`, referer: `/c/${input.key}.htm`, accept: 'json',
    });
    this.requireSession(response, '获取下载链接');
    let payload: unknown;
    try { payload = JSON.parse(response.text); } catch {
      const text = plainText(response.text);
      if (/額度|额度/.test(text)) throw new KmoeError('quota_exhausted', 'Kmoe 下载额度不足');
      if (response.status === 403 || /登[錄录入]|非法/.test(text)) throw new KmoeError('login_required', 'Kmoe 登录已失效，请重新登录');
      throw siteChanged('下载链接');
    }
    return parseDownloadLink(payload);
  }
}
