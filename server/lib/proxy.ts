// Outbound HTTP proxy (设置 → 网络代理). A NAS container doesn't get the NAS's system proxy, so connections that leave the
// LAN (Bangumi, GitHub, notifications, optionally Kmoe) go through this one address; LAN addresses never do.
import { AppError } from '../http/errors';

/** Settings value → "http://host:port" ('' = no proxy). HTTP(S) proxies only (what fetch supports), no credentials stored. */
export function proxyUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  let url: URL;
  try { url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`); } catch {
    throw new AppError(400, 'invalid_settings', '代理地址无效，例如 http://192.168.1.2:7890');
  }
  if (!/^https?:$/.test(url.protocol)) throw new AppError(400, 'invalid_settings', '代理需为 http:// 或 https:// 地址（不支持 SOCKS）');
  if (url.username || url.password) throw new AppError(400, 'invalid_settings', '代理地址不能包含账号密码');
  if (url.pathname !== '/' || url.search || url.hash) throw new AppError(400, 'invalid_settings', '代理地址只需协议、主机和端口，例如 http://192.168.1.2:7890');
  return url.origin;
}

/** This machine and the LAN (Komga, a local webhook, the proxy itself): reached directly even when a proxy is set. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !host.includes(':')) return true; // single-label names: localhost, Docker services, NAS names
  if (/\.(local|lan|home|internal|localdomain|home\.arpa)$/.test(host)) return true;
  if (/^(127|10)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:');
}

/**
 * fetch through `proxy()` when one is set (read on every call, so settings changes apply at once); LAN hosts go direct.
 * Through a proxy a site that cannot be reached comes back as a response (502), so a failed connection is the proxy's:
 * it is thrown as a ProxyError (same code, still retryable) and reported as such instead of blaming the site.
 */
export function proxied(fetchImpl: typeof fetch, proxy: () => string): typeof fetch {
  return ((input: string | URL | Request, init?: BunFetchRequestInit) => {
    const via = proxy();
    const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
    if (!via || isLocalHost(host)) return fetchImpl(input, init);
    return fetchImpl(input, { ...init, proxy: via }).catch((error: unknown) => {
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw error;
      throw Object.assign(new Error(`代理 ${via} 不可达`, { cause: error }), { name: 'ProxyError', code: (error as { code?: unknown } | null)?.code });
    });
  }) as typeof fetch;
}
