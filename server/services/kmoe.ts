// The single Kmoe account: login, encrypted session cookies, quota, expiry handling, and (when asked) logging in again by itself.
import type { KmoeAccount, Quota } from '@shared/model';
import { now, json, type DB } from '../db';
import { AppError } from '../http/errors';
import type { Sealer } from '../lib/crypto';
import { KmoeClient, kmoeThrottle, type Cookies } from '../kmoe/client';
import { proxied } from '../lib/proxy';
import { KmoeError } from '../kmoe/errors';
import { errorMessage, isRetryable } from '../lib/retry';
import type { AccountInfo } from '../kmoe/parser';
import { KmoeSite } from '../kmoe/site';

interface Row { email: string | null; mirror: string | null; cookies: Uint8Array | null; state: KmoeAccount['state']; level: number | null; vip: number | null; free_quota: string | null; vip_quota: string | null; checked_at: string | null; error: string | null; password: Uint8Array | null; remember: number }

/** `auto`: the session came back by itself, with the remembered password. */
export interface KmoeHooks { expired(message: string): void; restored(auto: boolean): void }
/** What an automatic login did: `retry` it later (Kmoe did not answer it), or it `failed` for good (Kmoe refused it). */
export type AutoLogin = { outcome: 'ok' } | { outcome: 'retry'; message: string; first: boolean } | { outcome: 'failed'; message: string };

/** Wait after an automatic login that did not get through, doubling each time up to the maximum. */
const AUTO_RETRY_MS = 5 * 60_000, AUTO_RETRY_MAX_MS = 2 * 3_600_000;

const remaining = (quota: Quota | null) => quota?.totalMB != null && quota.usedMB != null ? Math.max(0, quota.totalMB - quota.usedMB) : null;

export class KmoeService {
  /** MB spent since the last profile refresh, so the quota guard sees downloads before the next refresh. */
  private spentSinceRefresh = 0;
  private hooks: KmoeHooks = { expired() {}, restored() {} };
  /** Automatic logins in a row that did not get through, and when the next one may go. */
  private autoRetry = { failures: 0, at: 0 };
  /** fetch for Kmoe pages, covers and downloads: through the proxy only when the settings send Kmoe there too. */
  readonly net: typeof fetch;

  constructor(private readonly db: DB, private readonly sealer: Sealer, readonly mirrors: string[], private readonly preferred: () => string,
    private readonly fetchImpl?: typeof fetch, proxy: () => string = () => '') {
    this.net = proxied(fetchImpl ?? fetch, proxy);
    db.run("INSERT OR IGNORE INTO kmoe_account (id, state, updated_at) VALUES (1, 'none', ?)", [now()]);
  }

  setHooks(hooks: KmoeHooks) { this.hooks = hooks; }

  get trustedHosts(): string[] { return this.mirrors.map(origin => new URL(origin).hostname); }

  private row(): Row { return this.db.query<Row, []>('SELECT email, mirror, cookies, state, level, vip, free_quota, vip_quota, checked_at, error, password, remember FROM kmoe_account WHERE id = 1').get()!; }

  account(): KmoeAccount {
    let row = this.row();
    if (row.state === 'active' && !this.sealer.open(row.cookies)) {
      this.expire('Kmoe 登录信息无法解密（实例密钥已更换），请重新登录');
      row = this.row();
    }
    const free = json<Quota | null>(row.free_quota, null), vipQuota = json<Quota | null>(row.vip_quota, null);
    const parts = [remaining(free), remaining(vipQuota)].filter((value): value is number => value !== null);
    return {
      state: row.state, email: row.email, mirror: row.mirror ? new URL(row.mirror).host : null, level: row.level,
      vip: row.vip === null ? null : row.vip === 1, free, vipQuota,
      remainingMB: parts.length ? Math.max(0, parts.reduce((sum, value) => sum + value, 0) - this.spentSinceRefresh) : null,
      checkedAt: row.checked_at, error: row.error,
      throttledUntil: ((cooldown) => cooldown ? new Date(cooldown.until).toISOString() : null)(kmoeThrottle()),
      remember: row.remember === 1,
    };
  }

  /** Origin to use: an explicit choice, else the preferred mirror setting, else the first configured mirror. */
  origin(choice?: string | null): string {
    const wanted = choice || this.preferred();
    if (wanted) {
      const match = this.mirrors.find(origin => origin === wanted || new URL(origin).host === wanted || new URL(origin).hostname === wanted);
      if (match) return match;
    }
    return this.mirrors[0]!;
  }

  private client(origin: string, cookies?: Cookies) {
    return new KmoeClient({ origin, cookies, fetch: this.net, interval: this.fetchImpl ? 0 : 400 });
  }

  /** A site bound to the stored session; throws login_required when there is none. */
  site(): KmoeSite {
    const row = this.row();
    const cookies = row.state === 'active' && row.mirror ? this.sealer.open(row.cookies) : null;
    if (row.state === 'active' && !cookies) {
      // The instance secret changed (data/secret.key lost or KMOESYNC_SECRET edited): the session can't be read any more.
      const message = 'Kmoe 登录信息无法解密（实例密钥已更换），请重新登录';
      this.expire(message);
      throw new KmoeError('login_required', message);
    }
    if (!row.mirror || !cookies) throw new KmoeError('login_required', row.state === 'expired' ? 'Kmoe 登录已失效，请在设置中重新登录' : '请先在设置中登录 Kmoe');
    return new KmoeSite(this.client(row.mirror, JSON.parse(cookies) as Cookies), this.trustedHosts);
  }

  /** A logged-in site when available, otherwise an anonymous one (detail pages work without login). */
  siteOrAnonymous(): { site: KmoeSite; session: boolean } {
    try { return { site: this.site(), session: true }; } catch { return { site: new KmoeSite(this.client(this.origin()), this.trustedHosts), session: false }; }
  }

  /** Runs an operation on the session, saves rotated cookies, and turns login_required into an "expired" account state. */
  async withSession<T>(operation: (site: KmoeSite) => Promise<T>): Promise<T> {
    const site = this.site();
    try {
      const result = await operation(site);
      this.saveCookies(site);
      return result;
    } catch (error) {
      if (error instanceof KmoeError && error.code === 'login_required') this.expire(error.message);
      else this.saveCookies(site);
      throw error;
    }
  }

  private saveCookies(site: KmoeSite) {
    this.db.run('UPDATE kmoe_account SET cookies = ?, updated_at = ? WHERE id = 1 AND state = ?', [this.sealer.seal(JSON.stringify(site.client.cookieJar())), now(), 'active']);
  }

  private saveAccount(info: AccountInfo, site: KmoeSite, email?: string) {
    this.spentSinceRefresh = 0;
    this.db.query(`UPDATE kmoe_account SET ${email !== undefined ? 'email = $email, ' : ''}mirror = $mirror, cookies = $cookies, state = 'active', level = $level, vip = $vip,
      free_quota = $free, vip_quota = $vipQuota, checked_at = $now, error = NULL, updated_at = $now WHERE id = 1`).run({
      ...(email !== undefined ? { email } : {}), mirror: site.client.origin, cookies: this.sealer.seal(JSON.stringify(site.client.cookieJar())),
      level: info.level, vip: info.vip === null ? null : info.vip ? 1 : 0, free: JSON.stringify(info.free), vipQuota: JSON.stringify(info.vipQuota), now: now(),
    });
  }

  /** `remember`: keep the password, sealed like the session, to log in again by itself later; left out, the last choice stands. */
  async login(email: string, password: string, mirror?: string, remember?: boolean): Promise<KmoeAccount> {
    const site = new KmoeSite(this.client(this.origin(mirror)), this.trustedHosts);
    const info = await site.login(email, password);
    this.saveAccount(info, site, email);
    const keep = remember ?? this.row().remember === 1;
    this.db.run('UPDATE kmoe_account SET password = ?, remember = ? WHERE id = 1', [keep ? this.sealer.seal(password) : null, keep ? 1 : 0]);
    this.autoRetry = { failures: 0, at: 0 };
    this.hooks.restored(false);
    return this.account();
  }

  /** An expired session can come back by itself: the user asked for it and the password is still there (and readable). */
  autoLoginReady(): boolean {
    const row = this.row();
    return row.remember === 1 && !!row.email && !!row.mirror && this.sealer.open(row.password) !== null;
  }

  /**
   * Logs in again with the remembered password after the session expired, on the mirror it was using. A login Kmoe refuses
   * (wrong password, disabled account, a challenge…) forgets the password and is never repeated; one that did not get
   * through (network, throttling) waits 5, 10, 20… minutes. Null: nothing to do right now.
   */
  async autoLogin(): Promise<AutoLogin | null> {
    const row = this.row();
    if (row.state !== 'expired' || !this.autoLoginReady() || Date.now() < this.autoRetry.at || kmoeThrottle()) return null;
    const site = new KmoeSite(this.client(row.mirror!), this.trustedHosts);
    try {
      this.saveAccount(await site.login(row.email!, this.sealer.open(row.password)!), site);
    } catch (error) {
      const message = errorMessage(error);
      if (isRetryable(error)) {
        const failures = this.autoRetry.failures + 1;
        this.autoRetry = { failures, at: Date.now() + Math.min(AUTO_RETRY_MAX_MS, AUTO_RETRY_MS * 2 ** (failures - 1)) };
        return { outcome: 'retry', message, first: failures === 1 };
      }
      this.autoRetry = { failures: 0, at: 0 };
      this.db.run('UPDATE kmoe_account SET password = NULL, error = ?, updated_at = ? WHERE id = 1', [`自动重新登录失败：${message}`, now()]);
      return { outcome: 'failed', message };
    }
    this.autoRetry = { failures: 0, at: 0 };
    this.hooks.restored(true);
    return { outcome: 'ok' };
  }

  /** No more logging in by itself: the remembered password is deleted. */
  forgetPassword(): KmoeAccount {
    this.db.run('UPDATE kmoe_account SET password = NULL, remember = 0, updated_at = ? WHERE id = 1', [now()]);
    return this.account();
  }

  /**
   * Moves the logged-in session to another mirror (the mirror setting). Its cookies are tried there once, on the profile
   * page, before anything changes: a mirror that does not accept them leaves the session where it was.
   */
  async moveSession(mirror: string): Promise<void> {
    const row = this.row(), origin = this.origin(mirror);
    if (row.state !== 'active' || row.mirror === origin) return;
    const site = new KmoeSite(this.client(origin, this.site().client.cookieJar()), this.trustedHosts);
    let info: AccountInfo;
    try { info = await site.account(); } catch (error) {
      if (error instanceof KmoeError && error.code === 'login_required') {
        throw new AppError(409, 'mirror_needs_login', `${new URL(origin).host} 不认现在的登录，没有切换。要用这个镜像，请退出后在它上面重新登录`);
      }
      throw error;
    }
    this.saveAccount(info, site);
  }

  /** Re-validates the session and refreshes quota. */
  async refresh(): Promise<KmoeAccount> {
    const site = this.site();
    try {
      const info = await site.account();
      this.saveAccount(info, site);
    } catch (error) {
      if (error instanceof KmoeError && error.code === 'login_required') this.expire(error.message);
      else this.db.run('UPDATE kmoe_account SET error = ?, updated_at = ? WHERE id = 1', [error instanceof Error ? error.message : String(error), now()]);
      throw error;
    }
    return this.account();
  }

  logout(): KmoeAccount {
    this.db.run("UPDATE kmoe_account SET cookies = NULL, password = NULL, remember = 0, state = 'none', level = NULL, vip = NULL, free_quota = NULL, vip_quota = NULL, checked_at = NULL, error = NULL, updated_at = ? WHERE id = 1", [now()]);
    return this.account();
  }

  expire(message: string) {
    const row = this.row();
    if (row.state !== 'active') return;
    this.db.run("UPDATE kmoe_account SET state = 'expired', cookies = NULL, error = ?, updated_at = ? WHERE id = 1", [message, now()]);
    this.hooks.expired(message);
  }

  recordUsage(mb: number) { if (Number.isFinite(mb) && mb > 0) this.spentSinceRefresh += mb; }
}
