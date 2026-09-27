// Kmoe adapter errors. `code` is stable (shown in the API), `retryable` drives the download queue.
export type KmoeErrorCode =
  | 'login_required' // no usable Kmoe session: log in again in settings
  | 'invalid_credentials'
  | 'account_disabled'
  | 'login_challenge' // the site rejected an automated login; try again later or log in on the website first
  | 'quota_exhausted'
  | 'refused' // the site refused the action with a message (level, verification, blocked content…)
  | 'site_changed' // the page no longer has the structure we parse
  | 'not_found'
  | 'rate_limited'
  | 'network'
  | 'download_expired'
  | 'download_forbidden'
  | 'not_a_book';

const RETRYABLE: ReadonlySet<KmoeErrorCode> = new Set(['rate_limited', 'network', 'download_expired']);

export class KmoeError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: KmoeErrorCode, message: string, retryable?: boolean) {
    super(message);
    this.retryable = retryable ?? RETRYABLE.has(code);
  }
}

export const siteChanged = (what: string) => new KmoeError('site_changed', `Kmoe 页面结构已变化（${what}），请更新 Kmoe Sync`);

/** A connection that could not be made or broke off (not an HTTP error): the network, not the request, is the problem. */
export const offline = (message: string) => Object.assign(new KmoeError('network', message), { offline: true });
export const isOffline = (error: unknown) => error instanceof KmoeError && (error as KmoeError & { offline?: boolean }).offline === true;
