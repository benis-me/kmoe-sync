// HTTP client for one Kmoe mirror: cookie jar, polite rate limiting, manual redirects (to see login redirects and
// every Set-Cookie) and the same request headers the site's own web client sends.
import { connectionProblem } from '../metadata/bangumi';
import { KmoeError, offline } from './errors';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const API_VERSION = 'KMOE/3.0.0';

export type Cookies = Record<string, string>;
export interface ClientOptions {
  /** e.g. "https://kzo.moe" */
  origin: string;
  cookies?: Cookies;
  /** Minimum gap between requests to the site, ms. */
  interval?: number;
  timeout?: number;
  fetch?: typeof fetch;
}
export interface KmoeRequest {
  query?: Record<string, string | number>;
  form?: Record<string, string>;
  /** Mimic the site's XHR helper (adds X-KM-FROM with the calling page). */
  xhrFrom?: string;
  referer?: string;
  accept?: 'html' | 'json';
  signal?: AbortSignal;
}
export interface KmoeResponse { status: number; url: URL; text: string; headers: Headers }

let lastRequestAt = 0;
let gate: Promise<void> = Promise.resolve();

// ---------- Kmoe's anti-bot throttle ----------
// When Kmoe decides an IP makes too many requests, it answers content pages (search, detail, data_book) with a redirect to
// a search engine (seen: www.google.com); the account page keeps working. Blocks were seen lasting over 1.5 h, and every
// request during one may prolong it, so everything this service sends to Kmoe pauses — 30 min, doubling up to 2 h.
const DEFLECTION = /(?:^|\.)(?:google|bing|baidu|yahoo|duckduckgo|yandex)\.[a-z.]+$/i;
const COOLDOWN_MS = 30 * 60_000, COOLDOWN_MAX_MS = 120 * 60_000, STRIKES_FORGOTTEN_MS = 4 * 3_600_000;
export interface ThrottleState { until: number; strikes: number; last: number; host: string }
const throttle = { until: 0, strikes: 0, last: 0, host: '', scale: 1 };
let saveThrottle: (state: ThrottleState) => void = () => {};

/** Restores a saved cooldown and keeps saving it, so a restart during a block keeps waiting instead of probing again. */
export function persistKmoeThrottle(saved: ThrottleState | null, save: (state: ThrottleState) => void) {
  if (saved) Object.assign(throttle, { until: saved.until, strikes: saved.strikes, last: saved.last, host: saved.host });
  saveThrottle = save;
}

/** The active cooldown, if any: requests fail fast with `rate_limited` until then. */
export function kmoeThrottle(): { until: number; host: string } | null {
  return throttle.until > Date.now() ? { until: throttle.until, host: throttle.host } : null;
}
function throttled(): KmoeError {
  const minutes = Math.max(1, Math.ceil((throttle.until - Date.now()) / 60_000));
  return new KmoeError('rate_limited', `Kmoe 暂时限制了访问频率（请求被转到了 ${throttle.host}），约 ${minutes} 分钟后自动恢复`);
}
function deflected(host: string): KmoeError {
  const time = Date.now();
  if (time - throttle.last > STRIKES_FORGOTTEN_MS) throttle.strikes = 0;
  throttle.strikes++;
  throttle.last = time;
  throttle.host = host;
  throttle.until = time + Math.min(COOLDOWN_MAX_MS, COOLDOWN_MS * 2 ** (throttle.strikes - 1)) * throttle.scale;
  saveThrottle({ until: throttle.until, strikes: throttle.strikes, last: throttle.last, host: throttle.host });
  return throttled();
}
/** Tests: shorten cooldowns (scale) and forget earlier blocks. */
export function resetKmoeThrottle(scale = 1) { Object.assign(throttle, { until: 0, strikes: 0, last: 0, host: '', scale }); }

/**
 * Whoever asks (pages, the API, MCP, the assistant, bulk jobs), the site sees at most `perMinute` requests in any minute:
 * about a third of the rate that got the home IP blocked for hours (~90 a minute). Tests change it.
 */
export const kmoeBudget = { perMinute: 25, windowMs: 60_000 };
const recent: number[] = [];

/** Serialises requests across all clients: at most one per `interval`, and within the budget (when `interval` > 0). */
async function politely(interval: number) {
  const turn = gate.then(async () => {
    for (;;) {
      const time = Date.now();
      while (recent.length && time - recent[0]! >= kmoeBudget.windowMs) recent.shift();
      const full = interval > 0 && recent.length >= kmoeBudget.perMinute;
      const wait = Math.max(lastRequestAt + interval - time, full ? recent[0]! + kmoeBudget.windowMs - time : 0);
      if (wait <= 0) break;
      await Bun.sleep(wait);
    }
    lastRequestAt = Date.now();
    recent.push(lastRequestAt);
  });
  gate = turn.catch(() => {});
  await turn;
}

/** Bun's codes for a connection that was open and then broke off. Refused connections and failed lookups are not retried. */
const DROPPED = new Set(['ECONNRESET', 'ConnectionClosed', 'EPIPE']);

export class KmoeClient {
  /** Pauses before the 2nd and 3rd attempt of a GET whose connection dropped (tests shorten them). */
  static retryDelays = [1_000, 3_000];
  readonly origin: string;
  private readonly cookies = new Map<string, string>();
  private readonly interval: number;
  private readonly timeout: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.origin = new URL(options.origin).origin;
    for (const [name, value] of Object.entries(options.cookies ?? {})) this.cookies.set(name, value);
    this.interval = options.interval ?? 400;
    this.timeout = options.timeout ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  get host() { return new URL(this.origin).host; }
  cookieJar(): Cookies { return Object.fromEntries(this.cookies); }
  hasSession() { return this.cookies.size > 0; }

  async request(method: 'GET' | 'POST', path: string, options: KmoeRequest = {}): Promise<KmoeResponse> {
    let url = new URL(path, this.origin);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, String(value));
    let body: FormData | undefined;
    if (options.form) {
      body = new FormData();
      for (const [name, value] of Object.entries(options.form)) body.append(name, value);
    }
    for (let hop = 0; hop < 6; hop++) {
      if (url.origin !== this.origin) {
        if (DEFLECTION.test(url.hostname)) throw deflected(url.host);
        throw new KmoeError('site_changed', `Kmoe 跳转到了其他站点（${url.host}）`);
      }
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: options.accept === 'json' ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh-TW;q=0.9,zh;q=0.8,en;q=0.6',
        Referer: options.referer ? new URL(options.referer, this.origin).href : `${this.origin}/`,
      };
      if (options.xhrFrom) headers['X-KM-FROM'] = `${API_VERSION}(WEB) ${method} ${options.xhrFrom}`;
      const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
      if (cookie) headers.Cookie = cookie;
      const { response, text } = await this.send(url, { method, headers, body, redirect: 'manual' }, options.signal);
      this.store(response.headers);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new KmoeError('site_changed', 'Kmoe 返回了无目标的跳转');
        url = new URL(location, url);
        if (response.status !== 307 && response.status !== 308) { method = 'GET'; body = undefined; }
        continue;
      }
      if (response.status === 429) throw new KmoeError('rate_limited', 'Kmoe 请求过于频繁，稍后自动重试');
      if (response.status >= 500) throw new KmoeError('network', `Kmoe 服务暂时不可用（HTTP ${response.status}）`);
      if (response.status === 404) throw new KmoeError('not_found', '在 Kmoe 上找不到该页面');
      return { status: response.status, url, text, headers: response.headers };
    }
    throw new KmoeError('site_changed', 'Kmoe 跳转次数过多');
  }

  get(path: string, options?: KmoeRequest) { return this.request('GET', path, options); }
  post(path: string, options?: KmoeRequest) { return this.request('POST', path, options); }

  /**
   * One request, body included. A GET whose connection broke off ("The socket connection was closed unexpectedly": a
   * stale keep-alive socket, a proxy or NAT dropping it) is sent again; a POST (the login) never is.
   */
  private async send(url: URL, init: RequestInit, outer?: AbortSignal): Promise<{ response: Response; text: string }> {
    for (let attempt = 0; ; attempt++) {
      if (kmoeThrottle()) throw throttled();
      await politely(this.interval);
      try {
        const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(this.timeout)]) : AbortSignal.timeout(this.timeout);
        const response = await this.fetchImpl(url, { ...init, signal });
        return { response, text: await response.text() };
      } catch (error) {
        if (outer?.aborted) throw error;
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (init.method === 'GET' && attempt < KmoeClient.retryDelays.length && DROPPED.has(code)) { await Bun.sleep(KmoeClient.retryDelays[attempt]!); continue; }
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
        throw offline(timedOut ? `连接 ${this.host} 超时` : `无法连接 ${this.host}（${connectionProblem(error)}）`);
      }
    }
  }

  private store(headers: Headers) {
    for (const line of headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (!pair || index <= 0) continue;
      const name = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim();
      const expired = attributes.some(attribute => {
        const [key, raw] = attribute.split('=').map(part => part.trim());
        if (key?.toLowerCase() === 'max-age') return Number(raw) <= 0;
        if (key?.toLowerCase() === 'expires') return raw ? Date.parse(raw) <= Date.now() : false;
        return false;
      });
      if (expired || value === '' || value === 'deleted') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

/** JSON body of a Kmoe response, or site_changed. */
export function jsonOf(response: KmoeResponse, what: string): unknown {
  try { return JSON.parse(response.text); } catch { throw new KmoeError('site_changed', `Kmoe ${what}没有返回 JSON`); }
}
