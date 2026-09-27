// Transient-failure classification, ported from the browser extension (lib/retry.ts).
/** HTTP statuses that usually clear up on their own. 401/403/404/412 never do. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
export const transientStatus = (status: number) => TRANSIENT_STATUS.has(status);

export function transient<T extends object>(error: T, retryable = true): T & { retryable: boolean } {
  return Object.assign(error, { retryable });
}

export function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('retryable' in error) return error.retryable === true;
  // A bare fetch() failure ("Failed to fetch", "Unable to connect") or AbortSignal.timeout(); other TypeErrors are bugs.
  if (error instanceof TypeError && /fetch|network|connect|socket|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(error.message)) return true;
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ConnectionRefused', 'ConnectionClosed'].includes(code);
}

/** fetch() rejects with a bare TypeError ("Failed to fetch") or a TimeoutError: give it a readable, retryable form. */
export function networkError(error: unknown, target: string): unknown {
  if (error instanceof DOMException && error.name === 'TimeoutError') return Object.assign(transient(new Error(`连接${target}超时，请检查网络`)), { name: 'TimeoutError' });
  if (error instanceof TypeError || isRetryable(error)) return transient(new Error(`无法连接${target}（${error instanceof Error ? error.message : String(error)}），请检查网络`));
  return error;
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
